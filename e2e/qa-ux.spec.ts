import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * QA UX checks at a 390x844 phone viewport, light and dark: 48px touch targets (DESIGN 1.4),
 * no horizontal scroll, Call next in the bottom thumb zone at 25% of the screen height (Q2),
 * and the guest page updating live. `QA_SCREENSHOTS=1` saves screenshots to docs/screenshots/qa.
 */
const SHOTS = process.env.QA_SCREENSHOTS ? 'docs/screenshots/qa' : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const W = 390;
const H = 844;

/** Visible tappable elements smaller than 48x48, and whether the page scrolls sideways. */
async function audit(page: Page) {
  return page.evaluate(() => {
    const small: string[] = [];
    const els = document.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button]',
    );
    for (const el of Array.from(els)) {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!b.width || !b.height || cs.visibility === 'hidden') continue;
      // Off-screen, aria-hidden decoys such as the self-join honeypot are not for people.
      if (el.closest('[aria-hidden="true"]')) continue;
      // A checkbox inside its label is tapped through the (larger) label.
      if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.closest('label')) continue;
      // Inline links inside a sentence are exempt (WCAG 2.5.8 inline exception).
      if (el.tagName === 'A' && cs.display === 'inline') continue;
      if (b.height < 47.5 || b.width < 47.5) {
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
        small.push(
          `${el.tagName.toLowerCase()} "${label}" ${Math.round(b.width)}x${Math.round(b.height)}`,
        );
      }
    }
    return {
      small,
      hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

async function expectPhoneFriendly(page: Page, screen: string) {
  const r = await audit(page);
  expect(r.small, `${screen}: touch targets under 48px`).toEqual([]);
  expect(r.hscroll, `${screen}: horizontal scroll`).toBe(false);
}

/** Scrolled to the bottom, the last thing in the list must clear the fixed Call next bar. */
async function expectListClearsBar(page: Page, screen: string) {
  const gap = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const items = document.querySelectorAll('.content.with-bar > *');
    const last = items[items.length - 1]?.getBoundingClientRect();
    const bar = document.querySelector('.bottombar')?.getBoundingClientRect();
    return last && bar ? bar.top - last.bottom : 0;
  });
  expect(gap, `${screen}: last item hidden behind the bottom bar`).toBeGreaterThanOrEqual(0);
}

for (const theme of ['light', 'dark'] as const) {
  test(`phone UX at ${W}x${H}, ${theme} theme`, async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      colorScheme: theme, // guest pages follow the phone
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    // Host pages use the saved theme (default Light).
    await ctx.addInitScript(
      (t) => localStorage.setItem('pby.prefs', JSON.stringify({ theme: t })),
      theme,
    );
    const page = await ctx.newPage();
    const created = await page.request.post('/api/events', {
      data: { adminPassword: 'e2e-admin', name: 'Pumpkin Patch Portraits', pin: '246810' },
    });
    const { id, code } = await created.json();
    const rows = ['Garcia', 'Nguyen', 'Smith', 'Okafor', 'Rivera', 'Chen', 'Patel'].map((n, i) => ({
      name: `${n} Family`,
      phone: `555-201-88${10 + i}`,
      size: 1 + (i % 4),
    }));
    await page.request.post(`/api/host/events/${id}/import`, {
      data: { rows, consentConfirmed: true, arrived: true },
    });
    await page.request.post(`/api/host/events/${id}/import`, {
      data: { rows: [{ name: 'Late Arrival Family', phone: '555-201-8899' }] },
    });

    await page.goto(`/host/e/${id}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByTestId('call-next')).toBeVisible();
    await expectPhoneFriendly(page, 'dashboard');
    await expectListClearsBar(page, 'dashboard');

    // Q2: Call next is at least 25% of the screen tall and sits in the bottom 40% (thumb zone).
    const cn = (await page.getByTestId('call-next').boundingBox())!;
    expect(cn.height).toBeGreaterThanOrEqual(H * 0.25 - 1);
    expect(cn.y).toBeGreaterThanOrEqual(H * 0.6);
    expect(cn.y + cn.height).toBeLessThanOrEqual(H);

    await page.getByTestId('call-next').click();
    await expect(page.getByTestId('text-card').first()).toBeVisible();
    await expectPhoneFriendly(page, 'send texts sheet');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/host-send-texts-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('now-serving')).toContainText('Garcia');
    await expectPhoneFriendly(page, 'dashboard, serving');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/host-dashboard-${theme}.png` });

    await page.getByTestId('row-2').locator('button.main').click();
    const statusHref = await page.getByTestId('status-link').getAttribute('href');
    await expectPhoneFriendly(page, 'party sheet');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/host-party-sheet-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expectPhoneFriendly(page, 'add sheet');
    await page.getByRole('button', { name: /Type it in/ }).click();
    await expect(page.getByLabel('Party name')).toBeVisible();
    await expectPhoneFriendly(page, 'party editor');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The guest page, on its own, updates live when the host acts.
    const g = await ctx.newPage();
    await g.goto(statusHref!);
    await expect(g.getByTestId('position')).toHaveText('Next');
    await expectPhoneFriendly(g, 'guest status');
    if (SHOTS) await g.screenshot({ path: `${SHOTS}/guest-status-${theme}.png` });
    await page.waitForTimeout(1100); // Call next is debounced for 1 s
    await page.getByTestId('call-next').click();
    await expect(g.getByTestId('your-turn')).toBeVisible();
    if (SHOTS) await g.screenshot({ path: `${SHOTS}/guest-your-turn-${theme}.png` });

    // Missed list with its Re-add button. Each call opens the Texts to send tray first.
    const closeTray = async () => {
      await expect(page.getByTestId('text-card').first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    await closeTray();
    await page.waitForTimeout(1100);
    await page.getByTestId('now-serving').getByRole('button', { name: 'Not here' }).click();
    await closeTray();
    await expectListClearsBar(page, 'dashboard with missed toggle');
    await page.getByRole('button', { name: /Skipped & no-show/ }).click();
    await expect(page.getByRole('button', { name: 'Re-add' })).toBeVisible();
    await expectPhoneFriendly(page, 'dashboard with missed list');

    await g.goto(`/j/${code}`);
    await expect(g.getByRole('heading', { name: 'Join the photo line' })).toBeVisible();
    await expectPhoneFriendly(g, 'guest join');
    if (SHOTS) await g.screenshot({ path: `${SHOTS}/guest-join-${theme}.png`, fullPage: true });

    for (const path of [`/host/e/${id}/settings`, `/host/e/${id}/share`, '/host/new', '/host']) {
      await page.goto(path);
      await expect(page.locator('.screen').first()).toBeVisible();
      await expectPhoneFriendly(page, path);
    }
    if (SHOTS) {
      await page.goto(`/host/e/${id}/settings`);
      await page.screenshot({ path: `${SHOTS}/host-settings-${theme}.png`, fullPage: true });
    }
    await ctx.close();
  });
}
