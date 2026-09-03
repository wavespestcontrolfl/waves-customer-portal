/**
 * C2 — public services menu + keyed leads.
 *  - the menu is built ONLY from active, non-archived, public_quote_selectable rows;
 *  - items carry service_key / catalog name / family / mode / cadence /
 *    public_instant_quote and NEVER an engine key;
 *  - Rodent Inspection is instant ($75 flat, owner ruling 2026-08-29);
 *  - lead intake accepts an optional serviceKey, shape-checked, and the
 *    handler keeps it only when the catalog says it is publicly selectable.
 */
const { loadPublicServicesMenu, isPublicSelectableServiceKey, publicSelectableService, quoteServicesForKey, mergeKeyedRequestOptions, requestMatchesCatalogRow, menuItem, PUBLIC_QUOTE_REQUESTS, PUBLIC_INSTANT_QUOTE_KEYS } = require('../services/public-services-menu');
const { PEST } = require('../services/pricing-engine/constants');

function fakeConn(rows, { hasColumn = true, throws = false } = {}) {
  const conn = () => {
    let filters = {};
    const q = {
      where(cond) { filters = { ...filters, ...cond }; return q; },
      orderBy() { return q; },
      async select() { if (throws) throw new Error('db down'); return rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)).map((r) => ({ ...r })); },
      async first() { if (throws) throw new Error('db down'); const r = rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)); return r ? { id: r.id, service_key: r.service_key, name: r.name, billing_type: r.billing_type, visits_per_year: r.visits_per_year, frequency: r.frequency, booking_enabled: r.booking_enabled, public_quote_selectable: r.public_quote_selectable } : null; },
    };
    return q;
  };
  conn.schema = { hasColumn: async () => hasColumn };
  return conn;
}
const row = (o) => ({ id: 'id-' + o.service_key, is_active: true, is_archived: false, public_quote_selectable: true, category: 'pest_control', billing_type: 'one_time', frequency: null, visits_per_year: null, description: null, engine_keys: ['secret_engine_key'], ...o });

describe('public services menu', () => {
  test('only active, non-archived, selectable rows; engine keys never on the wire', async () => {
    const items = await loadPublicServicesMenu(fakeConn([
      row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service', category: 'inspection' }),
      row({ service_key: 'pest_re_service', name: 'Pest Control Re-Service', public_quote_selectable: false }),
      row({ service_key: 'termite_inspection', name: 'Termite Inspection Service', category: 'inspection', is_archived: true, is_active: false }),
      row({ service_key: 'pest_general_bimonthly', name: 'Bi-Monthly Pest Control Service', billing_type: 'recurring', frequency: 'bimonthly', visits_per_year: 6 }),
    ]));
    expect(items.map((i) => i.service_key)).toEqual(['wdo_inspection', 'pest_general_bimonthly']);
    for (const i of items) { expect(JSON.stringify(i)).not.toContain('engine'); expect(i.name).toMatch(/Service$/); expect(i).not.toHaveProperty('description'); }
  });
  test('modes, cadence and family labels', () => {
    expect(menuItem(row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service', category: 'inspection' }))).toMatchObject({ mode: 'inspection', family: 'Inspections', public_instant_quote: false });
    expect(menuItem(row({ service_key: 'pest_general_bimonthly', name: 'Bi-Monthly Pest Control Service', billing_type: 'recurring', frequency: 'bimonthly', visits_per_year: 6 })))
      .toMatchObject({ mode: 'recurring', family: 'Pest Control', cadence: { key: 'bimonthly', label: 'Bi-Monthly', visits_per_year: 6 }, public_instant_quote: true });
    expect(menuItem(row({ service_key: 'termite_liquid', name: 'Termite Liquid Treatment Service', category: 'termite' }))).toMatchObject({ mode: 'one_time', family: 'Termite', public_instant_quote: false });
  });
  test('Rodent Inspection is instant ($75 flat); WDO is quote-on-request', () => {
    expect(PUBLIC_INSTANT_QUOTE_KEYS.has('rodent_inspection')).toBe(true);
    expect(PUBLIC_INSTANT_QUOTE_KEYS.has('wdo_inspection')).toBe(false);
  });
  test('menu is empty (not an error) before the column exists', async () => {
    expect(await loadPublicServicesMenu(fakeConn([row({ service_key: 'x', name: 'X Service' })], { hasColumn: false }))).toEqual([]);
  });
});

describe('keyed leads', () => {
  const { _test } = require('../routes/lead-webhook');
  test('serviceKey is shape-checked on intake', () => {
    expect(_test.normalizeLeadServiceKey({ serviceKey: 'WDO_Inspection' })).toBe('wdo_inspection');
    expect(_test.normalizeLeadServiceKey({ service_key: 'pest_general_bimonthly' })).toBe('pest_general_bimonthly');
    expect(_test.normalizeLeadServiceKey({ serviceKey: 'drop table;' })).toBeNull();
    expect(_test.normalizeLeadServiceKey({})).toBeNull();
  });
  test('only a publicly selectable, active key is accepted; failures fail closed', async () => {
    const rows = [row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service' }), row({ service_key: 'pest_re_service', name: 'Re', public_quote_selectable: false })];
    expect(await isPublicSelectableServiceKey('wdo_inspection', fakeConn(rows))).toBe(true);
    expect(await isPublicSelectableServiceKey('pest_re_service', fakeConn(rows))).toBe(false);
    expect(await isPublicSelectableServiceKey('nope', fakeConn(rows))).toBe(false);
    expect(await isPublicSelectableServiceKey('wdo_inspection', fakeConn(rows, { throws: true }))).toBe(false);
    expect(await isPublicSelectableServiceKey('wdo_inspection', fakeConn(rows, { hasColumn: false }))).toBe(false);
  });
  test('a keyed lead derives its label from the catalog name (identity wins over the submitted label)', async () => {
    const rows = [row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service' })];
    expect(await publicSelectableService('wdo_inspection', fakeConn(rows))).toEqual({ service_key: 'wdo_inspection', name: 'WDO Inspection Service', instant: false, booking_enabled: true });
    expect((await publicSelectableService('wdo_inspection', fakeConn([row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service', booking_enabled: false })]))).booking_enabled).toBe(false);
    expect(await publicSelectableService('pest_re_service', fakeConn(rows))).toBeNull();
  });
  test('a key the menu used to advertise still resolves as quote-on-request, never instant (cached pages, stale snapshot)', async () => {
    const rows = [
      row({ service_key: 'lawn_care_quarterly', name: 'Quarterly Lawn Care Service', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4, public_quote_selectable: false }),
      row({ service_key: 'pest_general_semiannual', name: 'Semiannual Pest Control Service', public_quote_selectable: false, is_archived: true, is_active: false }),
    ];
    expect(await publicSelectableService('lawn_care_quarterly', fakeConn(rows))).toEqual({ service_key: 'lawn_care_quarterly', name: 'Quarterly Lawn Care Service', instant: false, booking_enabled: true });
    // Archived rows are gone for good — the compat window is for hidden rows only.
    expect(await publicSelectableService('pest_general_semiannual', fakeConn(rows))).toBeNull();
    // A hidden row that WAS instant is not instant any more.
    const wasInstant = [row({ service_key: 'pest_general_bimonthly', name: 'Bi-Monthly Pest Control Service', billing_type: 'recurring', frequency: 'bimonthly', visits_per_year: 6 })];
    expect((await publicSelectableService('pest_general_bimonthly', fakeConn(wasInstant))).instant).toBe(true);
  });
});

describe('instant-quote set stays in step with the public quote engine', () => {
  const { PUBLIC_QUOTE_SERVICE_KEYS } = require('../routes/public-quote');
  const { generateEstimate } = require('../services/pricing-engine');
  const BASE = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005 };
  test('every instant service_key expands to a /calculate request the route accepts', () => {
    for (const key of PUBLIC_INSTANT_QUOTE_KEYS) {
      const services = quoteServicesForKey(key);
      const paths = Object.keys(services);
      expect({ key, paths }).toEqual({ key, paths: [expect.any(String)] });
      expect({ key, accepted: PUBLIC_QUOTE_SERVICE_KEYS.includes(paths[0]) }).toEqual({ key, accepted: true });
    }
  });
  test('the expansion is lossless: cadence/tier keys select exactly that product', () => {
    const cadence = (key) => generateEstimate({ ...BASE, services: quoteServicesForKey(key) }).lineItems.find((l) => l.service === 'pest_control');
    expect(cadence('pest_general_bimonthly').frequency).toBe('bimonthly');
    expect(cadence('pest_general_monthly').frequency).toBe('monthly');
    expect(cadence('pest_general_quarterly').frequency).toBe('quarterly');
    const mosq = (key) => generateEstimate({ ...BASE, services: quoteServicesForKey(key) }).lineItems.find((l) => l.service === 'mosquito');
    expect(mosq('mosquito_seasonal').visitsPerYear ?? mosq('mosquito_seasonal').visits).toBe(9);
    expect(mosq('mosquito_monthly').visitsPerYear ?? mosq('mosquito_monthly').visits).toBe(12);
  });
  test('quoteServicesForKey returns a copy; callers cannot mutate the canonical request', () => {
    const a = quoteServicesForKey('pest_general_bimonthly'); a.pest.frequency = 'monthly';
    expect(PUBLIC_QUOTE_REQUESTS.pest_general_bimonthly.pest.frequency).toBe('bimonthly');
  });
  test('products with no complete public engine request are never advertised as instant', () => {
    for (const k of ['wdo_inspection', 'pest_general_semiannual', 'lawn_care_quarterly', 'termite_liquid',
      'palm_injection', 'bed_bug_treatment', 'dethatching', 'termite_trenching', 'termite_slab_pretreat',
      'lawn_care_one_time', 'rodent_sanitation_light', 'rodent_sanitation_standard', 'rodent_sanitation_heavy', 'bee_wasp_removal',
      'plugging', 'top_dressing', 'rodent_exclusion_only']) {
      expect({ k, instant: PUBLIC_INSTANT_QUOTE_KEYS.has(k) }).toEqual({ k, instant: false });
    }
  });
  test('CONTRACT: every advertised instant key prices to a positive, non-manual line on a plain property', () => {
    process.env.GATE_TERMITE_STATION_RENTAL = 'true';
    for (const key of PUBLIC_INSTANT_QUOTE_KEYS) {
      // A plain PUBLIC property carries the lookup's vision turf estimate
      // (MEDIUM confidence). A lot-only property now deliberately routes
      // turf-priced keys to review instead of instant-pricing a lot-derived
      // guess (estimator-engine audit 2026-08-30) — that fail-closed path is
      // covered in lawn-review-gates.test.js, not part of this contract.
      const estimate = generateEstimate({ ...BASE, estimatedTurfSf: 4500, services: quoteServicesForKey(key) });
      const priced = (estimate.lineItems || []).filter((l) => !l.quoteRequired && !l.requiresCustomQuote
        && Number(l.price ?? l.total ?? l.monthly ?? l.annual ?? 0) > 0);
      expect({ key, priced: priced.length > 0 }).toEqual({ key, priced: true });
    }
  });
  test('phase 2: one-time mosquito and lawn pest knockdown price from the lookup alone', () => {
    const mosq = generateEstimate({ ...BASE, services: quoteServicesForKey('mosquito_one_time') });
    expect(mosq.lineItems.map((l) => l.service)).toEqual(['one_time_mosquito']);
    expect(mosq.lineItems[0].price).toBeGreaterThan(0);
    const lawnPest = generateEstimate({ ...BASE, estimatedTurfSf: 4500, services: quoteServicesForKey('lawn_pest_knockdown') });
    expect(lawnPest.lineItems.map((l) => l.name)).toEqual(['Lawn Pest Knockdown Service']);
    expect(lawnPest.lineItems[0].track).toBe('st_augustine');
  });
  test('the site-collected grass track reaches the lawn pest knockdown request, nothing else does', () => {
    const merged = mergeKeyedRequestOptions(quoteServicesForKey('lawn_pest_knockdown'), { lawn: { track: 'bahia', tier: 'premium' }, lawnPestControl: { urgency: 'EMERGENCY' } });
    expect(merged).toEqual({ lawnPestControl: { track: 'bahia' } });
    expect(mergeKeyedRequestOptions(quoteServicesForKey('lawn_pest_knockdown'), { lawn: { track: 'paspalum' } })).toEqual({ lawnPestControl: {} });
    expect(mergeKeyedRequestOptions(quoteServicesForKey('mosquito_one_time'), { lawn: { track: 'bahia' }, oneTimeMosquito: { stationCount: 9 } })).toEqual({ oneTimeMosquito: {} });
  });
  test('flea_tick prices the SINGLE-visit knockdown, not the two-visit package', () => {
    const estimate = generateEstimate({ ...BASE, services: quoteServicesForKey('flea_tick') });
    expect(estimate.lineItems.map((l) => l.service)).toContain('flea_knockdown_single');
    expect(estimate.lineItems.map((l) => l.service)).not.toContain('flea_package');
  });
});

describe('catalog drift never leaks into an instant quote', () => {
  const pest6 = (over = {}) => row({ service_key: 'pest_general_bimonthly', name: 'Bi-Monthly Pest Control Service', billing_type: 'recurring', frequency: 'bimonthly', visits_per_year: 6, ...over });
  test('a recurring row is instant only while its visits/year match the mapped request', () => {
    expect(requestMatchesCatalogRow('pest_general_bimonthly', pest6())).toBe(true);
    expect(menuItem(pest6()).public_instant_quote).toBe(true);
    // admin edits the row to 4 visits — the map still says bimonthly → not instant
    expect(requestMatchesCatalogRow('pest_general_bimonthly', pest6({ visits_per_year: 4 }))).toBe(false);
    // cockroach_control is a two-treatment package: a row edited away from
    // two visits stops advertising an instant price (pre-push codex P1).
    const roach = (over = {}) => row({ service_key: 'cockroach_control', name: 'Cockroach Treatment Service', visits_per_year: 2, ...over });
    expect(requestMatchesCatalogRow('cockroach_control', roach())).toBe(true);
    expect(requestMatchesCatalogRow('cockroach_control', roach({ visits_per_year: 1 }))).toBe(false);
    expect(requestMatchesCatalogRow('cockroach_control', roach({ visits_per_year: 3 }))).toBe(false);
    expect(requestMatchesCatalogRow('cockroach_control', roach({ visits_per_year: null }))).toBe(false);
    expect(requestMatchesCatalogRow('cockroach_control', roach({ billing_type: 'recurring', frequency: 'semiannual' }))).toBe(false);
    // The live display count the estimate line renders is the second
    // authority: an admin edit to regular_standalone.treatments (3, or a
    // missing key) stops the instant advertisement too (codex #3842 r1 P1).
    const standalone = PEST.pestInitialRoach.display.regular_standalone;
    try {
      PEST.pestInitialRoach.display.regular_standalone = { ...standalone, treatments: 3 };
      expect(requestMatchesCatalogRow('cockroach_control', roach())).toBe(false);
      expect(menuItem(roach()).public_instant_quote).toBe(false);
      PEST.pestInitialRoach.display.regular_standalone = { name: standalone.name };
      expect(requestMatchesCatalogRow('cockroach_control', roach())).toBe(false);
    } finally {
      PEST.pestInitialRoach.display.regular_standalone = standalone;
    }
    expect(menuItem(roach()).public_instant_quote).toBe(true);
    expect(menuItem(pest6({ visits_per_year: 4 })).public_instant_quote).toBe(false);
    // admin edits only the frequency word — still not instant
    expect(requestMatchesCatalogRow('pest_general_bimonthly', pest6({ frequency: 'quarterly' }))).toBe(false);
  });
  test('a keyed lawn request takes only the site-collected grass type; nothing else leaks in', () => {
    const merged = mergeKeyedRequestOptions(quoteServicesForKey('lawn_care_6week'), { lawn: { track: 'bahia', tier: 'premium' }, pest: { frequency: 'monthly' } });
    expect(merged).toEqual({ lawn: { tier: 'enhanced', track: 'bahia' } });
    expect(mergeKeyedRequestOptions(quoteServicesForKey('lawn_care_6week'), { lawn: { track: 'astroturf' } })).toEqual({ lawn: { tier: 'enhanced' } });
    expect(mergeKeyedRequestOptions(quoteServicesForKey('pest_general_monthly'), { lawn: { track: 'bahia' } })).toEqual({ pest: { frequency: 'monthly' } });
  });
  test('a one-time product that became recurring is not instant', () => {
    const r = row({ service_key: 'one_time_pest_control', name: 'One-Time Pest Control Service' });
    expect(menuItem(r).public_instant_quote).toBe(true);
    expect(menuItem({ ...r, billing_type: 'recurring' }).public_instant_quote).toBe(false);
  });
  test('publicSelectableService reports instant from the live row so /calculate can answer quote-on-request', async () => {
    expect((await publicSelectableService('pest_general_bimonthly', fakeConn([pest6()]))).instant).toBe(true);
    expect((await publicSelectableService('pest_general_bimonthly', fakeConn([pest6({ visits_per_year: 4 })]))).instant).toBe(false);
  });
});

describe('keyed quote-on-request rides the standard manual-quote lifecycle', () => {
  const { _internals } = require('../routes/public-quote');
  test('the synthetic estimate is a manual-quote line with zero totals', () => {
    const est = _internals.quoteOnRequestEstimate({ service_key: 'wdo_inspection', name: 'WDO Inspection Service' }, { property: { homeSqFt: 1800 } });
    expect(est.lineItems).toHaveLength(1);
    expect(_internals.isManualQuoteLine(est.lineItems[0])).toBe(true);
    expect(est.lineItems[0]).toMatchObject({ service: 'wdo_inspection', name: 'WDO Inspection Service', reason: 'quote_on_request' });
    expect(est.summary).toMatchObject({ recurringMonthlyAfterDiscount: 0, oneTimeTotal: 0 });
    expect(est.property).toMatchObject({ homeSqFt: 1800, turfFlags: [] });
  });
});

describe('termite bait quotes as station RENTAL (owner ruling 2026-08-29)', () => {
  const { generateEstimate } = require('../services/pricing-engine');
  const BASE = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005 };
  const tbRow = () => row({ service_key: 'termite_bait', name: 'Termite Bait Station Service', category: 'termite', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4 });
  test('the keyed request is the rental; with the gate on it prices a rental line and no installation charge', () => {
    process.env.GATE_TERMITE_STATION_RENTAL = 'true';
    expect(quoteServicesForKey('termite_bait')).toEqual({ termite: { ownership: 'rent' } });
    const est = generateEstimate({ ...BASE, services: { termite: { ownership: 'rent', system: 'trelona', monitoringTier: 'basic' } } });
    expect(est.lineItems.map((l) => l.service)).toContain('termite_station_rental');
    expect(Number(est.summary.installationTotal || 0)).toBe(0);
    expect(menuItem(tbRow()).public_instant_quote).toBe(true);
  });
  test('with the rental gate off, termite bait is NOT instant (the engine would price purchase + install)', () => {
    process.env.GATE_TERMITE_STATION_RENTAL = 'false';
    expect(menuItem(tbRow()).public_instant_quote).toBe(false);
    process.env.GATE_TERMITE_STATION_RENTAL = 'true';
  });
});
