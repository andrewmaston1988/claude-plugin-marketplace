import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test.use({ viewport: { width: 1280, height: 900 } });

test('TCP listener on 127.0.0.1:18773 greets with "HELLO ui-probe"', async () => {
  const out = execFileSync(
    process.execPath,
    [process.env.UI_PROBE_PROBE_CLI as string, 'tcp', '--port', '18773'],
    { encoding: 'utf8' },
  );

  const { banner } = JSON.parse(out) as { banner: string };

  expect(banner).toBe('HELLO ui-probe');
});
