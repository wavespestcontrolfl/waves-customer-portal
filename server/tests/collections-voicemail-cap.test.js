/**
 * collections/outbound-voice/voicemail.js (real logic) — pins:
 *  - 1/30d cap read from the collections ledger (voicemail_left rows only);
 *  - ledger read failure ⇒ NO voicemail (fail closed);
 *  - isMachineEnd admits ONLY machine_end_* (unknown/fax/human/absent no).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});

const db = require('../models/db');
const {
  voicemailPermitted, isMachineEnd, VOICEMAIL_WINDOW_DAYS,
} = require('../services/collections/outbound-voice/voicemail');

function chain({ first, throws } = {}) {
  const q = { _wheres: [], _raws: [] };
  q.where = jest.fn((...a) => { q._wheres.push(a); return q; });
  q.whereRaw = jest.fn((...a) => { q._raws.push(a); return q; });
  q.first = jest.fn(async () => {
    if (throws) throw new Error('db down');
    return first;
  });
  return q;
}

beforeEach(() => jest.clearAllMocks());

test('no recent voicemail ⇒ permitted; the query is scoped to voicemail_left voice rows in the 30d window', async () => {
  const q = chain({ first: undefined });
  db.mockImplementation(() => q);
  const now = new Date('2026-08-12T15:00:00Z');
  await expect(voicemailPermitted('cust-1', { now })).resolves.toBe(true);
  expect(q._wheres[0][0]).toEqual({ customer_id: 'cust-1', channel: 'voice' });
  const windowStart = q._wheres[1][2];
  expect(now.getTime() - windowStart.getTime()).toBe(VOICEMAIL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  expect(q._raws[0][0]).toContain('voicemail_left');
});

test('a voicemail inside 30d ⇒ refused', async () => {
  db.mockImplementation(() => chain({ first: { id: 'row-1' } }));
  await expect(voicemailPermitted('cust-1')).resolves.toBe(false);
});

test('ledger read failure ⇒ refused (fail closed)', async () => {
  db.mockImplementation(() => chain({ throws: true }));
  await expect(voicemailPermitted('cust-1')).resolves.toBe(false);
});

test('missing customer id ⇒ refused', async () => {
  await expect(voicemailPermitted(null)).resolves.toBe(false);
  expect(db).not.toHaveBeenCalled();
});

test('isMachineEnd admits only machine_end_*', () => {
  expect(isMachineEnd('machine_end_beep')).toBe(true);
  expect(isMachineEnd('machine_end_silence')).toBe(true);
  expect(isMachineEnd('machine_end_other')).toBe(true);
  expect(isMachineEnd('unknown')).toBe(false);
  expect(isMachineEnd('fax')).toBe(false);
  expect(isMachineEnd('human')).toBe(false);
  expect(isMachineEnd('')).toBe(false);
  expect(isMachineEnd(undefined)).toBe(false);
});

// prb-r6 + prb-r9: the stamp is an atomic reservation SERIALIZED BY
// CUSTOMER — two overlapping calls carry two different ledger rows, so the
// per-row conditional alone never contends; the customer-keyed advisory
// xact lock + in-lock window re-check is the real boundary.
describe('stampVoicemailLeft (customer-serialized reservation)', () => {
  const { stampVoicemailLeft } = require('../services/collections/outbound-voice/voicemail');

  function makeTrx({ already, updated = 1 } = {}) {
    const qs = [];
    const trx = jest.fn(() => {
      const q = { _wheres: [], _raws: [] };
      q.where = jest.fn((...a) => { q._wheres.push(a); return q; });
      q.whereRaw = jest.fn((...a) => { q._raws.push(a); return q; });
      q.first = jest.fn(async () => already);
      q.update = jest.fn(async () => updated);
      qs.push(q);
      return q;
    });
    trx.raw = jest.fn(async (sql, bindings) => ({ sql, bindings }));
    trx._qs = qs;
    return trx;
  }

  test('missing customerId ⇒ refused with no db touch (fail closed — no lock key = no serialization)', async () => {
    db.transaction = jest.fn();
    await expect(stampVoicemailLeft('led-1', { now: new Date() })).resolves.toBe(false);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('takes the customer-keyed advisory xact lock, re-checks the window IN the lock, and refuses on a rival stamp', async () => {
    const trx = makeTrx({ already: { id: 'other-row' } });
    db.transaction = jest.fn(async (fn) => fn(trx));
    await expect(stampVoicemailLeft('led-1', { customerId: 'cust-1', now: new Date() })).resolves.toBe(false);
    expect(trx.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['collections_voicemail', 'cust-1'],
    );
    // The re-check is customer-scoped, inside the lock.
    expect(trx._qs[0]._wheres[0][0]).toEqual({ customer_id: 'cust-1', channel: 'voice' });
    // The rival stamp means NO update ran.
    expect(trx._qs).toHaveLength(1);
  });

  test('clear window ⇒ the per-row conditional stamp lands and returns true', async () => {
    const trx = makeTrx({ already: undefined, updated: 1 });
    db.transaction = jest.fn(async (fn) => fn(trx));
    await expect(stampVoicemailLeft('led-1', { customerId: 'cust-1', now: new Date() })).resolves.toBe(true);
    const stampQ = trx._qs[1];
    expect(stampQ._wheres[0][0]).toEqual({ id: 'led-1' });
    expect(stampQ._raws[0][0]).toBe("COALESCE(metadata->>'voicemail_left', '') <> 'true'");
  });

  test('transaction failure ⇒ refused (fail closed)', async () => {
    db.transaction = jest.fn(async () => { throw new Error('db down'); });
    await expect(stampVoicemailLeft('led-1', { customerId: 'cust-1' })).resolves.toBe(false);
  });
});
