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

const GATES = ['GATE_TYPED_DECISIONS', 'GATE_TYPED_DECISIONS_CLEF', 'GATE_VISIT_ACCESS_FLAGS', 'GATE_NEIGHBORHOOD_ACCESS'];
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
    ['a code after a separator with no space', 'Garage:sesame', 'sesame'],
    ['a code after an equals sign', 'Gate=BLUE', 'BLUE'],
    ['a capitalised code with no access word', 'Use BLUE at the box', 'BLUE'],
    ['a code on the line after its access point', 'Garage:\nsesame', 'sesame'],
    ['a spoken code on a continuation line', 'Gate code:\nfour five four five', 'four five'],
    ['a code in a later sentence', 'The side gate sticks. Try sesame twice.', 'sesame'],
    ['a word code after an instruction verb', 'Use sesame', 'sesame'],
  ])('%s never reaches the state', (_name, text, secret) => {
    const out = access.redactForState(text);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/\[redacted\]|\[access detail withheld/);
  });

  test('a text that mentions access leaves only as a marker of which access points it named', () => {
    expect(access.redactForState('Side gate code 5512, latch sticks. Our dog is friendly.')).toBe('[access detail withheld: mentions code, gate]');
  });

  test('what a technician needs to read survives: a time, a count, a date', () => {
    const kept = 'Come after 2 pm, we have 2 dogs, back on 10/15.';
    expect(access.redactForState(kept)).toBe(kept);
  });

  test('a past access problem is kept as a fixed phrase, never the writer\'s words', () => {
    expect(access.redactForState('Gate was locked, could not reach the back yard.')).toBe('[access detail withheld: mentions gate; reports a problem getting in]');
    expect(access.redactForState('WE HAVE ANTS ALL OVER THE KITCHEN')).toBe('WE HAVE ANTS ALL OVER THE KITCHEN');
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
  // The visit row as the sweep reads it (joined to its customer).
  const build = async (visitId) => access.buildVisitAccessState(await database('scheduled_services as s').join('customers as c', 's.customer_id', 'c.id').where('s.id', visitId)
    .first('s.*', 'c.address_line1 as customer_address_line1', 'c.address_line2 as customer_address_line2', 'c.zip as customer_zip', 'c.city as customer_city', 'c.has_multi_home'), database);

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.customers (id uuid PRIMARY KEY, deleted_at timestamptz, address_line1 text, address_line2 text, zip text, city text, has_multi_home boolean)`, [schema]);
    await database.raw(`CREATE TABLE ??.scheduled_services (id uuid PRIMARY KEY, customer_id uuid, service_type varchar(200),
      scheduled_date date, window_start time, status text, notes text, customer_request text, completed_at timestamptz, service_address_line1 text, service_address_line2 text, service_address_zip text, service_address_city text,
      property_id uuid, source_estimate_id uuid)`, [schema]);
    await database.raw(`CREATE TABLE ??.customer_properties (id uuid PRIMARY KEY, customer_id uuid, address_line1 text, address_line2 text, city text, zip text,
      neighborhood_id uuid, active boolean DEFAULT true)`, [schema]);
    await database.raw(`CREATE TABLE ??.neighborhoods (id uuid PRIMARY KEY, active boolean)`, [schema]);
    await database.raw(`CREATE TABLE ??.neighborhood_access (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), neighborhood_id uuid, gate_label text,
      access_type text, code text, instructions text, status text)`, [schema]);
    await database.raw(`CREATE TABLE ??.estimates (id uuid PRIMARY KEY, address text)`, [schema]);
    await database.raw(`CREATE TABLE ??.property_preferences (customer_id uuid PRIMARY KEY, pet_count integer, pet_details text,
      pets_secured_plan text, contact_preference text, away_mode_until date, side_gate_access varchar(200), neighborhood_gate_code varchar(50),
      property_gate_code varchar(50), garage_code varchar(50), lockbox_code varchar(50), access_notes text, parking_notes text, special_instructions text,
      chemical_sensitivities boolean, chemical_sensitivity_details text)`, [schema]);
    await database.raw(`CREATE TABLE ??.service_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, status varchar(30),
      service_type varchar(200), service_line varchar(40), service_date date, technician_notes text, created_at timestamptz DEFAULT now(),
      started_at timestamptz, pressure_index integer, structured_notes jsonb, service_data jsonb, completion_source varchar(40))`, [schema]);
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
    for (const t of ['decision_reviews', 'sms_log', 'service_records', 'property_preferences', 'scheduled_services', 'customer_properties', 'neighborhood_access', 'neighborhoods']) await database(t).del();
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
      chemical_sensitivities: true, chemical_sensitivity_details: 'Asthma, no sprays near the nursery',
    });
    await database('service_records').insert([
      { customer_id: customerId, status: 'completed', service_type: 'Quarterly Pest Control', service_date: '2026-07-06', technician_notes: 'Gate was locked, could not reach the back yard.' },
      { customer_id: customerId, status: 'completed', service_type: 'Lawn Care', service_date: '2026-09-20', technician_notes: 'Mowed short.' },
    ]);
    await visit({ scheduled_date: '2026-07-06', status: 'completed' });
    await visit({ scheduled_date: '2026-09-20', status: 'completed', service_type: 'Lawn Care' });
    await text('Please text before you come, the baby naps at noon.', '2026-10-01T15:00:00Z');
    await text('The garage one changed', '2026-10-01T16:00:00Z');
    await text('nine zero four two', '2026-10-01T16:02:00Z');
    await text('Also we got a second dog', '2026-10-03T18:00:00Z');
    await text('Liked "Your visit is confirmed"', '2026-10-02T15:00:00Z', { message_type: 'sms_reaction' });
    await text('Before the last pest visit', '2026-07-01T15:00:00Z');
    await text('After the visit started', '2026-10-06T14:00:00Z');
    // 9 PM Eastern the evening BEFORE the last pest visit (07-06): outside the window.
    await text('Evening before the last pest visit', '2026-07-06T01:00:00Z');
    await text('Morning of the last pest visit', '2026-07-06T13:00:00Z');
    const visitId = await visit({ notes: 'Customer asked for the lanai too' });

    const built = await build(visitId);
    expect(JSON.stringify(built.state)).not.toMatch(/latch sticks/);
    expect(built.state).toMatchObject({
      service_line: 'pest', visit_count: 2,
      structured: { pet_count: 2, has_codes: true, contact_preference: 'text', away_mode: true, side_gate: true, chemical_sensitivity: true, neighborhood_gate: false },
      last_tech_notes: '[access detail withheld: mentions gate; reports a problem getting in]',
    });
    expect(built.state.recent_texts).toContain('the baby naps at noon');
    expect(built.state.recent_texts).toContain('[access detail withheld: mentions garage]');
    expect(built.state.recent_texts).toContain('[follow-up to an access detail withheld]');
    expect(built.state.recent_texts).not.toContain('nine zero four two');
    expect(built.state.recent_texts).toContain('Also we got a second dog');
    expect(built.state.recent_texts).not.toMatch(/Liked|Before the last pest visit|After the visit started|Evening before/);
    expect(built.state.recent_texts).toContain('Morning of the last pest visit');
    expect(built.state.notes_text).toContain('Visit note: Customer asked for the lanai too');
    expect(built.state.notes_text).toContain('Chemical sensitivity: Asthma, no sprays near the nursery');
    expect(built.state.notes_text).toContain('[access detail withheld: mentions code, gate]');
    expect(JSON.stringify(built.state)).not.toMatch(/7731|5512|9042|latch/);
    expect(built.baselines).toEqual({ dog_on_property: { rules: true }, needs_code_key_or_person: { rules: true } });
    expect(Object.keys(built.state).sort()).toEqual([...pkg.stateShape].sort());
  });

  test('a completed visit with no service record still counts and still starts the text window', async () => {
    await visit({ scheduled_date: '2026-09-01', status: 'completed' });
    await text('We are away the last week of August', '2026-08-20T15:00:00Z');
    await text('The baby sleeps until ten', '2026-09-15T15:00:00Z');
    const visitId = await visit();
    const built = await build(visitId);
    expect(built.state.visit_count).toBe(1);
    expect(built.state.recent_texts).toContain('The baby sleeps until ten');
    expect(built.state.recent_texts).not.toContain('away the last week');
    expect(built.state.last_tech_notes).toBeNull();
  });

  test('a reply to a Waves text that asked about access is withheld; the Waves text itself never enters the state', async () => {
    await text('What is your gate password?', '2026-10-03T15:00:00Z', { direction: 'outbound', status: 'delivered' });
    await text('sesame', '2026-10-03T19:00:00Z');
    await text('Your visit is set for Tuesday', '2026-10-01T15:00:00Z', { direction: 'outbound', status: 'delivered' });
    await text('Great, the cat stays inside', '2026-10-01T15:05:00Z');
    const visitId = await visit();
    const built = await build(visitId);
    expect(built.state.recent_texts).not.toMatch(/sesame|password|Your visit is set/);
    expect(built.state.recent_texts).toContain('[follow-up to an access detail withheld]');
    expect(built.state.recent_texts).toContain('Great, the cat stays inside');
  });

  test('an access question sent just before the window still withholds the reply inside it', async () => {
    await visit({ scheduled_date: '2026-09-01', status: 'completed' });
    // The window starts at Eastern midnight 09-01 (04:00Z).
    await text('What is the code for the side gate?', '2026-09-01T02:00:00Z', { direction: 'outbound', status: 'delivered' });
    await text('sesame', '2026-09-01T12:00:00Z');
    await text('See you then', '2026-09-03T12:00:00Z');
    const visitId = await visit();
    const built = await build(visitId);
    expect(built.state.recent_texts).not.toContain('sesame');
    expect(built.state.recent_texts).toContain('See you then');
  });

  test('the access fields never leave as written, whatever they say', async () => {
    await database('property_preferences').insert({ customer_id: customerId, access_notes: 'sesame', side_gate_access: 'bluebird' });
    const visitId = await visit();
    const built = await build(visitId);
    expect(JSON.stringify(built.state)).not.toMatch(/sesame|bluebird/);
    expect(built.state.notes_text).toBe('Access notes: [access detail withheld]\nSide gate: [access detail withheld]');
    expect(built.state.structured.side_gate).toBe(true);
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

  test('a multi-property account is left out: saved facts, texts and history are keyed on the customer', async () => {
    await database('property_preferences').insert({ customer_id: customerId, pet_count: 3, garage_code: '1188' });
    const home = await visit({ service_address_line1: '100 Example Street', service_address_zip: '34200', service_address_city: 'Bradenton' });
    expect(await sweep()).toMatchObject({ considered: 1, asked: 1, skipped: 0 });
    expect(await rows(home)).toHaveLength(Object.keys(pkg.questions).length);
    // A second premises appears three ways: a stamp, a property link with no stamp, the flag.
    const rental = await visit({ service_address_line1: '77 Sample Rd', service_address_zip: '34201', service_address_city: 'Bradenton' });
    expect(await build(rental)).toBeNull();
    expect(await build(home)).toBeNull();
    expect(await access.liveVisitAccess(home, database)).toBeNull();
    await database('scheduled_services').where({ id: rental }).del();
    const propertyId = randomUUID();
    await database('customer_properties').insert({ id: propertyId, customer_id: customerId, address_line1: '9 Other Way', city: 'Sarasota', zip: '34230' });
    const linked = await visit({ property_id: propertyId });
    expect(await build(linked)).toBeNull();
    await database('customer_properties').del();
    await database('scheduled_services').where({ id: linked }).del();
    expect(await build(home)).not.toBeNull();
    await database('customers').where({ id: customerId }).update({ has_multi_home: true });
    expect(await build(home)).toBeNull();
    await database('customers').where({ id: customerId }).update({ has_multi_home: false });
  });

  test('long preference notes never push out the visit note or the sensitivity', async () => {
    const long = 'Please be careful around the flower beds. '.repeat(40);
    await database('property_preferences').insert({ customer_id: customerId, parking_notes: long, special_instructions: long, pet_details: long, pets_secured_plan: long,
      chemical_sensitivities: true, chemical_sensitivity_details: 'Asthma in the home' });
    const built = await build(await visit({ notes: 'Customer wants a knock first' }));
    expect(built.state.notes_text).toContain('Visit note: Customer wants a knock first');
    expect(built.state.notes_text).toContain('Chemical sensitivity: Asthma in the home');
    expect(built.state.notes_text).toContain('Parking: Please be careful');
  });

  test('a queued row older than the review window restarts its age; an unqueued one is left alone', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_id, _state, opts) => reply(opts && opts.provider === 'cloudflare' ? { contact_before_arrival: yes } : {}));
    const visitId = await visit();
    await sweep();
    await database('decision_reviews').where({ subject_id: visitId }).update({ created_at: new Date('2026-09-01T12:00:00Z') });
    expect(await sweep()).toMatchObject({ unchanged: 1, asked: 0 });
    for (const row of await rows(visitId)) {
      const fresh = new Date(row.created_at).getTime() > new Date('2026-10-01T00:00:00Z').getTime();
      expect(fresh).toBe(row.sampled_for !== null);
    }
    expect((await rows(visitId)).filter((r) => r.question_id === 'contact_before_arrival').every((r) => r.sampled_for)).toBe(true);
  });

  test('a cohort refresh that never ran is made good on the next unchanged pass', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_id, _state, opts) => reply(opts && opts.provider === 'cloudflare' ? { contact_before_arrival: yes } : {}));
    const visitId = await visit();
    await sweep();
    await database('decision_reviews').where({ subject_id: visitId, provider: 'typesafe', question_id: 'contact_before_arrival' }).update({ sampled_for: null });
    expect(await sweep()).toMatchObject({ unchanged: 1 });
    const pair = (await rows(visitId)).filter((r) => r.question_id === 'contact_before_arrival');
    expect(pair[0].sampled_for).toBe(pair[1].sampled_for);
    expect(pair[0].sampled_for).not.toBeNull();
  });

  test('the customer\'s request for this visit rides in the notes; the text window starts when the last visit finished', async () => {
    await visit({ scheduled_date: '2026-09-01', status: 'completed', completed_at: new Date('2026-09-01T18:00:00Z') });
    await text('Please knock today, baby asleep', '2026-09-01T13:00:00Z');
    await text('The lanai had ants again', '2026-09-01T20:00:00Z');
    const built = await build(await visit({ customer_request: 'Please knock first, we have a newborn' }));
    expect(built.state.notes_text).toContain('Customer request for this visit: Please knock first, we have a newborn');
    expect(built.state.recent_texts).toContain('The lanai had ants again');
    expect(built.state.recent_texts).not.toContain('Please knock today');
  });

  test('the last technician note is found behind many newer records of another line', async () => {
    await database('service_records').insert({ customer_id: customerId, status: 'completed', service_type: 'Quarterly Pest Control', service_date: '2026-01-05', technician_notes: 'Dog was loose in the yard.' });
    await database('service_records').insert(Array.from({ length: 130 }, (_, i) => ({
      customer_id: customerId, status: 'completed', service_type: 'Lawn Care', service_date: '2026-06-01', technician_notes: `Lawn visit ${i}`,
    })));
    const built = await build(await visit());
    expect(built.state.last_tech_notes).toBe('Dog was loose in the yard.');
    // Later same-line records never change what was known before the visit.
    await database('service_records').insert(Array.from({ length: 12 }, (_, i) => ({
      customer_id: customerId, status: 'completed', service_type: 'Quarterly Pest Control', service_date: '2026-11-01', technician_notes: `Later visit ${i}`,
    })));
    expect((await build((await database('scheduled_services').where({ status: 'confirmed' }).first('id')).id)).state.last_tech_notes).toBe('Dog was loose in the yard.');
  });

  test('many newer visits of another line neither cap the count nor hide the same-line anchor', async () => {
    await visit({ scheduled_date: '2026-09-10', status: 'completed', completed_at: new Date('2026-09-10T18:00:00Z') });
    await database('scheduled_services').insert(Array.from({ length: 230 }, () => ({
      id: randomUUID(), customer_id: customerId, service_type: 'Lawn Care', scheduled_date: '2026-09-20', status: 'completed',
    })));
    await text('Please knock today', '2026-09-05T15:00:00Z');
    await text('Ants are back in the lanai', '2026-09-25T15:00:00Z');
    const built = await build(await visit());
    expect(built.state.visit_count).toBe(231);
    expect(built.state.recent_texts).toContain('Ants are back in the lanai');
    expect(built.state.recent_texts).not.toContain('Please knock today');
  });

  test('a credential split over texts an hour apart is withheld; a failed Waves text opens no window', async () => {
    await text('My gate code is', '2026-10-02T15:00:00Z');
    await text('bluebird', '2026-10-02T16:10:00Z');
    await text('What is the garage code?', '2026-09-28T15:00:00Z', { direction: 'outbound', status: 'failed' });
    await text('The dog will be loose', '2026-09-28T16:00:00Z');
    const built = await build(await visit());
    expect(built.state.recent_texts).not.toContain('bluebird');
    expect(built.state.recent_texts).toContain('The dog will be loose');
  });

  test('scheduler audit text never enters the notes', async () => {
    const built = await build(await visit({ notes: 'Please use the back patio. recurring_align_2026_06: moved from Tue to Wed. No SMS sent.' }));
    expect(built.state.notes_text).not.toMatch(/recurring_align|No SMS sent/);
  });

  test('a shared neighborhood gate entry counts as a code on file, and its code never leaves', async () => {
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
    const neighborhoodId = randomUUID();
    await database('neighborhoods').insert({ id: neighborhoodId, active: true });
    await database('neighborhood_access').insert({ neighborhood_id: neighborhoodId, gate_label: 'Main', access_type: 'keypad', code: '6612', status: 'active' });
    await database('customer_properties').insert({ id: randomUUID(), customer_id: customerId, address_line1: '100 Example St', city: 'Bradenton', zip: '34200', neighborhood_id: neighborhoodId });
    const built = await build(await visit());
    expect(built.state.structured).toMatchObject({ has_codes: true, neighborhood_gate: true });
    expect(built.baselines.needs_code_key_or_person).toEqual({ rules: true });
    expect(JSON.stringify(built.state)).not.toContain('6612');
  });

  test('a provider that is down does not keep later visits from their first answer', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_id, _state, opts) => (opts && opts.provider === 'cloudflare' ? { ok: false, reason: 'error' } : reply()));
    const first = await visit();
    await sweep();
    const second = await visit();
    const result = await sweep();
    expect(result).toMatchObject({ askedVisits: 1, retryVisits: 1 });
    expect((await rows(second)).filter((r) => r.provider === 'typesafe')).toHaveLength(Object.keys(pkg.questions).length);
    expect((await rows(first)).filter((r) => r.provider === 'typesafe')).toHaveLength(Object.keys(pkg.questions).length);
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

  test('a fresh answer the recorder refused (its row is labeled) does not decide the other provider\'s cohort', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    const visitId = await visit();
    await sweep();
    await database('decision_reviews').where({ subject_id: visitId, provider: 'cloudflare' }).update({ label_status: 'confirmed_correct' });
    await text('We will be home all day', '2026-10-05T13:40:00Z');
    // Both are asked on the new state only if due: the labeled provider is settled, so only Jev is.
    mockAsk.mockImplementation(async (_id, _state, opts) => reply(opts && opts.provider === 'cloudflare' ? { contact_before_arrival: yes } : {}));
    expect(await sweep()).toMatchObject({ asked: 1 });
    const { sampleFor, stableDraw } = require('../services/typed-decisions/shadow-recorder');
    for (const row of (await rows(visitId)).filter((r) => r.provider === 'typesafe')) {
      expect(row.sampled_for).toBe(sampleFor(row.jev_answer, row.baseline_answers, () => stableDraw(row), []));
    }
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
