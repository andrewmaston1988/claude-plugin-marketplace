import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// The HTTP fixture is already listening. Read it through the shared probe CLI so
// every format observes it the same way; execFileSync blocks, so there is no
// sleep-polling and no browser involved.
test('health endpoint returns ok', async () => {
  const out = execFileSync(process.env.UI_PROBE_PROBE_CLI, [
    'http', '--url', 'http://127.0.0.1:18772/health',
  ], { encoding: 'utf8' });

  const result = JSON.parse(out);

  expect(result.status).toBe(200);

  // The CLI may hand back the JSON body already parsed or as raw text.
  const body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
  expect(body.ok).toBe(true);
});
