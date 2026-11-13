import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('the TCP listener greets with its banner', async () => {
  const out = execFileSync(process.execPath, [
    process.env.UI_PROBE_PROBE_CLI,
    'tcp', '--port', '18773',
  ], { encoding: 'utf8' });

  expect(JSON.parse(out).banner).toBe('HELLO ui-probe');
});
