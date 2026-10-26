import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectStack, generateDockerfile, prepareDockerfile, makeTag, BuildError } from '../src/services/builder.js';
import { tmpDir } from './helpers/setup.js';

function project(files) {
  const dir = tmpDir('stack-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('Dockerfile propio tiene prioridad y no se sobrescribe', () => {
  const dir = project({ Dockerfile: 'FROM scratch\n', 'package.json': '{}', 'index.html': '' });
  assert.equal(detectStack(dir).stack, 'dockerfile');
  prepareDockerfile(dir, { port: 3000 });
  assert.equal(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), 'FROM scratch\n');
});

test('Node: node:22-alpine, npm ci si hay lock, npm install si no, npm start', () => {
  const withLock = detectStack(project({ 'package.json': '{"scripts":{"start":"node app.js"}}', 'package-lock.json': '{}' }));
  assert.deepEqual(withLock, { stack: 'node', label: 'Node.js', hasLock: true, hasBuild: false, hasStart: true });
  const df = generateDockerfile(withLock, { port: 3000 });
  assert.match(df, /^FROM node:22-alpine$/m);
  assert.match(df, /^RUN npm ci --omit=dev$/m);
  assert.match(df, /^ENV PORT=3000$/m);
  assert.match(df, /^EXPOSE 3000$/m);
  assert.match(df, /^USER node$/m);
  assert.match(df, /^CMD \["npm", "start"\]$/m);

  const noLock = generateDockerfile(detectStack(project({ 'package.json': '{}' })), { port: 8080 });
  assert.match(noLock, /^RUN npm install --omit=dev$/m);

  const withBuild = generateDockerfile(detectStack(project({ 'package.json': '{"scripts":{"build":"vite build"}}', 'package-lock.json': '{}' })), { port: 80 });
  assert.match(withBuild, /^RUN npm ci && npm run build && npm prune --omit=dev$/m);
});

test('PHP y Laravel: php:8.3-apache, composer, extensiones y DocumentRoot /public', () => {
  const php = detectStack(project({ 'composer.json': '{"require":{"php":"^8.2"}}' }));
  assert.equal(php.stack, 'php');
  assert.equal(php.laravel, false);
  const df = generateDockerfile(php, { port: 80 });
  assert.match(df, /^FROM php:8\.3-apache$/m);
  assert.match(df, /docker-php-ext-install pdo_mysql pdo_pgsql zip/);
  assert.match(df, /mbstring/);
  assert.match(df, /COPY --from=composer:2 \/usr\/bin\/composer/);
  assert.match(df, /composer install --no-dev/);
  assert.doesNotMatch(df, /APACHE_DOCUMENT_ROOT/);

  const lara = detectStack(project({ 'composer.json': '{"require":{"laravel/framework":"^11.0"}}' }));
  assert.equal(lara.laravel, true);
  const ldf = generateDockerfile(lara, { port: 8000 });
  assert.match(ldf, /ENV APACHE_DOCUMENT_ROOT=\/var\/www\/html\/public/);
  assert.match(ldf, /AllowOverride All/);
  assert.match(ldf, /Listen 8000/);
  assert.match(ldf, /storage bootstrap\/cache/);
  // Laravel detectado también por el archivo artisan.
  assert.equal(detectStack(project({ 'composer.json': '{}', artisan: '' })).laravel, true);
});

test('Estático: nginx:alpine y puerto configurable', () => {
  const info = detectStack(project({ 'index.html': '<h1>x</h1>' }));
  assert.equal(info.stack, 'static');
  const df = generateDockerfile(info, { port: 8080 });
  assert.match(df, /^FROM nginx:alpine$/m);
  assert.match(df, /listen 8080;/);
  assert.match(df, /COPY \. \/usr\/share\/nginx\/html/);
});

test('sin archivos reconocibles o JSON roto: error claro', () => {
  assert.throws(() => detectStack(project({ 'README.md': '' })), BuildError);
  assert.throws(() => detectStack(project({ 'package.json': '{roto' })), /no es JSON válido/);
});

test('prepareDockerfile escribe Dockerfile y .dockerignore', () => {
  const dir = project({ 'index.html': '' });
  prepareDockerfile(dir, { port: 80 });
  assert.match(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), /nginx:alpine/);
  assert.match(fs.readFileSync(path.join(dir, '.dockerignore'), 'utf8'), /\.env/);
});

test('tag: commit corto o marca de tiempo UTC', () => {
  assert.equal(makeTag('abc1234', new Date()), 'abc1234');
  assert.equal(makeTag(null, new Date('2026-03-04T05:06:07Z')), '20260304050607');
});
