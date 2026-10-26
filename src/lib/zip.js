import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
    this.status = 400;
  }
}

export const ZIP_LIMITS = Object.freeze({
  maxFiles: 5000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
});

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const IGNORED = /^(__MACOSX\/|.*\/?\.DS_Store$)/;

/**
 * Normaliza el nombre de una entrada y lo valida contra zip-slip.
 * Devuelve las partes de la ruta o null si debe ignorarse.
 */
export function entryParts(rawName) {
  if (typeof rawName !== 'string' || rawName.includes('\0')) throw new ZipError('Nombre de archivo inválido en el zip');
  const name = rawName.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ZipError(`Ruta absoluta no permitida en el zip: ${rawName}`);
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new ZipError(`Ruta con ".." no permitida en el zip: ${rawName}`);
  return parts;
}

function unixMode(entry) {
  // Solo los zips creados en Unix guardan el modo en los 16 bits altos.
  const madeBy = entry.header.made >>> 8;
  return madeBy === 3 ? (entry.header.attr >>> 16) & 0xffff : 0;
}

/**
 * Lista y valida un zip sin descomprimir (rápido, para rechazar subidas obvias antes de encolar).
 */
export function inspectZip(file, limits = ZIP_LIMITS) {
  let zip;
  try {
    zip = new AdmZip(file);
  } catch (err) {
    throw new ZipError(`El archivo no es un zip válido: ${err.message}`);
  }
  const entries = zip.getEntries();
  if (entries.length === 0) throw new ZipError('El zip está vacío');
  if (entries.length > limits.maxFiles) throw new ZipError(`El zip tiene demasiados archivos (${entries.length} > ${limits.maxFiles})`);
  const seen = new Set();
  let declared = 0;
  for (const e of entries) {
    const parts = entryParts(e.entryName);
    if (!parts.length) continue;
    const key = parts.join('/').toLowerCase();
    if (seen.has(key) && !e.isDirectory) throw new ZipError(`Entrada duplicada en el zip: ${e.entryName}`);
    seen.add(key);
    const type = unixMode(e) & S_IFMT;
    if (type && type !== S_IFREG && type !== S_IFDIR) throw new ZipError(`Enlaces simbólicos y archivos especiales no están permitidos: ${e.entryName}`);
    if (e.header.encrypted || e.header.flags & 1) throw new ZipError(`Archivos cifrados no soportados: ${e.entryName}`);
    if (!e.isDirectory && ![0, 8].includes(e.header.method)) throw new ZipError(`Método de compresión no soportado en ${e.entryName}`);
    declared += e.header.size;
    if (e.header.size > limits.maxEntryBytes || declared > limits.maxTotalBytes)
      throw new ZipError('El contenido descomprimido supera el límite permitido');
  }
  return { zip, entries };
}

/**
 * Extrae el zip en `dest` (que debe estar vacío o no existir) con todas las defensas:
 * zip-slip, symlinks, duplicados, bombas (límite real de bytes inflados, no el declarado)
 * y sin preservar SUID/SGID.
 */
export function safeExtractZip(file, dest, limits = ZIP_LIMITS) {
  const { entries } = inspectZip(file, limits);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  if (fs.readdirSync(root).length) throw new ZipError('El directorio de destino no está vacío');

  let total = 0;
  let files = 0;
  for (const e of entries) {
    const parts = entryParts(e.entryName);
    if (!parts.length || IGNORED.test(parts.join('/'))) continue;
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) throw new ZipError(`Ruta fuera del destino: ${e.entryName}`);

    if (e.isDirectory) {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }

    const remaining = limits.maxTotalBytes - total;
    const cap = Math.min(remaining, limits.maxEntryBytes);
    const compressed = e.getCompressedData();
    let data;
    if (e.header.method === 0) {
      data = compressed;
    } else {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: cap + 1 });
      } catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)
          throw new ZipError('El contenido descomprimido supera el límite permitido (posible zip bomb)');
        throw new ZipError(`No se pudo descomprimir ${e.entryName}: ${err.message}`);
      }
    }
    if (data.length > cap) throw new ZipError('El contenido descomprimido supera el límite permitido (posible zip bomb)');
    if (data.length !== e.header.size) throw new ZipError(`Tamaño inconsistente en ${e.entryName} (zip corrupto o manipulado)`);
    total += data.length;

    // Solo se conserva el bit de ejecución: nada de SUID/SGID/sticky.
    const mode = unixMode(e) & 0o100 ? 0o755 : 0o644;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      // 'wx' falla si ya existe algo en esa ruta (incluido un symlink): defensa extra contra colisiones.
      fs.writeFileSync(target, data, { mode, flag: 'wx' });
    } catch (err) {
      throw new ZipError(`No se pudo escribir ${e.entryName}: ${err.code || err.message}`);
    }
    files++;
  }
  return { files, bytes: total };
}

/** Si el zip trae todo dentro de una única carpeta, devuelve esa carpeta como raíz del proyecto. */
export function projectRoot(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  if (items.length === 1 && items[0].isDirectory()) return path.join(dir, items[0].name);
  return dir;
}

export function looksLikeZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    return buf.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || buf.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  } finally {
    fs.closeSync(fd);
  }
}
