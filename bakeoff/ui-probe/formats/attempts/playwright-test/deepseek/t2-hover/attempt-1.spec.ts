import { test, expect, type Locator } from '@playwright/test';

const SHEET_URL = 'http://127.0.0.1:18771/sheet.html';
const HOVER_BAR = '[data-testid=hover-bar]';
// The task names only the hover bar's testid; accept the tile's plausible spellings.
const REC_TILE = '[data-testid=rec-tile], [data-testid=recommendation-tile], [data-testid=rec-card]';

const readOpacity = (locator: Locator) =>
  locator.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));

// Hover/tap state settles through a CSS transition, so poll the computed value.
const expectOpacity = (locator: Locator, expected: number) =>
  expect.poll(() => readOpacity(locator), { timeout: 3000 }).toBeCloseTo(expected, 2);

test.describe('desktop viewport', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('hovering the first recommendation tile shows its hover bar', async ({ page }) => {
    await page.goto(SHEET_URL);

    const tile = page.locator(REC_TILE).first();
    const hoverBar = page.locator(HOVER_BAR).first();

    await tile.hover();

    await expectOpacity(hoverBar, 1);
  });
});

test.describe('touch viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tapping the first recommendation tile keeps its hover bar hidden', async ({ page }) => {
    await page.goto(SHEET_URL);

    const tile = page.locator(REC_TILE).first();
    const hoverBar = page.locator(HOVER_BAR).first();

    await tile.tap();

    await expectOpacity(hoverBar, 0);
  });
});