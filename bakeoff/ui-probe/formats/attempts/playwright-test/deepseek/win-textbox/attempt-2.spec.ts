import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test.use({ viewport: { width: 1280, height: 900 } });

test('the WinForms textbox exposes its fixture value', async () => {
  const out = execFileSync(process.execPath, [
    process.env.UI_PROBE_PROBE_CLI,
    'uia', '--window', 'ui-probe-fixture', '--control', 'ValueBox',
  ], { encoding: 'utf8' });

  expect(JSON.parse(out).text).toBe('fixture-value-42');
});
