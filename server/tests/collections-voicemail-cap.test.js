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

// prb-r6: the stamp is an atomic reservation — the conditional WHERE makes
// the overlap loser see zero rows and stay silent.
test('the voicemail stamp is conditional on not-already-stamped', async () => {
  const { stampVoicemailLeft } = require('../services/collections/outbound-voice/voicemail');
  const q = {
    where: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    update: jest.fn(async () => 1),
  };
  db.mockImplementation(() => q);
  db.raw = jest.fn((sql, b) => ({ sql, b }));
  await stampVoicemailLeft('led-1', { now: new Date() });
  expect(q.whereRaw).toHaveBeenCalledWith("COALESCE(metadata->>'voicemail_left', '') <> 'true'");
});
