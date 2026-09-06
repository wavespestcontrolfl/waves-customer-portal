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
  transcriptionMetadataWrite: jest.fn((meta) => JSON.stringify(meta)),
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
      case 'ne': return row[clause.col] !== clause.val;
      case 'null': return row[clause.col] == null;
      case 'in': return clause.vals.includes(row[clause.col]);
      case 'notin': return !clause.vals.includes(row[clause.col]);
      case 'group': return evalGroup(row, clause.clauses);
      case 'raw': {
        const sql = clause.sql;
        if (sql.includes("pan_detected') IS DISTINCT FROM 'true'")) return !isPan(row);
        if (sql.includes("pan_detected') = 'true'")) return isPan(row);
        if (sql.includes("NOT COALESCE(metadata -> 'additional_recordings'")) {
          const wanted = JSON.parse(clause.bindings[0])[0].recording_sid;
          return !(metaOf(row).additional_recordings || []).some((r) => r.recording_sid === wanted);
        }
        if (sql === 'recording_sid IS DISTINCT FROM ?') return row.recording_sid !== clause.bindings[0];
        if (sql.startsWith("(processing_status IS NULL OR processing_status NOT IN (")) {
          const names = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
          return row.processing_status == null || !names.includes(String(row.processing_status));
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
      whereNot(col, val) { clauses.push({ type: 'ne', col, val }); return sb; },
      orWhereNull(col) { clauses.push({ type: 'null', col, or: true }); return sb; },
      whereRaw(sql, bindings) { clauses.push({ type: 'raw', sql, bindings }); return sb; },
      orWhereRaw(sql, bindings) { clauses.push({ type: 'raw', sql, bindings, or: true }); return sb; },
      whereIn(col, vals) { clauses.push({ type: 'in', col, vals }); return sb; },
      whereNotIn(col, vals) { clauses.push({ type: 'notin', col, vals }); return sb; },
      clauses,
    };
    return sb;
  }

  function applyUpdate(row, patch) {
    // SQL evaluates every expression against the row BEFORE the update.
    const before = { ...row };
    for (const [k, v] of Object.entries(patch)) {
      if (v && v.__raw) {
        if (v.sql.startsWith('CASE WHEN transcription_status = \'rejected\'')) {
          // The replace path's voicemail-stamp reset.
          row[k] = (before.transcription_status === 'rejected' && before[k] === 'voicemail') ? null : before[k];
          continue;
        }
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
      whereNotIn(...a) { sb.whereNotIn(...a); return builder; },
      whereNot(...a) { sb.whereNot(...a); return builder; },
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
        // The partial unique index the real table carries: one open card per
        // (call, reason). ignore() keeps the existing one; merge() folds the
        // new parked SID into its payload the way the SQL does.
        const open = table === 'triage_items'
          ? rows.find((r) => r.call_log_id === obj.call_log_id && r.reason_code === obj.reason_code && ['open', 'in_progress'].includes(r.status))
          : null;
        const conflict = { onConflict: () => ({
          ignore: () => { if (!open) rows.push(inserted); return Promise.resolve([inserted]); },
          merge: (patch) => {
            if (!open) { rows.push(inserted); return Promise.resolve([inserted]); }
            const cur = JSON.parse(open.payload || '{}');
            const sids = new Set([...(cur.parked_recording_sids || []), ...(cur.recording_sid ? [cur.recording_sid] : []), patch.payload.bindings[0]]);
            open.payload = JSON.stringify({ ...cur, parked_recording_sids: [...sids] });
            return Promise.resolve([open]);
          },
        }) };
        // A bare insert (no onConflict) lands on await; the conflict paths
        // decide for themselves above.
        const base = Promise.resolve([inserted]);
        return Object.assign({}, conflict, { then: (res, rej) => { if (!open) rows.push(inserted); return base.then(res, rej); }, catch: (rej) => base.catch(rej) });
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
  test('a RecordingSid this row already superseded or parked is a duplicate, never a replace or a second park', () => {
    const row = { recording_sid: REC_2, recording_url: URL_2, processing_status: null, metadata: { superseded_recordings: [{ recording_sid: REC_1 }] } };
    expect(decideRecordingAttach(row, { recording_sid: REC_1 })).toEqual({ action: 'duplicate', reason: 'already_superseded' });
    const parked = { recording_sid: REC_1, recording_url: URL_1, processing_status: 'processed', metadata: { additional_recordings: [{ recording_sid: REC_2 }] } };
    expect(decideRecordingAttach(parked, { recording_sid: REC_2 })).toEqual({ action: 'duplicate', reason: 'already_parked' });
  });

  test('a finished downstream failure is load-bearing: a different recording is parked, not swapped in', () => {
    for (const status of ['customer_creation_failed', 'lead_creation_failed']) {
      expect(decideRecordingAttach({ recording_sid: REC_1, recording_url: URL_1, processing_status: status }, { recording_sid: REC_2 })).toEqual({ action: 'park', reason: `processing_status_${status}` });
    }
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
    // A processed row is settled: no pass is scheduled for a duplicate (the
    // dedup guard would skip it anyway; a settled voicemail/spam/failed row
    // it would NOT — see the settled-row test below, codex gh-r15 P1).
    jest.advanceTimersByTime(15 * 60 * 1000);
    expect(processor.processRecording).not.toHaveBeenCalled();
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
    // The call is under review the moment its card exists (r15 P2).
    expect(row.review_status).toBe('open');
    // buildTriageItem serializes the payload for the jsonb column.
    expect(JSON.parse(tables.triage_items[0].payload)).toMatchObject({ recording_sid: REC_2, kept_recording_sid: REC_1 });
    // Nothing is auto-processed against a recording the row does not carry.
    jest.advanceTimersByTime(15 * 60 * 1000);
    expect(processor.processRecording).not.toHaveBeenCalled();
  });

  test('a retry of a parked SID that an operator adopted between the read and the write is not re-parked and files no card (codex #3736 gh-r12)', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 45,
      processing_status: 'processed', transcription: 'Agent: fixture line.',
      metadata: { additional_recordings: [{ recording_sid: REC_2, recording_url: `${URL_2}.mp3`, parked_because: 'processing_status_processed' }] },
    });
    tables.triage_items.push({ id: 't1', call_log_id: 'c1', reason_code: 'additional_recording', status: 'resolved', payload: JSON.stringify({ recording_sid: REC_2 }) });
    // The handler reads REC_2 as parked and decides "already parked" (a
    // retry). Before the park write runs, the operator adopts REC_2: it
    // becomes the current recording and leaves the parked list.
    let adopted = false;
    tables.__afterFirst = (row) => {
      if (!adopted && row.twilio_call_sid === PARENT) {
        adopted = true;
        row.recording_sid = REC_2; row.recording_url = `${URL_2}.mp3`;
        row.metadata = { additional_recordings: [{ recording_sid: REC_1, recording_url: `${URL_1}.mp3`, parked_because: 'replaced_by_operator' }] };
      }
    };
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    const row = tables.call_log[0];
    // The active recording is never duplicated into the parked list…
    expect(row.recording_sid).toBe(REC_2);
    expect(row.metadata.additional_recordings.map((r) => r.recording_sid)).toEqual([REC_1]);
    // …and no spurious adoption card is filed for it (the resolved card stays as it was).
    expect(tables.triage_items).toHaveLength(1);
    expect(tables.triage_items[0].status).toBe('resolved');
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

  test('a replace decided on a stale read is parked when a downstream failure lands before the write', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: null, metadata: null });
    let landed = false;
    tables.__afterFirst = (row) => { if (!landed && row.twilio_call_sid === PARENT) { landed = true; row.processing_status = 'customer_creation_failed'; } };
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2 }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_1);
    expect(row.metadata.additional_recordings).toEqual([expect.objectContaining({ recording_sid: REC_2, parked_because: 'processing_status_customer_creation_failed' })]);
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

  test('a replace retires the old audio\'s cards but keeps missing_unit_number open, and the review flag follows the cards (codex #3764 gh-r3 P1 + #3736 gh-r14 P2)', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12,
      processing_status: null, transcription: null, metadata: null, review_status: 'open',
    });
    tables.triage_items.push(
      { id: 't-addr', call_log_id: 'c1', reason_code: 'address_unverified', status: 'open', payload: '{}' },
      { id: 't-unit', call_log_id: 'c1', reason_code: 'missing_unit_number', status: 'open', payload: '{}' },
      { id: 't-email', call_log_id: 'c1', reason_code: 'email_unverified', status: 'open', payload: '{}' },
      { id: 't-bounce', call_log_id: 'c1', reason_code: 'email_bounce_reverify', status: 'open', payload: '{}' },
    );
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    expect(tables.call_log[0].recording_sid).toBe(REC_2);
    const addr = tables.triage_items.find((t) => t.id === 't-addr');
    const unit = tables.triage_items.find((t) => t.id === 't-unit');
    expect(addr.status).toBe('resolved');
    expect(addr.resolution_note).toContain(`replaced by ${REC_2}`);
    // The owed dispatch-blocking question survives the swap — a human closes it.
    expect(unit.status).toBe('open');
    // …and so do the email-review cards: a resolved one would read as operator approval to the first-touch release gate (r4 P1).
    expect(tables.triage_items.find((t) => t.id === 't-email').status).toBe('open');
    expect(tables.triage_items.find((t) => t.id === 't-bounce').status).toBe('open');
    // …so the call stays review-open.
    expect(tables.call_log[0].review_status).toBe('open');
  });

  test('a replace whose retired cards were the last open ones clears the review flag', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12,
      processing_status: null, transcription: null, metadata: null, review_status: 'open',
    });
    tables.triage_items.push({ id: 't-addr', call_log_id: 'c1', reason_code: 'address_unverified', status: 'open', payload: '{}' });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    expect(tables.triage_items.find((t) => t.id === 't-addr').status).toBe('resolved');
    expect(tables.call_log[0].review_status).toBeNull();
  });

  test('a retry of a parked SID whose first delivery lost its card files the card AND opens the call for review (hook P1 on r15)', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 45,
      processing_status: 'processed', transcription: 'Agent: fixture line.', review_status: null,
      metadata: { additional_recordings: [{ recording_sid: REC_2, recording_url: `${URL_2}.mp3`, parked_because: 'processing_status_processed' }] },
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    expect(tables.triage_items).toHaveLength(1);
    expect(tables.triage_items[0]).toMatchObject({ call_log_id: 'c1', reason_code: 'additional_recording', status: 'open' });
    expect(tables.call_log[0].review_status).toBe('open');
    // Still exactly one parked entry — the retry appended nothing.
    expect(tables.call_log[0].metadata.additional_recordings).toHaveLength(1);
  });

  test('a duplicate delivery for a settled row (voicemail) schedules no pass; one for a row still awaiting a pass does (codex #3736 gh-r15 P1)', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 45,
      processing_status: 'voicemail', transcription_status: 'completed', transcription: 'Agent: fixture line.', metadata: { source: 'voice_webhook' },
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1, RecordingDuration: '45' }));
    jest.advanceTimersByTime(15 * 60 * 1000);
    expect(processor.processRecording).not.toHaveBeenCalled();
    // The same duplicate on a row whose first pass was lost is what recovers it.
    tables.call_log[0].processing_status = null;
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1, RecordingDuration: '45' }));
    jest.advanceTimersByTime(15 * 60 * 1000);
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
    // The incoming recording AND the row's own (with every parked one) go.
    expect(processor.quarantineCardRecording).toHaveBeenCalledTimes(2);
    expect(processor.quarantineCardRecording).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ id: 'c1', recording_sid: REC_2, recording_url: `${URL_2}.mp3` }),
      { source: 'recording_status_post_quarantine_park' },
    );
    expect(processor.quarantineCardRecording).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ id: 'c1', recording_sid: REC_1 }),
      { source: 'recording_status_post_quarantine_park' },
    );
  });

  test('parking is idempotent per RecordingSid — a retried callback appends once and files no second card (a resolved card stays resolved)', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: 'processing' });
    await post('/recording-status', recordingCallback());
    expect(tables.triage_items).toHaveLength(1);
    // The office resolved the card; the carrier retries the same callback.
    tables.triage_items[0].status = 'resolved';
    await post('/recording-status', recordingCallback());
    expect(tables.call_log[0].metadata.additional_recordings).toHaveLength(1);
    expect(tables.triage_items).toHaveLength(1);
    expect(tables.triage_items[0].status).toBe('resolved');
  });

  test('a retry after the first delivery parked the recording but its card insert failed files the card', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: 'processing' });
    await post('/recording-status', recordingCallback());
    expect(tables.triage_items).toHaveLength(1);
    // The card never landed (transient DB error on the first delivery).
    tables.triage_items.length = 0;
    await post('/recording-status', recordingCallback());
    expect(tables.call_log[0].metadata.additional_recordings).toHaveLength(1);
    expect(tables.triage_items).toHaveLength(1);
    expect(tables.triage_items[0]).toMatchObject({ call_log_id: 'c1', reason_code: 'additional_recording', status: 'open' });
  });

  test('a retry that must file the lost card and cannot answers 500 too', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: 'processing' });
    await post('/recording-status', recordingCallback());
    tables.triage_items.length = 0;
    // The recovered card and the review flag are filed in one transaction
    // (hook P1 on r15); the insert inside it fails.
    const realTx = db.transaction;
    db.transaction = jest.fn(async (fn) => fn(Object.assign((t) => {
      const b = db(t);
      if (t === 'triage_items') b.insert = () => ({ onConflict: () => ({ ignore: () => Promise.reject(new Error('deadlock detected')) }) });
      return b;
    }, { raw: db.raw })));
    const res = await post('/recording-status', recordingCallback());
    expect(res.sendStatus).toHaveBeenCalledWith(500);
    db.transaction = realTx;
  });

  test('a retry of a recording REC2 already replaced does not replace REC2 back', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: null, metadata: null });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2 }));
    expect(tables.call_log[0].recording_sid).toBe(REC_2);
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1 }));
    expect(tables.call_log[0].recording_sid).toBe(REC_2);
    expect(tables.call_log[0].metadata.additional_recordings).toBeUndefined();
    expect(tables.triage_items).toHaveLength(0);
  });

  test('a replace clears the old transcript, its structure and provider with the swap', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: null,
      transcription: 'Agent: old words.', transcript_structured: { segments: [] }, transcription_provider: 'openai', transcription_metadata: null,
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2 }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_2);
    expect(row.transcription).toBeNull();
    expect(row.transcript_structured).toBeNull();
    expect(row.transcription_provider).toBeNull();
    expect(row.ai_extraction).toBeNull();
    expect(row.call_summary).toBeNull();
    expect(row.lead_synopsis).toBeNull();
  });

  test('a replace whose transaction fails answers 500 so Twilio redelivers — the new SID is stored nowhere (codex #3736 gh-r16 P1)', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: null, transcription: null, metadata: null });
    const realTx = db.transaction;
    db.transaction = jest.fn(async (fn) => fn(Object.assign((t) => {
      const b = db(t);
      if (t === 'call_log') b.update = () => Promise.reject(new Error('deadlock detected'));
      return b;
    }, { raw: db.raw })));
    const res = await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    expect(res.sendStatus).toHaveBeenCalledWith(500);
    db.transaction = realTx;
    expect(tables.call_log[0].recording_sid).toBe(REC_1);
    // The redelivery lands it.
    const again = await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    expect(again.sendStatus).toHaveBeenCalledWith(200);
    expect(tables.call_log[0].recording_sid).toBe(REC_2);
  });

  test('a park whose review card cannot be filed answers 500 so Twilio retries; the retry parks and files it', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: 'processing' });
    const realTx = db.transaction;
    db.transaction = jest.fn(async (fn) => fn(Object.assign((t) => {
      const b = db(t);
      if (t === 'triage_items') b.insert = () => { throw new Error('deadlock detected'); };
      return b;
    }, { raw: db.raw })));
    const res = await post('/recording-status', recordingCallback());
    expect(res.sendStatus).toHaveBeenCalledWith(500);
    db.transaction = realTx;
    const again = await post('/recording-status', recordingCallback());
    expect(again.sendStatus).toHaveBeenCalledWith(200);
    expect(tables.call_log[0].metadata.additional_recordings).toHaveLength(1);
    expect(tables.triage_items).toHaveLength(1);
  });

  test('a second parked recording rides the open review card instead of hiding behind it', async () => {
    const REC_3 = 'RE' + '3'.repeat(32);
    const URL_3 = `https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/${REC_3}`;
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, processing_status: 'processed' });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2 }));
    await post('/recording-status', recordingCallback({ RecordingSid: REC_3, RecordingUrl: URL_3 }));
    expect(tables.call_log[0].metadata.additional_recordings.map((r) => r.recording_sid)).toEqual([REC_2, REC_3]);
    expect(tables.triage_items).toHaveLength(1);
    expect(JSON.parse(tables.triage_items[0].payload).parked_recording_sids.sort()).toEqual([REC_2, REC_3].sort());
  });

  test('a replace on a voicemail row (rejected dial-leg audio) resets processing_status so the sweep re-runs it on the new audio', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12,
      processing_status: 'voicemail', transcription_status: 'rejected', transcription: '[Recording had no usable speech; an implausible transcription was rejected.]', metadata: null,
      extraction_attempts: 3, disposition: 'spam_discarded',
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    const row = tables.call_log[0];
    expect(row.recording_sid).toBe(REC_2);
    expect(row.processing_status).toBeNull();
    // The old audio's terminal disposition goes with it (codex gh-r17 P2).
    expect(row.disposition).toBeNull();
    // The retry budget was spent on the OLD audio (codex #3736 gh-r11).
    expect(row.extraction_attempts).toBe(0);
    expect(row.transcription_status).toBe('pending');
    expect(row.metadata.superseded_recordings[0]).toMatchObject({ recording_sid: REC_1 });
  });

  test('a replace retires the review cards the OLD audio raised and keeps the additional_recording card (codex #3736 gh-r10)', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12, processing_status: 'extraction_failed', transcription: null, metadata: null });
    tables.triage_items.push(
      { id: 't1', call_log_id: 'c1', reason_code: 'address_recovered', status: 'open', payload: '{}' },
      { id: 't2', call_log_id: 'c1', reason_code: 'additional_recording', status: 'open', payload: '{}' },
      { id: 't3', call_log_id: 'c1', reason_code: 'customer_creation_failed', status: 'resolved', payload: '{}' },
      { id: 't4', call_log_id: 'other', reason_code: 'address_recovered', status: 'open', payload: '{}' },
    );
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    expect(tables.call_log[0].recording_sid).toBe(REC_2);
    const byId = Object.fromEntries(tables.triage_items.map((t) => [t.id, t]));
    expect(byId.t1).toMatchObject({ status: 'resolved', resolution_note: expect.stringContaining(REC_2) });
    expect(byId.t2.status).toBe('open');
    expect(byId.t3.resolution_note).toBeUndefined();
    expect(byId.t4.status).toBe('open');
  });

  test('a replace clears the voicemail stamps a REJECTED transcript produced, and keeps the ones Twilio stamped (codex #3736 gh-r6)', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12,
      processing_status: 'voicemail', transcription_status: 'rejected', answered_by: 'voicemail', call_outcome: 'voicemail',
      transcription: '[Recording had no usable speech; an implausible transcription was rejected.]', metadata: null,
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    expect(tables.call_log[0]).toMatchObject({ recording_sid: REC_2, answered_by: null, call_outcome: null });

    // Control: a voicemail stamped by the dial completion (no rejection) is
    // evidence about the call, not the discarded audio — it stays.
    tables.call_log.length = 0;
    tables.call_log.push({
      id: 'c2', twilio_call_sid: PARENT, recording_sid: REC_1, recording_url: `${URL_1}.mp3`, recording_duration_seconds: 12,
      processing_status: null, transcription_status: 'pending', answered_by: 'voicemail', call_outcome: 'voicemail', transcription: null, metadata: null,
    });
    await post('/recording-status', recordingCallback({ RecordingSid: REC_2, RecordingUrl: URL_2, RecordingDuration: '80' }));
    expect(tables.call_log[0]).toMatchObject({ recording_sid: REC_2, answered_by: 'voicemail', call_outcome: 'voicemail' });
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

  test('a row PAN-stamped between the read and the guarded write (the Studio race) deletes the arriving recording AND the row\'s current one now, not at the next sweep', async () => {
    tables.call_log.push({
      id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_2, recording_url: `${URL_2}.mp3`, recording_duration_seconds: 30, processing_status: null,
      transcription: null, transcription_metadata: null, metadata: null,
    });
    let raced = false;
    tables.__afterFirst = (row) => {
      if (!raced && row.twilio_call_sid === PARENT) { raced = true; row.transcription_metadata = JSON.stringify({ pan_detected: true }); }
    };
    await post('/recording-status', recordingCallback({ RecordingSid: REC_1, RecordingUrl: URL_1, RecordingDuration: '45' }));
    expect(tables.call_log[0].recording_sid).toBe(REC_2);
    expect(processor.quarantineCardRecording).toHaveBeenCalledTimes(2);
    expect(processor.quarantineCardRecording).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'c1', recording_sid: REC_1 }), { source: 'recording_status_post_quarantine' });
    expect(processor.quarantineCardRecording).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'c1', recording_sid: REC_2 }), { source: 'recording_status_post_quarantine' });
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
    // …then the row as it is (its own recording and every parked one).
    expect(processor.quarantineCardRecording).toHaveBeenCalledTimes(2);
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
    // Sandy PR 2A: the relay's own transcript yields to the recording's text ONLY on a transferred row whose AI segment is stashed.
    const stashed = { relay_transcript: { text: 'Agent: hi' }, relay_handoff: {} };
    expect(builtinTranscriptMayReplace({ transcription: 'Agent: hi', transcription_provider: 'conversation_relay', metadata: stashed })).toBe(true);
    expect(builtinTranscriptMayReplace({ transcription: 'Agent: hi', transcription_provider: 'conversation_relay', metadata: JSON.stringify(stashed) })).toBe(true);
    expect(builtinTranscriptMayReplace({ transcription: 'Agent: hi', transcription_provider: 'conversation_relay', metadata: { relay_handoff: {} } })).toBe(false); // not stashed
    expect(builtinTranscriptMayReplace({ transcription: 'Agent: hi', transcription_provider: 'conversation_relay', metadata: { relay_transcript: { text: 'Agent: hi' } } })).toBe(false); // not a transfer, not reconnected
    expect(builtinTranscriptMayReplace({ transcription: 'Agent: hi', transcription_provider: 'conversation_relay', metadata: { relay_transcript: { text: 'Agent: hi' }, relay_reconnects: 1 } })).toBe(true); // a reconnected call's voicemail (PR 2B)
    expect(builtinTranscriptMayReplace({ transcription: 'Agent: hi', transcription_provider: 'conversation_relay', metadata: { relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Agent: hi' }] } })).toBe(true); // …preserved in durable segments (a silent resumed leg wrote no stash)
    expect(builtinTranscriptMayReplace({ transcription: 'Agent: hi', transcription_provider: 'conversation_relay', metadata: { relay_reconnects: 1, relay_segments: [{ generation: 1, text: '' }] } })).toBe(false); // an empty segment preserves nothing
    expect(builtinTranscriptMayReplace({ transcription: 'Agent: hi', transcription_provider: 'conversation_relay' })).toBe(false);
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

  test('a late built-in transcript for a recording the row no longer carries is kept out of the new recording\'s row', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_2, transcription: null, transcription_provider: null });
    await post('/transcription', { CallSid: PARENT, RecordingSid: REC_1, TranscriptionText: 'words from the replaced audio', TranscriptionStatus: 'completed' });
    expect(tables.call_log[0].transcription).toBeNull();
    // The current recording's own transcript still lands.
    await post('/transcription', { CallSid: PARENT, RecordingSid: REC_2, TranscriptionText: 'words from the current audio', TranscriptionStatus: 'completed' });
    expect(tables.call_log[0].transcription).toBe('words from the current audio');
  });

  test('a PAN-bearing late transcript for a replaced recording quarantines that recording AND the row\'s current one', async () => {
    tables.call_log.push({ id: 'c1', twilio_call_sid: PARENT, recording_sid: REC_2, recording_url: `${URL_2}.mp3`, transcription: null, transcription_provider: null, transcription_metadata: null });
    await post('/transcription', { CallSid: PARENT, RecordingSid: REC_1, TranscriptionText: 'my card is 4242 4242 4242 4242', TranscriptionStatus: 'completed' });
    // Stale text kept out of the row; the stamp still lands and both recordings go.
    expect(tables.call_log[0].transcription).toBeNull();
    expect(processor.quarantineCardRecording).toHaveBeenCalledTimes(2);
    expect(processor.quarantineCardRecording).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'c1', recording_sid: REC_1, recording_url: null }), { source: 'twilio_transcription_webhook' });
    expect(processor.quarantineCardRecording).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'c1', recording_sid: REC_2 }), { source: 'twilio_transcription_webhook' });
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
