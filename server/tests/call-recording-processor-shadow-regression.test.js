// Regression: PR #2225's phantom-customer guard calls the module-level
// isOutboundCall(call) helper early in processRecording, but a later
// `const isOutboundCall = ...` in the same function scope shadowed it —
// putting the guard reference in the temporal dead zone. Every inbound call
// arriving with a webhook-pre-linked customer_id threw
// "Cannot access 'isOutboundCall' before initialization" and wedged at
// processing_status='extraction_failed' (prod, 2026-07-01: 6 calls).
// This test drives the REAL processRecording past the guard lines — the
// existing guards suite only exercises exported _test helpers, which is how
// the shadowing shipped unnoticed. Fixtures fictitious; 555-01xx numbers.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const db = require('../models/db');
const CallRecordingProcessor = require('../services/call-recording-processor');

// Minimal thenable knex-builder mock: chain methods return the builder;
// first() pops from a queue, update() resolves 1 row (claim + status writes).
function mockDb(firstResults) {
  const firstQueue = [...firstResults];
  db.mockImplementation(() => {
    const builder = {
      where: () => builder,
      whereRaw: () => builder,
      whereNull: () => builder,
      whereIn: () => builder,
      orWhereRaw: () => builder,
      select: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      first: () => Promise.resolve(firstQueue.shift() ?? null),
      update: () => Promise.resolve(1),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  });
}

describe('processRecording isOutboundCall shadowing (TDZ) regression', () => {
  beforeEach(() => jest.clearAllMocks());

  test('inbound call with a pre-linked customer_id passes the phantom guard (no ReferenceError)', async () => {
    const call = {
      id: 'call-tdz-1',
      twilio_call_sid: 'CA00000000000000000000000000000tdz',
      direction: 'inbound',
      from_phone: '+15555550188', // external caller
      to_phone: '+15555550199',
      customer_id: 'cust-prelinked', // the trigger: webhook pre-linked an existing customer
      processing_status: null,
      recording_url: null, // stop the run right after the guards (no transcription available)
      transcription: null,
      created_at: new Date(),
    };
    // first() order: call fetch → linked-customer lookup inside the guard →
    // fresh-transcription fallback. All later paths are cut off by the
    // no-transcription early return.
    mockDb([call, null, null]);

    const result = await CallRecordingProcessor.processRecording(call.twilio_call_sid);

    // Pre-fix this rejects with "Cannot access 'isOutboundCall' before
    // initialization"; post-fix the run reaches the no-transcription exit.
    expect(result).toEqual({ success: false, error: 'No transcription available' });
  });

  test('outbound call with a linked customer takes the same guard lines safely', async () => {
    const call = {
      id: 'call-tdz-2',
      twilio_call_sid: 'CA00000000000000000000000000000td2',
      direction: 'outbound-api',
      from_phone: '+15555550199',
      to_phone: '+15555550188',
      customer_id: 'cust-prelinked',
      processing_status: null,
      recording_url: null,
      transcription: null,
      created_at: new Date(),
    };
    mockDb([call, null, null]);

    const result = await CallRecordingProcessor.processRecording(call.twilio_call_sid);
    expect(result).toEqual({ success: false, error: 'No transcription available' });
  });
});
