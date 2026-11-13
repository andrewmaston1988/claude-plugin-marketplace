import { test, expect } from '@playwright/test';

const SHEET = 'http://127.0.0.1:18771/sheet.html';

test.describe('desktop pointer', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('hovering a recommendation reveals its bar', async ({ page }) => {
    await page.goto(SHEET);

    await page.locator('[data-testid="rec-tile"]').first().hover();

    await expect(page.locator('[data-testid="hover-bar"]').first()).toHaveCSS('opacity', '1');
  });
});

test.describe('touch pointer', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tapping a recommendation leaves its bar hidden', async ({ page }) => {
    await page.goto(SHEET);

    await page.locator('[data-testid="rec-tile"]').first().tap();

    await expect(page.locator('[data-testid="hover-bar"]').first()).toHaveCSS('opacity', '0');
  });
});
