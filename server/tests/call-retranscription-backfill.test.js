/**
 * Re-transcription backfill — query contract + run-loop semantics.
 * No DB, no OpenAI: a capturing fake knex pins the consent/eligibility
 * filters, and injected transcriber/implausibility fns exercise the
 * verdict-vs-retry attempt discipline and the guarded-upgrade rules.
 */
const { candidateQuery, runRetranscriptionBackfill, BATCH_LIMIT, MAX_ATTEMPTS } = require('../services/call-retranscription-backfill');

function makeFakeDbi(candidates, { attemptsAfterFailure = 1 } = {}) {
  const calls = [];
  const updates = [];
  let firstSelect = true;
  const builder = {};
  const record = (name) => (...args) => {
    if (name === 'where' && typeof args[0] === 'function') {
      args[0].call(builder, builder); // knex grouped where: builder is both `this` and the arg
    } else {
      calls.push([name, args]);
    }
    return builder;
  };
  for (const m of ['where', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereNotIn', 'select', 'orderBy', 'limit']) {
    builder[m] = record(m);
  }
  builder.update = (patch) => {
    updates.push(patch);
    const thenable = {
      returning: async () => [{ retranscribe_attempts: attemptsAfterFailure }],
      then: (resolve, reject) => Promise.resolve(1).then(resolve, reject),
    };
    return thenable;
  };
  builder.then = (resolve, reject) => {
    const rows = firstSelect ? candidates : [];
    firstSelect = false;
    return Promise.resolve(rows).then(resolve, reject);
  };
  const dbi = () => builder;
  dbi.raw = (sql) => sql;
  dbi.fn = { now: () => 'NOW' };
  dbi.__calls = calls;
  dbi.__updates = updates;
  return dbi;
}

const CALL = {
  id: 'c1',
  recording_url: 'https://x/rec.mp3',
  transcription: 'legacy text',
  recording_duration_seconds: 120,
};
const DIARIZED = 'Agent: Hi!\nCaller: I have ants.';
const notImplausible = () => false;

describe('candidateQuery — mirrors the miner posture, clear of the live processor', () => {
  test('filters: inbound + consent + recording + never-stamped + attempts cap + age + undiarized + outcome', () => {
    const dbi = makeFakeDbi([]);
    candidateQuery(dbi, { limit: 7 });
    const flat = JSON.stringify(dbi.__calls);
    expect(flat).toContain('["where",["direction","inbound"]]');
    expect(flat).toContain('["where",["call_recording_consent_disclaimer_played",true]]');
    expect(flat).toContain('["whereNull",["retranscribed_at"]]');
    expect(flat).toContain(`["where",["retranscribe_attempts","<",${MAX_ATTEMPTS}]]`);
    // 7 days = the live lane's longest retry horizon (Codex r4 P1)
    expect(flat).toMatch(/INTERVAL '7 days'/);
    expect(flat).toMatch(/NOT ILIKE '%agent:%'/);
    expect(flat).toContain('["whereNull",["call_outcome"]]');
    expect(flat).toContain('["orWhereNotIn",["call_outcome",["wrong_number","spam"]]]');
    // spam/voicemail live on processing_status WITHOUT a call_outcome stamp (Codex r3 P2)
    expect(flat).toContain('["whereNull",["processing_status"]]');
    expect(flat).toContain('["orWhereNotIn",["processing_status",["spam","voicemail"]]]');
    expect(flat).toContain('["limit",[7]]');
  });

  test('default batch cap is bounded', () => {
    expect(BATCH_LIMIT).toBeGreaterThan(0);
    expect(BATCH_LIMIT).toBeLessThanOrEqual(100);
  });
});

describe('runRetranscriptionBackfill — verdict vs retry discipline', () => {
  test('a plausible diarized result upgrades the row (original preserved, undiarized re-check in the guard)', async () => {
    const dbi = makeFakeDbi([CALL]);
    const out = await runRetranscriptionBackfill({
      dbi,
      transcribe: async () => ({ transcription: DIARIZED }),
      implausible: notImplausible,
    });
    expect(out).toMatchObject({ attempted: 1, upgraded: 1, unusable: 0, retried: 0 });
    expect(dbi.__updates).toHaveLength(1);
    expect(dbi.__updates[0].transcription).toContain('Agent:');
    expect(dbi.__updates[0].transcription_pre_backfill).toMatch(/COALESCE/);
    // Sweep-eligible rows are parked as processed so processAllPending never
    // resurrects a backfilled legacy call into live workflows (Codex r3 P1);
    // terminal statuses ride the CASE's ELSE and are preserved.
    expect(dbi.__updates[0].processing_status).toMatch(/CASE WHEN processing_status/);
    expect(dbi.__updates[0].processing_status).toMatch(/'processed'/);
    expect(dbi.__updates[0].processing_status).toMatch(/'no_transcription','extraction_failed','processing'/);
    const flat = JSON.stringify(dbi.__calls);
    expect(flat.match(/NOT ILIKE '%agent:%'/g).length).toBeGreaterThanOrEqual(2); // select AND guarded update
  });

  test('an undiarized result is a per-recording VERDICT: stamped once, transcript untouched', async () => {
    const dbi = makeFakeDbi([CALL]);
    const out = await runRetranscriptionBackfill({
      dbi,
      transcribe: async () => ({ transcription: 'no labels here' }),
      implausible: notImplausible,
    });
    expect(out).toMatchObject({ attempted: 1, upgraded: 0, unusable: 1 });
    expect(dbi.__updates).toEqual([{ retranscribed_at: 'NOW' }]);
  });

  test('an IMPLAUSIBLE diarized transcript is rejected — same hallucination guard as the live path (Codex P2)', async () => {
    const dbi = makeFakeDbi([CALL]);
    const seen = [];
    const out = await runRetranscriptionBackfill({
      dbi,
      transcribe: async () => ({ transcription: DIARIZED }),
      implausible: (text, seconds) => { seen.push(seconds); return true; },
    });
    expect(out).toMatchObject({ unusable: 1, upgraded: 0 });
    expect(seen).toEqual([120]); // real recording duration reaches the guard
    expect(dbi.__updates).toEqual([{ retranscribed_at: 'NOW' }]);
  });

  test('an openai_unlabeled_fallback result is RETRYABLE, not a verdict (Codex r2 P2)', async () => {
    const dbi = makeFakeDbi([CALL], { attemptsAfterFailure: 1 });
    const out = await runRetranscriptionBackfill({
      dbi,
      // Labeling + Gemini both transiently failed: raw text, no labels.
      transcribe: async () => ({ transcription: 'raw unlabeled words', provider: 'openai_unlabeled_fallback' }),
      implausible: notImplausible,
    });
    expect(out).toMatchObject({ attempted: 1, retried: 1, unusable: 0, upgraded: 0 });
    expect(dbi.__updates[0].retranscribed_at).toBeUndefined();
  });

  test('a transcriber THROW is an infrastructure failure: attempt counted, NOT stamped (Codex P2)', async () => {
    const dbi = makeFakeDbi([CALL], { attemptsAfterFailure: 1 });
    const out = await runRetranscriptionBackfill({ dbi, transcribe: async () => { throw new Error('rate limited'); } });
    expect(out).toMatchObject({ attempted: 1, retried: 1, exhausted: 0, unusable: 0 });
    expect(dbi.__updates).toHaveLength(1);
    expect(JSON.stringify(dbi.__updates[0])).toMatch(/retranscribe_attempts/);
    expect(dbi.__updates[0].retranscribed_at).toBeUndefined();
  });

  test('the attempts cap converts repeated failures into a permanent stamp', async () => {
    const dbi = makeFakeDbi([CALL], { attemptsAfterFailure: MAX_ATTEMPTS });
    const out = await runRetranscriptionBackfill({ dbi, transcribe: async () => { throw new Error('still down'); } });
    expect(out).toMatchObject({ exhausted: 1, retried: 0 });
    expect(dbi.__updates).toHaveLength(2); // attempt increment + verdict stamp
    expect(dbi.__updates[1]).toEqual({ retranscribed_at: 'NOW' });
  });

  test('zero candidates → clean no-op (the backlog is self-terminating)', async () => {
    const dbi = makeFakeDbi([]);
    const out = await runRetranscriptionBackfill({ dbi, transcribe: async () => ({}) });
    expect(out).toMatchObject({ attempted: 0, upgraded: 0 });
    expect(dbi.__updates).toHaveLength(0);
  });
});

describe('production export contract (Codex P1: the _test-only trap)', () => {
  test('call-recording-processor exposes transcribeRecording + isImplausibleTranscript at top level', () => {
    const processor = require('../services/call-recording-processor');
    expect(typeof processor.transcribeRecording).toBe('function');
    expect(typeof processor.isImplausibleTranscript).toBe('function');
  });
});
