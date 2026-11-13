import { test, expect, type Page } from '@playwright/test';

const SHEET_URL = 'http://127.0.0.1:18771/sheet.html';
const HOVER_BAR = '[data-testid=hover-bar]';
const TILE_SELECTORS = [
  '[data-testid=recommendation-tile]',
  '[data-testid=rec-tile]',
  '[data-testid=recommendation]',
  '[data-testid=tile]',
];

async function activateFirstTile(page: Page, action: 'hover' | 'tap') {
  const bar = page.locator(HOVER_BAR).first();
  await bar.waitFor({ state: 'attached' });

  const tile = page.locator(TILE_SELECTORS.join(', ')).first();
  if ((await tile.count()) > 0) {
    await (action === 'hover' ? tile.hover() : tile.tap());
    return;
  }

  // Fallback when the tile carries no known testid: drive the pointer at the
  // hover bar's layout box, which overlays the tile it belongs to.
  const box = await bar.boundingBox();
  if (!box) throw new Error('hover bar is not laid out');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (action === 'hover') await page.mouse.move(x, y);
  else await page.touchscreen.tap(x, y);
}

async function hoverBarOpacity(page: Page): Promise<number> {
  return page
    .locator(HOVER_BAR)
    .first()
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('hover bar reaches full opacity when the first recommendation tile is hovered', async ({ page }) => {
    await page.goto(SHEET_URL);
    await activateFirstTile(page, 'hover');

    await expect
      .poll(async () => Math.abs((await hoverBarOpacity(page)) - 1), { timeout: 5000 })
      .toBeLessThanOrEqual(0.01);
  });
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('hover bar stays hidden when the first recommendation tile is tapped', async ({ page }) => {
    await page.goto(SHEET_URL);
    await activateFirstTile(page, 'tap');

    await expect
      .poll(async () => Math.abs(await hoverBarOpacity(page)), { timeout: 5000 })
      .toBeLessThanOrEqual(0.01);
  });
});
