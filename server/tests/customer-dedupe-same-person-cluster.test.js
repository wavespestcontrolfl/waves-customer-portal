/**
 * resolveSamePersonCluster — the public quote wizard's "this phone matches the
 * same person twice" resolver. Returns the nightly sweep's winner when every
 * row is live, one person at one premise, and matches the typed contact;
 * anything else returns null (a shared household line is never one person).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolveSamePersonCluster } = require('../services/customer-dedupe');

// counts: { invoices: { 'row-id': 3 } } -> grouped counts batchAutoBlockers reads.
function fakeDb(counts = {}) {
  return (table) => {
    const chain = {
      whereIn: () => chain,
      groupBy: () => chain,
      select: () => chain,
      count: async () => Object.entries(counts[table] || {}).map(([customer_id, n]) => ({ customer_id, n })),
    };
    return chain;
  };
}

const TYPED = {
  first_name: 'Jane', last_name: 'Sample', address_line1: '123 Sample St', address_line2: null, city: 'Parrish', zip: '34219',
};
const row = (id, over = {}) => ({
  id,
  first_name: 'Jane',
  last_name: 'Sample',
  address_line1: '123 Sample Street',
  address_line2: null,
  city: 'Parrish',
  zip: '34219',
  pipeline_stage: 'new_lead',
  stripe_customer_id: null,
  password_hash: null,
  active: true,
  deleted_at: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

describe('resolveSamePersonCluster', () => {
  test('two same-person rows at the typed address resolve to the older row', async () => {
    const older = row('a', { created_at: '2026-09-01T00:00:00Z' });
    const newer = row('b', { created_at: '2026-10-29T00:00:00Z' });
    expect((await resolveSamePersonCluster(fakeDb(), [newer, older], TYPED)).id).toBe('a');
  });

  test('a row with business history beats an older bare shell', async () => {
    const shell = row('shell', { created_at: '2026-01-01T00:00:00Z' });
    const billed = row('billed', { created_at: '2026-10-01T00:00:00Z' });
    const winner = await resolveSamePersonCluster(fakeDb({ invoices: { billed: 2 } }), [shell, billed], TYPED);
    expect(winner.id).toBe('billed');
  });

  test('equal business weight keeps the older row', async () => {
    const counts = { invoices: { a: 1, b: 1 } };
    const winner = await resolveSamePersonCluster(
      fakeDb(counts),
      [row('b', { created_at: '2026-10-02T00:00:00Z' }), row('a', { created_at: '2026-10-01T00:00:00Z' })],
      TYPED,
    );
    expect(winner.id).toBe('a');
  });

  test('a name conflict between the rows returns null', async () => {
    expect(await resolveSamePersonCluster(fakeDb(), [row('a'), row('b', { first_name: 'Joan' })], TYPED)).toBeNull();
  });

  test('a row that conflicts with the typed name returns null', async () => {
    expect(await resolveSamePersonCluster(fakeDb(), [row('a'), row('b')], { ...TYPED, first_name: 'Pat' })).toBeNull();
  });

  test('one row at another street returns null', async () => {
    expect(await resolveSamePersonCluster(fakeDb(), [row('a'), row('b', { address_line1: '9 Other Ave' })], TYPED)).toBeNull();
  });

  test('a different unit returns null', async () => {
    const rows = [row('a', { address_line1: '123 Sample St Apt 1' }), row('b', { address_line1: '123 Sample St Apt 2' })];
    expect(await resolveSamePersonCluster(fakeDb(), rows, { ...TYPED, address_line1: '123 Sample St' })).toBeNull();
  });

  test('a typed address that differs from the rows returns null', async () => {
    expect(await resolveSamePersonCluster(fakeDb(), [row('a'), row('b')], { ...TYPED, address_line1: '77 Elm Ct' })).toBeNull();
  });

  test('a row with no address cannot prove the premise and returns null', async () => {
    expect(await resolveSamePersonCluster(fakeDb(), [row('a'), row('b', { address_line1: '' })], TYPED)).toBeNull();
  });

  test('fewer than 2 or more than 10 rows returns null', async () => {
    expect(await resolveSamePersonCluster(fakeDb(), [row('a')], TYPED)).toBeNull();
    expect(await resolveSamePersonCluster(fakeDb(), [], TYPED)).toBeNull();
    const eleven = Array.from({ length: 11 }, (_, i) => row(`r${i}`));
    expect(await resolveSamePersonCluster(fakeDb(), eleven, TYPED)).toBeNull();
    const ten = Array.from({ length: 10 }, (_, i) => row(`r${i}`));
    expect(await resolveSamePersonCluster(fakeDb(), ten, TYPED)).not.toBeNull();
  });

  test('a deleted or inactive row returns null', async () => {
    expect(await resolveSamePersonCluster(fakeDb(), [row('a'), row('b', { deleted_at: '2026-10-30T00:00:00Z' })], TYPED)).toBeNull();
    expect(await resolveSamePersonCluster(fakeDb(), [row('a'), row('b', { active: false })], TYPED)).toBeNull();
  });
});
