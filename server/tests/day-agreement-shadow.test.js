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
// The unit fakes cannot load booking_config; treat it as read (the unread case is its own test).
jest.mock('../services/scheduling/customer-windows', () => ({
  ...jest.requireActual('../services/scheduling/customer-windows'),
  refreshCustomerBookingWindowConfig: jest.fn(async () => {}),
  bookingWindowConfigKnown: jest.fn(() => true),
}));
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
    expect(sql).toContain('l.message_body ~* $4');
    expect(sql).toContain("d.source_key = 'sms:' || l.digits || ':' || l.id::text || '#0'");
    // The quiet probe counts only what the thread counts: inbound texts and Waves texts that
    // went out; scheduled, reserved or failed rows are not activity.
    expect(sql).toMatch(/NOT EXISTS \(\(select 1 from "sms_log" as "m" where "m"\."created_at" > \$11 and \("m"\."direction" = \$12 or "m"\."status" in \(\$13, \$14, \$15\)\)/);
    expect(sql).toContain("right(regexp_replace(m.to_phone, '\\D', '', 'g'), 10) = l.digits");
    expect(sql).toContain("COALESCE(m.metadata->>'review_ask_reservation', 'false')");
    expect(sql).toContain("COALESCE(m.status, '') IN ('canceled', 'cancelled')");
    // A day-less latest inbound is admitted by a delivered Waves text with a day word sent in the 3 hours before it.
    expect(sql).toMatch(/\(l\.message_body ~\* \$4 OR EXISTS \(\(select 1 from "sms_log" as "w" where "w"\."direction" = \$5 and "w"\."status" in \(\$6, \$7, \$8\)/);
    expect(sql).toContain("w.created_at < l.created_at AND w.created_at >= l.created_at - interval '3 hours'");
    expect(sql).toContain('w.message_body ~* $10');
    expect(bindings).toEqual([
      'inbound', new Date(NOW.getTime() - 3 * 3600 * 1000), 'job\\_%', rules.DAY_WORD_PATTERN,
      'outbound', 'sent', 'delivered', 'read', 'job\\_%', rules.DAY_WORD_PATTERN,
      new Date(NOW.getTime() - 30 * 60 * 1000), 'inbound', 'sent', 'delivered', 'read', 'job\\_%', internals.BATCH.sms,
    ]);
  });

  test('texts: push-only deliveries are no activity in the quiet probe, and recruiting (job_) texts are left out of candidates and the probe', () => {
    const { sql } = internals.smsCandidatesQuery(pg, NOW).toSQL().toNative();
    expect(sql).toContain("COALESCE(m.from_phone, '') <> 'push' AND COALESCE(m.metadata->>'channel', '') <> 'push'");
    expect(sql).toContain("COALESCE(w.from_phone, '') <> 'push' AND COALESCE(w.metadata->>'channel', '') <> 'push'");
    expect(sql.match(/not like \$/g)).toHaveLength(3); // the candidate inner query, the offer probe and the quiet probe
  });

  test('calls: voicemail, spam and the scheduling status are tested in SQL before the scan limit', () => {
    const { sql } = internals.callCandidatesQuery(pg, NOW).toSQL().toNative();
    expect(sql).toContain("COALESCE(c.answered_by, '') <> 'voicemail'");
    expect(sql).toContain("'meta' ->> 'is_voicemail', '') <> 'true'");
    expect(sql).toContain("'spam_verdict' ->> 'spam_kind', ''), 'not_spam') = 'not_spam'");
    expect(sql.indexOf("'scheduling' ->> 'status' IN")).toBeLessThan(sql.indexOf('limit $'));
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

  test('a stubbed dispatch gets the deepAnalysis (DEEP) policy with the DEEP output floor, the lane label, the prompt version and the validator', async () => {
    const dispatch = jest.fn(async () => ({ ok: true, json: JSON.parse(good), model: 'stub-model' }));
    const out = await internals.judge(parts, { dispatch });
    expect(out).toMatchObject({ ok: true, model: 'stub-model' });
    const [policy, payload, options] = dispatch.mock.calls[0];
    expect(policy.name).toBe('deepAnalysis');
    expect(policy.primary.model).toBe(require('../config/models').DEEP);
    expect(payload).toMatchObject({ laneId: 'day_agreement', promptVersion: 'day-agreement-v1', jsonMode: true, maxTokens: 4096 });
    expect(options.validate({ json: JSON.parse(good) })).toBeNull();
    expect(options.validate({ json: { agreements: [] } })).toBeTruthy();
  });
});

const SERVICE = { name: 'Quarterly Pest Control Service', service_key: 'pest_general_quarterly', default_duration_minutes: 75 };

describe('which service the picker is asked about', () => {
  const conn = jest.fn(() => ({ where: () => ({ first: async () => ({ latitude: 27.4, longitude: -82.45 }) }) }));
  const catalog = [
    { id: 1, name: 'Quarterly Pest Control Service', short_name: 'Pest Quarterly', service_key: 'pest_general_quarterly' },
    { id: 2, name: 'Monthly Lawn Care Service', short_name: 'Lawn Care', service_key: 'lawn_care_monthly' },
    { id: 3, name: 'Waves Pest Control Appointment Service', short_name: 'Appointment', service_key: 'general_appointment' },
    { id: 4, name: 'Waves Assessment', short_name: 'Waves Assess', service_key: 'lawn_inspection' },
  ];

  test('resolves only an exact name, short name or key (no keyword rules)', () => {
    expect(internals.resolveNewVisitService(catalog, 'Quarterly Pest Control Service').id).toBe(1);
    expect(internals.resolveNewVisitService(catalog, 'pest quarterly').id).toBe(1);
    expect(internals.resolveNewVisitService(catalog, 'lawn_care_monthly').id).toBe(2);
  });

  test('a missing, unknown, multi-service or generic service is unresolved', () => {
    for (const text of [null, '', '  ', 'pest control', 'pest and lawn', 'Waves Pest Control Appointment Service', 'Waves Assessment',
      // A combined ask never resolves to its first keyword match (pre-push audit P1).
      'Quarterly Pest Control Service and Monthly Lawn Care Service', 'cockroach control and rodent trapping']) {
      expect(internals.resolveNewVisitService(catalog, text)).toBeNull();
    }
    expect(internals.resolveNewVisitService([], 'Quarterly Pest Control Service')).toBeNull();
  });

  test('a new visit passes the service identity and its catalog length; a move passes its own visit\'s', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const findSlots = jest.fn(async () => ({ slots: [] }));
    const args = { customerId: 'c1', day: '2040-03-14', daypart: 'any' };
    await internals.pickSlot(conn, { ...args, fromVisit: null, service: SERVICE }, { findSlots });
    expect(findSlots).toHaveBeenLastCalledWith(expect.objectContaining({
      serviceType: 'Quarterly Pest Control Service', serviceTypes: ['Quarterly Pest Control Service'], durationMinutes: 75,
    }));
    await internals.pickSlot(conn, { ...args, fromVisit: { id: 'v1', service_type: 'Lawn Care', estimated_duration_minutes: 90, lat: 27.9, lng: -82.1 } }, { findSlots });
    expect(findSlots).toHaveBeenLastCalledWith(expect.objectContaining({ serviceType: 'Lawn Care', serviceTypes: ['Lawn Care'], durationMinutes: 90 }));
  });

  test('with no service identity at all the picker is never called', async () => {
    const findSlots = jest.fn();
    expect(await internals.pickSlot(conn, { customerId: 'c1', day: '2040-03-14', daypart: 'any', fromVisit: null, service: null }, { findSlots }))
      .toEqual({ reason: 'service_unresolved' });
    expect(findSlots).not.toHaveBeenCalled();
  });

  test('the collision guard is told the service, so a technician switched off for it is dropped outside capacity routing too', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const filterColliding = jest.fn(async (shaped) => shaped);
    const findSlots = jest.fn(async () => ({ slots: [{ date: '2040-03-14', start_time: '10:00', end_time: '11:00', technician: { id: 't1' } }] }));
    await internals.pickSlot(conn, { customerId: 'c1', day: '2040-03-14', daypart: 'any', fromVisit: null, service: SERVICE }, { findSlots, filterColliding });
    expect(filterColliding.mock.calls[0][1].serviceMix).toEqual({ services: ['Quarterly Pest Control Service'] });
  });
});

describe('grounding, visit context and prompt note', () => {
  const act = (at) => ({
    at, act: true, kind: 'new_visit', day: '2040-03-14', from_day: null, daypart: 'any', service: 'Quarterly Pest Control Service',
    blockers: [], confidence: 0.9, reason: 'Agreed.',
  });
  const smsSrc = { kind: 'sms', key: 'sms:9415550142:x', callLogId: null, phoneDigits: '9415550142', customerId: 'c1', agreedAt: new Date('2040-03-12T15:15:00Z'), stamps: new Set(['2040-03-12T11:15', '2040-03-12T10:20']) };
  const ctx = { now: NOW, todayET: '2040-03-12', model: 'm', deps: {} };

  test('etMinuteKey is the Eastern minute in the form the model returns', () => {
    expect(internals.etMinuteKey(new Date('2040-03-12T15:15:40Z'))).toBe('2040-03-12T11:15');
  });

  test('an SMS action whose time is not the minute of a shown message is at_ungrounded; no visit is read', async () => {
    const conn = jest.fn(() => { throw new Error('no read before the grounding check'); });
    for (const at of ['2040-03-12T11:16', '2040-03-12T09:00', '2040-03-11T11:15']) {
      expect(await internals.decideMoment(conn, smsSrc, 0, act(at), ctx)).toMatchObject({ verdict: 'skip', skip_reason: 'at_ungrounded', target_date: '2040-03-14' });
    }
    expect(conn).not.toHaveBeenCalled();
  });

  test('a time that is a shown message (to the minute) passes grounding and moves on to the visit read', async () => {
    const conn = jest.fn(() => { throw new Error('reached the visit read'); });
    await expect(internals.decideMoment(conn, smsSrc, 0, act('2040-03-12T11:15'), ctx)).rejects.toThrow('reached the visit read');
  });

  test('visitLines leaves out a visit changed after the agreement and counts it', async () => {
    const before = new Date(NOW.getTime() - 3600 * 1000);
    const rows = [
      { d: '2040-03-14', window_start: '09:00:00', service_type: 'Pest Control', status: 'confirmed', updated_at: new Date(before.getTime() - 1000) },
      { d: '2040-03-15', window_start: '10:00:00', service_type: 'Lawn Care', status: 'confirmed', updated_at: new Date(before.getTime() + 1000) },
    ];
    const conn = () => ({ where: () => ({ where: () => ({ where: () => ({ whereNotIn: () => ({ orderBy: () => ({ limit: () => ({ select: async () => rows }) }) }) }) }) }) });
    conn.raw = () => 'raw';
    expect(await internals.visitLines(conn, 'c1', before, NOW)).toEqual({ lines: ['2040-03-14 09:00 Pest Control (confirmed)'], omitted: 1 });
  });

  test('the prompt says how many visits were left out, and says nothing when none were', () => {
    const base = { sourceLabel: 'x', todayET: '2040-03-12', weekdayET: 'Monday', lines: ['l'] };
    expect(prompts.buildDayAgreementPrompt({ ...base, omittedVisits: 2 }).text).toContain('2 visit(s) changed after this moment are not shown.');
    expect(prompts.buildDayAgreementPrompt({ ...base, omittedVisits: 0 }).text).not.toContain('changed after this moment');
  });
});

describe('retryable and ambiguous inputs', () => {
  const failing = new Proxy({}, { get: (_t, key) => (key === 'then' ? (_res, rej) => rej(new Error('db down')) : () => failing) });

  test('the strict catalog read throws instead of returning the legacy empty list', async () => {
    const { loadBookableCallServices } = require('../services/call-booking-catalog');
    const conn = () => failing;
    expect(await loadBookableCallServices(conn)).toEqual([]);
    await expect(loadBookableCallServices(conn, { strict: true })).rejects.toThrow('db down');
  });

  test('a source is left unjudged (the error propagates, no row) when the catalog read fails or is empty', async () => {
    const src = { kind: 'call', key: 'call:x', customerId: 'c1', lines: ['[Mon 2040-03-12 11:00] CUSTOMER: Wed works'], agreedAt: NOW, truncated: false };
    const dispatch = jest.fn();
    const ctx = { now: NOW, todayET: '2040-03-12', deps: { dispatch } };
    const visits = { where: () => ({ where: () => ({ where: () => ({ whereNotIn: () => ({ orderBy: () => ({ limit: () => ({ select: async () => [] }) }) }) }) }) }) };
    const emptyCatalog = { where: () => ({ whereNotIn: () => ({ orderBy: () => ({ orderBy: () => ({ select: async () => [] }) }) }) }) };
    // The per-customer quota read (Codex security review): under quota.
    const quota = { where() { return this; }, count() { return { first: async () => ({ n: 0 }) }; } };
    const conn = (table) => (table === 'day_agreement_decisions' ? quota : table === 'services' ? emptyCatalog : (table === 'scheduled_services' ? visits : failing));
    conn.raw = () => 'raw';
    await expect(internals.processSource(conn, src, ctx)).rejects.toMatchObject({ code: 'catalog_empty' });
    const broken = (table) => (table === 'day_agreement_decisions' ? quota : table === 'scheduled_services' ? visits : failing);
    broken.raw = () => 'raw';
    await expect(internals.processSource(broken, src, ctx)).rejects.toThrow('db down');
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('hasSeveralProperties: two active properties is ambiguous, one or none is not', async () => {
    const conn = (ids) => () => ({ where: () => ({ limit: () => ({ pluck: async () => ids }) }) });
    expect(await internals.hasSeveralProperties(conn(['a', 'b']), 'c1')).toBe(true);
    expect(await internals.hasSeveralProperties(conn(['a']), 'c1')).toBe(false);
    expect(await internals.hasSeveralProperties(conn([]), 'c1')).toBe(false);
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
    const args = { customerId: 'c1', day: '2040-03-14', daypart: 'afternoon', fromVisit: null, service: SERVICE };
    expect((await internals.pickSlot(conn, args, { findSlots, filterColliding: guard(['13:00']) })).slot.start_time).toBe('15:00');
    expect(await internals.pickSlot(conn, args, { findSlots, filterColliding: guard(['13:00', '15:00']) })).toEqual({ reason: 'no_slot' });
  });

  test('a move is placed at the moved visit\'s own pin; the customer pin only when the visit has none', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const conn = jest.fn(() => ({ where: () => ({ first: async () => ({ latitude: 27.4, longitude: -82.45 }) }) }));
    const findSlots = jest.fn(async () => ({ slots: [] }));
    const args = { customerId: 'c1', day: '2040-03-14', daypart: 'any' };
    await internals.pickSlot(conn, { ...args, fromVisit: { id: 'v1', service_type: 'Lawn Care', lat: '27.9', lng: '-82.1' } }, { findSlots });
    expect(findSlots).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 27.9, lng: -82.1 }));
    expect(conn).not.toHaveBeenCalledWith('customers'); // the visit's pin was enough
    await internals.pickSlot(conn, { ...args, fromVisit: { id: 'v1', service_type: 'Lawn Care', lat: null, lng: null } }, { findSlots });
    expect(findSlots).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 27.4, lng: -82.45 }));
    await internals.pickSlot(conn, { ...args, fromVisit: null, service: SERVICE }, { findSlots });
    expect(findSlots).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 27.4, lng: -82.45 }));
  });

  test('an unread booking_config throws (retryable), and strict closure reads are asked for (Codex #6350 r12)', async () => {
    const windows = require('../services/scheduling/customer-windows');
    const conn = jest.fn(() => ({ where: () => ({ first: async () => ({ latitude: 27.4, longitude: -82.45 }) }) }));
    const findSlots = jest.fn(async () => ({ slots: [] }));
    windows.bookingWindowConfigKnown.mockReturnValueOnce(false);
    await expect(internals.pickSlot(conn, { customerId: 'c1', day: '2040-03-14', daypart: 'any', fromVisit: null, service: SERVICE }, { findSlots })).rejects.toMatchObject({ code: 'booking_config_unknown' });
    expect(findSlots).not.toHaveBeenCalled();
    await internals.pickSlot(conn, { customerId: 'c1', day: '2040-03-14', daypart: 'any', fromVisit: null, service: SERVICE }, { findSlots });
    expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({ strictBlackout: true }));
  });

  test('a move keeps its stored window length when no duration is set (Codex #6350 r12)', () => {
    expect(internals.visitIdentity({ fromVisit: { service_type: 'Lawn Care', window_start: '09:00:00', window_end: '10:30:00', estimated_duration_minutes: null } }).minutes).toBe(90);
  });

  test('pickSlot passes the configured customer day end (18:00 by default), so a 17:00 start is possible in legacy mode', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const conn = jest.fn(() => ({ where: () => ({ first: async () => ({ latitude: 27.4, longitude: -82.45 }) }) }));
    const findSlots = jest.fn(async () => ({ slots: [] }));
    await internals.pickSlot(conn, { customerId: 'c1', day: '2040-03-14', daypart: 'any', fromVisit: null, service: SERVICE }, { findSlots });
    expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({ dayEndHour: 18 }));
  });

  test('pickSlot asks find-time for customer-facing slots, so capacity mode applies the 09:00 grid, close and lunch gate', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const conn = jest.fn(() => ({ where: () => ({ first: async () => ({ latitude: 27.4, longitude: -82.45 }) }) }));
    const findSlots = jest.fn(async () => ({ slots: [] }));
    await internals.pickSlot(conn, { customerId: 'c1', day: '2040-03-14', daypart: 'any', fromVisit: null, service: SERVICE }, { findSlots });
    expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({ customerFacing: true }));
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
    // Out-of-range clock values and junk around a valid-looking time are unreadable, never rolled into another time.
    for (const bad of ['2040-03-12T12:60', '2040-03-12T24:00', '2040-03-12T25:10', '2040-03-12T11:00 junk', 'x2040-03-12T11:00', '2040-03-12T11:0', '2040-03-12T11:00:61', '']) {
      expect(internals.parseAt(bad)).toBeNull();
    }
    expect(internals.parseAt('2040-03-12T23:59').toISOString()).toBe('2040-03-13T03:59:00.000Z');
    expect(internals.parseAt(' 2040-03-12T11:00:30 ').toISOString()).toBe('2040-03-12T15:00:00.000Z');
  });
});
