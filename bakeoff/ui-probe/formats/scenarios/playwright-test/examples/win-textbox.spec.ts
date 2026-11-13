import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// The Windows fixture is already running. Read it through the shared probe CLI so
// every format observes it the same way.
test('WinForms textbox holds the fixture value', async () => {
  const out = execFileSync(process.execPath, [
    process.env.UI_PROBE_PROBE_CLI,
    'uia', '--window', 'ui-probe-fixture', '--control', 'ValueBox',
  ], { encoding: 'utf8' });

  expect(JSON.parse(out).text).toBe('fixture-value-42');
});
