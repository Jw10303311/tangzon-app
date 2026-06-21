const { test, expect } = require('@playwright/test');
const path = require('path');

test('Tangzon app shell loads', async ({ page }) => {
  const htmlPath = path.join(__dirname, '..', 'Tangzon_产品管理_个人版本.html').replace(/\\/g, '/');
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('file:///' + htmlPath);
  await expect(page).toHaveTitle(/Tangzon/);
  await expect(page.locator('.main')).toBeVisible();
  await expect(page.locator('#sb-tree')).toBeAttached();
  await expect(page.locator('#prod-grid')).toBeAttached();
  await expect(page.locator('#settings-btn')).toBeAttached();
  expect(errors).toEqual([]);
});
