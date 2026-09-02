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
  builder.whereRaw = jest.fn(() => builder);
  builder.first = jest.fn(async () => state.call);
  builder.update = jest.fn(async () => 1);
  const db = jest.fn(() => builder);
  db.raw = jest.fn((sql) => sql);
  db.__state = state;
  db.__builder = builder;
  return db;
});
jest.mock('twilio', () => {
  const recordingsSpy = Object.assign(jest.fn(() => ({ remove: jest.fn(async () => {}) })), {
    list: jest.fn(async () => []),
  });
  const factory = jest.fn(() => ({ recordings: recordingsSpy }));
  factory.__recordingsSpy = recordingsSpy;
  return factory;
});

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
      // Fully complete: delete done AND alert delivered — the one state
      // with nothing left to retry (round-18: a missing pan_notified now
      // re-runs the quarantine to resend the office alert).
      transcription_metadata: { pan_detected: true, recording_quarantined: true, pan_notified: true },
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

  test('a stamped row with a STILL-POPULATED recording_url is quarantine work, not already_has_recording (round-14)', async () => {
    const processor = require('../services/call-recording-processor');
    const recordingsSpy = require('twilio').__recordingsSpy;
    recordingsSpy.mockClear();
    db.__state.call = {
      id: 'c-stamped-url',
      recording_url: 'https://api.twilio.com/x.mp3',
      recording_sid: 'REold000000000000000000000000000',
      transcription_metadata: { pan_detected: true, recording_quarantined: false, quarantine_recording_sid: 'REfresh0000000000000000000000000' },
    };
    const out = await processor.recoverRecordingForCall('CAtest0000000000000000000000000004');
    expect(out).toMatchObject({ skipped: true, reason: 'pan_quarantined' });
    // The retry ran the REAL quarantine and targeted the SAVED quarantine
    // SID (the delete that failed), not the row's older recording_sid.
    expect(recordingsSpy).toHaveBeenCalledWith('REfresh0000000000000000000000000');
  });

  test('a failed Twilio delete leaves the quarantine INCOMPLETE — recording_quarantined false, the SID saved, the parked entry tombstoned without its URL', async () => {
    const processor = require('../services/call-recording-processor');
    const recordingsSpy = require('twilio').__recordingsSpy;
    const PARKED = 'REparked000000000000000000000001';
    recordingsSpy.mockImplementationOnce(() => ({ remove: async () => { throw Object.assign(new Error('twilio 503'), { status: 503 }); } }));
    db.__builder.update.mockClear();
    db.raw.mockClear();
    // An already-quarantined call (its first recording deleted, office told)
    // with a parked second recording whose delete now fails.
    db.__state.call = {
      id: 'c-parked', recording_url: null, recording_sid: 'REmain0000000000000000000000001',
      metadata: { additional_recordings: [{ recording_sid: PARKED, recording_url: 'https://api.twilio.com/p.mp3' }] },
      transcription_metadata: { pan_detected: true, recording_quarantined: true, pan_notified: true },
    };
    const out = await processor.quarantineCardRecording({ ...db.__state.call, recording_sid: PARKED, recording_url: 'https://api.twilio.com/p.mp3' }, { source: 'adopt_recording_post_quarantine' });
    expect(out).toMatchObject({ quarantined: true, twilioDeleted: false });
    const stamp = db.__builder.update.mock.calls.map((c) => c[0]).find((patch) => patch.transcription_metadata);
    expect(JSON.parse(stamp.transcription_metadata)).toMatchObject({ pan_detected: true, recording_quarantined: false, quarantine_recording_sid: PARKED, pan_notified: true });
    // The parked entry is rewritten in place: URL gone, delete still owed.
    const tomb = db.raw.mock.calls.find(([sql]) => String(sql).includes("'{additional_recordings}'"));
    expect(tomb).toBeDefined();
    expect(tomb[1][0]).toBe(PARKED);
    expect(JSON.parse(tomb[1][1])).toMatchObject({ recording_url: null, delete_pending: true });
  });

  test('a recording already gone at Twilio (404) counts as deleted — never a retry loop', async () => {
    const processor = require('../services/call-recording-processor');
    const recordingsSpy = require('twilio').__recordingsSpy;
    const PARKED = 'REparked000000000000000000000002';
    recordingsSpy.mockImplementationOnce(() => ({ remove: async () => { throw Object.assign(new Error('not found'), { status: 404, code: 20404 }); } }));
    db.__builder.update.mockClear();
    db.raw.mockClear();
    db.__state.call = {
      id: 'c-parked-404', recording_url: null, recording_sid: 'REmain0000000000000000000000002',
      metadata: { additional_recordings: [{ recording_sid: PARKED, recording_url: null, delete_pending: true }] },
      transcription_metadata: { pan_detected: true, recording_quarantined: false, quarantine_recording_sid: PARKED, pan_notified: true },
    };
    const out = await processor.quarantineCardRecording({ ...db.__state.call, recording_sid: PARKED }, { source: 'recovery_quarantine_retry' });
    expect(out.twilioDeleted).toBe(true);
    const stamp = db.__builder.update.mock.calls.map((c) => c[0]).find((patch) => patch.transcription_metadata);
    const meta = JSON.parse(stamp.transcription_metadata);
    expect(meta.recording_quarantined).toBe(true);
    expect(meta.quarantine_recording_sid).toBeUndefined();
    const tomb = db.raw.mock.calls.find(([sql]) => String(sql).includes("'{additional_recordings}'"));
    expect(JSON.parse(tomb[1][1])).toMatchObject({ recording_url: null, delete_pending: false });
  });

  test('recovery retries a parked delete still owed even when the primary quarantine is complete', async () => {
    const processor = require('../services/call-recording-processor');
    const recordingsSpy = require('twilio').__recordingsSpy;
    recordingsSpy.mockClear();
    const PARKED = 'REparked000000000000000000000003';
    db.__state.call = {
      id: 'c-parked-retry', recording_url: null, recording_sid: 'REmain0000000000000000000000003',
      metadata: { additional_recordings: [{ recording_sid: PARKED, recording_url: null, delete_pending: true }] },
      transcription_metadata: { pan_detected: true, recording_quarantined: true, pan_notified: true },
    };
    const out = await processor.recoverRecordingForCall('CAtest0000000000000000000000000009');
    expect(out).toMatchObject({ skipped: true, reason: 'pan_quarantined' });
    expect(recordingsSpy).toHaveBeenCalledWith(PARKED);
    expect(recordingsSpy).not.toHaveBeenCalledWith('REmain0000000000000000000000003');
  });

  test('an unstamped call still proceeds into the Twilio lookup', async () => {
    const processor = require('../services/call-recording-processor');
    db.__state.call = { id: 'c-clean', recording_url: null, transcription_metadata: null };
    const out = await processor.recoverRecordingForCall('CAtest0000000000000000000000000003');
    // Empty Twilio list → benign skip, but the guard did NOT short-circuit.
    expect(out).toMatchObject({ success: true, skipped: true, reason: 'no_completed_recording' });
  });

  test('a <Dial>-forwarded call with no parent recording asks Twilio for the accepted child leg too', async () => {
    const processor = require('../services/call-recording-processor');
    const recordingsSpy = require('twilio').__recordingsSpy;
    recordingsSpy.list.mockClear();
    db.__builder.update.mockClear();
    const child = 'CAchild000000000000000000000000001';
    recordingsSpy.list.mockImplementation(async ({ callSid }) => (callSid === child
      ? [{ sid: 'REchild00000000000000000000000001', status: 'completed', dateCreated: '2026-08-29T12:34:10Z', duration: '199', uri: `/2010-04-01/Accounts/AC/Recordings/REchild00000000000000000000000001.json` }]
      : []));
    db.__state.call = {
      id: 'c-forwarded', recording_url: null, transcription_metadata: null, duration_seconds: 257,
      // jsonb metadata as the webhook persists it at /inbound-forward-accept
      metadata: { forward_acceptance: { accepted: true, dial_call_sid: child } },
    };
    const out = await processor.recoverRecordingForCall('CAtest0000000000000000000000000004');
    expect(recordingsSpy.list.mock.calls.map((c) => c[0].callSid)).toEqual(['CAtest0000000000000000000000000004', child]);
    expect(out).toMatchObject({ success: true, recovered: true, recordingSid: 'REchild00000000000000000000000001' });
    expect(db.__builder.update).toHaveBeenCalledWith(expect.objectContaining({ recording_sid: 'REchild00000000000000000000000001', transcription_status: 'pending' }));
    recordingsSpy.list.mockImplementation(async () => []);
  });

  test('no recording on the parent OR the child leg reports which SIDs were checked', async () => {
    const processor = require('../services/call-recording-processor');
    const recordingsSpy = require('twilio').__recordingsSpy;
    recordingsSpy.list.mockClear();
    db.__state.call = {
      id: 'c-forwarded-none', recording_url: null, transcription_metadata: null,
      metadata: JSON.stringify({ forward_acceptance: { accepted: true, dial_call_sid: 'CAchild000000000000000000000000002' } }),
    };
    const out = await processor.recoverRecordingForCall('CAtest0000000000000000000000000005');
    expect(out).toMatchObject({ skipped: true, reason: 'no_completed_recording', checkedSids: ['CAtest0000000000000000000000000005', 'CAchild000000000000000000000000002'] });
    expect(recordingsSpy.list).toHaveBeenCalledTimes(2);
  });
});
