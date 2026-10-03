/**
 * Visit access flags, shadow leg (visit_access.v1). Behavior under proof:
 *  - gate off: no read, no provider call, no write;
 *  - no access code or long digit run ever reaches the state the providers see;
 *  - the state depends on the visit and on facts dated before it, so the
 *    review route rebuilds the same digest after the visit is done;
 *  - each provider is asked once per state, and again only when it changes;
 *  - the migration adds the subject type without dropping another one's value.
 * The providers are scripted: nothing here reaches a network.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAsk = jest.fn();
jest.mock('../services/typed-decisions/jev', () => ({ askPackage: (...a) => mockAsk(...a) }));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const subjectMigration = require('../models/migrations/20261003101500_decision_reviews_scheduled_services_subject');
const { packageFor, packageHash } = require('../services/typed-decisions/packages');
const access = require('../services/typed-decisions/visit-access-shadow');

jest.setTimeout(60000);

const GATES = ['GATE_TYPED_DECISIONS', 'GATE_TYPED_DECISIONS_CLEF', 'GATE_VISIT_ACCESS_FLAGS'];
const saved = {};
beforeAll(() => { for (const k of GATES) saved[k] = process.env[k]; });
afterAll(() => { for (const k of GATES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const gates = (on) => {
  for (const k of GATES) delete process.env[k];
  if (on) { process.env.GATE_TYPED_DECISIONS = 'true'; process.env.GATE_VISIT_ACCESS_FLAGS = 'shadow'; }
};

const pkg = packageFor('visit_access.v1');
const yes = { p: 0.95, yes: true, confident: true };
const no = { p: 0.03, yes: false, confident: true };
const answersOf = (over = {}) => ({ ...Object.fromEntries(Object.keys(pkg.questions).map((id) => [id, no])), ...over });
const reply = (over) => ({ ok: true, answers: answersOf(over), servedModel: 'scripted', packageHash: packageHash(pkg) });

describe('visit access shadow: rules that need no database', () => {
  test('the gate needs GATE_TYPED_DECISIONS and exactly "shadow"; off reads nothing', async () => {
    const never = () => { throw new Error('no reads with the gate off'); };
    gates(false);
    await expect(access.runVisitAccessSweep({ dbh: never })).resolves.toMatchObject({ skippedReason: 'gate_off', asked: 0 });
    process.env.GATE_VISIT_ACCESS_FLAGS = 'shadow';
    await expect(access.runVisitAccessSweep({ dbh: never })).resolves.toMatchObject({ skippedReason: 'gate_off' });
    process.env.GATE_TYPED_DECISIONS = 'true';
    process.env.GATE_VISIT_ACCESS_FLAGS = 'true';
    await expect(access.runVisitAccessSweep({ dbh: never })).resolves.toMatchObject({ skippedReason: 'gate_off' });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  test.each([
    ['a keyword code', 'Gate code is 4471, thanks', '4471'],
    ['a bare keypad entry', 'Use 2468# at the box', '2468'],
    ['a leading pound', 'Press #9031 then wait', '9031'],
    ['a house number', 'We moved to 1200 Example Ave', '1200'],
    ['a phone number', 'Call me at 941-555-0100 first', '555'],
    ['a word used as a code', 'Use BLUE at the keypad', 'BLUE'],
    ['a letters-and-digits code', 'Use AB12 at the box', 'AB12'],
    ['a code spelled out', 'Use four five four five at the keypad', 'four five'],
    ['a code stated after its access point', 'Garage is sesame', 'sesame'],
  ])('%s never reaches the state', (_name, text, secret) => {
    const out = access.redactForState(text);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/\[redacted\]|\[access detail withheld/);
  });

  test('a withheld access sentence keeps which access points it mentioned, and nothing else', () => {
    expect(access.redactForState('Side gate code 5512, latch sticks. Our dog is friendly.')).toBe('[access detail withheld: mentions code, gate] Our dog is friendly.');
  });

  test('what a technician needs to read survives: a time, a count, a date, a past access problem', () => {
    const kept = 'Come after 2 pm, we have 2 dogs, back on 10/15. Gate was locked, could not reach the back yard.';
    expect(access.redactForState(kept)).toBe(kept);
  });

  test('texts stop at the visit\'s own start: its window, else 8 AM Eastern on its date', () => {
    expect(access.stateCutoff({ scheduled_date: '2026-10-05', window_start: '13:00:00' }).toISOString()).toBe('2026-10-05T17:00:00.000Z');
    expect(access.stateCutoff({ scheduled_date: '2026-10-05', window_start: null }).toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });

  test('the digest ignores key order and moves with any value', () => {
    const state = { service_line: 'pest', visit_count: 2, structured: { pet_count: 1, has_codes: true }, notes_text: null, recent_texts: null, last_tech_notes: null };
    const reordered = { last_tech_notes: null, recent_texts: null, notes_text: null, structured: { has_codes: true, pet_count: 1 }, visit_count: 2, service_line: 'pest' };
    expect(access.visitAccessSubjectHash(reordered)).toBe(access.visitAccessSubjectHash(state));
    expect(access.visitAccessSubjectHash({ ...state, visit_count: 3 })).not.toBe(access.visitAccessSubjectHash(state));
  });
});

(SKIP ? describe.skip : describe)('visit access shadow on PostgreSQL', () => {
  const schema = `visit_access_${randomUUID().replaceAll('-', '')}`;
  let database;
  // A Monday; the sweep reads today (10-05) and tomorrow (10-06), Eastern.
  const NOW = new Date('2026-10-05T14:00:00Z');
  const customerId = randomUUID();

  const visit = async (over = {}) => {
    const id = randomUUID();
    await database('scheduled_services').insert({
      id, customer_id: customerId, service_type: 'Quarterly Pest Control', scheduled_date: '2026-10-06', window_start: '09:00', status: 'confirmed', notes: null, ...over,
    });
    return id;
  };
  const text = (body, at, over = {}) => database('sms_log').insert({
    id: randomUUID(), customer_id: customerId, direction: 'inbound', message_body: body, message_type: 'manual', status: 'received', created_at: new Date(at), ...over,
  });
  const rows = (visitId) => database('decision_reviews').where({ subject_id: visitId }).orderBy(['provider', 'question_id']);
  const sweep = () => access.runVisitAccessSweep({ dbh: database, now: NOW });

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.customers (id uuid PRIMARY KEY, deleted_at timestamptz, address_line1 text, zip text, city text)`, [schema]);
    await database.raw(`CREATE TABLE ??.scheduled_services (id uuid PRIMARY KEY, customer_id uuid, service_type varchar(200),
      scheduled_date date, window_start time, status text, notes text, service_address_line1 text, service_address_zip text, service_address_city text)`, [schema]);
    await database.raw(`CREATE TABLE ??.property_preferences (customer_id uuid PRIMARY KEY, pet_count integer, pet_details text,
      pets_secured_plan text, contact_preference text, away_mode_until date, side_gate_access varchar(200), neighborhood_gate_code varchar(50),
      property_gate_code varchar(50), garage_code varchar(50), lockbox_code varchar(50), access_notes text, parking_notes text, special_instructions text,
      chemical_sensitivities boolean, chemical_sensitivity_details text)`, [schema]);
    await database.raw(`CREATE TABLE ??.service_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, status varchar(30),
      service_type varchar(200), service_line varchar(40), service_date date, technician_notes text, created_at timestamptz DEFAULT now())`, [schema]);
    await database.raw(`CREATE TABLE ??.sms_log (id uuid PRIMARY KEY, customer_id uuid, direction varchar(20), message_body text,
      message_type varchar(40), status varchar(30), metadata jsonb, created_at timestamptz)`, [schema]);
    await database.raw(`CREATE TABLE ??.decision_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), capability varchar(60) NOT NULL,
      package_id varchar(80) NOT NULL, package_hash varchar(64), provider varchar(30) NOT NULL, served_model varchar(60),
      subject_type varchar(30) NOT NULL, subject_id uuid NOT NULL, question_id varchar(60) NOT NULL, jev_answer jsonb NOT NULL,
      baseline_answers jsonb, sampled_for varchar(20), subject_hash varchar(64), label jsonb, label_status varchar(20) NOT NULL DEFAULT 'unreviewed',
      created_at timestamptz DEFAULT now(),
      CONSTRAINT decision_reviews_provider_subject_question_uniq UNIQUE (capability, package_id, provider, subject_type, subject_id, question_id),
      CONSTRAINT decision_reviews_subject_type_check CHECK (subject_type IN ('call_log','sms_log','social_post')))`, [schema]);
    await subjectMigration.up(database);
    await database('customers').insert({ id: customerId, address_line1: '100 Example St', zip: '34200', city: 'Bradenton' });
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  });
  beforeEach(async () => {
    gates(true);
    mockAsk.mockReset();
    mockAsk.mockResolvedValue(reply());
    for (const t of ['decision_reviews', 'sms_log', 'service_records', 'property_preferences', 'scheduled_services']) await database(t).del();
  });

  test('the migration keeps a value another migration added, and its down refuses while a visit row exists', async () => {
    const def = async () => (await database.raw(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'decision_reviews_subject_type_check' AND conrelid = ?::regclass`, [`${schema}.decision_reviews`])).rows[0].def;
    expect(await def()).toEqual(expect.stringContaining('scheduled_services'));
    expect(await def()).toEqual(expect.stringContaining('social_post'));
    await subjectMigration.up(database); // a second run changes nothing
    const visitId = await visit();
    await sweep();
    await expect(database.transaction((trx) => subjectMigration.down(trx))).rejects.toThrow(/scheduled_services rows/);
    await database('decision_reviews').del();
    await database.transaction((trx) => subjectMigration.down(trx));
    expect(await def()).not.toEqual(expect.stringContaining('scheduled_services'));
    expect(await def()).toEqual(expect.stringContaining('social_post'));
    await subjectMigration.up(database);
    expect(visitId).toEqual(expect.any(String));
  });

  test('the state carries what is on file and the customer\'s words, and never a code', async () => {
    await database('property_preferences').insert({
      customer_id: customerId, pet_count: 2, pet_details: 'Two labs, friendly', contact_preference: 'text', property_gate_code: '7731',
      access_notes: 'Side gate code 5512, latch sticks', side_gate_access: 'Left side', away_mode_until: '2026-10-20',
      chemical_sensitivities: true, chemical_sensitivity_details: 'Asthma, no sprays near the nursery window',
    });
    await database('service_records').insert([
      { customer_id: customerId, status: 'completed', service_type: 'Quarterly Pest Control', service_date: '2026-07-06', technician_notes: 'Gate was locked, could not reach the back yard.' },
      { customer_id: customerId, status: 'completed', service_type: 'Lawn Care', service_date: '2026-09-20', technician_notes: 'Mowed short.' },
    ]);
    await text('Please text before you come, the baby naps at noon. Garage is 9042#', '2026-10-01T15:00:00Z');
    await text('Liked "Your visit is confirmed"', '2026-10-02T15:00:00Z', { message_type: 'sms_reaction' });
    await text('Before the last pest visit', '2026-07-01T15:00:00Z');
    await text('After the visit started', '2026-10-06T14:00:00Z');
    // 9 PM Eastern the evening BEFORE the last pest visit (07-06): outside the window.
    await text('Evening before the last pest visit', '2026-07-06T01:00:00Z');
    await text('Morning of the last pest visit', '2026-07-06T13:00:00Z');
    const visitId = await visit({ notes: 'Customer asked for the lanai too' });

    const built = await access.buildVisitAccessState(await database('scheduled_services').where({ id: visitId }).first(), database);
    expect(JSON.stringify(built.state)).not.toMatch(/latch sticks/);
    expect(built.state).toMatchObject({
      service_line: 'pest', visit_count: 2,
      structured: { pet_count: 2, has_codes: true, contact_preference: 'text', away_mode: true, side_gate: true, chemical_sensitivity: true },
      last_tech_notes: 'Gate was locked, could not reach the back yard.',
    });
    expect(built.state.recent_texts).toContain('the baby naps at noon');
    expect(built.state.recent_texts).not.toMatch(/Liked|Before the last pest visit|After the visit started|Evening before/);
    expect(built.state.recent_texts).toContain('Morning of the last pest visit');
    expect(built.state.notes_text).toContain('Visit note: Customer asked for the lanai too');
    expect(built.state.notes_text).toContain('Chemical sensitivity: Asthma, no sprays near the nursery window');
    expect(built.state.notes_text).toContain('[access detail withheld: mentions code, gate]');
    expect(JSON.stringify(built.state)).not.toMatch(/7731|5512|9042/);
    expect(built.baselines).toEqual({ dog_on_property: { rules: true }, needs_code_key_or_person: { rules: true } });
    expect(Object.keys(built.state).sort()).toEqual([...pkg.stateShape].sort());
  });

  test('one row per question; a second pass over an unchanged visit asks nobody; a new text asks again', async () => {
    const visitId = await visit();
    await visit({ status: 'cancelled' });
    await visit({ scheduled_date: '2026-10-09' });
    expect(await sweep()).toMatchObject({ considered: 1, asked: 1, recorded: 1, failed: 0 });
    const first = await rows(visitId);
    expect(first).toHaveLength(Object.keys(pkg.questions).length);
    expect(first[0]).toMatchObject({ subject_type: 'scheduled_services', provider: 'typesafe', package_id: 'visit_access.v1', capability: 'visit_access' });
    expect(first.find((r) => r.question_id === 'dog_on_property').baseline_answers).toEqual({ rules: false });
    expect(first.find((r) => r.question_id === 'contact_before_arrival').baseline_answers).toBeNull();

    expect(await sweep()).toMatchObject({ considered: 1, asked: 0, unchanged: 1 });
    expect(mockAsk).toHaveBeenCalledTimes(1);

    await text('Our dog Biscuit will be in the yard', '2026-10-05T13:00:00Z');
    mockAsk.mockResolvedValue(reply({ dog_on_property: yes }));
    expect(await sweep()).toMatchObject({ asked: 1, recorded: 1 });
    const second = await rows(visitId);
    expect(second).toHaveLength(first.length);
    expect(second.find((r) => r.question_id === 'dog_on_property').jev_answer).toMatchObject({ yes: true });
    expect(second[0].subject_hash).not.toBe(first[0].subject_hash);
  });

  test('with the Clef gate on both providers answer, and a case where they differ queues both rows', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_id, _state, opts) => reply(opts && opts.provider === 'cloudflare' ? { past_access_problem: yes } : {}));
    const visitId = await visit();
    expect(await sweep()).toMatchObject({ asked: 2, recorded: 2, failed: 0 });
    const split = (await rows(visitId)).filter((r) => r.question_id === 'past_access_problem');
    expect(split.map((r) => r.provider)).toEqual(['cloudflare', 'typesafe']);
    expect(new Set(split.map((r) => r.sampled_for))).toEqual(new Set([split[0].sampled_for]));
    expect(['disagreement', 'random_audit']).toContain(split[0].sampled_for);
  });

  test('a provider that fails is asked again next pass; the one that answered is not', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_id, _state, opts) => (opts && opts.provider === 'cloudflare' ? { ok: false, reason: 'error' } : reply()));
    const visitId = await visit();
    expect(await sweep()).toMatchObject({ asked: 2, recorded: 1, failed: 1 });
    mockAsk.mockClear();
    mockAsk.mockResolvedValue(reply());
    expect(await sweep()).toMatchObject({ asked: 1, recorded: 1 });
    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockAsk.mock.calls[0][2]).toEqual({ provider: 'cloudflare' });
    expect(new Set((await rows(visitId)).map((r) => r.provider))).toEqual(new Set(['typesafe', 'cloudflare']));
  });

  test('a retried provider that differs from the stored one queues BOTH rows', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_id, _state, opts) => (opts && opts.provider === 'cloudflare' ? { ok: false, reason: 'error' } : reply()));
    const visitId = await visit();
    await sweep();
    mockAsk.mockResolvedValue(reply({ contact_before_arrival: yes }));
    await sweep();
    const pair = (await rows(visitId)).filter((r) => r.question_id === 'contact_before_arrival');
    expect(pair).toHaveLength(2);
    expect(pair[0].sampled_for).toBe(pair[1].sampled_for);
    expect(['disagreement', 'random_audit']).toContain(pair[0].sampled_for);
    // A question they agree on is not queued by the refresh.
    const agreed = (await rows(visitId)).filter((r) => r.question_id === 'person_home_needs_notice');
    expect(agreed[0].sampled_for).toBe(agreed[1].sampled_for);
    expect(agreed[0].sampled_for).not.toBe('disagreement');
  });

  test('a visit stamped at another address is left out: the saved pets and codes are the primary home\'s', async () => {
    await database('property_preferences').insert({ customer_id: customerId, pet_count: 3, garage_code: '1188' });
    const rental = await visit({ service_address_line1: '77 Sample Rd', service_address_zip: '34201', service_address_city: 'Bradenton' });
    const home = await visit({ service_address_line1: '100 Example Street', service_address_zip: '34200' });
    expect(await sweep()).toMatchObject({ considered: 2, asked: 1, skipped: 1 });
    expect(await rows(rental)).toHaveLength(0);
    expect(await rows(home)).toHaveLength(Object.keys(pkg.questions).length);
    expect(await access.liveVisitAccess(rental, database)).toBeNull();
  });

  test('only upcoming statuses are read, and an answered visit never uses up the pass', async () => {
    const live = await Promise.all(['pending', 'confirmed', 'en_route', 'on_site'].map((status) => visit({ status })));
    for (const status of ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show']) await visit({ status });
    expect(await sweep()).toMatchObject({ considered: live.length, asked: live.length, deferred: 0 });
    const late = await visit();
    expect(await sweep()).toMatchObject({ considered: live.length + 1, asked: 1, unchanged: live.length });
    expect(await rows(late)).toHaveLength(Object.keys(pkg.questions).length);
  });

  test('a switched-off provider\'s rows for an older state do not decide a new answer\'s cohort', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_id, _state, opts) => reply(opts && opts.provider === 'cloudflare' ? { contact_before_arrival: yes } : {}));
    const visitId = await visit();
    await sweep();
    const before = (await rows(visitId)).find((r) => r.provider === 'cloudflare' && r.question_id === 'contact_before_arrival');
    delete process.env.GATE_TYPED_DECISIONS_CLEF;
    await text('Please knock first, thank you', '2026-10-05T13:30:00Z');
    mockAsk.mockResolvedValue(reply());
    expect(await sweep()).toMatchObject({ asked: 1, recorded: 1 });
    const { sampleFor, stableDraw } = require('../services/typed-decisions/shadow-recorder');
    for (const row of (await rows(visitId)).filter((r) => r.provider === 'typesafe')) {
      const alone = sampleFor(row.jev_answer, row.baseline_answers, () => stableDraw(row), []);
      expect(row.sampled_for).toBe(alone);
    }
    const after = (await rows(visitId)).find((r) => r.provider === 'cloudflare' && r.question_id === 'contact_before_arrival');
    expect(after).toMatchObject({ subject_hash: before.subject_hash, sampled_for: before.sampled_for });
  });

  test('the review route\'s rebuild matches the stored digest after the visit is completed', async () => {
    await text('The dog will be inside today', '2026-10-04T15:00:00Z');
    const visitId = await visit();
    await sweep();
    const stored = (await rows(visitId))[0].subject_hash;
    // The visit runs: it completes, its own record lands, the customer texts after.
    await database('scheduled_services').where({ id: visitId }).update({ status: 'completed' });
    await database('service_records').insert({ customer_id: customerId, status: 'completed', service_type: 'Quarterly Pest Control', service_date: '2026-10-06', technician_notes: 'All good today.' });
    await text('Thanks for coming', '2026-10-06T18:00:00Z');
    const live = await access.liveVisitAccess(visitId, database);
    expect(live.hash).toBe(stored);
    expect(live.text).toContain('The dog will be inside today');
    expect(live.text).not.toContain('Thanks for coming');
    expect(await access.liveVisitAccess(randomUUID(), database)).toBeNull();
  });
});
