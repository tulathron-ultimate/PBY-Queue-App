import { expect, test } from '@playwright/test';

/**
 * README screenshots for the v1.1 features. Skipped unless `SCREENSHOTS=1`:
 * `SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts` (after `npm run build`).
 */
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/screenshots');

const OUT = 'docs/screenshots';

test('lobby display, and the paused line for host and guest', async ({ browser }) => {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });
  const page = await phone.newPage();
  const created = await page.request.post('/api/events', {
    data: { adminPassword: 'e2e-admin', name: 'Pumpkin Patch Portraits', pin: '246810' },
  });
  const { id } = await created.json();
  const names = ['Garcia Family', 'Priya & Dev', 'Smith Family', 'Okafor', 'Walsh Family'];
  const rows = [...names, 'Chen Family', 'Martinez'].map((name, i) => ({
    name,
    phone: `555-201-88${10 + i}`,
    size: 1 + (i % 4),
  }));
  await page.request.post(`/api/host/events/${id}/import`, {
    data: { rows, consentConfirmed: true, arrived: true },
  });
  await page.request.post(`/api/host/events/${id}/call-next`, { data: {} });
  const snap = await (await page.request.post(`/api/host/events/${id}/lobby`, { data: {} })).json();

  // Lobby display on a 16:9 TV, before the pause.
  const tvContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1.5,
  });
  const tv = await tvContext.newPage();
  await tv.goto(snap.event.lobbyUrl);
  await expect(tv.getByTestId('lobby-now')).toContainText('#1');
  await expect(tv.locator('.lb-foot img')).toHaveJSProperty('complete', true);
  await tv.waitForTimeout(300);
  await tv.screenshot({ path: `${OUT}/lobby-display.png` });

  await page.request.post(`/api/host/events/${id}/pause`, {
    data: { message: 'Back in 10 minutes — lunch break' },
  });
  await page.goto(`/host/e/${id}`);
  await expect(page.getByTestId('paused-bar')).toBeVisible();
  await page.screenshot({ path: `${OUT}/host-paused.png` });

  const guest = await phone.newPage();
  await guest.goto(`/s/${snap.parties[3].token}`);
  await expect(guest.getByTestId('paused-banner')).toBeVisible();
  await guest.screenshot({ path: `${OUT}/guest-paused.png` });

  await tvContext.close();
  await phone.close();
});
