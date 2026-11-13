import { test, expect } from '@playwright/test';

test('health endpoint reports ok', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:18772/health');

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
});
