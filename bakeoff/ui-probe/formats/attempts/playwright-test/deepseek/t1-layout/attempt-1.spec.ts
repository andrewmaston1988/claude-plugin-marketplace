import { test, expect } from '@playwright/test';

const SHEET = 'http://127.0.0.1:18771/sheet.html';
const EXPECTED_WIDTH = 111;
const TOLERANCE = 1;

test.describe('detail sheet at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('action tiles are each 111px wide', async ({ page }) => {
    await page.goto(SHEET);

    const tiles = page.locator('[data-testid="action-tile"]');

    // The detail sheet may need opening from the page; open it only if the tiles
    // are not already on screen.
    if ((await tiles.count()) === 0) {
      for (const id of ['detail-trigger', 'open-detail', 'sheet-trigger']) {
        const trigger = page.locator(`[data-testid="${id}"]`).first();
        if ((await trigger.count()) > 0) {
          await trigger.tap();
          break;
        }
      }
    }

    await expect(tiles).toHaveCount(3);

    // Widths are read live from the laid-out boxes, so a wrong rule cannot pass.
    const widths = await tiles.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );

    expect(widths).toHaveLength(3);
    widths.forEach((width, index) => {
      expect(
        Math.abs(width - EXPECTED_WIDTH),
        `action tile ${index} measured ${width}px, expected ${EXPECTED_WIDTH}px +/- ${TOLERANCE}px`,
      ).toBeLessThanOrEqual(TOLERANCE);
    });
  });
});
