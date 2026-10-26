// ÚNICO módulo autorizado a crear procesos. Ver test/security.test.js.
import { spawn } from 'node:child_process';

export const ALLOWED_COMMANDS = Object.freeze(['kubectl', 'helm', 'minikube', 'git']);

// Variables del propio panel que jamás deben heredar los procesos hijos.
const PANEL_SECRET_ENV = ['SESSION_SECRET', 'SECRETS_KEY'];

const REDACTED = '***';
const MIN_SECRET_LENGTH = 3;

export class ExecError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExecError';
    Object.assign(this, details);
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Devuelve una función que reemplaza cada secreto (y su forma base64) por ***.
 * Valores de 1-2 caracteres no se consideran secretos: redactarlos destrozaría los logs.
 */
export function createRedactor(secrets = []) {
  const variants = new Set();
  for (const s of secrets) {
    if (s === undefined || s === null) continue;
    const v = String(s);
    if (v.length < MIN_SECRET_LENGTH) continue;
    variants.add(v);
    variants.add(Buffer.from(v).toString('base64'));
    variants.add(encodeURIComponent(v));
  }
  if (!variants.size) return (text) => String(text);
  const re = new RegExp([...variants].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g');
  return (text) => String(text).replace(re, REDACTED);
}

export function formatCommand(cmd, args) {
  const q = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);
  return [cmd, ...args].map(q).join(' ');
}

function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

/**
 * @param {object} o
 * @param {boolean} o.dryRun  si es true no se ejecuta nada: se registra y se simula éxito.
 * @param {object} [o.logger]
 * @param {string[]} [o.allowed] comandos permitidos.
 */
export function createExec({ dryRun = false, logger = console, allowed = ALLOWED_COMMANDS } = {}) {
  const history = [];

  async function run(cmd, args = [], opts = {}) {
    const {
      cwd,
      stdin,
      env = {},
      secrets = [],
      onLine,
      echo = Boolean(onLine),
      signal,
      timeoutMs = 10 * 60 * 1000,
      maxBuffer = 8 * 1024 * 1024,
    } = opts;

    if (!allowed.includes(cmd)) throw new ExecError(`Comando no permitido: ${cmd}`);
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))
      throw new ExecError('Los argumentos deben ser un arreglo de strings');

    // Los valores de env adicionales se tratan siempre como secretos (p. ej. tokens de git).
    const redact = createRedactor([...secrets, ...Object.values(env)]);
    const printable = redact(formatCommand(cmd, args));
    const emit = (line, stream) => onLine && onLine(redact(line), stream);

    if (dryRun) {
      const entry = {
        cmd,
        args: args.map((a) => redact(a)),
        cwd: cwd || null,
        stdinBytes: stdin === undefined ? 0 : Buffer.byteLength(stdin),
        envKeys: Object.keys(env),
      };
      history.push(entry);
      logger.info?.(`[DRY_RUN] ${printable}${entry.stdinBytes ? ` (stdin: ${entry.stdinBytes} bytes)` : ''}`);
      if (echo) emit(`[DRY_RUN] $ ${printable}${entry.stdinBytes ? `  <stdin: ${entry.stdinBytes} bytes>` : ''}`, 'meta');
      return { code: 0, stdout: '', stderr: '', dryRun: true };
    }

    if (echo) emit(`$ ${printable}`, 'meta');

    const childEnv = { ...process.env, ...env };
    for (const k of PANEL_SECRET_ENV) delete childEnv[k];

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, args, { cwd, env: childEnv, shell: false, signal, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        reject(new ExecError(`No se pudo iniciar ${cmd}: ${err.message}`, { cmd: printable }));
        return;
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const outLines = lineSplitter((l) => emit(l, 'stdout'));
      const errLines = lineSplitter((l) => emit(l, 'stderr'));

      const append = (current, chunk) => {
        if (current.length + chunk.length > maxBuffer) {
          truncated = true;
          return current + chunk.slice(0, Math.max(0, maxBuffer - current.length));
        }
        return current + chunk;
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => {
        stdout = append(stdout, c);
        if (onLine) outLines.push(c);
      });
      child.stderr.on('data', (c) => {
        stderr = append(stderr, c);
        if (onLine) errLines.push(c);
      });

      let killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        const msg =
          err.code === 'ENOENT'
            ? `No se encontró "${cmd}" en el PATH`
            : err.name === 'AbortError'
              ? `${cmd} cancelado`
              : `Error ejecutando ${cmd}: ${err.message}`;
        reject(new ExecError(msg, { cmd: printable, aborted: err.name === 'AbortError', stdout: redact(stdout), stderr: redact(stderr) }));
      });

      child.on('close', (code, sig) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (onLine) {
          outLines.flush();
          errLines.flush();
        }
        const result = { code, signal: sig, stdout: redact(stdout), stderr: redact(stderr), truncated, dryRun: false };
        if (timedOut) return reject(new ExecError(`${cmd} superó el tiempo límite (${Math.round(timeoutMs / 1000)} s)`, { ...result, cmd: printable, timedOut }));
        if (code !== 0) {
          const tail = result.stderr.trim().split('\n').slice(-5).join('\n');
          return reject(new ExecError(`${cmd} terminó con código ${code}${tail ? `: ${tail}` : ''}`, { ...result, cmd: printable }));
        }
        resolve(result);
      });

      child.stdin.on('error', () => {}); // EPIPE si el proceso termina antes de leer stdin
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
  }

  return {
    run,
    dryRun,
    history,
    clearHistory: () => history.splice(0, history.length),
  };
}
