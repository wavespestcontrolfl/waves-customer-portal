jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({
  recordSuppression: jest.fn(async () => ({ ok: true })),
  clearSuppression: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/recipient-optin', () => ({ markRecipientOptin: jest.fn(async () => 0) }));

const db = require('../models/db');
const { recordSuppression } = require('../services/messaging/validators/suppression');
const { standingVerdictTime } = require('../services/messaging/suppression-ownership');
const { recordSyncProviderOptOut } = require('../services/messaging/sync-optout');

describe('standingVerdictTime', () => {
  test('parses the attempt timestamp out of a sync-authored active row', async () => {
    const t = await standingVerdictTime({ active: true, source: 'twilio_send_21610:2026-08-26T15:00:00.000Z' }, {});
    expect(t).toEqual(new Date('2026-08-26T15:00:00.000Z'));
  });

  test('resolves a callback-authored row through the owner SID sms_log lookup', async () => {
    const dbh = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn(async () => ({ created_at: '2026-08-26T14:00:00.000Z' })),
    }));
    const t = await standingVerdictTime({ active: true, source: 'twilio_status_21610:SM_owner' }, { dbh });
    expect(t).toEqual(new Date('2026-08-26T14:00:00.000Z'));
    expect(dbh).toHaveBeenCalledWith('sms_log');
  });

  test('returns null for inactive rows, the caller own SID, and unparseable provenance', async () => {
    const dbh = jest.fn();
    await expect(standingVerdictTime({ active: false, source: 'twilio_send_21610:2026-08-26T15:00:00.000Z' }, { dbh })).resolves.toBeNull();
    await expect(standingVerdictTime({ active: true, source: 'twilio_status_21610:SM_self' }, { dbh, excludeSid: 'SM_self' })).resolves.toBeNull();
    await expect(standingVerdictTime({ active: true, source: 'twilio_send_21610:garbage' }, { dbh })).resolves.toBeNull();
    await expect(standingVerdictTime({ active: true, source: 'twilio_send_21610' }, { dbh })).resolves.toBeNull();
    await expect(standingVerdictTime(null, { dbh })).resolves.toBeNull();
    expect(dbh).not.toHaveBeenCalled();
  });
});

describe('recordSyncProviderOptOut newer-owner defer (codex #3495 r14)', () => {
  test('an older attempt defers to a standing row authored by a newer sync attempt', async () => {
    // Timeline: send A (14:00) → START → send B's 21610 records (15:00).
    // A's slower 21610 processes last: without the guard, A's recheck
    // window (from 14:00) would see the START and clear B's newer verdict.
    const supRow = { active: true, cleared_at: null, source: 'twilio_send_21610:2026-08-26T15:00:00.000Z' };
    const trx = jest.fn((table) => {
      if (table === 'messaging_suppression') {
        return {
          where: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          first: jest.fn(async () => supRow),
        };
      }
      throw new Error(`Unexpected table ${table} — the deferred path must not query further`);
    });
    trx.raw = jest.fn(async () => ({}));
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const outcome = await recordSyncProviderOptOut({
      phone: '+19415551234',
      attemptAt: new Date('2026-08-26T14:00:00.000Z'),
    });

    expect(outcome).toEqual({ deferred: 'newer-attempt-owns-row' });
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  test('a newer attempt proceeds and stamps its own timestamp into the source', async () => {
    const supRow = { active: true, cleared_at: null, source: 'twilio_send_21610:2026-08-26T13:00:00.000Z' };
    const smsLogChain = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn(async () => []),
    };
    const customersChain = {
      whereRaw: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      select: jest.fn(async () => []),
    };
    const trx = jest.fn((table) => {
      if (table === 'messaging_suppression') {
        return {
          where: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          first: jest.fn(async () => supRow),
        };
      }
      if (table === 'sms_log') return smsLogChain;
      if (table === 'customers') return customersChain;
      throw new Error(`Unexpected table ${table}`);
    });
    trx.raw = jest.fn(async () => ({}));
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const outcome = await recordSyncProviderOptOut({
      phone: '+19415551234',
      attemptAt: new Date('2026-08-26T14:00:00.000Z'),
    });

    expect(outcome).toEqual({ recorded: true });
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({
      source: 'twilio_send_21610:2026-08-26T14:00:00.000Z',
    }));
  });
});
