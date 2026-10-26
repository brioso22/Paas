import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyGithubSignature, signPayload, decideGithubEvent, parseGithubBody } from '../src/services/webhooks.js';
import { boot, createProject } from './helpers/app.js';

const SECRET = 'secreto-del-webhook';
const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40) }));

test('HMAC SHA-256: firma correcta, incorrecta, mal formada y cuerpo alterado', () => {
  const sig = signPayload(SECRET, body);
  assert.equal(sig, 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex'));
  assert.ok(verifyGithubSignature(SECRET, body, sig));
  assert.ok(!verifyGithubSignature('otro', body, sig));
  assert.ok(!verifyGithubSignature(SECRET, Buffer.concat([body, Buffer.from(' ')]), sig));
  for (const bad of [undefined, '', 'sha1=abc', sig.slice(0, -1), sig.toUpperCase(), 'sha256=' + 'g'.repeat(64)])
    assert.ok(!verifyGithubSignature(SECRET, body, bad), String(bad));
});

test('decisión por evento y rama', () => {
  const p = { branch: 'main' };
  assert.equal(decideGithubEvent('ping', {}, p).action, 'pong');
  assert.equal(decideGithubEvent('issues', {}, p).action, 'ignore');
  assert.equal(decideGithubEvent('push', { ref: 'refs/tags/v1' }, p).action, 'ignore');
  assert.match(decideGithubEvent('push', { ref: 'refs/heads/dev' }, p).reason, /distinta/);
  assert.equal(decideGithubEvent('push', { ref: 'refs/heads/main', deleted: true }, p).action, 'ignore');
  assert.deepEqual(decideGithubEvent('push', { ref: 'refs/heads/main', after: 'b'.repeat(40) }, p), { action: 'deploy', branch: 'main', commit: 'b'.repeat(40) });
  assert.equal(decideGithubEvent('push', { ref: 'refs/heads/main', after: '$(rm -rf /)' }, p).commit, null);
});

test('cuerpo form-urlencoded de GitHub', () => {
  const raw = Buffer.from('payload=' + encodeURIComponent('{"ref":"refs/heads/main"}'));
  assert.deepEqual(parseGithubBody(raw, 'application/x-www-form-urlencoded'), { ref: 'refs/heads/main' });
});

test('endpoint /hooks/github/:id de punta a punta (DRY_RUN)', async (t) => {
  const { ctx, srv, c, close } = await boot();
  t.after(close);
  const id = await createProject(c, { name: 'api', source: 'git', repo_url: 'https://github.com/acme/api.git', branch: 'main', port: '3000' });
  const secret = ctx.projects.webhookSecret(ctx.projects.get(id));

  const send = (event, payload, { sig, projectId = id, contentType = 'application/json' } = {}) => {
    const raw = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return fetch(`${srv.base}/hooks/github/${projectId}`, {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-github-event': event, 'x-hub-signature-256': sig ?? signPayload(secret, raw) },
      body: raw,
    });
  };

  let r = await send('ping', { zen: 'hola' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).message, 'pong');

  r = await send('push', { ref: 'refs/heads/main' }, { sig: 'sha256=' + '0'.repeat(64) });
  assert.equal(r.status, 401);
  r = await send('push', { ref: 'refs/heads/main' }, { sig: '' });
  assert.equal(r.status, 401);
  r = await send('push', { ref: 'refs/heads/main' }, { projectId: 999 });
  assert.equal(r.status, 401, 'proyecto inexistente: mismo error que firma inválida');

  r = await send('push', { ref: 'refs/heads/otra', after: 'c'.repeat(40) });
  assert.equal(r.status, 202);
  assert.equal((await r.json()).queued, false);

  // Push válido: no requiere sesión ni CSRF y encola un build.
  ctx.exec.clearHistory();
  const sha = '0123456789abcdef0123456789abcdef01234567';
  r = await send('push', { ref: 'refs/heads/main', after: sha });
  assert.equal(r.status, 202);
  const j = await r.json();
  assert.equal(j.queued, true);
  await ctx.queue.idle();
  const dep = ctx.db.prepare('SELECT * FROM deployments WHERE id = ?').get(j.deploymentId);
  assert.equal(dep.triggered_by, 'webhook:github');
  assert.equal(dep.source_ref, 'main@0123456');
  assert.equal(dep.status, 'success', dep.log);
  // En DRY_RUN no hay rev-parse real: el tag sale del commit del payload.
  assert.equal(dep.tag, '0123456');
  assert.ok(ctx.exec.history[0].args.includes('https://github.com/acme/api.git'));

  // Cuerpo no JSON con firma válida.
  r = await send('push', 'no-json');
  assert.equal(r.status, 400);

  // Proyecto zip no acepta webhooks.
  const zipId = await createProject(c, { name: 'web', source: 'zip' });
  const zipSecret = ctx.projects.webhookSecret(ctx.projects.get(zipId));
  const raw = JSON.stringify({ ref: 'refs/heads/main' });
  r = await fetch(`${srv.base}/hooks/github/${zipId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': signPayload(zipSecret, raw) },
    body: raw,
  });
  assert.equal(r.status, 400);
});

test('UI del webhook: URL con PUBLIC_BASE_URL, secreto revelable y rotación', async (t) => {
  const { ctx, c, close } = await boot();
  t.after(close);
  const id = await createProject(c, { name: 'api', source: 'git', repo_url: 'https://github.com/acme/api.git', branch: 'main' });
  const old = ctx.projects.webhookSecret(ctx.projects.get(id));
  const page = await c.get(`/projects/${id}/webhook`);
  assert.match(page.text, new RegExp(`https://panel\\.example\\.test/hooks/github/${id}`));
  assert.ok(!page.text.includes(old));
  const r = await c.request('POST', `/projects/${id}/webhook/reveal`, { headers: { 'x-csrf-token': c.csrf, accept: 'application/json' } });
  assert.equal(JSON.parse(r.text).value, old);
  await c.post(`/projects/${id}/webhook/rotate`, { form: { _csrf: c.csrf } });
  assert.notEqual(ctx.projects.webhookSecret(ctx.projects.get(id)), old);
});
