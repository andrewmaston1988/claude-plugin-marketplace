import { test, expect } from '@playwright/test';

// The health endpoint is a plain HTTP fixture, so use Playwright's APIRequestContext
// rather than a page. No sleeps: the request resolves before the assertions run.
test('health endpoint returns 200 with ok: true', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:18772/health');

  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.ok).toBe(true);
});
