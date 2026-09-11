'use strict';
// Surfaces that already have a repo fixture harness (client/preview-*.html).
// These render the REAL page components against in-browser stubbed fetch;
// the harness still blocks every /api request that leaks past the stub.
/* global document */

const noApi = () => null; // preview mains stub fetch in-page; anything reaching the network is a leak we record

const hoverFirstCard = {
  name: 'hover-card', widths: [1440], fullPage: false,
  run: async (page) => { const c = page.locator('[data-glass="card"]').first(); await c.scrollIntoViewIfNeeded(); await c.hover(); },
};
const focusFirstAccent = {
  name: 'focus-accent', fullPage: false,
  run: async (page) => { const c = page.locator('[data-glass-accent]').first(); await c.scrollIntoViewIfNeeded(); await page.keyboard.press('Tab'); await c.focus(); await page.evaluate(() => { const el = document.activeElement; el && el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); }); },
};

module.exports = [
  {
    id: 'tokens-showcase', family: 'showcase', surface: 'customer', role: 'public', route: '(dev only) preview-tokens.html',
    url: '/preview-tokens.html', ready: 'css:[data-glass]', handle: noApi, extraWidths: true,
    interactions: [hoverFirstCard, focusFirstAccent],
  },
  {
    id: 'portal-home', family: 'portal-app', surface: 'customer', role: 'customer', route: '/ (?tab=dashboard)',
    url: '/preview-portal.html', ready: 'Jordan', handle: noApi, extraWidths: true,
    states: [
      { name: 'default' },
      { name: 'reduced-motion', reducedMotion: true, widths: [390] },
      { name: 'forced-colors', forcedColors: true, widths: [390], skipFocusProbe: true },
    ],
    interactions: [
      hoverFirstCard,
      { name: 'more-sheet', widths: [390], fullPage: false, run: async (page) => { await page.getByRole('button', { name: /^More$/ }).first().click({ force: true }); } },
      // Interactions run in sequence on the same page: the More sheet (390) is still open here, so close
      // it first (Escape, via the sheet's modal focus contract) and REQUIRE an overlay-free page before
      // opening the account menu, so the capture measures one dialog, the state a customer can reach.
      { name: 'account-menu', widths: [1440, 390], fullPage: false, run: async (page) => {
        if (await page.locator('[role="dialog"]').count()) { await page.keyboard.press('Escape'); await page.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: 5000 }); }
        if (await page.locator('[role="dialog"], [data-glass-scrim]').count()) throw new Error('an overlay is still open before account-menu');
        await page.locator('button[aria-label="Account menu"]').first().click({ force: true });
      } },
    ],
  },
  { id: 'portal-plan', family: 'portal-app', surface: 'customer', role: 'customer', route: '/?tab=plan', url: '/preview-portal.html?tab=plan', ready: 'css:[data-glass="card"]', handle: noApi },
  { id: 'portal-visits', family: 'portal-app', surface: 'customer', role: 'customer', route: '/?tab=schedule|services', url: '/preview-portal.html?tab=schedule', ready: 'css:[data-glass="card"]', handle: noApi,
    states: [{ name: 'upcoming' }, { name: 'completed', url: '/preview-portal.html?tab=services', ready: 'css:[data-glass="card"]' }] },
  { id: 'portal-billing', family: 'portal-app', surface: 'customer', role: 'customer', route: '/?tab=billing', url: '/preview-portal.html?tab=billing', ready: 'css:[data-glass="card"]', handle: noApi,
    interactions: [{ name: 'open-first-dialog', fullPage: false, run: async (page) => { await page.getByRole('button', { name: /add|update|change|manage/i }).first().click(); } }] },
  { id: 'portal-refer', family: 'portal-app', surface: 'customer', role: 'customer', route: '/?tab=refer', url: '/preview-portal.html?tab=refer', ready: 'css:[data-glass="card"]', handle: noApi },
  { id: 'portal-documents', family: 'portal-app', surface: 'customer', role: 'customer', route: '/?tab=documents', url: '/preview-portal.html?tab=documents', ready: 'css:[data-glass="card"]', handle: noApi },
  { id: 'portal-property', family: 'portal-app', surface: 'customer', role: 'customer', route: '/?tab=property', url: '/preview-portal.html?tab=property', ready: 'css:[data-glass="card"]', handle: noApi,
    states: [{ name: 'default' }, { name: 'saved-properties', url: '/preview-portal.html?tab=property&properties=saved', ready: 'css:[data-glass="card"]' }] },
  { id: 'portal-learn', family: 'portal-app', surface: 'customer', role: 'customer', route: '/?tab=learn', url: '/preview-portal.html?tab=learn', ready: 'css:[data-glass="card"]', handle: noApi },
  { id: 'portal-cancelled', family: 'portal-app', surface: 'customer', role: 'customer (cancelled)', route: '/ (cancelled persona)', url: '/preview-portal.html?persona=cancelled', ready: 'cancelled', handle: noApi,
    states: [{ name: 'home' }, { name: 'plan', url: '/preview-portal.html?persona=cancelled&tab=plan' }] },

  // Estimate — the template surface. Category scenarios exercise the same page family.
  ...['pest', 'lawn', 'mosquito', 'termite_bait', 'rodent', 'bundle', 'commercial', 'quote_required', 'accepted', 'expired', 'long_content', 'proposal', 'lawn_member_upgrade'].map((s) => ({
    id: `estimate-${s}`, family: 'estimate', surface: 'customer', role: 'public token', route: '/estimate/:token',
    url: `/preview-estimate.html?scenario=${s}&chrome=0`, ready: 'css:[data-glass-theme]', handle: noApi,
    extraWidths: s === 'pest', settle: 1200,
    states: s === 'pest' ? [{ name: 'default' }, { name: 'reduced-motion', reducedMotion: true, widths: [390, 1440] }, { name: 'forced-colors', forcedColors: true, widths: [390], skipFocusProbe: true }] : undefined,
    interactions: s === 'pest' ? [hoverFirstCard, { name: 'pick-slot', fullPage: false, run: async (page) => { const b = page.getByRole('button', { name: /^Choose|AM|PM/ }).first(); await b.scrollIntoViewIfNeeded(); await b.click(); } }] : s === 'lawn' ? [hoverFirstCard] : undefined,
  })),

  // Secure appointment (card-on-file)
  { id: 'secure-pest', family: 'flow', surface: 'customer', role: 'public token', route: '/secure/:token', url: '/preview-secure.html?v=pest', ready: 'Quarterly Pest Control', handle: noApi, extraWidths: true },
  { id: 'secure-lawn', family: 'flow', surface: 'customer', role: 'public token', route: '/secure/:token', url: '/preview-secure.html?v=lawn', ready: 'Lawn Care', handle: noApi },

  // Service report (V1 + V2 bodies)
  { id: 'report-service', family: 'document-report', surface: 'customer', role: 'public token', route: '/report/:token', url: '/preview-service-report.html?scenario=server-summary', ready: 'Quarterly Pest Control', handle: noApi, extraWidths: true, settle: 1200, hide: ['div[style*="z-index: 9999"]'],
    interactions: [hoverFirstCard, { name: 'ask-waves-focus', fullPage: false, run: async (page) => { const i = page.locator('.waves-ask-form input').first(); await i.scrollIntoViewIfNeeded(); await i.focus(); } }] },
  { id: 'report-service-client', family: 'document-report', surface: 'customer', role: 'public token', route: '/report/:token', url: '/preview-service-report.html?scenario=client-built', ready: 'css:h1.sr-title', handle: noApi, settle: 1200, hide: ['div[style*="z-index: 9999"]'] },
  ...['report', 'termite', 'termite-treatment', 'cockroach', 'one-time-pest', 'one-time-lawn', 'rodent-exclusion', 'mosquito', 'palm', 'bed-bug', 'wdo', 'certificate'].map((s) => ({
    id: `report-project-${s}`, family: 'document-report', surface: 'customer', role: 'public token', route: '/report/project/:token',
    url: `/preview-project-report.html?scenario=${s}`, ready: 'css:h1', handle: noApi, settle: 1000, hide: ['div[style*="z-index: 9999"]'],
  })),

  // Day-of-service tracker
  ...['scheduled', 'en_route', 'on_property', 'complete'].map((s) => ({
    id: `track-${s}`, family: 'flow', surface: 'customer', role: 'public token', route: '/track/:token',
    url: `/preview-track.html?state=${s}`, ready: s === 'scheduled' ? 'stops before yours' : s === 'complete' ? 'Thanks for choosing Waves' : s === 'on_property' ? 'css:[data-glass="card"]' : 'Alex arrives in', handle: noApi, extraWidths: s === 'en_route',
  })),

  // Reschedule / re-service flow
  { id: 'flow-reschedule', family: 'flow', surface: 'customer', role: 'public token', route: '/reschedule/:token', url: '/preview-schedule-flow.html', ready: 'Our best times for you', handle: noApi, extraWidths: true,
    interactions: [
      { name: 'select-slot', fullPage: true, run: async (page) => { await page.getByRole('button', { name: /^Choose 9:00 AM/ }).first().click(); } },
      { name: 'confirmed', fullPage: true, run: async (page) => { await page.getByRole('button', { name: /^(Confirm|Book).*→/ }).click(); await page.getByText("You're all set", { exact: true }).waitFor(); } },
    ] },
  { id: 'flow-reschedule-collective', family: 'flow', surface: 'customer', role: 'public token', route: '/reschedule/:token', url: '/preview-schedule-flow.html?scenario=collective', ready: 'Our best times for you', handle: noApi },
  { id: 'flow-reservice', family: 'flow', surface: 'customer', role: 'public token', route: '/reservice/:token', url: '/preview-schedule-flow.html?flow=reservice', ready: 'pests back between visits', handle: noApi },

  // Irrigation / watering plan card (portal)
  { id: 'portal-irrigation', family: 'portal-app', surface: 'customer', role: 'customer', route: '/ (watering plan card)', url: '/preview-irrigation.html', ready: 'css:[data-glass]', handle: noApi,
    states: [{ name: 'spray' }, { name: 'plan-live', url: '/preview-irrigation.html?plan=live' }] },
];
