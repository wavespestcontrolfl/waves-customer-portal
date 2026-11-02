/**
 * Tech voice line admission (services/tech-voice-line.js): a call is admitted
 * only on the line's number, from exactly one active technician's own cell
 * (never a Waves number), with its own internal call_log row, and only after
 * its minutes are reserved. The registry carries the number as its own kind,
 * and the call readers treat its source as internal.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), techVoiceLineLive: jest.fn(() => true) }));
jest.mock('../services/tech-voice-usage', () => ({ reserveTechVoiceCall: jest.fn(async () => ({ ok: true })) }));

const LINE = '+19415550188';
process.env.TECH_VOICE_NUMBER = LINE;

const { techVoiceLineLive } = require('../config/feature-gates');
const { reserveTechVoiceCall } = require('../services/tech-voice-usage');
const { admitTechVoiceCall } = require('../services/tech-voice-line');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { TECH_VOICE_SOURCE, VOICE_RELAY_SANDBOX_SOURCE, isInternalCallSource } = require('../services/voice-agent/relay-protocol');
const { callSinceInbound } = require('../services/sms-unanswered-reply');

const CELL = '+19415550101';
const NOW = new Date('2026-11-12T20:00:00Z');

// technicians answers `techs`; call_log reads answer `existing` inside a transaction.
function fakeConn({ techs = [], existing } = {}) {
  const writes = { insert: [], update: [], locks: [] };
  const conn = jest.fn((table) => {
    expect(table).toBe('technicians');
    const chain = { where: jest.fn(() => chain), select: jest.fn(async () => techs) };
    return chain;
  });
  const trx = jest.fn((table) => {
    expect(table).toBe('call_log');
    const chain = {
      where: jest.fn(() => chain),
      first: jest.fn(async () => existing),
      insert: jest.fn(async (row) => { writes.insert.push(row); return [1]; }),
      update: jest.fn(async (row) => { writes.update.push(row); return 1; }),
    };
    return chain;
  });
  trx.raw = jest.fn(async (sql, bindings) => { writes.locks.push([sql, bindings]); return {}; });
  conn.transaction = jest.fn(async (fn) => fn(trx));
  conn.writes = writes;
  conn.trx = trx;
  return conn;
}
const TECH = { id: 'tech-1', name: 'Pat Sample', phone: '(941) 555-0101' };
const args = (over = {}) => ({ callSid: 'CA-1', from: CELL, to: LINE, callStatus: 'ringing', stirVerstat: null, now: NOW, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  techVoiceLineLive.mockReturnValue(true);
  reserveTechVoiceCall.mockResolvedValue({ ok: true });
});

describe('admitTechVoiceCall', () => {
  test('gate off or another number: refused before any read', async () => {
    techVoiceLineLive.mockReturnValue(false);
    let conn = fakeConn({ techs: [TECH] });
    expect(await admitTechVoiceCall(conn, args())).toEqual({ ok: false, reason: 'gate_off' });
    techVoiceLineLive.mockReturnValue(true);
    conn = fakeConn({ techs: [TECH] });
    expect(await admitTechVoiceCall(conn, args({ to: '+19412975749' }))).toEqual({ ok: false, reason: 'not_the_line' });
    expect(conn).not.toHaveBeenCalled();
  });

  test('admits an active technician calling from their own cell: internal row first, then the reservation', async () => {
    const conn = fakeConn({ techs: [TECH, { id: 'tech-2', phone: '+19415550177' }] });
    expect(await admitTechVoiceCall(conn, args({ stirVerstat: 'No-TN-Validation' }))).toEqual({ ok: true, technicianId: 'tech-1' });
    expect(conn.writes.locks[0]).toEqual(['SELECT pg_advisory_xact_lock(hashtext(?))', ['CA-1']]);
    const [row] = conn.writes.insert;
    expect(row).toMatchObject({ direction: 'inbound', from_phone: CELL, to_phone: LINE, twilio_call_sid: 'CA-1', source: TECH_VOICE_SOURCE });
    // The carrier verdict is logged, never required.
    expect(JSON.parse(row.metadata)).toEqual({ tech_voice: true, technician_id: 'tech-1', stir_verstat: 'No-TN-Validation' });
    // The reservation runs in the same CallSid-locked transaction as the row.
    expect(reserveTechVoiceCall).toHaveBeenCalledWith(conn.trx, { callSid: 'CA-1', technicianId: 'tech-1', now: NOW });
  });

  test('an unknown caller, a cell two technicians share, or a Waves line on a technician row admits nobody', async () => {
    expect(await admitTechVoiceCall(fakeConn({ techs: [{ id: 't9', phone: '+19415550177' }] }), args())).toEqual({ ok: false, reason: 'unknown_caller' });
    expect(await admitTechVoiceCall(fakeConn({ techs: [TECH, { id: 'tech-3', phone: CELL }] }), args())).toEqual({ ok: false, reason: 'unknown_caller' });
    // The main line on a technician row is never a dial target, so a spoofed main-line caller ID matches nobody.
    expect(await admitTechVoiceCall(fakeConn({ techs: [{ id: 'tech-4', phone: '+19412975749' }] }), args({ from: '+19412975749' })))
      .toEqual({ ok: false, reason: 'unknown_caller' });
    expect(reserveTechVoiceCall).not.toHaveBeenCalled();
  });

  test('adopts a /call-status fallback row; refuses a CallSid another source owns', async () => {
    let conn = fakeConn({ techs: [TECH], existing: { id: 5, source: null } });
    expect(await admitTechVoiceCall(conn, args())).toEqual({ ok: true, technicianId: 'tech-1' });
    expect(conn.writes.update[0]).toMatchObject({ source: TECH_VOICE_SOURCE, customer_id: null });
    reserveTechVoiceCall.mockClear();
    conn = fakeConn({ techs: [TECH], existing: { id: 6, source: 'collections_voice' } });
    expect(await admitTechVoiceCall(conn, args())).toEqual({ ok: false, reason: 'call_sid_owned_elsewhere' });
    expect(conn.writes.update).toHaveLength(0);
    expect(reserveTechVoiceCall).not.toHaveBeenCalled();
  });

  test('a final status already on the row (the caller hung up during admission) reserves nothing', async () => {
    for (const existing of [{ id: 8, source: TECH_VOICE_SOURCE, status: 'canceled' }, { id: 9, source: null, status: 'completed' }]) {
      const conn = fakeConn({ techs: [TECH], existing });
      expect(await admitTechVoiceCall(conn, args())).toEqual({ ok: false, reason: 'call_ended' });
      // The row is still marked internal; only the reservation is skipped.
      expect(conn.writes.update[0]).toMatchObject({ source: TECH_VOICE_SOURCE, customer_id: null });
    }
    expect(reserveTechVoiceCall).not.toHaveBeenCalled();
  });

  test('a spent budget or a live call refuses with its reason', async () => {
    reserveTechVoiceCall.mockResolvedValueOnce({ ok: false, reason: 'daily_limit' });
    expect(await admitTechVoiceCall(fakeConn({ techs: [TECH] }), args())).toEqual({ ok: false, reason: 'daily_limit' });
  });
});

describe('the line in the number registry', () => {
  test('its own kind, owned, never office semantics; a number another bucket carries is refused', () => {
    expect(TWILIO_NUMBERS.techVoiceNumber()).toBe(LINE);
    expect(TWILIO_NUMBERS.findByNumber(LINE)).toMatchObject({ type: 'tech_voice', number: LINE });
    expect(TWILIO_NUMBERS.allNumbers.filter((n) => n.number === LINE).map((n) => n.type)).toEqual(['tech_voice']);
    const saved = process.env.TECH_VOICE_NUMBER;
    try {
      process.env.TECH_VOICE_NUMBER = TWILIO_NUMBERS.fieldTech[0].number;
      expect(TWILIO_NUMBERS.techVoiceNumber()).toBeNull();
      process.env.TECH_VOICE_NUMBER = '941-555-0188';
      expect(TWILIO_NUMBERS.techVoiceNumber()).toBeNull();
    } finally {
      process.env.TECH_VOICE_NUMBER = saved;
    }
  });
});

describe('call readers treat the source as internal', () => {
  test('isInternalCallSource covers both internal sources and nothing else', () => {
    expect(isInternalCallSource(TECH_VOICE_SOURCE)).toBe(true);
    expect(isInternalCallSource(VOICE_RELAY_SANDBOX_SOURCE)).toBe(true);
    expect(isInternalCallSource(null)).toBe(false);
    expect(isInternalCallSource('collections_voice')).toBe(false);
  });

  test('a customer call to the tech line does not count as "a call since the text" for an unanswered reply', async () => {
    // The tech line rejects any caller it does not admit, so a customer who
    // dials it reached nobody: their unanswered text must stay unanswered.
    const raws = [];
    const chain = {
      whereRaw: jest.fn((sql, bindings) => { raws.push([sql, bindings]); return chain; }),
      modify: jest.fn((fn) => { fn(chain); return chain; }),
      where: jest.fn(() => chain),
      first: jest.fn(async () => undefined),
    };
    expect(await callSinceInbound(() => chain, { threadLast10: '9415550101', customerId: null, smsLogId: 'sms-1' })).toBe(false);
    expect(raws).toEqual(expect.arrayContaining([
      ["COALESCE(??, '') <> ?", ['source', VOICE_RELAY_SANDBOX_SOURCE]],
      ["COALESCE(??, '') <> ?", ['source', TECH_VOICE_SOURCE]],
    ]));
  });
});
