import { isGitUrl, isBranch } from '../lib/validate.js';

/**
 * Variables de entorno para autenticar con un token sin ponerlo en la URL ni en argv.
 * Git lee GIT_CONFIG_COUNT/KEY_n/VALUE_n como si fueran `-c clave=valor`, y el header
 * se limita al origen del repositorio para no enviarlo a otros hosts (p. ej. submódulos).
 */
export function gitAuthEnv(repoUrl, token) {
  const env = { GIT_TERMINAL_PROMPT: '0' };
  if (!token) return env;
  const origin = new URL(repoUrl).origin;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export function createGit({ exec }) {
  return {
    async clone({ repoUrl, branch, dir, token, onLine }) {
      // Revalidación defensiva: estos valores terminan como argumentos de git.
      if (!isGitUrl(repoUrl)) throw new Error('URL de repositorio inválida');
      if (!isBranch(branch)) throw new Error('Rama inválida');
      await exec.run(
        'git',
        ['clone', '--depth', '1', '--branch', branch, '--single-branch', '--no-tags', '--', repoUrl, dir],
        { env: gitAuthEnv(repoUrl, token), secrets: token ? [token] : [], onLine, timeoutMs: 5 * 60 * 1000 },
      );
    },

    /** Commit corto de HEAD, o null en DRY_RUN / si no se puede leer. */
    async headCommit(dir) {
      const r = await exec.run('git', ['-C', dir, 'rev-parse', '--short=7', 'HEAD'], { timeoutMs: 15_000 });
      const sha = r.stdout.trim();
      return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
    },
  };
}
