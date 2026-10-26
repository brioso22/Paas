import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CERT_DAYS = 365;
const CA_DAYS = 3650;

const RENEW_BEFORE_DAYS = 30;

export function tlsPaths(config) {
  const dir = path.join(config.dataDir, 'tls');
  return {
    dir,
    caKey: path.join(dir, 'ca.key'),
    caCert: path.join(dir, 'ca.crt'),
    wildcardKey: path.join(dir, 'wildcard.key'),
    wildcardCert: path.join(dir, 'wildcard.crt'),
    projects: path.join(dir, 'projects'),
  };
}

/** ¿Cubre *.domain todos los hosts? (un solo nivel de subdominio, como exige X.509). */
export function coveredByWildcard(hosts, domain) {
  return hosts.every((h) => h === domain || (h.endsWith(`.${domain}`) && !h.slice(0, -domain.length - 1).includes('.')));
}

/** El certificado existe, cubre `hosts` y no caduca en los próximos RENEW_BEFORE_DAYS días. */
export function certUsable(certFile, hosts, now = new Date()) {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(certFile));
    if (new Date(x.validTo).getTime() - now.getTime() < RENEW_BEFORE_DAYS * 86400_000) return false;
    return hosts.every((h) => x.checkHost(h) !== undefined);
  } catch {
    return false;
  }
}

/** Extensiones X.509 del certificado de un proyecto (SAN con todos sus hosts). */
export function certExtensions(hosts) {
  return [
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(',')}`,
  ].join('\n') + '\n';
}

export function renderTlsSecret(project, certPem, keyPem) {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/tls',
    metadata: { name: `${project.name}-tls`, namespace: project.namespace, labels: { 'paas/project': project.name, 'app.kubernetes.io/managed-by': 'paas-panel' } },
    data: { 'tls.crt': Buffer.from(certPem).toString('base64'), 'tls.key': Buffer.from(keyPem).toString('base64') },
  });
}

/**
 * CA propia de la plataforma y certificados por proyecto, firmados con openssl a través
 * de exec.js. Las claves privadas quedan en DATA_DIR/tls con permisos 600 y solo salen
 * hacia el clúster por stdin (Secret TLS).
 */
export function createTls(ctx) {
  const { config, exec, kube } = ctx;
  const paths = tlsPaths(config);
  const openssl = (args, opts) => exec.run('openssl', args, { timeoutMs: 60_000, ...opts });
  const lock600 = (...files) => files.forEach((f) => fs.existsSync(f) && fs.chmodSync(f, 0o600));

  async function ensureCA(opts = {}) {
    fs.mkdirSync(paths.projects, { recursive: true, mode: 0o700 });
    if (fs.existsSync(paths.caKey) && fs.existsSync(paths.caCert)) return false;
    await openssl(
      [
        'req', '-quiet', '-x509', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', String(CA_DAYS),
        '-keyout', paths.caKey, '-out', paths.caCert, '-subj', '/CN=Lisec PaaS CA',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      ],
      opts,
    );
    lock600(paths.caKey, paths.caCert);
    return true;
  }

  function expiryOf(certFile) {
    try {
      return new Date(new crypto.X509Certificate(fs.readFileSync(certFile)).validTo).toISOString();
    } catch {
      return null;
    }
  }

  return {
    paths,
    ensureCA,

    caExists: () => fs.existsSync(paths.caCert),

    /**
     * Crea/actualiza el Secret TLS del proyecto. Si todos sus hosts son <x>.DOMAIN usa el
     * certificado wildcard compartido (*.DOMAIN y DOMAIN); si tiene dominio propio, uno
     * suyo con todos los SAN. Reutiliza el certificado vigente salvo `force` (renovar).
     * Devuelve la expiración ISO.
     */
    async issue(project, hosts, opts = {}) {
      const { force = false, ...execOpts } = opts;
      await ensureCA(execOpts);
      const wildcard = coveredByWildcard(hosts, config.domain);
      const base = path.join(paths.projects, project.name);
      const [key, crt] = wildcard ? [paths.wildcardKey, paths.wildcardCert] : [`${base}.key`, `${base}.crt`];
      const sans = wildcard ? [`*.${config.domain}`, config.domain] : hosts;
      if (force || !certUsable(crt, hosts, ctx.now())) {
        const csr = wildcard ? path.join(paths.dir, 'wildcard.csr') : `${base}.csr`;
        const ext = wildcard ? path.join(paths.dir, 'wildcard.ext') : `${base}.ext`;
        fs.writeFileSync(ext, certExtensions(sans), { mode: 0o600 });
        await openssl(['req', '-quiet', '-new', '-nodes', '-newkey', 'rsa:2048', '-keyout', key, '-out', csr, '-subj', `/CN=${sans[0]}`], execOpts);
        await openssl(
          [
            'x509', '-req', '-in', csr, '-CA', paths.caCert, '-CAkey', paths.caKey,
            '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`,
            '-days', String(CERT_DAYS), '-sha256', '-extfile', ext, '-out', crt,
          ],
          execOpts,
        );
        lock600(key, crt);
        fs.rmSync(csr, { force: true });
      }
      opts = execOpts;

      if (config.dryRun && !fs.existsSync(crt)) {
        // Sin openssl real no hay PEM: se registra el apply igualmente para ver el flujo completo.
        await kube.applyManifest(renderTlsSecret(project, 'DRY_RUN', 'DRY_RUN'), opts);
        return new Date(ctx.now().getTime() + CERT_DAYS * 86400_000).toISOString();
      }
      const keyPem = fs.readFileSync(key, 'utf8');
      await kube.applyManifest(renderTlsSecret(project, fs.readFileSync(crt, 'utf8'), keyPem), opts);
      return expiryOf(crt);
    },

    remove(project) {
      for (const ext of ['key', 'crt', 'ext', 'csr']) fs.rmSync(path.join(paths.projects, `${project.name}.${ext}`), { force: true });
    },
  };
}
