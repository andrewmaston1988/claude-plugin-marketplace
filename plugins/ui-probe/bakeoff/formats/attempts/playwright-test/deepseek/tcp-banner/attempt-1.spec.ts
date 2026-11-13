import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('tcp banner from 127.0.0.1:18773 is exactly "HELLO ui-probe"', async () => {
  const out = execFileSync(
    process.execPath,
    [process.env.UI_PROBE_PROBE_CLI!, 'tcp', '--port', '18773'],
    { encoding: 'utf8' },
  );

  const { banner } = JSON.parse(out) as { banner: string };
  const firstLine = String(banner).split(/\r?\n/)[0];

  expect(firstLine).toBe('HELLO ui-probe');
});