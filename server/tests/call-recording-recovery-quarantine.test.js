/**
 * Recording recovery must honor the PAN quarantine stamp (Codex #2676
 * round-7 P1): a quarantined call's nulled recording_url makes it look like
 * a missing-recording candidate, and without the guard the 5-minute sweep
 * would reattach the card audio from Twilio, undoing the quarantine.
 */
jest.mock('../models/db', () => {
  const state = { call: null };
  const builder = {};
  builder.where = jest.fn(() => builder);
  builder.whereNull = jest.fn(() => builder);
  builder.orWhere = jest.fn(() => builder);
  builder.first = jest.fn(async () => state.call);
  builder.update = jest.fn(async () => 1);
  const db = jest.fn(() => builder);
  db.raw = jest.fn((sql) => sql);
  db.__state = state;
  db.__builder = builder;
  return db;
});
jest.mock('twilio', () => jest.fn(() => ({
  recordings: Object.assign(jest.fn(() => ({ remove: jest.fn(async () => {}) })), {
    list: jest.fn(async () => []),
  }),
})));

const db = require('../models/db');

describe('recoverRecordingForCall — PAN quarantine guard', () => {
  const OLD_SID = process.env.TWILIO_ACCOUNT_SID;
  const OLD_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  beforeAll(() => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000';
    process.env.TWILIO_AUTH_TOKEN = 'testtoken';
  });
  afterAll(() => {
    if (OLD_SID === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = OLD_SID;
    if (OLD_TOKEN === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = OLD_TOKEN;
  });

  test('skips a call stamped pan_detected instead of reattaching its recording', async () => {
    const processor = require('../services/call-recording-processor');
    db.__state.call = {
      id: 'c-quarantined',
      recording_url: null,
      // jsonb comes back as an OBJECT from Postgres — the guard handles both.
      transcription_metadata: { pan_detected: true, recording_quarantined: true },
    };
    const out = await processor.recoverRecordingForCall('CAtest0000000000000000000000000001');
    expect(out).toMatchObject({ success: true, skipped: true, reason: 'pan_quarantined' });
    // Never wrote a recording_url back.
    expect(db.__builder.update).not.toHaveBeenCalled();
  });

  test('string-form metadata is parsed the same way', async () => {
    const processor = require('../services/call-recording-processor');
    db.__state.call = {
      id: 'c-quarantined-2',
      recording_url: null,
      transcription_metadata: JSON.stringify({ pan_detected: true }),
    };
    const out = await processor.recoverRecordingForCall('CAtest0000000000000000000000000002');
    expect(out).toMatchObject({ skipped: true, reason: 'pan_quarantined' });
  });

  test('an unstamped call still proceeds into the Twilio lookup', async () => {
    const processor = require('../services/call-recording-processor');
    db.__state.call = { id: 'c-clean', recording_url: null, transcription_metadata: null };
    const out = await processor.recoverRecordingForCall('CAtest0000000000000000000000000003');
    // Empty Twilio list → benign skip, but the guard did NOT short-circuit.
    expect(out).toMatchObject({ success: true, skipped: true, reason: 'no_completed_recording' });
  });
});
