import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolveCookies, AuthError } from '../src/auth.mjs';

function fakeSpawn(calls, { stdout = '', code = 0 } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
}

const config = (command, extra = {}) => ({
  auth: { cookies: [{ name: 'session', command, ...extra }] },
  configDir: 'C:\\cfg',
});

test('runs the command with shell:false, argv split, cwd = config dir', async () => {
  const calls = [];
  const [cookie] = await resolveCookies(
    config(['get-cookie', '--token', '{TOKEN}']),
    { TOKEN: 'abc123' },
    { _spawn: fakeSpawn(calls, { stdout: 'cookie-value\n' }) },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.shell, false);
  assert.deepEqual(calls[0].args, ['--token', 'abc123']);
  assert.equal(calls[0].opts.cwd, 'C:\\cfg');
  assert.equal(cookie.value, 'cookie-value');
  assert.equal(cookie.name, 'session');
});

test('cwd falls back to the process cwd when the config carries no configDir', async () => {
  const calls = [];
  await resolveCookies({ auth: { cookies: [{ name: 's', command: ['x'] }] } }, {}, { _spawn: fakeSpawn(calls) });
  assert.equal(calls[0].opts.cwd, process.cwd());
});

test('domain is carried onto the resolved cookie', async () => {
  const cookies = await resolveCookies(
    config(['x'], { domain: 'example.test' }),
    {},
    { _spawn: fakeSpawn([], { stdout: 'v' }) },
  );
  assert.equal(cookies[0].domain, 'example.test');
});

test('{var} in argv[0] is rejected', async () => {
  await assert.rejects(
    resolveCookies(config(['{BIN}', '--x']), { BIN: 'get-cookie' }, { _spawn: fakeSpawn([]) }),
    (err) => err instanceof AuthError && /argv\[0\]/.test(err.message),
  );
});

for (const ch of [';', '|', '&', '$', '`', '/', '\\', '<', '>']) {
  test(`a --var value containing ${JSON.stringify(ch)} is rejected, naming the variable but not the value`, async () => {
    const secret = `s3cret${ch}value`;
    const err = await resolveCookies(
      config(['get-cookie', '--token', '{TOKEN}']),
      { TOKEN: secret },
      { _spawn: fakeSpawn([]) },
    ).then(() => { throw new Error('should have rejected'); }, (e) => e);
    assert.ok(err instanceof AuthError);
    assert.match(err.message, /TOKEN/);
    assert.ok(!err.message.includes(secret), 'error must not contain the value');
  });
}

test('a missing variable is rejected naming the variable', async () => {
  await assert.rejects(
    resolveCookies(config(['get-cookie', '--token', '{MISSING}']), {}, { _spawn: fakeSpawn([]) }),
    (err) => err instanceof AuthError && /MISSING/.test(err.message),
  );
});

test('a non-zero exit throws naming the cookie, never the stdout value', async () => {
  const err = await resolveCookies(
    config(['get-cookie']),
    {},
    { _spawn: fakeSpawn([], { stdout: 'super-secret-value', code: 3 }) },
  ).then(() => { throw new Error('should have rejected'); }, (e) => e);
  assert.ok(err instanceof AuthError);
  assert.match(err.message, /session/);
  assert.match(err.message, /3/);
  assert.ok(!err.message.includes('super-secret-value'));
});

test('a spawn error throws naming the cookie, never the stdout value', async () => {
  const _spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn get-cookie ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const err = await resolveCookies(config(['get-cookie']), {}, { _spawn })
    .then(() => { throw new Error('should have rejected'); }, (e) => e);
  assert.ok(err instanceof AuthError);
  assert.match(err.message, /session/);
});

test('stdout is trimmed before it becomes the cookie value', async () => {
  const [cookie] = await resolveCookies(config(['x']), {}, { _spawn: fakeSpawn([], { stdout: '  tok\r\n' }) });
  assert.equal(cookie.value, 'tok');
});
