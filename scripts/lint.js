#!/usr/bin/env node
// Comprobaciones estáticas sin dependencias: sintaxis de cada módulo y reglas del proyecto.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dirs = ['src', 'public/js', 'scripts', 'test'];
const problems = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

for (const file of dirs.flatMap((d) => walk(path.join(root, d)))) {
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  try {
    // Solo compila (no ejecuta): detecta errores de sintaxis en ESM y scripts clásicos.
    if (rel.startsWith('public/')) new vm.Script(src, { filename: rel });
    else new vm.SourceTextModule(src, { identifier: rel });
  } catch (err) {
    if (err instanceof SyntaxError) problems.push(`${rel}: ${err.message}`);
  }
  if (rel.startsWith('src/') && rel !== 'src/lib/exec.js' && /child_process/.test(src)) problems.push(`${rel}: solo src/lib/exec.js puede usar child_process`);
  if (/\bexecSync\b|shell:\s*true/.test(src) && !rel.startsWith('test/') && !rel.startsWith('scripts/lint')) problems.push(`${rel}: prohibido exec/execSync/shell`);
  if (/console\.log\(.*(password|token|secret)/i.test(src) && rel.startsWith('src/')) problems.push(`${rel}: posible secreto en un log`);
  if (/[ \t]+$/m.test(src)) problems.push(`${rel}: espacios al final de línea`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint OK');
