jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: () => 'NOW()' };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { clearSuppression } = require('../services/messaging/validators/suppression');

function wire({ delThrows = null } = {}) {
  const sup = { where: jest.fn(() => sup), update: jest.fn(async () => 1) };
  const cache = {
    where: jest.fn(() => cache),
    del: jest.fn(async () => { if (delThrows) throw delThrows; return 1; }),
  };
  db.mockImplementation((table) => {
    if (table === 'messaging_suppression') return sup;
    if (table === 'phone_line_types') return cache;
    throw new Error(`unexpected table ${table}`);
  });
  return { sup, cache };
}

beforeEach(() => jest.clearAllMocks());

describe('clearSuppression also clears the line-type cache', () => {
  test('deactivates the suppression AND drops the phone_line_types row', async () => {
    const { sup, cache } = wire();
    const res = await clearSuppression({ phone: '+18777175476', source: 'twilio_webhook_START' });
    expect(res.ok).toBe(true);
    expect(sup.update).toHaveBeenCalled();
    expect(cache.where).toHaveBeenCalledWith({ phone: '+18777175476' });
    expect(cache.del).toHaveBeenCalled();
  });

  test('still succeeds when the line-type cache table does not exist yet', async () => {
    wire({ delThrows: new Error('relation "phone_line_types" does not exist') });
    const res = await clearSuppression({ phone: '+19415550101', source: 'admin' });
    expect(res.ok).toBe(true);
  });
});
