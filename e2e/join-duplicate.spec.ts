import { expect, test } from '@playwright/test';

// SEC-10 (owner decision): self-joining with a phone number that's already in line only says
// "You're already in line". It never hands back that party's status link.
test("a phone number already in line hears it's already in line, with no link", async ({
  page,
  browser,
}) => {
  const created = await page.request.post('/api/events', {
    data: { adminPassword: 'e2e-admin', name: 'Pumpkin Patch Portraits', pin: '246810' },
  });
  const { id, code } = await created.json();
  await page.request.post(`/api/host/events/${id}/import`, {
    data: {
      rows: [{ name: 'Garcia Family', phone: '555-201-8830', size: 4 }],
      consentConfirmed: true,
      arrived: true,
    },
  });

  // A stranger's phone: its own browser, no saved join, no host cookie.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const g = await ctx.newPage();
  await g.goto(`/j/${code}`);
  await g.getByLabel('Your name or family name').fill('Nosy');
  await g.getByLabel('Mobile number').fill('(555) 201-8830');
  await g.getByRole('checkbox').check();
  await g.getByRole('button', { name: 'Join the line' }).click();

  const banner = g.getByRole('status').filter({ hasText: "You're already in line" });
  await expect(banner).toContainText('Use the link we texted you, or ask the photographer.');
  await expect(g).toHaveURL(new RegExp(`/j/${code}$`));
  await expect(g.locator('a[href^="/s/"]')).toHaveCount(0);
  await expect(g.getByRole('button', { name: 'Join the line' })).toHaveCount(0);
  if (process.env.SCREENSHOTS) {
    await g.screenshot({ path: 'docs/screenshots/guest-already-in-line.png', fullPage: true });
  }

  // "Add someone else" goes back to the form with the phone cleared.
  await g.getByRole('button', { name: 'Add someone else' }).click();
  await expect(g.getByLabel('Mobile number')).toHaveValue('');
  await ctx.close();
});
