import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('solo src/lib/exec.js crea procesos y nunca con shell', () => {
  for (const file of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, file);
    const src = fs.readFileSync(file, 'utf8');
    if (rel === path.join('src', 'lib', 'exec.js')) {
      assert.doesNotMatch(src, /\bexecSync\b|\bexec\(|shell:\s*true/, rel);
      continue;
    }
    assert.doesNotMatch(src, /child_process/, `${rel} no debe importar child_process`);
  }
});

test('sin eval ni innerHTML en el código', () => {
  for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'public'))]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /\beval\(|new Function\(|\.innerHTML\s*=|insertAdjacentHTML|document\.write/, path.relative(root, file));
  }
});

test('.env.example no contiene secretos reales y .gitignore excluye lo necesario', () => {
  const ex = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(ex, /SESSION_SECRET=cambia-esto/);
  assert.match(ex, /SECRETS_KEY=A{43}=/);
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const p of ['.env', 'data/', 'workspaces/', 'node_modules/']) assert.ok(gi.split('\n').includes(p), p);
});
