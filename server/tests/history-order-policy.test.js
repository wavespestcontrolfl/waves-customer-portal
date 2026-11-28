const {
  POLICY_KEY,
  CAPS_LOCK_KEY,
  DEFAULT_POLICY,
  parsePolicy,
  parseItemKey,
  isItemApproved,
  readHistoryOrderPolicy,
  saveHistoryOrderPolicy,
} = require('../services/procurement/history-order-policy');

describe('history-order-policy (unit)', () => {
  test('parsePolicy fails closed on missing, corrupted, or inconsistent JSON', () => {
    expect(parsePolicy(null)).toEqual({ ...DEFAULT_POLICY, approvedItems: [] });
    expect(parsePolicy('')).toEqual({ ...DEFAULT_POLICY, approvedItems: [] });

    for (const bad of [
      '{not-json',
      '[]',
      'null',
      JSON.stringify({ enabled: 'true', approvedItems: ['stickermule:1'], maxPerOrderCents: 35000, maxMonthlyCents: 40000, revision: 1 }),
      JSON.stringify({ enabled: true, approvedItems: [], maxPerOrderCents: 35000, maxMonthlyCents: 40000, revision: 1 }),
      JSON.stringify({ enabled: true, approvedItems: ['stickermule:1'], maxPerOrderCents: null, maxMonthlyCents: 40000, revision: 1 }),
      JSON.stringify({ enabled: true, approvedItems: ['stickermule:1'], maxPerOrderCents: 50000, maxMonthlyCents: 40000, revision: 1 }),
      JSON.stringify({ enabled: true, approvedItems: ['siteone:123'], maxPerOrderCents: 35000, maxMonthlyCents: 40000, revision: 1 }),
      JSON.stringify({ enabled: false, approvedItems: ['stickermule:1'], maxPerOrderCents: 35000, maxMonthlyCents: null, revision: 1 }),
      JSON.stringify({ enabled: false, approvedItems: ['stickermule:1'], maxPerOrderCents: 50, maxMonthlyCents: 40000, revision: 1 }),
      JSON.stringify({ enabled: false, approvedItems: ['stickermule:1'], maxPerOrderCents: null, maxMonthlyCents: null, revision: -1 }),
    ]) {
      const parsed = parsePolicy(bad);
      expect(parsed.enabled).toBe(false);
      expect(parsed.invalid).toBe(true);
      expect(parsed.approvedItems).toEqual([]);
    }
  });

  test('parsePolicy normalizes valid JSON and dedupes/sorts approvedItems', () => {
    const actor = '11111111-1111-4111-8111-111111111111';
    const raw = JSON.stringify({
      enabled: true,
      approvedItems: ['StickerMule:71047955', 'stickermule:71046032', 'stickermule:71047955'],
      maxPerOrderCents: 35000,
      maxMonthlyCents: 80000,
      revision: 3,
      updatedAt: '2026-11-28T06:00:00.000Z',
      updatedBy: actor,
    });
    expect(parsePolicy(raw)).toEqual({
      enabled: true,
      approvedItems: ['stickermule:71046032', 'stickermule:71047955'],
      maxPerOrderCents: 35000,
      maxMonthlyCents: 80000,
      revision: 3,
      updatedAt: '2026-11-28T06:00:00.000Z',
      updatedBy: actor,
      invalid: false,
    });
  });

  test('parseItemKey allows only known history-total adapters and non-whitespace SKUs', () => {
    expect(parseItemKey('stickermule:71046032')).toBe('stickermule:71046032');
    expect(parseItemKey('  StickerMule:71046032  ')).toBe('stickermule:71046032');
    expect(parseItemKey('siteone:D0001')).toBeNull();
    expect(parseItemKey('stickermule:')).toBeNull();
    expect(parseItemKey('stickermule:a b')).toBeNull();
    expect(parseItemKey('stickermule:a,b')).toBeNull();
    expect(parseItemKey(null)).toBeNull();
  });

  test('isItemApproved requires enabled, valid caps, exact item match, and invalid=false', () => {
    const live = {
      enabled: true,
      approvedItems: ['stickermule:71046032'],
      maxPerOrderCents: 35000,
      maxMonthlyCents: 80000,
      revision: 1,
      invalid: false,
    };
    expect(isItemApproved(live, 'stickermule', '71046032')).toBe(true);
    expect(isItemApproved(live, 'stickermule', 71046032)).toBe(true);
    expect(isItemApproved(live, 'stickermule', '71047955')).toBe(false);
    expect(isItemApproved(live, 'siteone', '71046032')).toBe(false);
    expect(isItemApproved({ ...live, enabled: false }, 'stickermule', '71046032')).toBe(false);
    expect(isItemApproved({ ...live, invalid: true }, 'stickermule', '71046032')).toBe(false);
    expect(isItemApproved({ ...live, maxPerOrderCents: 90000 }, 'stickermule', '71046032')).toBe(false);
  });

  test('readHistoryOrderPolicy applies requested row lock and parses stored value', async () => {
    const calls = [];
    const chain = {
      where(w) { calls.push(['where', w]); return this; },
      forShare() { calls.push(['forShare']); return this; },
      forUpdate() { calls.push(['forUpdate']); return this; },
      async first(col) { calls.push(['first', col]); return { value: JSON.stringify({ enabled: false, approvedItems: [], maxPerOrderCents: 35000, maxMonthlyCents: 80000, revision: 2 }) }; },
    };
    const conn = jest.fn(() => chain);
    const p = await readHistoryOrderPolicy(conn, { forShare: true });
    expect(p).toMatchObject({ enabled: false, maxPerOrderCents: 35000, maxMonthlyCents: 80000, revision: 2, invalid: false });
    expect(calls).toContainEqual(['where', { key: POLICY_KEY }]);
    expect(calls).toContainEqual(['forShare']);
  });

  test('saveHistoryOrderPolicy rejects bad inputs before starting a transaction', async () => {
    const conn = { transaction: jest.fn() };
    await expect(saveHistoryOrderPolicy(conn, { enabled: true, approvedItems: ['stickermule:1'], maxPerOrderCents: 35000, maxMonthlyCents: 80000 }, { expectedRevision: -1 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_revision' });
    await expect(saveHistoryOrderPolicy(conn, { enabled: true, approvedItems: [], maxPerOrderCents: 35000, maxMonthlyCents: 80000 }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'items_required' });
    await expect(saveHistoryOrderPolicy(conn, { enabled: true, approvedItems: ['stickermule:1'], maxPerOrderCents: null, maxMonthlyCents: 80000 }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'caps_required' });
    await expect(saveHistoryOrderPolicy(conn, { enabled: true, approvedItems: ['stickermule:1'], maxPerOrderCents: 90000, maxMonthlyCents: 80000 }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_caps' });
    await expect(saveHistoryOrderPolicy(conn, { enabled: false, approvedItems: ['siteone:1'], maxPerOrderCents: null, maxMonthlyCents: null }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_items' });
    expect(conn.transaction).not.toHaveBeenCalled();
    expect(CAPS_LOCK_KEY).toBe('vendor-order-caps');
  });
});
