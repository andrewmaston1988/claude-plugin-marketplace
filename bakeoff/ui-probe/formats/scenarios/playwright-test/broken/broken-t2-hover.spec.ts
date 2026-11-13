import { test, expect } from '@playwright/test';

// DELIBERATELY BROKEN: it performs the steps but asserts nothing, so it would go
// green while proving nothing. The validator must reject it (no expect(...) call).
test('hovering a recommendation reveals its bar', async ({ page }) => {
  await page.goto('http://127.0.0.1:18771/sheet.html');

  await page.locator('[data-testid="rec-tile"]').first().hover();
});
