/**
 * Weekly buy list alerts (procurement/weekly-buy-alert.js): the alert text, one
 * per technician with something to say, the Monday-to-Saturday life of each
 * alert (raise, ring again only on growth, refresh quietly, close, end of week),
 * and a failure that surfaces. A fake notifier and a fake alert store stand in
 * for the notification service; the SQL of the real store is in
 * weekly-buy-alert-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { runWeeklyBuyList, specFor, detailFor, whyFor, growth } = require('../services/procurement/weekly-buy-alert');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const item = (over = {}) => ({
  productId: 'p1', name: 'Synthetic Liquid', needQty: 3.1, unit: 'gal', onHand: 1.2, shortQty: 1.9,
  packs: 1, packLabel: '2.5 gal', estCostCents: 10700, vendorName: 'Synthetic Supply', reasons: ['lawn_plan'], ...over,
});
const entry = (over = {}) => ({
  technicianId: 'tech-a', technicianName: 'Alex Sample', supplyStore: 'Synthetic Supply North',
  items: [item()], estTotalCents: 10700, notes: [], warnings: [], ...over,
});
const empty = { technicianId: null, technicianName: null, supplyStore: null, items: [], estTotalCents: null, notes: [], warnings: [] };
const listOf = (technicians, over = {}) => ({ weekStart: '2026-12-07', weekEnd: '2026-12-12', fromDate: '2026-12-07', technicians, unassigned: empty, warnings: [], ...over });

// A fake alert store: rows by key, plus the open keys the sync closes.
function fakeIo({ standing = {}, open = [] } = {}) {
  const closed = [];
  return {
    closed,
    standing: jest.fn(async (key) => standing[key] || null),
    openKeys: jest.fn(async () => open),
    close: jest.fn(async (keys, reason) => { closed.push([keys, reason]); return keys.length; }),
  };
}
const notifier = () => jest.fn(async () => ({ id: 'n1' }));
const stated = (items, extra = {}) => ({ open: true, cleared: false, weeklyBuy: { signature: 'old', items, ...extra } });

describe('alert text', () => {
  test('a synthetic week reads as one headline, one sentence and a full body', () => {
    const list = listOf([entry({ notes: ['Synthetic Liquid: stock not counted, treated as none on hand.'], warnings: ['1 lawn visit has no lawn plan'] })]);
    const { spec, key } = specFor(list.technicians[0], list);
    const composed = composeAdminAlert(spec); // throws when the headline or why break the alert rules
    expect(key).toBe('weekly-buy:tech-a:2026-12-07');
    expect(composed.headline).toBe("Inventory — buy Alex's supplies, week of Dec 7");
    expect(composed.why).toBe('1 product to buy at Synthetic Supply North, about $107.00; 1 to check.');
    expect(detailFor(list.technicians[0], list)).toBe([
      'Store: Synthetic Supply North',
      'Week: Dec 7 to Dec 12',
      '1 x 2.5 gal Synthetic Liquid (need 3.1 gal, on hand 1.2 gal)',
      'Estimated total: $107.00',
      'Notes:',
      '- Synthetic Liquid: stock not counted, treated as none on hand.',
      'Check:',
      '- 1 lawn visit has no lawn plan',
    ].join('\n'));
  });

  test('a recheck says where its count starts; a held, unpriced and spare-floor line each read plainly', () => {
    const group = entry({ items: [
      item({ name: 'Held Fert', packs: 0, packLabel: null, estCostCents: null, unit: 'lb', needQty: 60, onHand: 0, shortQty: 60 }),
      item({ productId: 'p2', name: 'No Price', packs: null, packLabel: null, estCostCents: null, shortQty: 4, needQty: 4, onHand: 0 }),
      item({ productId: 'p3', name: 'House Liquid', packs: 2, packLabel: '1 gal', reasons: ['pest_mix', 'spare_floor'] }),
    ] });
    const text = detailFor(group, listOf([group], { fromDate: '2026-12-09' }));
    expect(text).toContain('Week: Dec 7 to Dec 12, counted from Dec 9');
    expect(text).toContain('HOLD Held Fert: short 60 lb (need 60 lb, on hand 0 lb); N/P fertilizer blackout, not bought');
    expect(text).toContain('No Price: buy about 4 gal, no pack or price on file (need 4 gal, on hand 0 gal)');
    expect(text).toContain('2 x 1 gal House Liquid (need 3.1 gal, on hand 1.2 gal, includes one spare container)');
  });

  test('the headline fits 60 characters for a long first name and for unassigned visits; the sentence fits 110', () => {
    const long = entry({ technicianName: 'Maximilianoalexandrovich Sample', supplyStore: 'A Synthetic Supply Store With A Very Long Branch Name Nobody Would Type' });
    for (const group of [long, { ...empty, items: [item()], estTotalCents: 5 }]) {
      const list = listOf([group]);
      const composed = composeAdminAlert(specFor(group, list).spec);
      expect(composed.headline.length).toBeLessThanOrEqual(60);
      expect(whyFor(group).length).toBeLessThanOrEqual(110);
    }
    expect(specFor({ ...empty, items: [item()] }, listOf([])).key).toBe('weekly-buy:unassigned:2026-12-07');
  });

  test('a store name that would break the alert rules is left out of the sentence, not the body', () => {
    const group = entry({ supplyStore: 'Synthetic Supply Inc. North Branch' });
    expect(whyFor(group)).not.toMatch(/Inc\./);
    expect(detailFor(group, listOf([group]))).toContain('Store: Synthetic Supply Inc. North Branch');
  });
});

describe('Monday run', () => {
  test('raises one alert for each technician with something to buy or a warning, none for an empty one', async () => {
    const notify = notifier();
    const io = fakeIo();
    const list = listOf([
      entry(), entry({ technicianId: 'tech-b', technicianName: 'Blake Sample', items: [], estTotalCents: null, warnings: ['2 visits of types this list does not plan yet'] }),
      entry({ technicianId: 'tech-c', technicianName: 'Casey Sample', items: [], estTotalCents: null }),
    ]);
    const result = await runWeeklyBuyList({ list, io, notify });
    expect(result).toMatchObject({ weekStart: '2026-12-07', raised: 2, unchanged: 0, closed: 0 });
    expect(notify).toHaveBeenCalledTimes(2);
    const [category, title, why, opts] = notify.mock.calls[0];
    expect(category).toBe('system');
    expect(title).toBe("Inventory — buy Alex's supplies, week of Dec 7");
    expect(why).toMatch(/1 product to buy/);
    expect(opts).toMatchObject({
      bell: true, dedupeKey: 'weekly-buy:tech-a:2026-12-07', refreshOnDedupe: true, link: '/admin/inventory?tab=restock',
      metadata: { subject: { type: 'check', id: 'weekly-buy:tech-a:2026-12-07' }, doneWhen: 'supplies_bought', who: 'person', weeklyBuy: { weekStart: '2026-12-07', technicianId: 'tech-a', items: [{ productId: 'p1', packs: 1, shortQty: 1.9 }] } },
    });
    expect(opts.ringOnRefresh()).toBe(true);
    expect(notify.mock.calls[1][3].dedupeKey).toBe('weekly-buy:tech-b:2026-12-07');
  });

  test('nothing to buy and no warning: no alert at all', async () => {
    const notify = notifier();
    const result = await runWeeklyBuyList({ list: listOf([entry({ items: [], estTotalCents: null })]), io: fakeIo(), notify });
    expect(notify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ raised: 0, closed: 0 });
  });

  test('closes the alerts of earlier weeks', async () => {
    const io = fakeIo({ open: ['weekly-buy:tech-a:2026-11-30', 'weekly-buy:unassigned:2026-11-30', 'weekly-buy:tech-a:2026-12-07'] });
    const result = await runWeeklyBuyList({ list: listOf([entry()]), io, notify: notifier() });
    expect(io.closed).toEqual([[['weekly-buy:tech-a:2026-11-30', 'weekly-buy:unassigned:2026-11-30'], 'week_over']]);
    expect(result.closed).toBe(2);
  });

  test('a rerun with the same list does nothing', async () => {
    const group = entry();
    const first = notifier();
    await runWeeklyBuyList({ list: listOf([group]), io: fakeIo(), notify: first });
    const sent = first.mock.calls[0][3].metadata.weeklyBuy;
    const second = notifier();
    const result = await runWeeklyBuyList({ list: listOf([group]), io: fakeIo({ standing: { 'weekly-buy:tech-a:2026-12-07': { open: true, cleared: false, weeklyBuy: sent } } }), notify: second });
    expect(second).not.toHaveBeenCalled();
    expect(result.unchanged).toBe(1);
  });
});

describe('daily recheck', () => {
  const KEY = 'weekly-buy:tech-a:2026-12-07';
  const priorItems = [{ productId: 'p1', packs: 1, shortQty: 1.9 }];
  const recheck = (group, standing) => {
    const notify = notifier();
    const io = fakeIo({ standing: { [KEY]: standing }, open: [KEY] });
    return runWeeklyBuyList({ list: listOf([group], { fromDate: '2026-12-09' }), io, notify }).then((result) => ({ result, notify, io }));
  };

  test('more packs than last stated: the alert updates and rings again', async () => {
    const { result, notify } = await recheck(entry({ items: [item({ packs: 2, shortQty: 3.5 })] }), stated(priorItems));
    expect(result.rang_again).toBe(1);
    expect(notify.mock.calls[0][3].ringOnRefresh()).toBe(true);
  });

  test('a new short product: rings again', async () => {
    const { result, notify } = await recheck(entry({ items: [item(), item({ productId: 'p2', name: 'Second Liquid' })] }), stated(priorItems));
    expect(result.rang_again).toBe(1);
    expect(notify.mock.calls[0][3].ringOnRefresh()).toBe(true);
  });

  test('the same list: nothing is written and nothing rings', async () => {
    const group = entry();
    const raised = notifier();
    await runWeeklyBuyList({ list: listOf([group]), io: fakeIo(), notify: raised });
    const { result, notify } = await recheck(group, { open: true, cleared: false, weeklyBuy: raised.mock.calls[0][3].metadata.weeklyBuy });
    expect(notify).not.toHaveBeenCalled();
    expect(result.unchanged).toBe(1);
  });

  test('fewer packs than last stated: the text updates quietly, no ring', async () => {
    const { result, notify } = await recheck(entry({ items: [item({ packs: 1, shortQty: 0.4 })] }), stated([{ productId: 'p1', packs: 2, shortQty: 3.5 }]));
    expect(result.refreshed).toBe(1);
    expect(notify.mock.calls[0][3].ringOnRefresh()).toBe(false);
  });

  test('nothing short any more: the alert closes', async () => {
    const { result, io, notify } = await recheck(entry({ items: [], estTotalCents: null }), stated(priorItems));
    expect(notify).not.toHaveBeenCalled();
    expect(io.closed).toEqual([[[KEY], 'count_zero']]);
    expect(result.closed).toBe(1);
  });

  test('a person\'s Done on a standing list stays done; growth brings it back', async () => {
    const done = { open: false, cleared: false, weeklyBuy: { signature: 'old', items: priorItems } };
    expect((await recheck(entry(), done)).notify).not.toHaveBeenCalled();
    const grown = await recheck(entry({ items: [item({ packs: 3, shortQty: 6 })] }), done);
    expect(grown.notify).toHaveBeenCalledTimes(1);
    expect(grown.notify.mock.calls[0][3].ringOnRefresh()).toBe(true);
  });

  test('an alert this module closed (nothing was short) rings as a comeback when something is short again', async () => {
    const { result, notify } = await recheck(entry(), { open: false, cleared: true, weeklyBuy: { signature: 'old', items: [] } });
    expect(result.raised).toBe(1);
    expect(notify.mock.calls[0][3].ringOnRefresh()).toBe(true);
  });

  test('growth compares what was stated: packs, or the short amount when no pack could be read', () => {
    expect(growth(entry(), priorItems)).toBe(false);
    expect(growth(entry(), [])).toBe(true);
    expect(growth(entry({ items: [item({ packs: null, shortQty: 5 })] }), [{ productId: 'p1', packs: null, shortQty: 4 }])).toBe(true);
    expect(growth(entry({ items: [item({ packs: null, shortQty: 4 })] }), [{ productId: 'p1', packs: null, shortQty: 4 }])).toBe(false);
  });
});

describe('failures surface', () => {
  test('an alert that did not persist fails the run after the other alerts are tried', async () => {
    const notify = jest.fn(async (_c, _t, _w, opts) => (opts.dedupeKey.includes('tech-a') ? null : { id: 'n2' }));
    const list = listOf([entry(), entry({ technicianId: 'tech-b', technicianName: 'Blake Sample' })]);
    await expect(runWeeklyBuyList({ list, io: fakeIo(), notify })).rejects.toThrow(/weekly-buy:tech-a:2026-12-07: weekly buy list alert not persisted/);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('a notifier that throws fails the run', async () => {
    await expect(runWeeklyBuyList({ list: listOf([entry()]), io: fakeIo(), notify: jest.fn(async () => { throw new Error('notify down'); }) })).rejects.toThrow(/notify down/);
  });
});
