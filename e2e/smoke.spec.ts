import { expect, test } from '@playwright/test';

const ROSTER = [
  'Name,Phone,Party Size,Members',
  'Garcia Family,(555) 201-8830,4,Maria; Leo; Ana; Sam',
  'Nguyen Family,555-309-4417,5,',
  'Smith Family,555-740-1122,4,Jen; Tom; Lily; Max',
  'Example Rivera Family,(555) 201-0000,2,',
].join('\n');

test('create event → add parties → check in → call next → guest sees it live', async ({
  page,
  browser,
}) => {
  // Create the event (E1)
  await page.goto('/host');
  await page.getByRole('link', { name: 'New event' }).click();
  await page.getByLabel('Event name').fill('Pumpkin Patch Portraits');
  await page.getByLabel('Host PIN').fill('246810');
  await page.getByLabel('Admin password').fill('e2e-admin');
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page).toHaveURL(/\/host\/e\/[A-Za-z0-9]+$/);
  await expect(page.getByText('No one in line yet.')).toBeVisible();

  // Import a roster (A2): imported parties are "not arrived" (A8)
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('spreadsheet-input').setInputFiles({
    name: 'roster.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(ROSTER),
  });
  await expect(page.getByRole('heading', { name: 'Review 3 people' })).toBeVisible();
  await page.getByText('These people agreed to receive texts').click();
  await page.getByTestId('import-submit').click();
  await expect(page.getByTestId('row-3')).toBeVisible();
  await expect(page.getByTestId('call-next')).toHaveText(/Nobody checked in/);

  // Add one more party by hand (A1); manual adds are checked in by default
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /Type it in/ }).click();
  await page.getByLabel('Party name').fill('Okafor');
  await page.getByTestId('party-save').click();
  await expect(page.getByTestId('row-4')).toBeVisible();

  // Check in #1 and #2 from the host list
  await page.getByTestId('check-in-1').click();
  await expect(page.getByTestId('check-in-1')).toHaveCount(0);
  await page.getByTestId('check-in-2').click();
  await expect(page.getByTestId('check-in-2')).toHaveCount(0);

  // Grab Nguyen Family's (#2) private status link from Party actions
  await page.getByTestId('row-2').locator('button.main').click();
  const statusHref = await page.getByTestId('status-link').getAttribute('href');
  expect(statusHref).toMatch(/\/s\/[A-Za-z0-9]{12}$/);
  await page.keyboard.press('Escape');

  // Guest opens it on their own phone (separate browser context, no host cookie)
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(statusHref!);
  await expect(guest.getByTestId('position')).toHaveText('2');
  await expect(guest.getByTestId('now-serving')).toContainText('Starting soon');
  await expect(guest.getByTestId('my-card')).toContainText('Nguyen F.');
  // No full last names either (G2), not even the guest's own
  await expect(guest.locator('body')).not.toContainText('Nguyen Family');
  // No phone numbers on the guest page
  await expect(guest.locator('body')).not.toContainText('555');

  // Smith Family (#3) checks in from their own status page (G4)
  await page.getByTestId('row-3').locator('button.main').click();
  const smithHref = await page.getByTestId('status-link').getAttribute('href');
  await page.keyboard.press('Escape');
  const smith = await guestContext.newPage();
  await smith.goto(smithHref!);
  await smith.getByTestId('im-here').click();
  await expect(smith.getByTestId('im-here')).toHaveCount(0);
  await expect(page.getByTestId('check-in-3')).toHaveCount(0);

  // Call next: #1 Garcia is served; the guest page updates live, with no reload
  await expect(page.getByTestId('call-next')).toContainText('Garcia Family · #1');
  await page.getByTestId('call-next').click();
  await expect(page.getByTestId('now-serving')).toContainText('Garcia Family');
  await expect(guest.getByTestId('now-serving')).toContainText('#1');
  await expect(guest.getByTestId('now-serving')).toContainText('Garcia F.');
  await expect(guest.getByTestId('position')).toHaveText('Next');
  await expect(guest.getByText("You're up next!")).toBeVisible();
  // Already Up next, so the "we'll text you when you're 2 away" promise is gone (QA nit).
  await expect(guest.getByTestId('guest-note')).toHaveText(
    "Stay nearby. We'll text you when it's your turn.",
  );

  // The tap-to-send tray opened with the "Your turn" text ready for Garcia
  await expect(page.getByTestId('text-card').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Call next again: Nguyen's page flips to "It's your turn"
  await page.waitForTimeout(1100); // Call next is debounced for 1 s
  await page.getByTestId('call-next').click();
  await expect(guest.getByTestId('your-turn')).toBeVisible();
  await expect(guest.getByRole('alert')).toContainText("It's your turn!");

  // Pause the line (E6) with a message: Call next is off and Smith's page shows the banner.
  await page.keyboard.press('Escape'); // the texts tray opened after Call next
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByTestId('menu-pause').click();
  await page.getByLabel('Message for guests (optional)').fill('Back in 10 minutes — lunch break');
  await page.getByTestId('pause-submit').click();
  await expect(page.getByTestId('paused-bar')).toContainText('Back in 10 minutes');
  await expect(page.getByTestId('call-next')).toBeDisabled();
  await expect(page.getByTestId('call-next')).toContainText('Line paused');
  await expect(smith.getByTestId('paused-banner')).toContainText('The line is paused.');
  await expect(smith.getByTestId('paused-banner')).toContainText(
    'Back in 10 minutes — lunch break',
  );

  // Lobby display (G5): make the TV link on the Share screen and open it on a "TV".
  await page.getByRole('button', { name: 'Share and QR code' }).click();
  await page.getByTestId('lobby-create').click();
  const lobbyHref = await page.getByTestId('open-lobby-here').getAttribute('href');
  expect(lobbyHref).toMatch(/\/d\/[A-Za-z0-9_-]{24}$/);
  const tvContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const tv = await tvContext.newPage();
  await tv.goto(lobbyHref!);
  await expect(tv.getByTestId('lobby-now')).toContainText('#2');
  await expect(tv.getByTestId('lobby-now')).toContainText('Nguyen F.');
  await expect(tv.getByTestId('lobby-next')).toContainText('#3');
  await expect(tv.getByTestId('lobby-paused')).toContainText('Back in 10 minutes');
  await expect(tv.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(tv.locator('body')).not.toContainText('555');
  await expect(tv.locator('body')).not.toContainText('Family');

  // Resume from the dashboard: the banner goes away live on the guest page and the TV.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('paused-bar')).toHaveCount(0);
  await expect(smith.getByTestId('paused-banner')).toHaveCount(0);
  await expect(tv.getByTestId('lobby-paused')).toHaveCount(0);

  // Results CSV (E8) from Settings.
  await page.goto(page.url() + '/settings');
  await expect(page.getByTestId('retention-note')).toContainText('7 days');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-csv').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^pumpkin-patch-portraits-.*-results\.csv$/);
  const csv = await (await download.createReadStream()).toArray();
  const text = Buffer.concat(csv).toString('utf8');
  expect(text).toContain('Ticket,Party name,Party size');
  expect(text).toContain("1,Garcia Family,4,Maria; Leo; Ana; Sam,'+15552018830,,,done,");

  // Turning the TV link off disconnects the display.
  await page.goto(page.url().replace('/settings', '/share'));
  await page.getByTestId('lobby-off').click();
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(tv.getByTestId('lobby-gone')).toBeVisible();

  await tvContext.close();
  await guestContext.close();
});
