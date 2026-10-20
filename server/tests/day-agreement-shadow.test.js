/**
 * Day-only agreement shadow sweep: no database, no network.
 *
 *  - the two candidate SELECTs compile (knex pg, compile-only) and carry the
 *    sandbox exclusion, the windows and the "not judged yet" test;
 *  - the judge runs through the REAL dispatchWithFallback with the provider
 *    SDK and fetch mocked: an unusable answer fails its leg so the backup gets
 *    a turn, both unusable is recorded, an outage is not;
 *  - the sweep reads the gate and does nothing while it is off.
 * The SQL itself runs against Postgres in day-agreement-shadow-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const knex = require('knex');
const shadow = require('../services/day-agreement-shadow');
const prompts = require('../services/prompts/day-agreement-v1');
const rules = require('../services/day-agreement-rules');
const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

const { _internals: internals } = shadow;
const NOW = new Date('2040-03-12T16:00:00Z');
const pg = knex({ client: 'pg' });

const answer = (agreements) => JSON.stringify({ agreements });
const good = answer([{
  at: '2040-03-12T11:00', act: true, kind: 'new_visit', day: '2040-03-14', from_day: null, daypart: 'morning',
  service: 'pest control', blockers: [], confidence: 0.9, reason: 'Staff offered Wednesday morning; the customer agreed.',
}]);
const noAgreement = answer([{
  at: '2040-03-12T11:00', act: false, kind: null, day: null, from_day: null, daypart: null, service: null,
  blockers: ['no_day_agreed'], confidence: 0.9, reason: 'No day was agreed.',
}]);
const parts = prompts.buildDayAgreementPrompt({
  sourceLabel: 'This is a text thread.', todayET: '2040-03-12', weekdayET: 'Monday',
  visits: ['2040-03-16 09:00 Pest Control (confirmed)'], lines: ['[Mon 2040-03-12 11:00] CUSTOMER: Wednesday works'],
});

describe('candidate SQL (compile only)', () => {
  test('calls: sandbox calls are excluded, only the last 3 hours of finished calls with a valid extraction, and judged sources are left out', () => {
    const { sql, bindings } = internals.callCandidatesQuery(pg, NOW).toSQL().toNative();
    expect(sql).toContain('from "call_log" as "c"');
    expect(sql).toContain('COALESCE("c"."source", \'\') <> $');
    expect(bindings).toContain(VOICE_RELAY_SANDBOX_SOURCE);
    expect(sql).toContain('"c"."processed_at" >= $');
    expect(bindings).toContainEqual(new Date(NOW.getTime() - 3 * 3600 * 1000));
    expect(bindings).toContain('valid');
    expect(sql).toContain("NOT IN ('voicemail', 'spam', 'processing')");
    expect(sql).toContain("d.source_key = 'call:' || c.id::text || '#0'");
    expect(sql).toContain('left(c.transcription, $');
    expect(sql).toMatch(/limit \$\d+$/);
  });

  test('texts: latest inbound per phone, day word on that text, quiet for 30 minutes both ways, not judged yet', () => {
    const { sql, bindings } = internals.smsCandidatesQuery(pg, NOW).toSQL().toNative();
    expect(sql).toContain('DISTINCT ON');
    expect(sql).toContain("direction = 'inbound'");
    expect(sql).toContain('l.message_body ~* $2');
    expect(sql).toContain("d.source_key = 'sms:' || l.digits || ':' || l.id::text || '#0'");
    expect(sql).toMatch(/m\.created_at > \$3/);
    expect(sql).toContain("right(regexp_replace(m.to_phone, '\\D', '', 'g'), 10) = l.digits");
    expect(bindings).toEqual([
      new Date(NOW.getTime() - 3 * 3600 * 1000), rules.DAY_WORD_PATTERN, new Date(NOW.getTime() - 30 * 60 * 1000), internals.BATCH.sms,
    ]);
  });
});

describe('the judge, through the real fallback chain', () => {
  const keys = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
  let fetchSpy;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-key';
    mockAnthropicCreate.mockReset();
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    for (const [key, value] of [['ANTHROPIC_API_KEY', keys.anthropic], ['OPENAI_API_KEY', keys.openai]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const claude = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', model: 'claude-test' });
  const openai = (text) => ({ ok: true, json: async () => ({ output_text: text }) });

  test('a good first answer is used and the backup is never called', async () => {
    mockAnthropicCreate.mockResolvedValue(claude(good));
    const out = await internals.judge(parts, {});
    expect(out).toMatchObject({ ok: true });
    expect(out.agreements).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const request = mockAnthropicCreate.mock.calls[0][0];
    // The wire copy drops the array bounds Anthropic rejects; the lane label and the rules ride along.
    expect(JSON.stringify(request.output_config.format.schema)).not.toMatch(/minItems|maxItems/);
    expect(request.system[0].text).toContain('a wrong booking or a wrong move is worse than doing nothing');
    expect(request.messages[0].content.map((c) => c.text).join('\n')).toContain('Visits on file for this customer');
  });

  test('an answer that fails the schema fails its leg and the OpenAI backup gets a turn', async () => {
    mockAnthropicCreate.mockResolvedValue(claude(JSON.stringify({ agreements: [{ act: true }] })));
    fetchSpy.mockResolvedValue(openai(good));
    const out = await internals.judge(parts, {});
    expect(out).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  test('act:true with an unknown kind or a made-up day is unusable too, and the backup is used', async () => {
    const badKind = answer([{ ...JSON.parse(good).agreements[0], kind: 'cancel' }]);
    mockAnthropicCreate.mockResolvedValue(claude(badKind));
    fetchSpy.mockResolvedValue(openai(good));
    expect(await internals.judge(parts, {})).toMatchObject({ ok: true });
    const badDay = answer([{ ...JSON.parse(good).agreements[0], day: '2040-02-31' }]);
    mockAnthropicCreate.mockResolvedValue(claude(badDay));
    expect(await internals.judge(parts, {})).toMatchObject({ ok: true });
  });

  test('an empty list of agreements is unusable (the brief asks for one object even when nothing was agreed)', async () => {
    mockAnthropicCreate.mockResolvedValue(claude(answer([])));
    fetchSpy.mockResolvedValue(openai(noAgreement));
    const out = await internals.judge(parts, {});
    expect(out).toMatchObject({ ok: true });
    expect(out.agreements[0].blockers).toEqual(['no_day_agreed']);
  });

  test('both legs unusable: not transient, so the sweep records judge_unusable and never asks again', async () => {
    mockAnthropicCreate.mockResolvedValue(claude('{"agreements":[{"act":true}]}'));
    fetchSpy.mockResolvedValue(openai('{"agreements":[]}'));
    expect(await internals.judge(parts, {})).toMatchObject({ ok: false, transient: false });
  });

  test('both providers down: transient, so nothing is recorded and the next tick tries again', async () => {
    mockAnthropicCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    fetchSpy.mockResolvedValue({ ok: false, status: 529 });
    expect(await internals.judge(parts, {})).toMatchObject({ ok: false, transient: true });
  });

  test('one validator rejection plus a transient failure on the other leg stays retryable (either order)', async () => {
    // Primary answers badly, backup is down.
    mockAnthropicCreate.mockResolvedValue(claude('{"agreements":[{"act":true}]}'));
    fetchSpy.mockResolvedValue({ ok: false, status: 529 });
    expect(await internals.judge(parts, {})).toMatchObject({ ok: false, transient: true });
    // Primary is down, backup answers badly.
    mockAnthropicCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    fetchSpy.mockResolvedValue(openai('{"agreements":[]}'));
    expect(await internals.judge(parts, {})).toMatchObject({ ok: false, transient: true });
  });

  test('an empty failure list is never proof of an unusable answer', async () => {
    const dispatch = jest.fn(async () => ({ ok: false, reason: 'no_route', failures: [] }));
    expect(await internals.judge(parts, { dispatch })).toMatchObject({ ok: false, transient: true });
  });

  test('a validator rejection mixed with a non-validator failure from a stub is retryable; all validator rejections are not', async () => {
    const mixed = jest.fn(async () => ({ ok: false, failures: [{ validator: true, reason: 'schema_invalid' }, { reason: 'openai_timeout' }] }));
    expect(await internals.judge(parts, { dispatch: mixed })).toMatchObject({ transient: true });
    const allBad = jest.fn(async () => ({ ok: false, failures: [{ validator: true, reason: 'schema_invalid' }, { validator: true, reason: 'kind_invalid' }] }));
    expect(await internals.judge(parts, { dispatch: allBad })).toMatchObject({ transient: false });
  });

  test('a stubbed dispatch gets the highStakes policy, the lane label, the prompt version and the validator', async () => {
    const dispatch = jest.fn(async () => ({ ok: true, json: JSON.parse(good), model: 'stub-model' }));
    const out = await internals.judge(parts, { dispatch });
    expect(out).toMatchObject({ ok: true, model: 'stub-model' });
    const [policy, payload, options] = dispatch.mock.calls[0];
    expect(policy.name).toBe('highStakes');
    expect(payload).toMatchObject({ laneId: 'day_agreement', promptVersion: 'day-agreement-v1', jsonMode: true });
    expect(options.validate({ json: JSON.parse(good) })).toBeNull();
    expect(options.validate({ json: { agreements: [] } })).toBeTruthy();
  });
});

describe('the collision guard on offered slots', () => {
  const OLD_CAPACITY = process.env.GATE_SCHEDULING_CAPACITY;
  afterEach(() => {
    if (OLD_CAPACITY === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = OLD_CAPACITY;
  });
  const slot = (start, tech) => ({ date: '2040-03-14', start_time: start, end_time: `${Number(start.slice(0, 2)) + 1}:00`, technician: { id: tech } });
  const where = { lat: 27.4, lng: -82.45 };

  test('runs the estimate picker\'s filterCollidingSlots on the day, with the pin and the moved visit excluded, and keeps the picker\'s order', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const slots = [slot('13:00', 't1'), slot('14:00', null), slot('15:00', 't1')];
    const filterColliding = jest.fn(async (shaped) => shaped.filter((s) => s.windowStart !== '14:00'));
    const out = await internals.dropCollidingSlots(slots, { day: '2040-03-14', where, fromVisit: { id: 'v-move' } }, { filterColliding });
    expect(out.map((s) => s.start_time)).toEqual(['13:00', '15:00']);
    expect(filterColliding).toHaveBeenCalledWith(
      [expect.objectContaining({ date: '2040-03-14', techId: 't1', windowStart: '13:00', windowEnd: '14:00' }),
        expect.objectContaining({ techId: null, windowStart: '14:00' }), expect.anything()],
      { dateFrom: '2040-03-14', dateTo: '2040-03-14', coords: where, excludeServiceIds: ['v-move'] },
    );
  });

  test('a new visit excludes nothing', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const filterColliding = jest.fn(async (shaped) => shaped);
    await internals.dropCollidingSlots([slot('09:00', 't1')], { day: '2040-03-14', where, fromVisit: null }, { filterColliding });
    expect(filterColliding.mock.calls[0][1].excludeServiceIds).toEqual([]);
  });

  test('under capacity routing the route already holds unassigned blockers: slots pass through untouched', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const filterColliding = jest.fn();
    const slots = [slot('09:00', 't1')];
    expect(await internals.dropCollidingSlots(slots, { day: '2040-03-14', where, fromVisit: null }, { filterColliding })).toBe(slots);
    expect(filterColliding).not.toHaveBeenCalled();
  });

  test('pickSlot takes the first slot that survives the guard, and no_slot when none does', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const conn = jest.fn(() => ({ where: () => ({ first: async () => ({ latitude: 27.4, longitude: -82.45 }) }) }));
    const findSlots = jest.fn(async () => ({ slots: [slot('13:00', 't1'), slot('15:00', 't1')] }));
    const guard = (blocked) => jest.fn(async (shaped) => shaped.filter((s) => !blocked.includes(s.windowStart)));
    const args = { customerId: 'c1', day: '2040-03-14', daypart: 'afternoon', fromVisit: null };
    expect((await internals.pickSlot(conn, args, { findSlots, filterColliding: guard(['13:00']) })).slot.start_time).toBe('15:00');
    expect(await internals.pickSlot(conn, args, { findSlots, filterColliding: guard(['13:00', '15:00']) })).toEqual({ reason: 'no_slot' });
  });
});

describe('the sweep', () => {
  const OLD_GATE = process.env.GATE_DAY_AGREEMENT_SHADOW;
  afterEach(() => {
    if (OLD_GATE === undefined) delete process.env.GATE_DAY_AGREEMENT_SHADOW; else process.env.GATE_DAY_AGREEMENT_SHADOW = OLD_GATE;
  });

  test('is dark: with the gate off it reads nothing', async () => {
    const conn = jest.fn(() => { throw new Error('the sweep must not read while the gate is off'); });
    expect(await shadow.runDayAgreementShadow({ conn, now: NOW })).toEqual({ skipped: 'gate_off' });
    expect(conn).not.toHaveBeenCalled();
  });

});

describe('message and call context lines', () => {
  test('a message line carries the ET stamp, the speaker label with the automated type, and a scrubbed, clipped body', () => {
    const line = internals.messageLine({
      direction: 'outbound', message_type: 'reminder', created_at: new Date('2040-03-12T15:00:00Z'),
      message_body: `Your visit is Wednesday. Card 4111 1111 1111 1111 ${'x'.repeat(2500)}`,
    });
    expect(line.startsWith('[Mon 2040-03-12 11:00] WAVES (reminder): Your visit is Wednesday.')).toBe(true);
    expect(line).not.toContain('4111 1111 1111 1111');
    expect(line.length).toBeLessThan(2100); // clipped at MESSAGE_CHARS (the thread is skipped as message_too_long anyway)
    expect(internals.messageLine({ direction: 'inbound', created_at: NOW, message_body: '   ' })).toBeNull();
    expect(internals.messageLine({ direction: 'inbound', created_at: NOW, message_body: 'Tuesday works' })).toContain('CUSTOMER: Tuesday works');
  });

  test('parseAt reads the model\'s Eastern time and refuses anything else', () => {
    expect(internals.parseAt('2040-03-12T11:00').toISOString()).toBe('2040-03-12T15:00:00.000Z');
    expect(internals.parseAt('2040-03-12 11:00').toISOString()).toBe('2040-03-12T15:00:00.000Z');
    expect(internals.parseAt('Monday morning')).toBeNull();
    expect(internals.parseAt('2040-02-30T10:00')).toBeNull();
  });
});
