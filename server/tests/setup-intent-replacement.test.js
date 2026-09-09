// Shared SetupIntent retirement vocabulary (estimate accept, secure-card
// visit lane, standalone Auto Pay link).
const {
  MAX_REPLACEMENT_HOPS,
  isRetiredSetupIntent,
  isStripeResourceMissing,
  followReplacementChain,
} = require('../services/setup-intent-replacement');

const fam = (id, extra = {}) => ({ id, status: 'requires_payment_method', metadata: { purpose: 'p', request_id: 'r1', ...extra } });
const retired = (id, replacedBy, extra = {}) => fam(id, { retired: 'true', ...(replacedBy ? { replaced_by: replacedBy } : {}), ...extra });
const belongs = (si) => si?.metadata?.purpose === 'p' && si?.metadata?.request_id === 'r1';
const readerOver = (map) => async (id) => map[id] || null;

describe('isRetiredSetupIntent / isStripeResourceMissing', () => {
  test('reads the Stripe metadata stamp only', () => {
    expect(isRetiredSetupIntent(retired('a'))).toBe(true);
    expect(isRetiredSetupIntent(fam('a', { retired: 'false' }))).toBe(false);
    expect(isRetiredSetupIntent(null)).toBe(false);
  });
  test('resource_missing / 404 only', () => {
    expect(isStripeResourceMissing({ code: 'resource_missing' })).toBe(true);
    expect(isStripeResourceMissing({ statusCode: 404 })).toBe(true);
    expect(isStripeResourceMissing(new Error('down'))).toBe(false);
  });
});

describe('followReplacementChain', () => {
  test('follows replaced_by to the live head; a non-retired intent is returned as-is', async () => {
    const map = { b: retired('b', 'c'), c: fam('c') };
    expect((await followReplacementChain(retired('a', 'b'), readerOver(map), belongs)).id).toBe('c');
    expect((await followReplacementChain(fam('a'), readerOver({}), belongs)).id).toBe('a');
  });

  test('null on a broken chain, a canceled head, or a head that is itself retired at the hop cap', async () => {
    expect(await followReplacementChain(retired('a', null), readerOver({}), belongs)).toBeNull();
    expect(await followReplacementChain(retired('a', 'gone'), readerOver({}), belongs)).toBeNull();
    expect(await followReplacementChain(retired('a', 'b'), readerOver({ b: { ...fam('b'), status: 'canceled' } }), belongs)).toBeNull();
    const map = {};
    for (let i = 0; i <= MAX_REPLACEMENT_HOPS + 1; i += 1) map[`s${i}`] = retired(`s${i}`, `s${i + 1}`);
    expect(await followReplacementChain(map.s0, readerOver(map), belongs)).toBeNull();
  });

  test('refuses a head outside the caller\'s capture family', async () => {
    const foreignHead = { id: 'x', status: 'requires_payment_method', metadata: { purpose: 'p', request_id: 'OTHER' } };
    expect(await followReplacementChain(retired('a', 'x'), readerOver({ x: foreignHead }), belongs)).toBeNull();
  });

  // GH Codex #4163 r1: ownership is judged on EVERY hop. A chain that
  // leaves the family through a foreign intermediate and links back must
  // stop at the foreign link — the read for anything past it never happens.
  test('stops at a foreign INTERMEDIATE link even when the chain returns to the family', async () => {
    const foreignMid = { id: 'f', status: 'succeeded', metadata: { purpose: 'other', request_id: 'r1', retired: 'true', replaced_by: 'c' } };
    const reads = [];
    const reader = async (id) => { reads.push(id); return ({ f: foreignMid, c: fam('c') })[id] || null; };
    expect(await followReplacementChain(retired('a', 'f'), reader, belongs)).toBeNull();
    expect(reads).toEqual(['f']);
    // The starting intent itself is judged too.
    expect(await followReplacementChain({ ...retired('z', 'c'), metadata: { ...retired('z', 'c').metadata, request_id: 'OTHER' } }, reader, belongs)).toBeNull();
  });
});
