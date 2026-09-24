// Follow-ups to #4741 (owner "do the follow up", 2026-09-24).
const { confirmFirstVisitUnderLock } = require('../services/pest-pressure/first-visit');
const { activityScaleNames, DEFAULT_ACTIVITY_SCALE } = require('../services/pest-pressure/label');
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const { buildPrompt } = require('../services/completion-recap');

function fakeTrx(priorRow) {
  const calls = { raw: [], order: [] };
  const builder = {
    where: jest.fn((arg) => {
      if (typeof arg === 'function') {
        const nested = { where: jest.fn(() => nested), orWhereNull: jest.fn(() => nested) };
        arg.call(nested);
      }
      return builder;
    }),
    whereRaw: jest.fn(() => builder),
    first: jest.fn(async () => { calls.order.push('history'); return priorRow; }),
  };
  const trx = jest.fn(() => builder);
  trx.raw = jest.fn(async (sql, bindings) => { calls.order.push('lock'); calls.raw.push({ sql, bindings }); });
  return { trx, calls };
}

describe('confirmFirstVisitUnderLock', () => {
  test('locks the customer/line before re-reading history', async () => {
    const { trx, calls } = fakeTrx(undefined);
    await expect(confirmFirstVisitUnderLock(trx, { customerId: 'c1', serviceLine: 'pest' })).resolves.toBe(true);
    expect(calls.order).toEqual(['lock', 'history']);
    expect(calls.raw[0].sql).toMatch(/pg_advisory_xact_lock/);
    expect(calls.raw[0].bindings).toEqual(['pest-first-visit', 'c1:pest']);
  });

  test('a visit committed first means this one is no longer the first', async () => {
    const { trx } = fakeTrx({ id: 'sr-committed-first' });
    await expect(confirmFirstVisitUnderLock(trx, { customerId: 'c1', serviceLine: 'pest' })).resolves.toBe(false);
  });

  test('no customer never confirms', async () => {
    const { trx } = fakeTrx(undefined);
    await expect(confirmFirstVisitUnderLock(trx, { customerId: null, serviceLine: 'pest' })).resolves.toBe(false);
    expect(trx.raw).not.toHaveBeenCalled();
  });
});

describe('activityScaleNames', () => {
  test('default labels give the six-band scale', () => {
    expect(activityScaleNames(DEFAULT_CONFIG.labels)).toEqual(['none', 'very low', 'low', 'moderate', 'elevated', 'high']);
  });

  test('a customized label set names each rating by its band', () => {
    const labels = [
      { key: 'calm', name: 'Calm', min: 0, max: 2.4 },
      { key: 'busy', name: 'Busy', min: 2.5, max: 4.4 },
      { key: 'severe', name: 'Severe', min: 4.5, max: 5 },
    ];
    expect(activityScaleNames(labels)).toEqual(['calm', 'calm', 'calm', 'busy', 'busy', 'severe']);
  });

  test('missing labels fall back to the default names', () => {
    expect(activityScaleNames(null)).toEqual([...DEFAULT_ACTIVITY_SCALE]);
  });
});

describe('completion recap prompt uses the active scale', () => {
  test('default scale when the caller has none', () => {
    const prompt = buildPrompt({ serviceType: 'Quarterly Pest Control Service', pestActivityRating: 4 });
    expect(prompt).toMatch(/on a 0 \(none\) to 5 \(high\) scale: 4 \(elevated\)/);
  });

  test('customized scale names flow into the prompt', () => {
    const prompt = buildPrompt({
      serviceType: 'Quarterly Pest Control Service',
      pestActivityRating: 5,
      pestActivityScale: ['calm', 'calm', 'calm', 'busy', 'busy', 'severe'],
    });
    expect(prompt).toMatch(/on a 0 \(calm\) to 5 \(severe\) scale: 5 \(severe\)/);
  });
});
