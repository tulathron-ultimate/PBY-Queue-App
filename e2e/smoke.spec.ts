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
  await expect(guest.getByText('Nguyen Family')).toBeVisible();
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

  // The tap-to-send tray opened with the "Your turn" text ready for Garcia
  await expect(page.getByTestId('text-card').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Call next again: Nguyen's page flips to "It's your turn"
  await page.waitForTimeout(1100); // Call next is debounced for 1 s
  await page.getByTestId('call-next').click();
  await expect(guest.getByTestId('your-turn')).toBeVisible();
  await expect(guest.getByRole('alert')).toContainText("It's your turn!");

  await guestContext.close();
});
