/**
 * The recording processor's tech follow-up seam (codex #4072 r1–r8): a
 * technician's own-line call (source tech-click) finalizes ABOVE the lead
 * pipeline — extraction, summary and commitments land; no lead, booking,
 * automation, SMS, interaction or CSR write ever runs for it.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), isEnabled: jest.fn(() => false) }));
jest.mock('../services/call-commitments', () => ({ recordCallCommitments: jest.fn(async () => ({ seeds: 1, model: 0, written: 1, dropped: 0 })) }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { recordCallCommitments } = require('../services/call-commitments');
const { _test } = require('../services/call-recording-processor');

const { isTechFollowUpCall, finalizeTechFollowUpCall } = _test;

function primeDb({ written = 1 } = {}) {
  const updates = [];
  const builder = {
    where: jest.fn(() => builder),
    first: jest.fn(async () => ({ transcript_structured: null, processing_status: 'processed' })),
    update: jest.fn(async (u) => { updates.push(u); return written; }),
  };
  db.mockImplementation((table) => { expect(table).toBe('call_log'); return builder; });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return { builder, updates };
}

const CALL = { id: 'call-1', twilio_call_sid: 'CA1', source: 'tech-click', customer_id: 'c1', direction: 'outbound' };
const ARGS = {
  call: CALL,
  callSid: 'CA1',
  procToken: 'tok-1',
  procGeneration: 3,
  processingStartedAt: new Date(Date.now() - 1500),
  stageTimings: { transcription_ms: 900 },
  transcription: 'Tech: I am on my way, be there in ten minutes. Customer: great, thank you.',
  extracted: { call_summary: 'Tech confirmed arrival time.', sentiment: 'positive', appointment_confirmed: true, email: 'pat@example.com' },
  v2Result: { status: 'valid', extraction: { call_nature: 'existing_customer_service' } },
};

beforeEach(() => { jest.clearAllMocks(); isEnabled.mockReturnValue(false); });

test('only the bridge source the tech-line route sends is a tech follow-up', () => {
  expect(isTechFollowUpCall({ source: 'tech-click' })).toBe(true);
  expect(isTechFollowUpCall({ source: 'admin-click' })).toBe(false);
  expect(isTechFollowUpCall({ source: null })).toBe(false);
  expect(isTechFollowUpCall(null)).toBe(false);
});

test('finalizes in one token-fenced write: extraction + summary land, the call is processed, the claim released — nothing else', async () => {
  const { builder, updates } = primeDb();
  const result = await finalizeTechFollowUpCall(ARGS);
  expect(result).toEqual({ success: true, callSid: 'CA1', customerId: 'c1', extracted: ARGS.extracted, techFollowUp: true });
  expect(builder.where).toHaveBeenCalledWith({ id: 'call-1' });
  expect(builder.where).toHaveBeenCalledWith('processing_token', 'tok-1');
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    ai_extraction: JSON.stringify(ARGS.extracted),
    call_summary: 'Tech confirmed arrival time.',
    sentiment: 'positive',
    processing_status: 'processed',
    processing_token: null,
  });
  const timings = JSON.parse(updates[0].metadata.bindings[0]);
  expect(timings).toMatchObject({ transcription_ms: 900, generation: 3, tech_follow_up: true });
  // Nothing of the lead pipeline: one call_log write, no other table touched.
  expect(db.mock.calls.every(([t]) => t === 'call_log')).toBe(true);
  expect(recordCallCommitments).not.toHaveBeenCalled(); // gate off
});

test('commitments run after the terminal write when the gate is on, generation-fenced', async () => {
  primeDb();
  isEnabled.mockImplementation((k) => k === 'callCommitments');
  const result = await finalizeTechFollowUpCall(ARGS);
  expect(result.success).toBe(true);
  expect(recordCallCommitments).toHaveBeenCalledWith(expect.objectContaining({
    transcript: ARGS.transcription,
    v2: ARGS.v2Result.extraction,
    procGeneration: 3,
    call: expect.objectContaining({ id: 'call-1' }),
  }));
});

test('a lost claim writes nothing further and reports ownership lost — commitments never run for a superseded pass', async () => {
  primeDb({ written: 0 });
  isEnabled.mockImplementation((k) => k === 'callCommitments');
  const result = await finalizeTechFollowUpCall(ARGS);
  expect(result).toEqual({ success: false, skipped: true, reason: 'terminal_write_ownership_lost', callSid: 'CA1' });
  expect(recordCallCommitments).not.toHaveBeenCalled();
});
