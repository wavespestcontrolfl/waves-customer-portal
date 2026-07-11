/**
 * Re-transcription backfill — query contract + run-loop semantics.
 * No DB, no OpenAI: a capturing fake knex pins the consent/eligibility
 * filters, and an injected transcriber exercises the one-attempt-per-call
 * and guarded-upgrade rules.
 */
const { candidateQuery, runRetranscriptionBackfill, BATCH_LIMIT } = require('../services/call-retranscription-backfill');

function makeFakeDbi(candidates) {
  const calls = [];
  const updates = [];
  let firstSelect = true;
  const builder = {};
  const record = (name) => (...args) => {
    if (name === 'where' && typeof args[0] === 'function') {
      args[0].call(builder);
    } else {
      calls.push([name, args]);
    }
    return builder;
  };
  for (const m of ['where', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'limit']) {
    builder[m] = record(m);
  }
  builder.update = async (patch) => { updates.push(patch); return 1; };
  builder.then = (resolve, reject) => {
    // First awaited builder = the candidate select; later awaits are updates
    // (which resolve via .update above, not then).
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

describe('candidateQuery — mirrors the miner consent posture, one attempt ever', () => {
  test('filters: inbound + consent + recording + never-attempted + undiarized', () => {
    const dbi = makeFakeDbi([]);
    candidateQuery(dbi, { limit: 7 });
    const flat = JSON.stringify(dbi.__calls);
    expect(flat).toContain('["where",["direction","inbound"]]');
    expect(flat).toContain('["where",["call_recording_consent_disclaimer_played",true]]');
    expect(flat).toContain('["whereNotNull",["recording_url"]]');
    expect(flat).toContain('["whereNull",["retranscribed_at"]]');
    expect(flat).toMatch(/NOT ILIKE '%agent:%'/);
    expect(flat).toMatch(/NOT ILIKE '%caller:%'/);
    expect(flat).toContain('["limit",[7]]');
  });

  test('default batch cap is bounded', () => {
    expect(BATCH_LIMIT).toBeGreaterThan(0);
    expect(BATCH_LIMIT).toBeLessThanOrEqual(100);
  });
});

describe('runRetranscriptionBackfill — run-loop semantics', () => {
  const CALL = { id: 'c1', recording_url: 'https://x/rec.mp3', transcription: 'legacy text' };

  test('a diarized result upgrades the row (original preserved, guarded stamp)', async () => {
    const dbi = makeFakeDbi([CALL]);
    const out = await runRetranscriptionBackfill({
      dbi,
      transcribe: async () => ({ transcription: 'Agent: Hi!\nCaller: I have ants.' }),
    });
    expect(out).toMatchObject({ attempted: 1, upgraded: 1, unusable: 0, failed: 0 });
    expect(dbi.__updates).toHaveLength(1);
    expect(dbi.__updates[0].transcription).toContain('Agent:');
    expect(dbi.__updates[0].transcription_pre_backfill).toMatch(/COALESCE/);
    expect(dbi.__updates[0].retranscribed_at).toBe('NOW');
  });

  test('an undiarized/empty result stamps the attempt WITHOUT touching the transcript', async () => {
    const dbi = makeFakeDbi([CALL]);
    const out = await runRetranscriptionBackfill({ dbi, transcribe: async () => ({ transcription: 'no labels here' }) });
    expect(out).toMatchObject({ attempted: 1, upgraded: 0, unusable: 1 });
    expect(dbi.__updates).toHaveLength(1);
    expect(dbi.__updates[0]).toEqual({ retranscribed_at: 'NOW' });
  });

  test('a transcriber throw stamps the attempt too — dead recordings are never retried', async () => {
    const dbi = makeFakeDbi([CALL]);
    const out = await runRetranscriptionBackfill({ dbi, transcribe: async () => { throw new Error('boom'); } });
    expect(out).toMatchObject({ attempted: 1, failed: 1 });
    expect(dbi.__updates).toEqual([{ retranscribed_at: 'NOW' }]);
  });

  test('zero candidates → clean no-op (the backlog is self-terminating)', async () => {
    const dbi = makeFakeDbi([]);
    const out = await runRetranscriptionBackfill({ dbi, transcribe: async () => ({}) });
    expect(out).toMatchObject({ attempted: 0, upgraded: 0 });
    expect(dbi.__updates).toHaveLength(0);
  });
});
