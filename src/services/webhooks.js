import crypto from 'node:crypto';

export function signPayload(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Verifica X-Hub-Signature-256 en tiempo constante. */
export function verifyGithubSignature(secret, rawBody, header) {
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from(signPayload(secret, rawBody));
  const received = Buffer.from(header);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/** GitHub puede enviar JSON o form-urlencoded con el JSON en el campo `payload`. */
export function parseGithubBody(rawBody, contentType = '') {
  const text = rawBody.toString('utf8');
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const payload = new URLSearchParams(text).get('payload');
    if (!payload) throw new Error('Falta el campo payload');
    return JSON.parse(payload);
  }
  return JSON.parse(text);
}

/**
 * Decide qué hacer con un evento ya autenticado.
 * Devuelve { action: 'pong' | 'ignore' | 'deploy', reason?, branch?, commit? }.
 */
export function decideGithubEvent(event, payload, project) {
  if (event === 'ping') return { action: 'pong' };
  if (event !== 'push') return { action: 'ignore', reason: `evento "${event}" ignorado` };
  const ref = typeof payload?.ref === 'string' ? payload.ref : '';
  if (!ref.startsWith('refs/heads/')) return { action: 'ignore', reason: 'el push no es de una rama' };
  const branch = ref.slice('refs/heads/'.length);
  if (payload.deleted) return { action: 'ignore', reason: `la rama ${branch} fue borrada` };
  if (branch !== project.branch) return { action: 'ignore', reason: `rama ${branch} distinta de la configurada (${project.branch})` };
  const commit = typeof payload.after === 'string' && /^[0-9a-f]{40}$/.test(payload.after) ? payload.after : null;
  return { action: 'deploy', branch, commit };
}
