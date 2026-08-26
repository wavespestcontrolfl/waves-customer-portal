jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: () => 'NOW()' };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { clearSuppression } = require('../services/messaging/validators/suppression');

function wire({ delThrows = null } = {}) {
  // clearSuppression upserts (tombstone semantics — a clear against a
  // phone with no row still persists an inactive marker).
  const sup = {
    where: jest.fn(() => sup),
    update: jest.fn(async () => 1),
    insert: jest.fn(() => sup),
    onConflict: jest.fn(() => sup),
    merge: jest.fn(async () => 1),
    // cleanup ownership re-check: inactive tombstone = the clearance still
    // owns the row, so the cache deletes proceed.
    first: jest.fn(async () => ({ active: false })),
  };
  const cache = {
    where: jest.fn(() => cache),
    del: jest.fn(async () => { if (delThrows) throw delThrows; return 1; }),
  };
  const customers = {
    whereRaw: jest.fn(() => customers),
    whereNull: jest.fn(() => customers),
    whereNotNull: jest.fn(() => customers),
    select: jest.fn(async () => []), // no cached holders → no legacy update
  };
  db.mockImplementation((table) => {
    if (table === 'messaging_suppression') return sup;
    if (table === 'phone_line_types') return cache;
    if (table === 'customers') return customers;
    throw new Error(`unexpected table ${table}`);
  });
  // Cleanup runs in its own advisory-locked transaction (nested savepoint
  // for the optional table); the mock trx is db itself.
  db.raw = jest.fn(async () => ({}));
  db.transaction = jest.fn(async (fn) => fn(db));
  return { sup, cache, customers };
}

beforeEach(() => jest.clearAllMocks());

describe('clearSuppression also clears the line-type cache', () => {
  test('deactivates the suppression AND drops the phone_line_types row', async () => {
    const { sup, cache } = wire();
    const res = await clearSuppression({ phone: '+18777175476', source: 'twilio_webhook_START' });
    expect(res.ok).toBe(true);
    expect(sup.insert).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(sup.merge).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(cache.where).toHaveBeenCalledWith({ phone: '+18777175476' });
    expect(cache.del).toHaveBeenCalled();
  });

  test('still succeeds when the line-type cache table does not exist yet', async () => {
    wire({ delThrows: new Error('relation "phone_line_types" does not exist') });
    const res = await clearSuppression({ phone: '+19415550101', source: 'admin' });
    expect(res.ok).toBe(true);
  });
});
