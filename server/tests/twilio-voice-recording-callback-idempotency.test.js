// Twilio delivers the recording, status and transcription callbacks at least
// once and in no guaranteed order. These tests drive the REAL handlers with
// an in-memory call_log so the attach decision, the status monotonicity and
// the built-in-transcript precedence are proven on the write path, not just
// on the exported helpers. Fixtures are fictitious (555-01xx numbers, fake
// SIDs); no transcript text resembles a real call.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
  syncVoiceMessageForCall: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/notification-service', () => ({
  supersedeMissedCallAdmin: jest.fn(() => Promise.resolve()),
  notifyAdmin: jest.fn(() => Promise.resolve({ id: 'n1' })),
}));
jest.mock('../services/call-recording-processor', () => ({
  processRecording: jest.fn(() => Promise.resolve({ success: true })),
  recoverRecordingForCall: jest.fn(() => Promise.resolve()),
  quarantineCardRecording: jest.fn(() => Promise.resolve()),
  withPanStamps: jest.fn(async (_id, meta) => ({ ...meta })),
}));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const logger = require('../services/logger');
const processor = require('../services/call-recording-processor');
const voiceRouter = require('../routes/twilio-voice-webhook');

const { decideRecordingAttach, nextCallStatus, builtinTranscriptMayReplace } = voiceRouter._test;

// ── In-memory knex stand-in ──────────────────────────────────────────────
// Evaluates exactly the clause shapes the three handlers use. Anything else
// throws, so a handler change that reaches for a new clause fails loudly
// here instead of silently matching every row.
function isPan(row) {
  const raw = row.transcription_metadata;
  try {
    const meta = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return String(meta?.pan_detected) === 'true';
  } catch { return false; }
}
function metaOf(row) {
  const raw = row.metadata;
  if (!raw) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function makeDb(tables) {
  const raw = (sql, bindings = []) => ({ __raw: true, sql, bindings });

  function evalClause(row, clause) {
    switch (clause.type) {
      case 'eq': return row[clause.col] === clause.val;
      case 'null': return row[clause.col] == null;
      case 'in': return clause.vals.includes(row[clause.col]);
      case 'group': return evalGroup(row, clause.clauses);
      case 'raw': {
        const sql = clause.sql;
        if (sql.includes("pan_detected') IS DISTINCT FROM 'true'")) return !isPan(row);
        if (sql.includes("pan_detected') = 'true'")) return isPan(row);
        if (sql.includes("NOT COALESCE(metadata -> 'additional_recordings'")) {
          const wanted = JSON.parse(clause.bindings[0])[0].recording_sid;
          return !(metaOf(row).additional_recordings || []).some((r) => r.recording_sid === wanted);
        }
        if (sql.includes("processing_status IS DISTINCT FROM 'processing' AND processing_status IS DISTINCT FROM 'processed'")) {
          return !['processing', 'processed'].includes(String(row.processing_status));
        }
        throw new Error(`fake db: unsupported raw clause ${sql}`);
      }
      default: throw new Error(`fake db: unsupported clause ${clause.type}`);
    }
  }
  function evalGroup(row, clauses) {
    if (!clauses.length) return true;
    let acc = evalClause(row, clauses[0]);
    for (const c of clauses.slice(1)) {
      acc = c.or ? (acc || evalClause(row, c)) : (acc && evalClause(row, c));
    }
    return acc;
  }

  function subBuilder() {
    const clauses = [];
    const sb = {
      where(col, val) {
        if (typeof col === 'function') { const inner = subBuilder(); col.call(inner); clauses.push({ type: 'group', clauses: inner.clauses }); return sb; }
        if (typeof col === 'object') { for (const [k, v] of Object.entries(col)) clauses.push({ type: 'eq', col: k, val: v }); return sb; }
        clauses.push({ type: 'eq', col, val }); return sb;
      },
      orWhere(col, val) { clauses.push({ type: 'eq', col, val, or: true }); return sb; },
      whereNull(col) { clauses.push({ type: 'null', col }); return sb; },
      orWhereNull(col) { clauses.push({ type: 'null', col, or: true }); return sb; },
      whereRaw(sql, bindings) { clauses.push({ type: 'raw', sql, bindings }); return sb; },
      orWhereRaw(sql, bindings) { clauses.push({ type: 'raw', sql, bindings, or: true }); return sb; },
      whereIn(col, vals) { clauses.push({ type: 'in', col, vals }); return sb; },
      clauses,
    };
    return sb;
  }

  function applyUpdate(row, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && v.__raw) {
        const meta = metaOf(row);
        const appended = JSON.parse(v.bindings[0]);
        if (v.sql.includes("'{superseded_recordings}'")) {
          meta.superseded_recordings = [...(meta.superseded_recordings || []), ...appended];
        } else if (v.sql.includes("'{additional_recordings}'")) {
          meta.additional_recordings = [...(meta.additional_recordings || []), ...appended];
        } else if (v.sql.includes("COALESCE(transcription_metadata, '{}'::jsonb) || ?::jsonb")) {
          // Atomic jsonb merge onto the CURRENT row value.
          const raw = row.transcription_metadata;
          let current = {};
          try { current = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { current = {}; }
          row.transcription_metadata = JSON.stringify({ ...current, ...JSON.parse(v.bindings[0]) });
          continue;
        } else {
          throw new Error(`fake db: unsupported raw update ${v.sql}`);
        }
        row.metadata = meta;
      } else {
        row[k] = v;
      }
    }
  }

  const dbLike = jest.fn((table) => {
    const rows = tables[table] || (tables[table] = []);
    const sb = subBuilder();
    const builder = {
      ...sb,
      where(...a) { sb.where(...a); return builder; },
      orWhere(...a) { sb.orWhere(...a); return builder; },
      whereNull(...a) { sb.whereNull(...a); return builder; },
      orWhereNull(...a) { sb.orWhereNull(...a); return builder; },
      whereRaw(...a) { sb.whereRaw(...a); return builder; },
      orWhereRaw(...a) { sb.orWhereRaw(...a); return builder; },
      whereIn(...a) { sb.whereIn(...a); return builder; },
      select() { return builder; },
      first() {
        const hit = rows.find((r) => evalGroup(r, sb.clauses));
        const snapshot = hit ? { ...hit } : undefined;
        // Race hook: mutate the live row AFTER the handler has read it, the
        // way a processing claim lands between a read and a write.
        if (hit && typeof tables.__afterFirst === 'function') tables.__afterFirst(hit, table);
        return Promise.resolve(snapshot);
      },
      modify(fn) { fn(builder); return builder; },
      update(patch) {
        const hits = rows.filter((r) => evalGroup(r, sb.clauses));
        hits.forEach((r) => applyUpdate(r, patch));
        return Promise.resolve(hits.length);
      },
      insert(obj) {
        const inserted = { id: `row-${rows.length + 1}`, ...obj };
        const conflict = { onConflict: () => ({ ignore: () => Promise.resolve([inserted]) }) };
        rows.push(inserted);
        return Object.assign(Promise.resolve([inserted]), conflict);
      },
      then(resolve, reject) {
        return Promise.resolve(rows.filter((r) => evalGroup(r, sb.clauses)).map((r) => ({ ...r }))).then(resolve, reject);
      },
    };
    return builder;
  });
  dbLike.raw = jest.fn(raw);
  dbLike.transaction = jest.fn(async (fn) => fn(Object.assign((t) => dbLike(t), { raw: dbLike.raw })));
  return dbLike;
}

function handlerFor(path) {
  const layer = voiceRouter.stack.find((l) => l.route && l.route.path === path);
  if (!layer) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}

async function post(path, body) {
  const res = { sendStatus: jest.fn(), status: jest.fn(() => res), send: jest.fn(), type: jest.fn(() => res) };
  await handlerFor(path)({ body, query: {}, originalUrl: path }, res);
  return res;
}

const PARENT = 'CA' + 'a'.repeat(32);
const CHILD = 'CA' + 'b'.repeat(32);
const REC_1 = 'RE' + '1'.repeat(32);
const REC_2 = 'RE' + '2'.repeat(32);
const URL_1 = `https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/${REC_1}`;
const URL_2 = `https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/${REC_2}`;

function recordingCallback(overrides = {}) {
  return {
    CallSid: CHILD,
    ParentCallSid: PARENT,
    RecordingSid: REC_2,
    RecordingUrl: URL_2,
    RecordingDuration: '45',
    RecordingStatus: 'completed',
    ...overrides,
  };
}

let tables;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  tables = { call_log: [], triage_items: [] };
  const fake = makeDb(tables);
  db.mockImplementation((t) => fake(t));
  db.raw = fake.raw;
  db.transaction = fake.transaction;
});
afterEach(() => {
  jest.useRealTimers();
});

describe('decideRecordingAttach (pure)', () => {
  test('first delivery attaches', () => {
    expect(decideRecordingAttach({ recording_sid: null, recording_url: null }, { recording_sid: REC_1 })).toEqual({ action: 'attach' });
  });
  test('a first recording for a row a pass is working (or finished) without audio is parked, not installed under it', () => {
    expect(decideRecordingAttach({ recording_sid: null, recording_url: null, processing_status: 'processing' }, { recording_sid: REC_1 })).toEqual({ action: 'park', reason: 'processing_status_processing' });
    expect(decideRecordingAttach({ recording_sid: null, recording_url: null, processing_status: 'processed' }, { recording_sid: REC_1 })).toEqual({ action: 'park', reason: 'processing_status_processed' });
  });
  test('the same RecordingSid again is a duplicate — never a rewrite', () => {
    for (const status of [null, 'pending', 'processing', 'processed', 'voicemail']) {
      expect(decideRecordingAttach({ recording_sid: REC_1, recording_url: URL_1, processing_status: status }, { recording_sid: REC_1 }).action).toBe('duplicate');
    }
  });
  test('a different recording on a row nothing has finished on replaces it and keeps the old one', () => {
    for (const status of [null, 'pending', 'voicemail', 'spam', 'no_transcription', 'extraction_failed']) {
      const d = decideRecordingAttach({ recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 9, processing_status: status }, { recording_sid: REC_2 });
      expect(d.action).toBe('replace');
      expect(d.superseded).toEqual({ recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 9 });
    }
  });
  test('a different recording on a processing or processed row is parked', () => {
    expect(decideRecordingAttach({ recording_sid: REC_1, recording_url: URL_1, processing_status: 'processing' }, { recording_sid: REC_2 })).toEqual({ action: 'park', reason: 'processing_status_processing' });
    expect(decideRecordingAttach({ recording_sid: REC_1, recording_url: URL_1, processing_status: 'processed' }, { recording_sid: REC_2 })).toEqual({ action: 'park', reason: 'processing_status_processed' });
  });
});

describe('POST /recording-status', () => {
  test('first delivery attaches to the PARENT row and schedules processing on the parent SID', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: null, recording_url: null, processing_status: null });
    const res = await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1 }));
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_1);
    expect(row.recording_url).toBe(`${URL_1}.mp3`);
    expect(row.recording_duration_seconds).toBe(45);
    expect(row.transcription_status).toBe('pending');
    jest.advanceTimersByTime(2 * 60 * 1000 + 5);
    expect(processor.processRecording).toHaveBeenCalledWith(PARENT);
  });

  test('a retried delivery of the same RecordingSid on a processed row writes NOTHING', async () => {
    const before = {
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 45,
      processing_status: 'processed', transcription_status: 'completed', transcription: 'Agent: fixture line.', updated_at: 'T0',
    };
    tables.call_log.push({ ...before });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1 }));
    expect(tables.call_log[0]).toEqual(before);
    // The idempotent processing attempt is still scheduled — it is what
    // recovers a first delivery whose timers a deploy wiped.
    jest.advanceTimersByTime(2 * 60 * 1000 + 5);
    expect(processor.processRecording).toHaveBeenCalledWith(PARENT);
  });

  test('a DIFFERENT recording after processing finished is parked, the transcript keeps its recording, a review card is filed', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 45,
      processing_status: 'processed', transcription_status: 'completed', transcription: 'Agent: fixture line.', metadata: { source: 'voice_webhook' },
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_1);
    expect(row.recording_url).toBe(`${URL_1}.mp3`);
    expect(row.transcription_status).toBe('completed');
    expect(row.metadata.source).toBe('voice_webhook');
    expect(row.metadata.additional_recordings).toHaveLength(1);
    expect(row.metadata.additional_recordings[0]).toMatchObject({
      recording_sid: REC_2, recording_url: `${URL_2}.mp3`, recording_duration_seconds: 80, parked_because: 'processing_status_processed',
    });
    expect(tables.triage_items).toHaveLength(1);
    expect(tables.triage_items[0]).toMatchObject({ call_log_id: 'c1', reason_code: 'additional_recording', severity: 'advisory', status: 'open' });
    // buildTriageItem serializes the payload for the jsonb column.
    expect(JSON.parse(tables.triage_items[0].payload)).toMatchObject({ recording_sid: REC_2, kept_recording_sid: REC_1 });
    // Nothing is auto-processed against a recording the row does not carry.
    jest.advanceTimersByTime(15 * 60 * 1000);
    expect(processor.processRecording).not.toHaveBeenCalled();
  });

  test('a replace decided on a stale read is parked when a pass claims the row before the write', async () => {
    // The handler reads processing_status NULL and decides "replace"; a pass
    // claims the row before the UPDATE runs and starts transcribing the OLD
    // audio. The write must refuse and the new recording must be parked —
    // never swapped under a live claim.
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12,
      processing_status: null, transcription: null, metadata: null,
    });
    let claimed = false;
    tables.__afterFirst = (row) => {
      if (!claimed && row.twilio_call_sid === PARENT) { claimed = true; row.processing_status = 'processing'; row.processing_token = 'tok'; }
    };
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_1);
    expect(row.recording_url).toBe(`${URL_1}.mp3`);
    expect(row.processing_status).toBe('processing');
    expect(row.metadata.superseded_recordings).toBeUndefined();
    expect(row.metadata.additional_recordings).toEqual([expect.objectContaining({ recording_sid: REC_2, parked_because: 'processing_status_processing' })]);
    expect(tables.triage_items).toHaveLength(1);
    jest.advanceTimersByTime(15 * 60 * 1000);
    expect(processor.processRecording).not.toHaveBeenCalled();
  });

  test('a first attach decided on a stale read is parked when a pass claims the recording-less row before the write', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: null, recording_url: null, processing_status: null, transcription: 'cached builtin text', metadata: null });
    let claimed = false;
    tables.__afterFirst = (row) => {
      if (!claimed && row.twilio_call_sid === PARENT) { claimed = true; row.processing_status = 'processing'; row.processing_token = 'tok'; }
    };
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1 }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBeNull();
    expect(row.recording_url).toBeNull();
    expect(row.metadata.additional_recordings).toEqual([expect.objectContaining({ recording_sid: REC_1, parked_because: 'processing_status_processing' })]);
    expect(tables.triage_items).toHaveLength(1);
    jest.advanceTimersByTime(15 * 60 * 1000);
    expect(processor.processRecording).not.toHaveBeenCalled();
  });

  test('a first attach that loses to a competing callback is re-decided, never dropped', async () => {
    // Callback A (REC_1) reads a recording-less row and decides "attach";
    // callback B (REC_2) attaches first. A's fenced write refuses; A must
    // re-read and decide again — here a replace, with REC_2 kept as
    // superseded — so neither recording is lost.
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: null, recording_url: null, processing_status: null, metadata: null });
    let raced = false;
    tables.__afterFirst = (row) => {
      if (!raced && row.twilio_call_sid === PARENT) {
        raced = true;
        row.recording_sid = REC_2;
        row.recording_url = `${URL_2}.mp3`;
        row.recording_duration_seconds = 80;
      }
    };
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1, RecordingDuration: '45' }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_1);
    expect(row.metadata.superseded_recordings).toEqual([expect.objectContaining({ recording_sid: REC_2, superseded_by: REC_1 })]);
    jest.advanceTimersByTime(2 * 60 * 1000 + 5);
    expect(processor.processRecording).toHaveBeenCalledWith(PARENT);
  });

  test('a duplicate delivery WITHOUT ParentCallSid (voicemail on the parent) writes nothing and never takes the Studio-recovery insert path', async () => {
    const before = {
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 45,
      processing_status: 'processed', transcription_status: 'completed', transcription: 'Agent: fixture line.', metadata: { source: 'voice_webhook' },
    };
    tables.call_log.push({ ...before });
    await post('/recording-status', recordingCallback({ CallSid: PARENT, ParentCallSid: undefined, RecordingSid: REC_1, RecordingUrl: URL_1 }));
    expect(tables.call_log).toHaveLength(1);
    expect(tables.call_log[0]).toEqual(before);
  });

  test('a park that loses to a PAN stamp between the read and the write deletes the incoming recording instead of parking it', async () => {
    // The handler reads a processed, unquarantined row and decides "park";
    // the transcription webhook stamps pan_detected before the park UPDATE
    // runs. The parked list must stay empty, no review card may name audio
    // that no longer exists, and the recording that just arrived is the one
    // deleted at Twilio.
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 45,
      processing_status: 'processed', transcription: 'Agent: fixture line.', metadata: null,
    });
    let stamped = false;
    tables.__afterFirst = (row) => {
      if (!stamped && row.twilio_call_sid === PARENT) { stamped = true; row.transcription_metadata = JSON.stringify({ pan_detected: true }); }
    };
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_1);
    expect(metaOf(row).additional_recordings).toBeUndefined();
    expect(tables.triage_items).toHaveLength(0);
    expect(processor.quarantineCardRecording).toHaveBeenCalledTimes(1);
    expect(processor.quarantineCardRecording).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', recording_sid: REC_2, recording_url: `${URL_2}.mp3` }),
      { source: 'recording_status_post_quarantine_park' },
    );
  });

  test('parking is idempotent per RecordingSid — a retried callback appends once', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: 'processing' });
    await post('/recording-status', recordingCallback());
    await post('/recording-status', recordingCallback());
    expect(tables.call_log[0].metadata.additional_recordings).toHaveLength(1);
  });

  test('a replace on a voicemail row (rejected dial-leg audio) resets processing_status so the sweep re-runs it on the new audio', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12,
      processing_status: 'voicemail', transcription_status: 'rejected', transcription: '[Recording had no usable speech; an implausible transcription was rejected.]', metadata: null,
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_2);
    expect(row.processing_status).toBeNull();
    expect(row.transcription_status).toBe('pending');
    expect(row.metadata.superseded_recordings[0]).toMatchObject({ recording_sid: REC_1 });
  });

  test('a different recording on an unprocessed row replaces it (ring-first voicemail after the dial leg) and keeps the superseded one', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12,
      processing_status: null, transcription: null, metadata: null,
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_2);
    expect(row.recording_url).toBe(`${URL_2}.mp3`);
    expect(row.recording_duration_seconds).toBe(80);
    expect(row.metadata.superseded_recordings).toHaveLength(1);
    expect(row.metadata.superseded_recordings[0]).toMatchObject({ recording_sid: REC_1, recording_duration_seconds: 12, superseded_by: REC_2 });
    jest.advanceTimersByTime(2 * 60 * 1000 + 5);
    expect(processor.processRecording).toHaveBeenCalledWith(PARENT);
  });

  test('a PAN-quarantined row never re-attaches audio: the new recording is deleted at Twilio and the masked transcript is processed', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: null, recording_url: null, processing_status: null,
      transcription: '[masked]', transcription_metadata: JSON.stringify({ pan_detected: true }),
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1 }));
    expect(tables.call_log[0].recording_url).toBeNull();
    expect(processor.quarantineCardRecording).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', recording_sid: REC_1 }),
      { source: 'recording_status_post_quarantine' },
    );
    expect(processor.processRecording).toHaveBeenCalledWith(PARENT);
  });

  test('log lines never carry a bare CallSid or RecordingSid', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: null, recording_url: null, processing_status: null });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1 }));
    const lines = [...logger.info.mock.calls, ...logger.warn.mock.calls].map((c) => String(c[0]));
    for (const line of lines) {
      expect(line).not.toContain(PARENT);
      expect(line).not.toContain(REC_1);
    }
  });
});

describe('nextCallStatus (pure) and POST /call-status', () => {
  test('a terminal status is never downgraded by a late non-terminal event', () => {
    expect(nextCallStatus('completed', 'ringing')).toBe('completed');
    expect(nextCallStatus('completed', 'in-progress')).toBe('completed');
    expect(nextCallStatus('no-answer', 'initiated')).toBe('no-answer');
  });
  test('completed is absorbing — a late failed/busy/no-answer leg callback never overwrites it', () => {
    for (const late of ['failed', 'busy', 'no-answer', 'canceled']) {
      expect(nextCallStatus('completed', late)).toBe('completed');
    }
    // An unsuccessful terminal may still advance to completed.
    expect(nextCallStatus('no-answer', 'completed')).toBe('completed');
    expect(nextCallStatus('failed', 'busy')).toBe('busy');
  });
  test('non-terminal → anything still applies', () => {
    expect(nextCallStatus('ringing', 'completed')).toBe('completed');
    expect(nextCallStatus('in-progress', 'ringing')).toBe('ringing');
    expect(nextCallStatus(null, 'completed')).toBe('completed');
    expect(nextCallStatus('completed', undefined)).toBe('completed');
  });

  test('a retried "ringing" after "completed" leaves the row completed with its duration', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, direction: 'outbound-api', status: 'completed', duration_seconds: 95 });
    await post('/call-status', { CallSid: PARENT, CallStatus: 'ringing', Direction: 'outbound-api', From: '+15555550100', To: '+15555550101' });
    expect(tables.call_log[0].status).toBe('completed');
    expect(tables.call_log[0].duration_seconds).toBe(95);
  });

  test('a late leg callback carrying CallDuration "0" keeps a completed call\'s real duration', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, direction: 'outbound-api', status: 'completed', duration_seconds: 95 });
    for (const late of [{ CallStatus: 'busy', CallDuration: '0' }, { CallStatus: 'ringing', CallDuration: '0' }, { CallStatus: 'failed' }]) {
      await post('/call-status', { CallSid: PARENT, Direction: 'outbound-api', From: '+15555550100', To: '+15555550101', ...late });
      expect(tables.call_log[0].status).toBe('completed');
      expect(tables.call_log[0].duration_seconds).toBe(95);
    }
  });

  test('a duplicate "completed" carrying CallDuration "0" keeps the real duration; a larger one advances it', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, direction: 'outbound-api', status: 'completed', duration_seconds: 95 });
    await post('/call-status', { CallSid: PARENT, CallStatus: 'completed', CallDuration: '0', Direction: 'outbound-api', From: '+15555550100', To: '+15555550101' });
    expect(tables.call_log[0]).toMatchObject({ status: 'completed', duration_seconds: 95 });
    await post('/call-status', { CallSid: PARENT, CallStatus: 'completed', CallDuration: '120', Direction: 'outbound-api', From: '+15555550100', To: '+15555550101' });
    expect(tables.call_log[0].duration_seconds).toBe(120);
  });

  test('a genuine "completed" after "ringing" still lands with its duration', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, direction: 'outbound-api', status: 'ringing', duration_seconds: 0 });
    await post('/call-status', { CallSid: PARENT, CallStatus: 'completed', CallDuration: '61', Direction: 'outbound-api', From: '+15555550100', To: '+15555550101' });
    expect(tables.call_log[0].status).toBe('completed');
    expect(tables.call_log[0].duration_seconds).toBe(61);
  });
});

describe('builtinTranscriptMayReplace (pure) and POST /transcription', () => {
  test('fills an empty row, replaces its own earlier copy, never displaces a provider transcript', () => {
    expect(builtinTranscriptMayReplace({ transcription: null })).toBe(true);
    expect(builtinTranscriptMayReplace({ transcription: 'x', transcription_provider: 'twilio_builtin' })).toBe(true);
    expect(builtinTranscriptMayReplace({ transcription: 'x', transcription_provider: null })).toBe(true);
    expect(builtinTranscriptMayReplace({ transcription: 'x', transcription_provider: 'openai' })).toBe(false);
    expect(builtinTranscriptMayReplace({ transcription: 'x', transcription_provider: 'gemini' })).toBe(false);
  });

  test('a late built-in transcription does not overwrite the diarized provider transcript the extraction ran on', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, transcription: 'Agent: fixture provider line.', transcription_provider: 'openai',
      transcription_status: 'completed', transcription_model: 'fixture-model', transcription_metadata: JSON.stringify({ provider: 'openai' }),
    });
    await post('/transcription', { CallSid: CHILD, ParentCallSid: PARENT, RecordingSid: REC_1, TranscriptionText: 'rough builtin text', TranscriptionStatus: 'completed' });
    const row = tables.call_log[0];
    expect(row.transcription).toBe('Agent: fixture provider line.');
    expect(row.transcription_provider).toBe('openai');
    expect(row.transcription_model).toBe('fixture-model');
  });

  test('the built-in transcription fills a row that has no transcript yet', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, transcription: null, transcription_provider: null });
    await post('/transcription', { CallSid: PARENT, RecordingSid: REC_1, TranscriptionText: 'rough builtin text', TranscriptionStatus: 'completed' });
    const row = tables.call_log[0];
    expect(row.transcription).toBe('rough builtin text');
    expect(row.transcription_provider).toBe('twilio_builtin');
    expect(row.transcription_status).toBe('completed');
  });

  test('a card number in the late built-in text still stamps detection and quarantines the audio, merging onto the CURRENT provenance', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, transcription: 'Agent: fixture provider line.', transcription_provider: 'openai',
      transcription_metadata: JSON.stringify({ provider: 'openai', transcript_chars: 28 }),
    });
    // The processor rewrites provenance between the webhook's read and its
    // write; the stamp must land on THAT, not on the snapshot.
    let raced = false;
    tables.__afterFirst = (row) => {
      if (!raced && row.twilio_call_sid === PARENT) { raced = true; row.transcription_metadata = JSON.stringify({ provider: 'openai', transcript_chars: 28, contact_pass_chars: 900 }); }
    };
    await post('/transcription', { CallSid: PARENT, RecordingSid: REC_1, TranscriptionText: 'card 4111 1111 1111 1111 please', TranscriptionStatus: 'completed' });
    const row = tables.call_log[0];
    expect(row.transcription).toBe('Agent: fixture provider line.');
    const meta = JSON.parse(row.transcription_metadata);
    expect(meta).toMatchObject({ provider: 'openai', transcript_chars: 28, contact_pass_chars: 900, pan_detected: true, builtin_pan_detected_after_provider_transcript: true });
    expect(processor.quarantineCardRecording).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', recording_sid: REC_1 }),
      { source: 'twilio_transcription_webhook' },
    );
  });
});
