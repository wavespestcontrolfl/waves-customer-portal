// The call sound check job (services/call-sound-check.js) against real PostgreSQL, one rolled-back transaction per test.
// The job keeps its state in call_log.metadata.sound_check and reads it back with raw jsonb SQL: which calls are
// candidates, the write that lands only while a call has no record, and the ET day's spend. A mocked knex cannot
// show a rejected parse, a wrong jsonb path or a claim that does not hold. The model adapter (llm/call.js) is mocked,
// and the download and the MP3 length read are fakes passed in: no network, no spend, no customer.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn(), rejectCall: jest.fn() }));

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const logger = require('../services/logger');
const llm = require('../services/llm/call');
const MODELS = require('../config/models');
const llmCost = require('../services/llm-cost');
const { VOICE_RELAY_SANDBOX_SOURCE, TECH_VOICE_SOURCE } = require('../services/voice-agent/relay-protocol');
const soundCheck = require('../services/call-sound-check');

const KEY = soundCheck.METADATA_KEY;
const MODEL_KEY = llmCost.normalizeModelId(MODELS.ROUTES.callSoundCheck.model);
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2027-01-15T18:00:00.000Z'); // 13:00 ET
const DAY = '2027-01-15';
const ago = (hours) => new Date(NOW.getTime() - hours * HOUR);
// The price row every test starts with, and the same price as the job reads it back.
const PRICE = { input: 3, output: 15, cacheRead: 0.15, cacheWrite: null, reasoning: 15, audioInput: 3, tiers: [] };
const reserveFor = (seconds) => Math.round(soundCheck.worstCaseUsd(PRICE, seconds) * 1e6) / 1e6;
const AUDIO = Buffer.from('fixture bytes, not a real recording');
const ANSWER = {
  no_conversation: false, caller_tone_start: 'worried', caller_tone_end: 'calm', caller_upset: false,
  talk_over_count: 1, agent_sounded_rushed: false, risky_claim: { flag: true, what: 'Said the spray is safe for pets.' },
};
const USAGE = { input_tokens: 4500, cached_input_tokens: 0, output_tokens: 120, reasoning_tokens: 300 };
const USAGE_COST = 0.0198; // (4,500 x $3 + 120 x $15 + 300 x $15) per 1M tokens
// What the model adapter hands back for a good listen.
const answer = (extra = {}) => ({ ok: true, json: ANSWER, model: 'listening-model', usage: USAGE, ...extra });
const TALLY = { done: 0, failed: 0, skipped: 0, capped: 0 };
const record = (fields) => ({ day: DAY, at: NOW.toISOString(), recording_url: expect.stringMatching(/^https:\/\/api\.twilio\.com\//), ...fields });
// The model's answer for the test (llm.dispatch), and the download and the MP3 length read the job is run with.
const fakes = ({ dispatch = async () => answer(), ...over } = {}) => {
  llm.dispatch.mockReset().mockImplementation(dispatch);
  return { download: jest.fn(async () => AUDIO), audioSeconds: jest.fn(() => 120), ...over };
};

afterEach(() => { delete process.env.GATE_CALL_SOUND_CHECK; });

describe('call sound check (no database)', () => {
  test.each([undefined, '', '1', 'TRUE', 'yes'])('gate %p: no query, no download, no model call', async (value) => {
    if (value !== undefined) process.env.GATE_CALL_SOUND_CHECK = value;
    const conn = jest.fn(() => { throw new Error('queried with the gate off'); });
    const f = fakes();
    expect(await soundCheck.runCallSoundCheck({ conn, ...f })).toEqual({ skipped: true, reason: 'gated_off' });
    for (const fn of [conn, f.download, f.audioSeconds, llm.dispatch]) expect(fn).not.toHaveBeenCalled();
  });

  test('the scheduler runs the job under its own lock, and reads the gate before it takes the lock', () => {
    const scheduler = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    const at = scheduler.indexOf("runExclusive('call-sound-check'");
    const tick = scheduler.slice(scheduler.lastIndexOf('cron.schedule(', at), at + 120);
    expect(tick).toContain("require('./call-sound-check').runCallSoundCheck()");
    expect(tick).toContain('callSoundCheckLive()');
    expect(tick.indexOf('callSoundCheckLive()')).toBeLessThan(tick.indexOf('runExclusive('));
  });
});

postgres('call sound check (live Postgres)', () => {
  jest.setTimeout(30000);
  let database;
  let trx;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's: the managed runner sets both marks and names
    // the database after the worktree id (scripts/dev/context.js, scripts/qa/server.js). Or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its settings, so ?host=, ?port= or
    // ?connectionString= would name another server than the one checked above. A URL with a query is refused,
    // and the pool gets the parts this guard read, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_CALL_SOUND_CHECK = 'true';
    trx = await database.transaction();
    await trx('llm_model_prices').where({ model_key: MODEL_KEY }).del();
    await trx('llm_model_prices').insert({
      model_key: MODEL_KEY, provider: 'gemini', source: 'fixture', source_model_id: 'fixture/listening-model',
      input_per_mtok: PRICE.input, output_per_mtok: PRICE.output, cache_read_per_mtok: PRICE.cacheRead, reasoning_per_mtok: PRICE.reasoning, audio_input_per_mtok: PRICE.audioInput, fetched_at: NOW,
    });
  });

  afterEach(async () => {
    await trx.rollback();
  });

  // An ordinary processed call with a 120-second recording, one hour old. `metadata: null` stores no metadata.
  const insertCall = async ({ metadata = {}, transcription_metadata: flagged, ...rest } = {}) => {
    const id = randomUUID();
    await trx('call_log').insert({
      id,
      direction: 'inbound',
      from_phone: '+15555550100',
      processing_status: 'processed',
      recording_url: `https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/RE${id.replaceAll('-', '')}.mp3`,
      recording_duration_seconds: 120,
      duration_seconds: 126,
      created_at: ago(1),
      updated_at: ago(1),
      metadata: metadata === null ? null : JSON.stringify(metadata),
      ...(flagged ? { transcription_metadata: JSON.stringify(flagged) } : {}),
      ...rest,
    });
    return id;
  };
  const metadataOf = async (id) => (await trx('call_log').where({ id }).first('metadata')).metadata;
  const recordOf = async (id) => (await metadataOf(id))?.[KEY];
  const SPEND = 'call_sound_check_spend';
  // An earlier attempt of the day, settled, on a call row that no longer exists.
  const spentToday = (usd, day = DAY) => trx(SPEND).insert({ call_id: randomUUID(), day, reserved_usd: usd, spent_usd: usd });
  const spendRows = () => trx(SPEND).orderBy('id').select('call_id', trx.raw('day::text AS day'), trx.raw('reserved_usd::float AS reserved_usd'), trx.raw('spent_usd::float AS spent_usd'));
  const run = (f, now = NOW) => soundCheck.runCallSoundCheck({ conn: trx, now, ...f });

  test("a listen saves the note, the model, the usage and its cost beside the call's other metadata, once", async () => {
    const id = await insertCall({ metadata: { relay_handoff: { kept: true } } });
    const f = fakes();
    expect(await run(f)).toEqual({ ...TALLY, done: 1 });

    expect(f.download).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/), 120);
    // the downloaded bytes are what the model hears, within the output limit the reserve is priced for
    expect(llm.dispatch.mock.calls[0][1]).toMatchObject({ audio: [{ mimeType: 'audio/mpeg', data: AUDIO.toString('base64') }], maxTokens: 4096 });
    expect(await metadataOf(id)).toEqual({
      relay_handoff: { kept: true },
      [KEY]: record({ status: 'done', note: ANSWER, model: 'listening-model', prompt_version: expect.any(String), usage: USAGE, spent_usd: USAGE_COST }),
    });

    expect(await run(f)).toEqual(TALLY);
    expect(llm.dispatch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the audio is longer than the call row says', 300, AUDIO, 300],
    ['the audio is shorter than the call row says', 30, AUDIO, 60],
    ['the file has no readable MP3 header (its size bounds its length)', null, Buffer.alloc(200 * 1000), 200],
  ])('while the model is asked the call holds a claim with the worst cost: %s', async (_label, audioSeconds, audio, pricedSeconds) => {
    const id = await insertCall({ recording_duration_seconds: 60 });
    let during;
    const f = fakes({
      download: jest.fn(async () => audio),
      audioSeconds: jest.fn(() => audioSeconds),
      dispatch: async () => { during = await recordOf(id); return answer(); },
    });
    await run(f);
    expect(during).toEqual(record({ status: 'started', reserved_usd: reserveFor(pricedSeconds) }));
    expect(await recordOf(id)).toEqual(expect.objectContaining({ status: 'done', spent_usd: USAGE_COST }));
    expect(await recordOf(id)).not.toHaveProperty('reserved_usd');
  });

  test('only a processed, recorded, ordinary call with no record is a candidate', async () => {
    const never = {
      'still in the pipeline': { processing_status: 'processing' },
      'a voicemail': { processing_status: 'voicemail' },
      'spam': { processing_status: 'spam' },
      'held by a re-process': { processing_token: 'held' },
      'the voice agent sandbox line': { source: VOICE_RELAY_SANDBOX_SOURCE },
      'the tech voice line': { source: TECH_VOICE_SOURCE },
      'no recording': { recording_url: null },
      'a blank recording URL': { recording_url: '  ' },
      'a recording under 20 seconds': { recording_duration_seconds: 19 },
      'a call under 20 seconds with no recording length': { recording_duration_seconds: null, duration_seconds: 19 },
      'flagged for card data': { transcription_metadata: { pan_detected: true } },
      'flagged for card data by live transcription': { metadata: { live_transcription: { pan_detected: true } } },
      'quarantined by live transcription': { metadata: { live_transcription: { quarantined_at: ago(1).toISOString() } } },
      'paused for a card by live transcription': { metadata: { live_transcription: { card_pause: { paused_at: ago(1).toISOString(), resumed_at: ago(1).toISOString() } } } },
      'older than 48 hours': { created_at: ago(49) },
      'done': { metadata: { [KEY]: { status: 'done' } } },
      'failed': { metadata: { [KEY]: { status: 'failed' } } },
      'skipped': { metadata: { [KEY]: { status: 'skipped' } } },
      'claimed and never finished': { metadata: { [KEY]: { status: 'started', reserved_usd: 0.07, at: ago(30).toISOString() } } },
      'metadata that is not an object': { metadata: [] },
    };
    const rows = [];
    for (const [label, overrides] of Object.entries(never)) {
      const id = await insertCall(overrides);
      rows.push({ label, id, before: await metadataOf(id) });
    }
    const f = fakes();
    expect(await run(f)).toEqual(TALLY);
    expect(f.download).not.toHaveBeenCalled();
    expect(llm.dispatch).not.toHaveBeenCalled();
    const changed = [];
    for (const row of rows) if (JSON.stringify(await metadataOf(row.id)) !== JSON.stringify(row.before)) changed.push(row.label);
    expect(changed).toEqual([]);
  });

  test('a tick checks the three oldest calls; the next tick takes the rest (a call with no metadata included)', async () => {
    const ids = [];
    for (const hours of [4, 3, 2, 1]) ids.push(await insertCall({ created_at: ago(hours), ...(hours === 4 ? { metadata: null } : {}) }));
    const f = fakes();
    expect(await run(f)).toEqual({ ...TALLY, done: 3 });
    expect((await recordOf(ids[0])).status).toBe('done');
    expect(await recordOf(ids[3])).toBeUndefined();
    expect(await run(f)).toEqual({ ...TALLY, done: 1 });
  });

  test('a failed listen is recorded with what it cost and is never tried again', async () => {
    const noUsage = await insertCall({ created_at: ago(2) });
    const withUsage = await insertCall({ created_at: ago(1) });
    const f = fakes({
      dispatch: jest.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'gemini_503' })
        .mockResolvedValueOnce({ ok: false, reason: 'gemini_incomplete', usage: USAGE }),
    });
    expect(await run(f)).toEqual({ ...TALLY, failed: 2 });
    // no usage reported: the whole reserve counts
    expect(await recordOf(noUsage)).toEqual(record({ status: 'failed', reason: 'gemini_503', spent_usd: reserveFor(120) }));
    expect(await recordOf(withUsage)).toEqual(record({ status: 'failed', reason: 'gemini_incomplete', spent_usd: USAGE_COST }));
    expect(await run(f)).toEqual(TALLY);
    expect(llm.dispatch).toHaveBeenCalledTimes(2);
  });

  test('with no Gemini key nothing was sent: the claim is taken back, the tick stops, and the call is heard once the key is back', async () => {
    const first = await insertCall({ created_at: ago(2), metadata: { relay_handoff: { kept: true } } });
    const second = await insertCall({ created_at: ago(1) });
    await expect(run(fakes({ dispatch: async () => ({ ok: false, reason: 'no_key' }) }))).rejects.toThrow(/no Gemini API key/);
    expect(llm.dispatch).toHaveBeenCalledTimes(1);
    expect(await metadataOf(first)).toEqual({ relay_handoff: { kept: true } });
    expect(await recordOf(second)).toBeUndefined();

    expect(await run(fakes())).toEqual({ ...TALLY, done: 2 });
    expect((await recordOf(first)).status).toBe('done');
  });

  test('an answer in the wrong shape is a failed listen at its usage cost; a good answer with no usage costs its reserve', async () => {
    const wrongShape = await insertCall({ created_at: ago(2) });
    const noUsage = await insertCall({ created_at: ago(1) });
    const f = fakes({
      dispatch: jest.fn()
        .mockResolvedValueOnce(answer({ json: { ...ANSWER, talk_over_count: 'twice' } }))
        .mockResolvedValueOnce(answer({ usage: undefined })),
    });
    expect(await run(f)).toEqual({ ...TALLY, done: 1, failed: 1 });
    expect(await recordOf(wrongShape)).toEqual(record({ status: 'failed', reason: 'invalid_note', spent_usd: USAGE_COST }));
    expect(await recordOf(noUsage)).toEqual(expect.objectContaining({ status: 'done', usage: null, spent_usd: reserveFor(120) }));
  });

  test('usage with no counts (the adapter\'s shape for a reply with no usageMetadata) costs the whole reserve', async () => {
    const id = await insertCall();
    const nulls = { input_tokens: null, cached_input_tokens: null, cache_write_tokens: null, output_tokens: null, reasoning_tokens: null };
    const f = fakes({ dispatch: async () => answer({ usage: nulls }) });
    expect(await run(f)).toEqual({ ...TALLY, done: 1 });
    expect(await recordOf(id)).toEqual(expect.objectContaining({ status: 'done', spent_usd: reserveFor(120) }));
  });

  test('a claim is charged to the ET day it is written in: a tick that runs past midnight uses the new day and its room', async () => {
    const before = new Date('2027-01-16T04:58:00.000Z'); // 23:58 ET on the 15th
    const after = new Date('2027-01-16T05:01:00.000Z'); // 00:01 ET on the 16th
    await insertCall({ created_at: new Date(before.getTime() - HOUR) });
    await insertCall({ created_at: new Date(before.getTime() - HOUR / 2) });
    // the 15th has no room left; the 16th has spent nothing
    await spentToday(soundCheck.DAILY_CAP_USD, '2027-01-15');
    const clock = jest.fn().mockReturnValueOnce(before).mockReturnValue(after);
    const f = fakes();
    const tally = await soundCheck.runCallSoundCheck({ conn: trx, clock, ...f });
    expect(tally).toEqual({ ...TALLY, done: 2 });
    const days = (await trx('call_log').whereRaw("metadata->:key->>'status' = 'done'", { key: KEY }).select(trx.raw("metadata->:key->>'day' AS day", { key: KEY }))).map((r) => r.day).sort();
    expect(days).toEqual(['2027-01-16', '2027-01-16']);
    expect((await spendRows()).map((r) => r.day)).toEqual(['2027-01-15', '2027-01-16', '2027-01-16']);
  });

  test('the day stops at the cap: a call that does not fit is left alone, and the next ET day has room', async () => {
    // $0.76 so far today, $0.26 of it an unfinished claim. The call's worst cost is about $0.077; the cap is $0.83.
    await spentToday(0.5);
    await trx(SPEND).insert({ call_id: await insertCall({ metadata: { [KEY]: { status: 'started', reserved_usd: 0.26, day: DAY } } }), day: DAY, reserved_usd: 0.26 });
    const id = await insertCall();
    const f = fakes();
    expect(await run(f)).toEqual({ ...TALLY, capped: 1 });
    expect(f.download).not.toHaveBeenCalled();
    expect(llm.dispatch).not.toHaveBeenCalled();
    expect(await recordOf(id)).toBeUndefined();

    expect(await run(f, new Date(NOW.getTime() + 24 * HOUR))).toEqual({ ...TALLY, done: 1 });
    expect((await recordOf(id)).day).toBe('2027-01-16');
  });

  test("the cap counts the audio's own length: a call that fits by its row but not by its audio is not sent", async () => {
    await spentToday(0.65);
    const id = await insertCall({ recording_duration_seconds: 60 });
    const f = fakes({ audioSeconds: jest.fn(() => 1700) });
    expect(await run(f)).toEqual({ ...TALLY, capped: 1 });
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(llm.dispatch).not.toHaveBeenCalled();
    expect(await recordOf(id)).toBeUndefined();
  });

  test('the cost of a failed listen counts for the next call of the same tick, and a capped call stops the tick', async () => {
    await spentToday(0.68);
    await insertCall({ created_at: ago(3) });
    const second = await insertCall({ created_at: ago(2) });
    const third = await insertCall({ created_at: ago(1) });
    const f = fakes({ dispatch: async () => ({ ok: false, reason: 'gemini_timeout' }) });
    expect(await run(f)).toEqual({ ...TALLY, failed: 1, capped: 1 });
    expect(llm.dispatch).toHaveBeenCalledTimes(1);
    expect([await recordOf(second), await recordOf(third)]).toEqual([undefined, undefined]);
  });

  test.each([
    ['a recording that is not an MP3', { recording_url: 'https://api.twilio.com/2010-04-01/Recordings/REfixture.wav' }, {}, 'not_mp3', 0],
    ['a recording on another host', { recording_url: 'https://example.com/2010-04-01/Recordings/REfixture.mp3' }, {}, 'not_twilio_url', 0],
    ['a Twilio URL with a port', { recording_url: 'https://api.twilio.com:8443/2010-04-01/Recordings/REfixture.mp3' }, {}, 'not_twilio_url', 0],
    ['a call over 30 minutes', { recording_duration_seconds: 1801 }, {}, 'too_long', 0],
    ['audio over 30 minutes, whatever the call row says', {}, { audioSeconds: () => 1801 }, 'too_long', 1],
    ['a file over 12 MB', {}, { download: async () => Buffer.alloc(12 * 1024 * 1024 + 1) }, 'too_long', 1],
    ['a large file with no readable MP3 header', {}, { download: async () => Buffer.alloc(1801 * 1000), audioSeconds: () => null }, 'too_long', 1],
  ])('%s gets a skipped record and is never sent', async (_label, call, fake, reason, downloads) => {
    const id = await insertCall(call);
    const f = fakes(Object.fromEntries(Object.entries(fake).map(([name, fn]) => [name, jest.fn(fn)])));
    expect(await run(f)).toEqual({ ...TALLY, skipped: 1 });
    expect(await recordOf(id)).toEqual(record({ status: 'skipped', reason, recording_url: (await trx('call_log').where({ id }).first('recording_url')).recording_url }));
    expect(f.download).toHaveBeenCalledTimes(downloads);
    expect(await run(f)).toEqual(TALLY);
    expect(llm.dispatch).not.toHaveBeenCalled();
  });

  test('a download that fails is a failed attempt at no cost, with no model call', async () => {
    const id = await insertCall();
    const f = fakes({ download: jest.fn(async () => { throw new Error('Download failed: 503'); }) });
    expect(await run(f)).toEqual({ ...TALLY, failed: 1 });
    expect(await recordOf(id)).toEqual(record({ status: 'failed', reason: 'download_failed' }));
    expect(await run(f)).toEqual(TALLY);
    expect(llm.dispatch).not.toHaveBeenCalled();
  });

  const OTHER = { status: 'done', by: 'another writer' };
  test.each([
    ['is flagged for card data', { transcription_metadata: JSON.stringify({ pan_detected: true }) }, undefined],
    ['goes back into the pipeline', { processing_token: 'held' }, undefined],
    ['gets another recording', { recording_url: 'https://api.twilio.com/2010-04-01/Recordings/REother.mp3' }, undefined],
    ['turns out to be a sandbox call', { source: VOICE_RELAY_SANDBOX_SOURCE }, undefined],
    ['gets a record from another writer', { metadata: JSON.stringify({ [KEY]: OTHER }) }, OTHER],
  ])('a call that %s during the download is not claimed and not sent', async (_label, change, recordAfter) => {
    const id = await insertCall();
    const f = fakes({ download: jest.fn(async () => { await trx('call_log').where({ id }).update(change); return AUDIO; }) });
    expect(await run(f)).toEqual({ ...TALLY, skipped: 1 });
    expect(llm.dispatch).not.toHaveBeenCalled();
    expect(await recordOf(id)).toEqual(recordAfter);
  });

  test('an outcome never overwrites a record that took the place of the claim during the model call', async () => {
    const id = await insertCall();
    const f = fakes({
      dispatch: async () => { await trx('call_log').where({ id }).update({ metadata: JSON.stringify({ [KEY]: OTHER }) }); return answer(); },
    });
    await run(f);
    expect(await recordOf(id)).toEqual(OTHER);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('outcome not saved'));
  });

  test('spend outlives the call row: a heard call deleted as spam still counts toward the day', async () => {
    const first = await insertCall({ created_at: ago(2) });
    const f = fakes();
    expect(await run(f)).toEqual({ ...TALLY, done: 1 });
    expect(await spendRows()).toEqual([{ call_id: first, day: DAY, reserved_usd: reserveFor(120), spent_usd: USAGE_COST }]);
    await trx('call_log').where({ id: first }).del();
    await spentToday(soundCheck.DAILY_CAP_USD - USAGE_COST - reserveFor(120) / 2);
    const second = await insertCall();
    expect(await run(f)).toEqual({ ...TALLY, capped: 1 });
    expect(await recordOf(second)).toBeUndefined();
  });

  test('a recording swapped in during the listen keeps no note of the old audio, and is heard on its own', async () => {
    const id = await insertCall();
    const swapped = 'https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/REswapped.mp3';
    const f = fakes({ dispatch: jest.fn()
      .mockImplementationOnce(async () => { await trx('call_log').where({ id }).update({ recording_url: swapped }); return answer(); })
      .mockImplementation(async () => answer()) });
    await run(f);
    expect(await recordOf(id)).toEqual(expect.objectContaining({ status: 'started' }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('outcome not saved'));
    // the old audio's attempt is still owed; the new recording is a new candidate
    expect(await run(f)).toEqual({ ...TALLY, done: 1 });
    expect(await recordOf(id)).toEqual(expect.objectContaining({ status: 'done', recording_url: swapped }));
    expect((await spendRows()).map((r) => r.spent_usd)).toEqual([USAGE_COST, USAGE_COST]);
  });

  test('a note of a recording the call no longer has makes the call a candidate again', async () => {
    const id = await insertCall({ metadata: { [KEY]: { status: 'done', recording_url: 'https://api.twilio.com/2010-04-01/Recordings/REold.mp3' } } });
    expect(await run(fakes())).toEqual({ ...TALLY, done: 1 });
    expect(await recordOf(id)).toEqual(expect.objectContaining({ status: 'done', note: expect.any(Object) }));
  });

  test('a long-prompt tier with no audio rate makes no call', async () => {
    await trx('llm_model_prices').where({ model_key: MODEL_KEY }).update({
      pricing_tiers: JSON.stringify([{ min_prompt_tokens: 200000, input_per_mtok: 6, output_per_mtok: 22.5, audio_input_per_mtok: null }]),
    });
    await insertCall();
    await expect(run(fakes())).rejects.toThrow(/no usable price/);
  });

  test('an old http:// Twilio URL is fetched over https', async () => {
    await insertCall({ recording_url: 'http://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/REold.mp3' });
    const f = fakes();
    expect(await run(f)).toEqual({ ...TALLY, done: 1 });
    expect(f.download).toHaveBeenCalledWith('https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/REold.mp3', 120);
  });

  test('a price row with no audio input rate makes no call: the cap could read low', async () => {
    await trx('llm_model_prices').where({ model_key: MODEL_KEY }).update({ audio_input_per_mtok: null });
    const id = await insertCall();
    const f = fakes();
    await expect(run(f)).rejects.toThrow(/no usable price/);
    expect(f.download).not.toHaveBeenCalled();
    expect(await recordOf(id)).toBeUndefined();
  });

  test('the reserve uses the audio rate when audio costs more than text', async () => {
    await trx('llm_model_prices').where({ model_key: MODEL_KEY }).update({ audio_input_per_mtok: 9 });
    const id = await insertCall();
    let reserved;
    const f = fakes({ dispatch: async () => { reserved = (await recordOf(id)).reserved_usd; return answer(); } });
    await run(f);
    expect(reserved).toBe(Math.round(soundCheck.worstCaseUsd({ ...PRICE, audioInput: 9 }, 120) * 1e6) / 1e6);
    expect(reserved).toBeGreaterThan(reserveFor(120));
  });

  test('with no price row for the model the tick fails before any download or model call', async () => {
    await trx('llm_model_prices').where({ model_key: MODEL_KEY }).del();
    const id = await insertCall();
    const f = fakes();
    await expect(run(f)).rejects.toThrow(/no usable price/);
    expect(f.download).not.toHaveBeenCalled();
    expect(llm.dispatch).not.toHaveBeenCalled();
    expect(await recordOf(id)).toBeUndefined();
  });
});
