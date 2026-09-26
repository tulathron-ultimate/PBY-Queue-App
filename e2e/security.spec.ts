import { expect, test, type Page } from '@playwright/test';

/** Collects CSP violations reported in the page (SEC-2: the strict policy must not break the PWA). */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = list;
    document.addEventListener('securitypolicyviolation', (e) =>
      list.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

test('the strict CSP allows the app, its service worker and live WebSockets', async ({
  page,
  browser,
}) => {
  const violations = await watchCsp(page);
  const response = await page.goto('/host');
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await page.getByRole('link', { name: 'New event' }).click();
  await page.getByLabel('Event name').fill('CSP Check');
  await page.getByLabel('Host PIN').fill('246810');
  await page.getByLabel('Admin password').fill('e2e-admin');
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page).toHaveURL(/\/host\/e\/[A-Za-z0-9]+$/);
  const eventId = page.url().split('/').pop()!;

  // The share screen shows the QR code as a same-origin SVG image.
  await page.goto(`/host/e/${eventId}/share`);
  await expect(page.locator('img.qr')).toBeVisible();
  await expect
    .poll(() => page.locator('img.qr').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  // The host feed WebSocket connects under connect-src 'self'.
  const wsOpened = await page.evaluate(
    (id) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws/host/${id}`);
        ws.onmessage = () => {
          ws.close();
          resolve(true);
        };
        ws.onerror = () => resolve(false);
      }),
    eventId,
  );
  expect(wsOpened).toBe(true);

  // A guest status page renders under the same policy.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const guestViolations = await watchCsp(guest);
  await guest.goto('/s/AAAAAAAAAAAA');
  await expect(guest.getByText("We can't find this spot in line.")).toBeVisible();
  expect(await guestViolations()).toEqual([]);
  await guestContext.close();

  expect(await violations()).toEqual([]);
});
