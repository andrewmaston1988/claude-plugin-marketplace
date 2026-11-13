import { test, expect } from '@playwright/test';

// Phone viewport: the three action tiles must measure 111 px each.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('action tiles are 111 px wide at 390x844', async ({ page }) => {
  await page.goto('http://127.0.0.1:18771/sheet.html');

  const tiles = page.locator('[data-testid="action-tile"]');
  await expect(tiles).toHaveCount(3);

  const widths = await tiles.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(widths).toEqual([111, 111, 111]);
});
