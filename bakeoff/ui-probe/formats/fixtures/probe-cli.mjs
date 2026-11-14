// One CLI over the shared probes, so every scenario format reaches the
// non-browser fixtures through the same implementation.
//
//   node fixtures/probe-cli.mjs http --url http://127.0.0.1:18772/health
//   node fixtures/probe-cli.mjs tcp  --port 18773
//   node fixtures/probe-cli.mjs uia  --window ui-probe-fixture --control ValueBox
import { httpJson, tcpBanner, uiaText } from '../lib/probes.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const command = process.argv[2];
try {
  if (command === 'http') {
    const url = arg('url');
    if (!url) throw new Error('--url is required');
    const res = await httpJson(url);
    console.log(JSON.stringify({ status: res.status, body: res.body, text: res.text }));
  } else if (command === 'tcp') {
    const port = Number(arg('port'));
    if (!port) throw new Error('--port is required');
    console.log(JSON.stringify({ banner: await tcpBanner(arg('host', '127.0.0.1'), port) }));
  } else if (command === 'uia') {
    const window = arg('window');
    const control = arg('control');
    if (!window || !control) throw new Error('--window and --control are required');
    console.log(JSON.stringify({ text: await uiaText(window, control) }));
  } else {
    throw new Error('usage: probe-cli.mjs <http|tcp|uia> [options]');
  }
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
