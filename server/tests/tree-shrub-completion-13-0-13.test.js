/**
 * The full completion form's Tree & Shrub defaults for LESCO 13-0-13 (labels read 2026-10-22). The visit's
 * completionDefaultProducts names the exact catalog row with treeShrubKey f13013, and the resolver passes it through the
 * same due/held path as the palm feed (filterTreeShrubDefaults): at most 2 in 12 months, 5 calendar months apart, none June
 * 1 to Sept. 30. A suggestion never carries an amount (owner ruling 2026-10-01).
 */
const { resolveCompletionProductDefaults } = require('../services/completion-product-defaults');
const { filterTreeShrubDefaults } = require('../services/tree-shrub-completion-defaults');
const protocols = require('../config/protocols.json');

const ORN = 'LESCO 13-0-13 60% PolyPlus Landscape';
const PALM = 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer (#511542)';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WITH_ORN = ['Feb', 'Mar', 'Apr', 'May', 'Oct', 'Nov', 'Dec'];

// A fake knex for exactly the chains the resolver and filterTreeShrubDefaults call; synthetic rows only.
function fakeDb({ scheduled, history = [], failHistory = false, property }) {
  const catalog = [
    { id: 'snap', name: 'Snapshot 2.5TG', category: 'herbicide', active: true },
    { id: 'palm', name: PALM, category: 'fertilizer', active: true },
    { id: 'palm16', name: 'LESCO 0-0-16 Palm & Tropical Ornamental Fertilizer (#510513)', category: 'fertilizer', active: true },
    { id: 'orn', name: ORN, category: 'fertilizer', application_method: null, default_rate_per_1000: null, rate_unit: 'lb', active: true },
  ];
  const aliases = [
    { product_id: 'palm', alias_name: 'LESCO 8-0-12 #511542' },
    { product_id: 'palm16', alias_name: 'LESCO 0-0-16 #510513' },
  ];
  return (table) => {
    const q = {
      where() { return q; },
      whereNull() { return q; },
      whereIn() { return q; },
      leftJoin() { return q; },
      first() { return Promise.resolve(table === 'scheduled_services' ? scheduled : table === 'customer_properties' ? property : undefined); },
      select() {
        if (table === 'property_application_history as history') return failHistory ? Promise.reject(new Error('down')) : Promise.resolve(history);
        if (table === 'products_catalog') return Promise.resolve(catalog);
        if (table === 'product_aliases') return Promise.resolve(aliases);
        return Promise.resolve([]);
      },
    };
    return q;
  };
}

const visitOn = (date) => ({ id: 'svc-1', customer_id: 'cust-1', property_id: 'prop-1', service_id: null, service_type: 'Tree & Shrub Care', service_key_snapshot: null, scheduled_date: date, followup_source_service_id: null });
const applied = (product_name, application_date, extra = {}) => ({ product_name, application_date, ledger_property_id: 'prop-1', property_id: 'prop-1', application_rate: 7.5, rate_unit: 'lb', ...extra });

async function resolveOn(date, history = [], extra = {}) {
  process.env.GATE_TREE_SHRUB_FIELD_GUIDE = 'true';
  return resolveCompletionProductDefaults({ db: fakeDb({ scheduled: visitOn(date), history, ...extra }), serviceId: 'svc-1' });
}
afterEach(() => { delete process.env.GATE_TREE_SHRUB_FIELD_GUIDE; });

describe('the protocol lists 13-0-13 as a keyed default', () => {
  test('Feb to May and Oct to Dec name the exact catalog row with treeShrubKey f13013, after the palm feed; other months do not', () => {
    for (const visit of protocols.tree_shrub.visits) {
      const entries = visit.completionDefaultProducts;
      const orn = entries.filter((entry) => entry.treeShrubKey === 'f13013');
      if (!WITH_ORN.includes(visit.month)) { expect([visit.month, orn]).toEqual([visit.month, []]); continue; }
      expect([visit.month, orn]).toEqual([visit.month, [{ name: ORN, treeShrubKey: 'f13013' }]]);
      expect(entries.map((entry) => entry.treeShrubKey)).toEqual(['snapshot', 'f8012', 'f13013']);
    }
  });
});

describe('resolveCompletionProductDefaults for a Tree & Shrub visit', () => {
  test.each(WITH_ORN)('%s with no history: 13-0-13 is a dose-selection suggestion with no amount', async (month) => {
    const date = `2028-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-10`;
    const result = await resolveOn(date);
    expect(result.error).toBeUndefined();
    expect(result.holds).toEqual([]);
    expect(result.products.map((row) => row.treeShrubKey)).toEqual(['snapshot', 'f8012', 'f13013']);
    const orn = result.products.find((row) => row.treeShrubKey === 'f13013');
    expect(orn).toMatchObject({ id: 'orn', name: ORN, requiresDoseSelection: true });
    expect(orn.protocolAmount).toBeUndefined();
  });

  test('January and the summer months do not offer it', async () => {
    for (const date of ['2028-01-10', '2028-06-10', '2028-07-10', '2028-09-10']) {
      expect((await resolveOn(date)).products.map((row) => row.treeShrubKey)).not.toContain('f13013');
    }
  });

  test('held when the last 13-0-13 was under five months ago; the other suggestions still show', async () => {
    const result = await resolveOn('2028-04-10', [applied(ORN, '2028-02-20')]);
    expect(result.products.map((row) => row.treeShrubKey)).toEqual(['snapshot', 'f8012']);
    expect(result.holds).toEqual([{ name: ORN, reason: 'The last 13-0-13 application was less than five months ago.' }]);
  });

  test('offered again once five months have passed, and a recent palm feed does not hold it', async () => {
    const result = await resolveOn('2028-10-10', [applied(ORN, '2028-04-12'), applied('LESCO 0-0-16 #510513', '2028-09-20')]);
    expect(result.products.map((row) => row.treeShrubKey)).toEqual(['snapshot', 'f13013']);
    expect(result.holds).toEqual([expect.objectContaining({ reason: 'The last palm feeding was less than three months ago.' })]);
  });

  test('held when two are already recorded in the past 12 months', async () => {
    const result = await resolveOn('2029-02-10', [applied(ORN, '2028-04-12'), applied(ORN, '2028-10-20')]);
    expect(result.holds).toContainEqual({ name: ORN, reason: 'Two 13-0-13 applications are already recorded in the past year.' });
    expect(result.products.map((row) => row.treeShrubKey)).not.toContain('f13013');
  });

  test('an unreadable history fails closed for the whole list', async () => {
    const result = await resolveOn('2028-04-10', [], { failHistory: true });
    expect(result.products).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});

describe('the property\'s ordinance zone decides the June to September hold on the full form', () => {
  const july = '2028-07-10';
  const offered = (result) => result.products.map((row) => row.treeShrubKey).includes('f13013');
  // The July card carries no 13-0-13 line, so the zone is judged through the resolver with a card month that does
  // (the due rule is the same whatever the card): filterTreeShrubDefaults with a keyed entry.
  const filter = (property) => filterTreeShrubDefaults({
    db: fakeDb({ scheduled: null }), scheduled: { ...visitOn(july), ...property }, entries: [{ name: ORN, treeShrubKey: 'f13013' }],
  });
  test('North Port: not held (landscape plants are outside the blackout)', async () => {
    const out = await filter({ city: 'North Port' });
    expect(out.holds).toEqual([]);
    expect(out.entries).toHaveLength(1);
  });
  test('Sarasota and an unknown zone are held', async () => {
    for (const property of [{ city: 'Sarasota' }, { city: 'Venice' }, { city: 'Parrish' }, {}, { city: 'Somewhere Else' }]) {
      expect((await filter(property)).holds).toEqual([{ name: ORN, reason: '13-0-13 holds nitrogen, so it is not allowed June 1 to September 30.' }]);
    }
  });
  test('an explicit zone wins over the visit row', async () => {
    const out = await filterTreeShrubDefaults({ db: fakeDb({ scheduled: null }), scheduled: visitOn(july), entries: [{ name: ORN, treeShrubKey: 'f13013' }], zone: 'north_port' });
    expect(out.holds).toEqual([]);
  });
  test('the resolver reads the property city for the zone and falls back to the conservative rule when it cannot', async () => {
    process.env.GATE_TREE_SHRUB_FIELD_GUIDE = 'true';
    const run = (property) => resolveCompletionProductDefaults({ db: fakeDb({ scheduled: visitOn('2028-10-10'), property }), serviceId: 'svc-1' });
    // October is outside the blackout in every zone: the line is offered whatever the property says.
    expect(offered(await run({ city: 'North Port', address_line1: '1 Synthetic Rd' }))).toBe(true);
    expect(offered(await run(undefined))).toBe(true);
  });
});

describe('an unidentified application only holds the list while it is inside the 12-month window', () => {
  const unidentified = (date) => ({ product_name: null, catalog_name: null, application_date: date, property_id: 'prop-1', ledger_property_id: 'prop-1' });
  test('older than 12 months: ignored; recent or undated: everything is held for review', async () => {
    expect((await resolveOn('2028-10-10', [unidentified('2026-05-01')])).holds).toEqual([]);
    for (const date of ['2028-03-01', null]) {
      const result = await resolveOn('2028-10-10', [unidentified(date)]);
      expect(result.products).toEqual([]);
      expect(result.holds.every((hold) => hold.reason === 'Review an application with an unidentified product.')).toBe(true);
    }
  });
});

describe('filterTreeShrubDefaults holds 13-0-13 in the blackout whatever the card says', () => {
  test('a June to September visit date is held', async () => {
    for (const date of ['2028-06-01', '2028-08-15', '2028-09-30']) {
      const out = await filterTreeShrubDefaults({
        db: fakeDb({ scheduled: null }), scheduled: visitOn(date), entries: [{ name: ORN, treeShrubKey: 'f13013' }],
      });
      expect(out.entries).toEqual([]);
      expect(out.holds).toEqual([{ name: ORN, reason: '13-0-13 holds nitrogen, so it is not allowed June 1 to September 30.' }]);
    }
    const open = await filterTreeShrubDefaults({ db: fakeDb({ scheduled: null }), scheduled: visitOn('2028-10-01'), entries: [{ name: ORN, treeShrubKey: 'f13013' }] });
    expect(open.holds).toEqual([]);
    expect(open.entries).toHaveLength(1);
  });
});
