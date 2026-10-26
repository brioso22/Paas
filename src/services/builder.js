import fs from 'node:fs';
import path from 'node:path';

export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new BuildError(`${path.basename(file)} no es JSON válido`);
  }
}

/** Detecta el stack por los archivos de la raíz, en orden de prioridad. */
export function detectStack(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('Dockerfile')) return { stack: 'dockerfile', label: 'Dockerfile propio' };
  if (has('package.json')) {
    const pkg = readJson(path.join(dir, 'package.json'));
    return {
      stack: 'node',
      label: 'Node.js',
      hasLock: has('package-lock.json') || has('npm-shrinkwrap.json'),
      hasBuild: Boolean(pkg.scripts?.build),
      hasStart: Boolean(pkg.scripts?.start) || has('server.js'),
    };
  }
  if (has('composer.json')) {
    const composer = readJson(path.join(dir, 'composer.json'));
    const laravel = has('artisan') || Boolean(composer.require?.['laravel/framework']);
    return { stack: 'php', label: laravel ? 'PHP / Laravel' : 'PHP', laravel };
  }
  if (has('requirements.txt')) return { stack: 'python', label: 'Python (gunicorn)' };
  if (has('index.html')) return { stack: 'static', label: 'Sitio estático (nginx)' };
  throw new BuildError('No se pudo detectar el stack: se esperaba Dockerfile, package.json, composer.json, requirements.txt o index.html en la raíz');
}

export function generateDockerfile(info, { port }) {
  const p = Number(port);
  switch (info.stack) {
    case 'node': {
      const install = info.hasBuild
        ? // Con paso de build hacen falta las devDependencies; se podan después.
          `RUN ${info.hasLock ? 'npm ci' : 'npm install'} && npm run build && npm prune --omit=dev`
        : `RUN ${info.hasLock ? 'npm ci --omit=dev' : 'npm install --omit=dev'}`;
      return `# Generado por paas-panel (stack: Node.js)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package*.json ./
${info.hasBuild ? 'COPY --chown=node:node . .\n' : ''}${install}
COPY --chown=node:node . .
ENV PORT=${p}
EXPOSE ${p}
USER node
CMD ["npm", "start"]
`;
    }
    case 'php': {
      const docroot = info.laravel
        ? `ENV APACHE_DOCUMENT_ROOT=/var/www/html/public
RUN sed -ri -e 's!/var/www/html!\${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf \\
 && sed -ri -e 's!/var/www/!\${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf
`
        : '';
      const laravelPerms = info.laravel
        ? 'RUN mkdir -p storage bootstrap/cache && chown -R www-data:www-data storage bootstrap/cache\n'
        : '';
      return `# Generado por paas-panel (stack: ${info.label})
FROM php:8.3-apache
RUN apt-get update \\
 && apt-get install -y --no-install-recommends libzip-dev libpq-dev libonig-dev unzip git \\
 && docker-php-ext-install pdo_mysql pdo_pgsql zip \\
 && (php -m | grep -qi '^mbstring$' || docker-php-ext-install mbstring) \\
 && rm -rf /var/lib/apt/lists/*
# AllowOverride All: sin esto Apache ignora el .htaccess (rutas amigables de Laravel y similares).
RUN a2enmod rewrite && sed -ri -e 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf
${docroot}RUN sed -ri -e 's/^Listen 80$/Listen ${p}/' /etc/apache2/ports.conf \\
 && sed -ri -e 's/<VirtualHost \\*:80>/<VirtualHost *:${p}>/' /etc/apache2/sites-available/000-default.conf
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
COPY composer.json composer.lock* ./
RUN composer install --no-dev --no-scripts --no-autoloader --no-interaction --no-progress
COPY . .
# --no-scripts: los scripts (p. ej. artisan) podrían necesitar un .env que no existe en el build.
RUN composer dump-autoload --optimize --no-dev --no-scripts
${laravelPerms}EXPOSE ${p}
`;
    }
    case 'python':
      return `# Generado por paas-panel (stack: Python con gunicorn, módulo app:app)
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY . .
RUN useradd --create-home --uid 10001 app && chown -R app /app
USER app
ENV PORT=${p}
EXPOSE ${p}
CMD ["gunicorn", "--bind", "0.0.0.0:${p}", "--workers", "2", "app:app"]
`;
    case 'static':
      return `# Generado por paas-panel (stack: sitio estático)
FROM nginx:alpine
RUN sed -ri -e 's/listen[[:space:]]+80;/listen ${p};/' -e 's/listen[[:space:]]+\\[::\\]:80;/listen [::]:${p};/' /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
EXPOSE ${p}
`;
    default:
      throw new BuildError(`No hay plantilla de Dockerfile para "${info.stack}"`);
  }
}

const DOCKERIGNORE = `.git
node_modules
vendor
.env
.env.*
Dockerfile.paas
`;

/** Genera el Dockerfile si el proyecto no trae uno. Devuelve la info del stack. */
export function prepareDockerfile(dir, { port }) {
  const info = detectStack(dir);
  if (info.stack !== 'dockerfile') {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), generateDockerfile(info, { port }));
    if (!fs.existsSync(path.join(dir, '.dockerignore'))) fs.writeFileSync(path.join(dir, '.dockerignore'), DOCKERIGNORE);
  }
  return info;
}

export function imageRef(project, tag) {
  return `${project.name}:${tag}`;
}

export function createBuilder({ exec }) {
  return {
    build(project, tag, dir, opts = {}) {
      return exec.run('minikube', ['image', 'build', '-t', imageRef(project, tag), dir], { timeoutMs: 30 * 60 * 1000, ...opts });
    },
    removeImage(project, tag, opts = {}) {
      return exec.run('minikube', ['image', 'rm', imageRef(project, tag)], { timeoutMs: 120_000, ...opts });
    },
  };
}

/** Tag de imagen: commit corto o, si no hay commit, marca de tiempo UTC. */
export function makeTag(commit, date) {
  if (commit) return commit;
  const d = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return d;
}
