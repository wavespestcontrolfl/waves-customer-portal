/**
 * Visit access flags for the technician (services/visit-access-flags.js). Behavior under proof:
 *  - a question is flagged when ANY provider answered yes for the visit's NEWEST stored state, and not once
 *    it is marked wrong; an older state's rows never show;
 *  - the quote and its source are picked from the stored redacted state by fixed keyword lists, no model;
 *  - a tap labels every unlabeled row of the question through the shared label write (rows that agree with the
 *    technician are correct, the others wrong with the true answer), twice changes nothing, and never replaces a
 *    reviewer's confirmed label;
 *  - Right on a dog flag saves one pet_details line only while nothing is on file.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAudit = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));
const mockCloseIfEmpty = jest.fn(async () => 0);
jest.mock('../services/typed-decisions/daily-review-item', () => ({ closeIfQueueEmpty: (...a) => mockCloseIfEmpty(...a) }));
// label-write reads the shared db module; the suite points it at its own schema.
let mockDatabase;
jest.mock('../models/db', () => (...args) => mockDatabase(...args));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const statesMigration = require('../models/migrations/20261003140000_visit_access_states');
const flags = require('../services/visit-access-flags');

jest.setTimeout(60000);

describe('visit access flags: the quote a technician reads', () => {
  const state = {
    notes_text: 'Visit note: gate sticks on the left\nPets: two labs',
    recent_texts: '- Please call before you come. The baby naps at noon.\n- Our dog Biscuit stays in the yard.',
    last_tech_notes: 'Gate was locked, could not reach the back yard.',
  };

  test.each([
    ['dog_on_property', 'Our dog Biscuit stays in the yard.', 'Customer text'],
    ['needs_code_key_or_person', 'Visit note: gate sticks on the left', 'Customer text'],
    ['contact_before_arrival', 'Please call before you come.', 'Customer text'],
    ['person_home_needs_notice', 'The baby naps at noon.', 'Customer text'],
    ['past_access_problem', 'Gate was locked, could not reach the back yard.', 'Last technician note'],
    ['access_fact_not_on_file', 'Our dog Biscuit stays in the yard.', 'Customer text'],
  ])('%s picks the first matching sentence in its own field order', (questionId, quote, source) => {
    // needs_code has no match in the texts, so it falls to the notes.
    const expected = questionId === 'needs_code_key_or_person' ? { quote, source: 'Notes on file' } : { quote, source };
    expect(flags.pickQuote(state, questionId)).toEqual(expected);
    expect(flags.pickQuote(state, questionId)).toEqual(expected);
  });

  test('no keyword match: no quote, and the source names the fields that were read', () => {
    expect(flags.pickQuote({ notes_text: 'Visit note: spray the front', recent_texts: null, last_tech_notes: '  ' }, 'dog_on_property'))
      .toEqual({ quote: null, source: 'Read: notes on file' });
    expect(flags.pickQuote({}, 'dog_on_property')).toEqual({ quote: null, source: 'Read: nothing written on file' });
  });

  test('a long line is cut to a short quote', () => {
    const out = flags.pickQuote({ recent_texts: `- dog ${'x'.repeat(400)}` }, 'dog_on_property');
    expect(out.quote.length).toBe(160);
  });

  test('a read that fails answers null, so the brief still serves', async () => {
    const broken = () => { throw new Error('db down'); };
    await expect(flags.accessFlagsFor(broken, { id: randomUUID(), customer_id: randomUUID() })).resolves.toBeNull();
  });
});

(SKIP ? describe.skip : describe)('visit access flags on PostgreSQL', () => {
  const schema = `visit_flags_${randomUUID().replaceAll('-', '')}`;
  let database;
  const customerId = randomUUID();
  const who = { labeledBy: 'tech@example.test', actorId: 'tech-1', ip: '127.0.0.1', userAgent: 'jest' };
  const QUESTIONS = ['dog_on_property', 'needs_code_key_or_person', 'contact_before_arrival', 'person_home_needs_notice', 'past_access_problem', 'access_fact_not_on_file'];
  const visit = () => ({ id: visitId, customer_id: customerId });
  let visitId;
  let seq = 0;

  // One stored state and its rows: answers = { provider: { question: boolean } }, unlisted = no.
  async function seed({ state = { recent_texts: '- Our dog Biscuit will be in the yard' }, answers = { typesafe: { dog_on_property: true } }, at = new Date('2026-10-06T10:00:00Z') } = {}) {
    seq += 1;
    const hash = `${String(seq).padStart(2, '0')}`.padEnd(64, 'a');
    await database('visit_access_states').insert({ scheduled_service_id: visitId, subject_hash: hash, state: JSON.stringify(state), created_at: at });
    for (const [provider, said] of Object.entries(answers)) {
      for (const q of QUESTIONS) {
        await database('decision_reviews').insert({
          capability: 'visit_access', package_id: 'visit_access.v1', provider, subject_type: 'scheduled_services', subject_id: visitId,
          question_id: q, jev_answer: JSON.stringify({ p: said[q] ? 0.95 : 0.03, yes: Boolean(said[q]), confident: true }), subject_hash: hash,
        });
      }
    }
    return hash;
  }
  const review = (provider, q) => database('decision_reviews').where({ subject_id: visitId, provider, question_id: q }).first();
  const pets = () => database('property_preferences').where({ customer_id: customerId }).first();

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    mockDatabase = database;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.decision_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), capability varchar(60) NOT NULL,
      package_id varchar(80) NOT NULL, provider varchar(30) NOT NULL, subject_type varchar(30) NOT NULL, subject_id uuid NOT NULL,
      question_id varchar(60) NOT NULL, jev_answer jsonb NOT NULL, subject_hash varchar(64), label jsonb,
      label_status varchar(20) NOT NULL DEFAULT 'unreviewed', labeled_by varchar(120), labeled_at timestamptz, created_at timestamptz DEFAULT now())`, [schema]);
    await database.raw(`CREATE TABLE ??.property_preferences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid UNIQUE,
      pet_count integer, pet_details text, updated_at timestamptz DEFAULT now(), irrigation_revision integer DEFAULT 0)`, [schema]);
    await statesMigration.up(database);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  });
  beforeEach(async () => {
    mockAudit.mockClear();
    mockCloseIfEmpty.mockClear();
    visitId = randomUUID();
    for (const t of ['visit_access_states', 'decision_reviews', 'property_preferences']) await database(t).del();
  });

  test('any provider saying yes flags the question; all no does not; the quote and read time come from the stored state', async () => {
    await seed({
      state: { recent_texts: '- Our dog Biscuit will be in the yard\n- Please text first' },
      answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false, contact_before_arrival: true } },
    });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out.map((f) => f.questionId)).toEqual(['dog_on_property', 'contact_before_arrival']);
    expect(out[0]).toEqual({
      questionId: 'dog_on_property', title: 'Dog or other animal may be loose', tone: 'amber', status: 'open', readAt: '2026-10-06T10:00:00.000Z',
      quote: 'Our dog Biscuit will be in the yard', source: 'Customer text', saveToFile: 'pets',
    });
    expect(out[1]).toMatchObject({ tone: 'plain', title: 'Customer asked for a call or text before you arrive', quote: 'Please text first', saveToFile: null });
  });

  test('only the newest stored state counts: an older state\'s yes does not show', async () => {
    await seed({ answers: { typesafe: { needs_code_key_or_person: true } }, at: new Date('2026-10-05T10:00:00Z') });
    await seed({ answers: { typesafe: { past_access_problem: true } }, at: new Date('2026-10-06T10:00:00Z') });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out.map((f) => f.questionId)).toEqual(['past_access_problem']);
    expect(out[0].tone).toBe('amber');
  });

  test('a visit with no stored state has no flags', async () => {
    await expect(flags.accessFlagsFor(database, visit())).resolves.toEqual([]);
  });

  test('Right labels every row of the question (agreeing rows correct, the others wrong with the true answer) and saves the pet line once', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false } } });
    const out = await flags.tapAccessFlag(database, visit(), { questionId: 'dog_on_property', verdict: 'right' }, who);
    expect(out).toEqual({ status: 'right', saved: true });
    expect(await review('typesafe', 'dog_on_property')).toMatchObject({ label_status: 'confirmed_correct', labeled_by: 'tech@example.test' });
    const clef = await review('cloudflare', 'dog_on_property');
    expect(clef).toMatchObject({ label_status: 'confirmed_error', labeled_by: 'tech@example.test' });
    expect(clef.label).toMatchObject({ verdict: 'jev_wrong', correct_value: true });
    // other questions are untouched
    expect(await review('typesafe', 'contact_before_arrival')).toMatchObject({ label_status: 'unreviewed' });
    expect(mockAudit.mock.calls.filter(([e]) => e.action === 'typed_decision.labeled')).toHaveLength(2);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ actor_type: 'technician', actor_id: 'tech-1', resource_type: 'decision_review' });
    expect(mockAudit.mock.calls.find(([e]) => e.action === 'visit_access_flag.pet_saved')[0]).toMatchObject({ resource_type: 'property_preferences', critical: true });
    expect((await pets()).pet_details).toMatch(/^Dog \(customer text; confirmed by tech \d{1,2}\/\d{1,2}\)$/);

    // The flag stays, now as right; a second tap changes nothing and saves nothing new.
    expect((await flags.accessFlagsFor(database, visit()))[0]).toMatchObject({ questionId: 'dog_on_property', status: 'right', saveToFile: null });
    mockAudit.mockClear();
    const saved = (await pets()).pet_details;
    expect(await flags.tapAccessFlag(database, visit(), { questionId: 'dog_on_property', verdict: 'right' }, who)).toEqual({ status: 'right', saved: false });
    expect(mockAudit).not.toHaveBeenCalled();
    expect((await pets()).pet_details).toBe(saved);
  });

  test('Wrong labels the yes rows wrong (true answer no), hides the flag and saves nothing', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false } } });
    expect(await flags.tapAccessFlag(database, visit(), { questionId: 'dog_on_property', verdict: 'wrong' }, who)).toEqual({ status: 'wrong', saved: false });
    const jev = await review('typesafe', 'dog_on_property');
    expect(jev).toMatchObject({ label_status: 'confirmed_error' });
    expect(jev.label).toMatchObject({ verdict: 'jev_wrong', correct_value: false });
    expect(await review('cloudflare', 'dog_on_property')).toMatchObject({ label_status: 'confirmed_correct' });
    expect(await flags.accessFlagsFor(database, visit())).toEqual([]);
    expect(await pets()).toBeUndefined();
    expect(mockCloseIfEmpty).toHaveBeenCalled();
  });

  test('the pet line is saved only while nothing is on file', async () => {
    await seed();
    await database('property_preferences').insert({ customer_id: customerId, pet_count: 2, pet_details: null });
    expect((await flags.accessFlagsFor(database, visit()))[0].saveToFile).toBeNull();
    expect(await flags.tapAccessFlag(database, visit(), { questionId: 'dog_on_property', verdict: 'right' }, who)).toEqual({ status: 'right', saved: false });
    expect(await pets()).toMatchObject({ pet_count: 2, pet_details: null });

    await database('property_preferences').update({ pet_count: 0, pet_details: 'Cat, indoors' });
    await expect(flags.tapAccessFlag(database, visit(), { questionId: 'dog_on_property', verdict: 'right' }, who)).resolves.toMatchObject({ saved: false });
    expect((await pets()).pet_details).toBe('Cat, indoors');
  });

  test('a profile row with a blank pet line (no count) still takes the save', async () => {
    await seed();
    await database('property_preferences').insert({ customer_id: customerId, pet_count: 0, pet_details: '' });
    expect(await flags.tapAccessFlag(database, visit(), { questionId: 'dog_on_property', verdict: 'right' }, who)).toEqual({ status: 'right', saved: true });
    expect((await pets()).pet_details).toMatch(/^Dog \(customer text/);
  });

  test('a reviewer\'s confirmed label is never replaced by a tap; a Right tap outranks an earlier Wrong', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: true } } });
    await database('decision_reviews').where({ provider: 'typesafe', question_id: 'dog_on_property' }).update({
      label_status: 'confirmed_error', labeled_by: 'owner@example.test', label: JSON.stringify({ verdict: 'jev_wrong', correct_value: false }),
    });
    // Someone confirmed the dog answer wrong, so the flag is hidden even though the other provider still says yes.
    expect(await flags.accessFlagsFor(database, visit())).toEqual([]);
    const out = await flags.tapAccessFlag(database, visit(), { questionId: 'dog_on_property', verdict: 'right' }, who);
    expect(out.status).toBe('right');
    expect(await review('typesafe', 'dog_on_property')).toMatchObject({ labeled_by: 'owner@example.test', label_status: 'confirmed_error' });
    expect(await review('cloudflare', 'dog_on_property')).toMatchObject({ labeled_by: 'tech@example.test', label_status: 'confirmed_correct' });
  });

  test('a question with no rows for the newest state answers null', async () => {
    await seed({ answers: { typesafe: {} } });
    await database('decision_reviews').where({ question_id: 'dog_on_property' }).del();
    await expect(flags.tapAccessFlag(database, visit(), { questionId: 'dog_on_property', verdict: 'right' }, who)).resolves.toBeNull();
    await expect(flags.tapAccessFlag(database, { id: randomUUID(), customer_id: customerId }, { questionId: 'dog_on_property', verdict: 'right' }, who)).resolves.toBeNull();
  });
});
