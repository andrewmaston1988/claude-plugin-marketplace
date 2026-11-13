import { spawn } from 'node:child_process';

export class AuthError extends Error {
  constructor(cookie, message) {
    super(`auth cookie "${cookie}": ${message}`);
    this.name = 'AuthError';
    this.cookie = cookie;
  }
}

// Substituted values must never carry path separators or shell metacharacters.
// Literal argv text is the author's own and passes through untouched.
const FORBIDDEN_VALUE_CHARS = /[\\/;&|<>$`]/;
const VAR_REF = /\{([A-Za-z0-9_.-]+)\}/g;

export async function resolveCookies(config, vars = {}, { _spawn = spawn, timeoutMs = 30000 } = {}) {
  const cookies = config?.auth?.cookies ?? [];
  const cwd = config?.configDir ?? process.cwd();
  const resolved = [];
  for (const cookie of cookies) {
    const argv = cookie.command;
    if (/[{}]/.test(argv[0])) {
      throw new AuthError(cookie.name, 'argv[0] must not contain {…}; the program is fixed, only its arguments may reference variables');
    }
    const args = argv.slice(1).map((part) => substitute(part, vars, cookie.name));
    resolved.push({ name: cookie.name, value: await runCommand([argv[0], ...args], cwd, cookie.name, _spawn, timeoutMs), ...(cookie.domain ? { domain: cookie.domain } : {}) });
  }
  return resolved;
}

function substitute(part, vars, cookieName) {
  return part.replace(VAR_REF, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new AuthError(cookieName, `variable "${name}" is not set; pass it with --var ${name}=<value>`);
    }
    const value = String(vars[name]);
    const bad = value.match(FORBIDDEN_VALUE_CHARS);
    if (bad) {
      throw new AuthError(cookieName, `variable "${name}" contains a forbidden character (one of \\ / ; & | < > $ \`); refusing to substitute it`);
    }
    return value;
  });
}

function runCommand(argv, cwd, cookieName, _spawn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = _spawn(argv[0], argv.slice(1), { shell: false, cwd });
    let stdout = '';
    const timer = setTimeout(() => {
      reject(new AuthError(cookieName, `command did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    const settle = (fn) => { clearTimeout(timer); fn(); };
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    // stderr is drained but never reported: it may echo the cookie value.
    child.stderr?.on('data', () => {});
    child.on('error', (err) => settle(() => reject(new AuthError(cookieName, `failed to start the command (${err.code ?? err.message})`))));
    child.on('close', (code) => {
      if (code !== 0) {
        settle(() => reject(new AuthError(cookieName, `command exited with code ${code}`)));
        return;
      }
      settle(() => resolve(stdout.trim()));
    });
  });
}
