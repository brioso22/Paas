import crypto from 'node:crypto';

const VERSION = 'v1';

/**
 * Cifrado AES-256-GCM para valores guardados en la BD.
 * El "contexto" (p. ej. "env:miapp:DB_PASS") se usa como AAD: un valor cifrado
 * copiado a otra fila o proyecto no se podrá descifrar.
 */
export function createCipher(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('La clave de cifrado debe tener 32 bytes');

  function encrypt(plaintext, context = '') {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  }

  function decrypt(payload, context = '') {
    const parts = String(payload).split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Formato de dato cifrado desconocido');
    const [, ivB64, tagB64, ctB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  }

  return { encrypt, decrypt };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Comparación en tiempo constante de dos strings (no filtra la longitud del secreto esperado por timing). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}
