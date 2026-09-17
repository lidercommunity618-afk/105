import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function clearStorage(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.clear();
  });
}

async function skipOnboarding(page: import('@playwright/test').Page) {
  await page.addInitScript((script) => {
    localStorage.setItem('terminal-settings', script);
  }, JSON.stringify({
    state: {
      symbolId: 'BTCUSDT',
      timeframe: '15m',
      marketMode: 'crypto',
      onboardingCompleted: true,
      sensitivity: 'soft',
      priorityThreshold: 0.7,
      indicators: {
        rsiPeriod: 14, emaFast: 20, emaSlow: 50,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        atrPeriod: 14, bbPeriod: 20, bbStdDev: 2,
      },
      activePatterns: [],
      activeIndicators: [],
      showBosLayer: false, showOrderBlocks: false, showImbalances: false,
      showSupportResistance: false, showEma20: false, showEma50: false,
      showEma200: false, showBollinger: false, showMacd: false,
      showRejectionBlocks: false,
    },
    version: 7,
  }));
}

test.beforeEach(async ({ page }) => {
  await page.route('https://api.binance.com/api/v3/ping', (route) =>
    route.fulfill({ status: 200, body: '{}' }),
  );
  await page.route('https://api.binance.us/api/v3/ping', (route) =>
    route.fulfill({ status: 200, body: '{}' }),
  );
});

test.describe('Terminal', () => {
  test('app loads and shows chart', async ({ page }) => {
    await skipOnboarding(page);
    await page.goto('/');

    await expect(page.getByText('Терминал')).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(3000);

    const chartContainer = page.locator('canvas').first();
    await expect(chartContainer).toBeVisible({ timeout: 15_000 });
  });

  test('switching symbol from crypto to forex changes active source', async ({ page }) => {
    await skipOnboarding(page);
    await page.goto('/');
    await expect(page.getByText('Терминал')).toBeVisible({ timeout: 15_000 });

    const symbolButton = page.locator('button', { hasText: 'BTC/USDT' }).first();
    await symbolButton.click();

    const forexTab = page.getByRole('button', { name: 'ФОРЕКС' });
    await forexTab.click();

    const eurUsd = page.getByText('EUR/USD').first();
    await eurUsd.click();

    await expect(page.locator('button', { hasText: 'EUR/USD' }).first()).toBeVisible({ timeout: 5_000 });

    await page.waitForTimeout(3000);

    const statusBadge = page.locator('span', { hasText: /В эфире|Подключение|Переподключение|Пониж/ }).first();
    await expect(statusBadge).toBeVisible({ timeout: 15_000 });
  });

  test('switching timeframe 1m/5m/15m redraws chart', async ({ page }) => {
    await skipOnboarding(page);
    await page.goto('/');
    await expect(page.getByText('Терминал')).toBeVisible({ timeout: 15_000 });

    const tf1m = page.getByRole('button', { name: '1m', exact: true });
    await tf1m.click();
    await page.waitForTimeout(2000);

    const tf5m = page.getByRole('button', { name: '5m', exact: true });
    await tf5m.click();
    await page.waitForTimeout(2000);

    const tf15m = page.getByRole('button', { name: '15m', exact: true });
    await tf15m.click();
    await page.waitForTimeout(2000);

    const chartContainer = page.locator('canvas').first();
    await expect(chartContainer).toBeVisible({ timeout: 5_000 });
  });

  test('settings modal opens and closes', async ({ page }) => {
    await skipOnboarding(page);
    await page.goto('/');
    await expect(page.getByText('Терминал')).toBeVisible({ timeout: 15_000 });

    const settingsButton = page.getByRole('button', { name: 'Настройки' });
    await settingsButton.click();

    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible({ timeout: 5_000 });

    const overlay = page.locator('.fixed.inset-0 .bg-black\\/60').first();
    if (await overlay.isVisible()) {
      await overlay.click();
    } else {
      const settingsHeader = page.locator('h2:has-text("Настройки")');
      const closeBtn = settingsHeader.locator('..').locator('button').first();
      await closeBtn.click();
    }

    await page.waitForTimeout(500);
  });

  test('priority notifications: sound toggles are gone, banner+sound explanation is shown instead (Задача 2)', async ({ page }) => {
    // Раньше здесь было два переключателя звука ("Новый сигнал" /
    // "Приоритетный сигнал"), которые ничего не делали — звук всё равно
    // всегда играл. Теперь это единственный, всегда действующий режим,
    // и тумблеров, обещающих несуществующий выбор, в UI быть не должно.
    await skipOnboarding(page);
    await page.goto('/');
    await expect(page.getByText('Терминал')).toBeVisible({ timeout: 15_000 });

    const settingsButton = page.getByRole('button', { name: 'Настройки' });
    await settingsButton.click();
    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible({ timeout: 5_000 });

    await expect(page.getByText('Звуковые уведомления')).toBeVisible();
    await expect(page.getByText(/Звук и приоритетный баннер воспроизводятся автоматически/)).toBeVisible();
    await expect(page.getByText('Новый сигнал', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Приоритетный сигнал', { exact: true })).toHaveCount(0);

    await expect(page.getByText('Приоритетные уведомления')).toBeVisible();
    await expect(page.getByText(/Сигналы создаются только при уверенности не ниже этого порога/)).toBeVisible();
  });

  test('onboarding shows only on first run', async ({ page }) => {
    await clearStorage(page);
    await page.goto('/');

    await expect(page.getByText('Торговый терминал')).toBeVisible({ timeout: 15_000 });

    const nextButton = page.getByRole('button', { name: /Далее/ });
    for (let i = 0; i < 3; i++) {
      if (await nextButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextButton.click();
        await page.waitForTimeout(300);
      }
    }

    const finishButton = page.getByRole('button', { name: /Понятно, начать/ });
    if (await finishButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await finishButton.click();
    }

    await expect(page.getByText('Терминал')).toBeVisible({ timeout: 15_000 });

    await page.reload();

    await expect(page.getByText('Торговый терминал')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Терминал')).toBeVisible({ timeout: 15_000 });
  });

  test('main screen has no critical accessibility violations', async ({ page }) => {
    await skipOnboarding(page);
    await page.goto('/');
    await expect(page.getByText('Терминал')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3000);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );

    expect(criticalViolations).toEqual([]);
  });
});
