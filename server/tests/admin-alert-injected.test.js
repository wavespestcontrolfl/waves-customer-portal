// raiserFor: raiseAdminAlert for emitters that take an injected old-shape notifier (alert step E2).
const { raiserFor, ringOnRefreshAfterConversion } = require('../services/admin-alert-injected');

const spec = {
  area: 'Inventory', action: 'log a purchase by hand', why: 'It could not be read, so log it by hand.',
  severity: 'needs-you', link: '/admin/inventory', subject: { type: 'check', id: 'k1' }, doneWhen: 'line_logged_by_hand', who: 'person',
};

describe('raiserFor with an injected notifier', () => {
  test('hands the composed alert to the notifier in the old (category, title, body, opts) shape', async () => {
    const notify = jest.fn(async () => ({ id: 'n1' }));
    const out = await raiserFor(notify)('inventory', spec, { bell: true, dedupeKey: 'k1', detail: 'long text', metadata: { emailId: 'e1' } });
    expect(out).toEqual({ id: 'n1' });
    expect(notify).toHaveBeenCalledWith('inventory', 'Inventory — log a purchase by hand', 'It could not be read, so log it by hand.', {
      bell: true, dedupeKey: 'k1', detail: 'long text', link: '/admin/inventory',
      metadata: { emailId: 'e1', area: 'Inventory', severity: 'needs-you', subject: { type: 'check', id: 'k1' }, doneWhen: 'line_logged_by_hand', who: 'person' },
    });
  });

  test('an fyi writes nothing unless the emitter opts in with fyiRow, and fyiRow never reaches the notifier', async () => {
    const notify = jest.fn(async () => ({ id: 'n2' }));
    const fyi = { ...spec, severity: 'fyi', doneWhen: 'already_done' };
    expect(await raiserFor(notify)('inventory', fyi, {})).toMatchObject({ suppressed: true });
    expect(notify).not.toHaveBeenCalled();
    await raiserFor(notify)('inventory', fyi, { fyiRow: true, bell: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][3]).not.toHaveProperty('fyiRow');
    expect(notify.mock.calls[0][3].metadata).toMatchObject({ severity: 'fyi' });
  });

  test('a spec that breaks the alert rules throws, as it does in the test run', async () => {
    const notify = jest.fn();
    await expect(raiserFor(notify)('inventory', { ...spec, why: 'First sentence. Second sentence.' }, {})).rejects.toMatchObject({ code: 'ADMIN_ALERT_RULE' });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('ringOnRefreshAfterConversion', () => {
  const old = { title: 'Restock: X is low (5 each)', body: 'Reorder 10 each.', link: '/admin/inventory?tab=restock' };
  const ring = ringOnRefreshAfterConversion(old);

  test('an old-format row with the same title, body and link refreshes without ringing', () => {
    expect(ring({ ...old }, {})).toBe(false);
    expect(ring({ ...old }, undefined)).toBe(false);
  });

  test('an old-format row whose title, body or link differs rings, as the old emitter would have', () => {
    expect(ring({ ...old, title: 'Restock: X is low (9 each)' }, {})).toBe(true);
    expect(ring({ ...old, body: 'Reorder 12 each.' }, {})).toBe(true);
    expect(ring({ ...old, link: '/admin/inventory' }, {})).toBe(true);
  });

  test('a row already carrying the composed fields rings on any content change', () => {
    expect(ring({ title: 'a', body: 'b', link: 'c' }, { area: 'Inventory' })).toBe(true);
  });
});
