import { test, expect } from '@playwright/test';

const SHEET = 'http://127.0.0.1:18771/sheet.html';
const TILE = '[data-testid="action-tile"]';
const EXPECTED_WIDTHS = [111, 111, 111];
const TOLERANCE = 1;

test.describe('detail sheet at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('each action tile is 111 CSS px wide', async ({ page }) => {
    await page.goto(SHEET);

    const tiles = page.locator(TILE);
    await expect(tiles).toHaveCount(EXPECTED_WIDTHS.length);
    await expect(tiles.first()).toBeVisible();

    const widths: number[] = [];
    for (let i = 0; i < EXPECTED_WIDTHS.length; i++) {
      const box = await tiles.nth(i).boundingBox();
      expect(box, `action tile ${i} should have a layout box`).not.toBeNull();
      widths.push(box!.width);
    }

    widths.forEach((width, i) => {
      expect(
        Math.abs(width - EXPECTED_WIDTHS[i]),
        `action tile ${i} width was ${width}px, expected ${EXPECTED_WIDTHS[i]}px +/- ${TOLERANCE}px`,
      ).toBeLessThanOrEqual(TOLERANCE);
    });
  });
});
