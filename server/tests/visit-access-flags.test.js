/**
 * Visit access flags for the technician (services/visit-access-flags.js). Behavior under proof:
 *  - a question is flagged when ANY provider answered yes for the visit's NEWEST stored state, and not once
 *    it is marked wrong; an older state's rows never show, except that an earlier Right carries forward
 *    (a Wrong does not); each flag names the evidence it came from and the time the provider answered;
 *  - the quote and its source are picked from the stored redacted state by fixed keyword lists, no model;
 *  - a tap is bound to that evidence (a moved state, or a question that shows no card, writes nothing), runs in one
 *    transaction under a FOR SHARE lock on the visit row, labels every unlabeled row of the question through the
 *    shared label write, twice changes nothing, and a tap that contradicts a confirmed answer writes nothing;
 *  - only an accepted Right on a dog flag saves one pet_details line, in the same transaction as its labels, and
 *    only while the locked profile row holds no pets.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAudit = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));
const mockCloseIfEmpty = jest.fn(async () => 0);
jest.mock('../services/typed-decisions/daily-review-item', () => ({ closeIfQueueEmpty: (...a) => mockCloseIfEmpty(...a) }));
// label-write reads the shared db module for its default connection; the suite points it at its own schema.
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
  const PET_LINE = /^Animal on property \(tech confirmed \d{1,2}\/\d{1,2}\)$/;
  let visitId;
  let seq = 0;
  let lastHash;

  const visit = () => ({ id: visitId, customer_id: customerId });
  // One stored state and its rows: answers = { provider: { question: boolean } }, unlisted = no.
  async function seed({ state = { recent_texts: '- Our dog Biscuit will be in the yard' }, answers = { typesafe: { dog_on_property: true } }, at = new Date('2026-10-06T10:00:00Z'), rowsAt = new Date('2026-10-06T10:20:00Z') } = {}) {
    seq += 1;
    const hash = `${String(seq).padStart(2, '0')}`.padEnd(64, 'a');
    await database('visit_access_states').insert({ scheduled_service_id: visitId, subject_hash: hash, state: JSON.stringify(state), created_at: at });
    for (const [provider, said] of Object.entries(answers)) {
      for (const q of QUESTIONS) {
        await database('decision_reviews').insert({
          capability: 'visit_access', package_id: 'visit_access.v1', provider, subject_type: 'scheduled_services', subject_id: visitId,
          question_id: q, jev_answer: JSON.stringify({ p: said[q] ? 0.95 : 0.03, yes: Boolean(said[q]), confident: true }), subject_hash: hash, created_at: rowsAt,
        });
      }
    }
    lastHash = hash;
    return hash;
  }
  const tap = (questionId, verdict, over = {}) => flags.tapAccessFlag(database, {
    visitId, scope: (q) => q, questionId, verdict, subjectHash: lastHash, ...over,
  }, who);
  const review = (provider, q, hash) => database('decision_reviews').where({ subject_id: visitId, provider, question_id: q, ...(hash ? { subject_hash: hash } : {}) }).first();
  const pets = () => database('property_preferences').where({ customer_id: customerId }).first();
  const labeledCount = async () => Number((await database('decision_reviews').where({ subject_id: visitId }).whereNot({ label_status: 'unreviewed' }).count('* as n').first()).n);

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    mockDatabase = database;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.decision_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), capability varchar(60) NOT NULL,
      package_id varchar(80) NOT NULL, provider varchar(30) NOT NULL, subject_type varchar(30) NOT NULL, subject_id uuid NOT NULL,
      question_id varchar(60) NOT NULL, jev_answer jsonb NOT NULL, subject_hash varchar(64), label jsonb,
      label_status varchar(20) NOT NULL DEFAULT 'unreviewed', labeled_by varchar(120), labeled_at timestamptz, created_at timestamptz DEFAULT now())`, [schema]);
    await database.raw(`CREATE TABLE ??.property_preferences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid UNIQUE,
      pet_count integer, pet_details text, updated_at timestamptz DEFAULT now(), irrigation_revision integer DEFAULT 0)`, [schema]);
    await database.raw('CREATE TABLE ??.scheduled_services (id uuid PRIMARY KEY, customer_id uuid, technician_id text)', [schema]);
    await statesMigration.up(database);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  });
  beforeEach(async () => {
    mockAudit.mockReset();
    mockAudit.mockResolvedValue('audit-1');
    mockCloseIfEmpty.mockClear();
    visitId = randomUUID();
    for (const t of ['visit_access_states', 'decision_reviews', 'property_preferences', 'scheduled_services']) await database(t).del();
    await database('scheduled_services').insert({ id: visitId, customer_id: customerId, technician_id: 'tech-1' });
  });

  test('any provider saying yes flags the question; the flag names its evidence and the time the provider answered', async () => {
    const hash = await seed({
      state: { recent_texts: '- Our dog Biscuit will be in the yard\n- Please text first' },
      answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false, contact_before_arrival: true } },
    });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out.map((f) => f.questionId)).toEqual(['dog_on_property', 'contact_before_arrival']);
    // readAt is when the providers answered (10:20), not when the state was stored (10:00).
    expect(out[0]).toEqual({
      questionId: 'dog_on_property', title: 'Dog or other animal may be loose', tone: 'amber', status: 'open', subjectHash: hash, readAt: '2026-10-06T10:20:00.000Z',
      quote: 'Our dog Biscuit will be in the yard', source: 'Customer text', saveToFile: 'pets',
    });
    expect(out[1]).toMatchObject({ tone: 'plain', title: 'Customer asked for a call or text before you arrive', quote: 'Please text first', saveToFile: null, subjectHash: hash });
  });

  test('the read time is the newest answer among the question\'s rows', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false } }, rowsAt: new Date('2026-10-06T10:20:00Z') });
    await database('decision_reviews').where({ provider: 'cloudflare', question_id: 'dog_on_property' }).update({ created_at: new Date('2026-10-06T11:45:00Z') });
    expect((await flags.accessFlagsFor(database, visit()))[0].readAt).toBe('2026-10-06T11:45:00.000Z');
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

  test('Right labels every row of the question and saves only what the tech confirmed; a replay changes nothing', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false } } });
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: true });
    expect(await review('typesafe', 'dog_on_property')).toMatchObject({ label_status: 'confirmed_correct', labeled_by: 'tech@example.test' });
    const clef = await review('cloudflare', 'dog_on_property');
    expect(clef).toMatchObject({ label_status: 'confirmed_error', labeled_by: 'tech@example.test' });
    expect(clef.label).toMatchObject({ verdict: 'jev_wrong', correct_value: true });
    expect(await review('typesafe', 'contact_before_arrival')).toMatchObject({ label_status: 'unreviewed' });
    const labelAudits = mockAudit.mock.calls.filter(([e]) => e.action === 'typed_decision.labeled');
    expect(labelAudits).toHaveLength(2);
    // inside the tap's transaction, so a failed audit takes the label back
    expect(labelAudits[0][0]).toMatchObject({ actor_type: 'technician', actor_id: 'tech-1', critical: true, trx: expect.anything() });
    expect(mockAudit.mock.calls.find(([e]) => e.action === 'visit_access_flag.pet_saved')[0]).toMatchObject({ resource_type: 'property_preferences', critical: true, trx: expect.anything() });
    expect((await pets()).pet_details).toMatch(PET_LINE);
    expect((await pets()).pet_details).not.toMatch(/dog|customer text/i);

    expect((await flags.accessFlagsFor(database, visit()))[0]).toMatchObject({ questionId: 'dog_on_property', status: 'right', saveToFile: null });
    mockAudit.mockClear();
    const saved = (await pets()).pet_details;
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: false });
    expect(mockAudit).not.toHaveBeenCalled();
    expect((await pets()).pet_details).toBe(saved);
  });

  test('Wrong labels the yes rows wrong (true answer no), hides the flag and saves nothing; a replay is a no-op', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false } } });
    await expect(tap('dog_on_property', 'wrong')).resolves.toEqual({ status: 'wrong', saved: false });
    const jev = await review('typesafe', 'dog_on_property');
    expect(jev).toMatchObject({ label_status: 'confirmed_error' });
    expect(jev.label).toMatchObject({ verdict: 'jev_wrong', correct_value: false });
    expect(await review('cloudflare', 'dog_on_property')).toMatchObject({ label_status: 'confirmed_correct' });
    expect(await flags.accessFlagsFor(database, visit())).toEqual([]);
    expect(await pets()).toBeUndefined();
    expect(mockCloseIfEmpty).toHaveBeenCalled();
    mockAudit.mockClear();
    await expect(tap('dog_on_property', 'wrong')).resolves.toEqual({ status: 'wrong', saved: false });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a tap for evidence that moved, or for a question that shows no card, is a conflict and writes nothing', async () => {
    const old = await seed({ answers: { typesafe: { dog_on_property: true } }, at: new Date('2026-10-06T09:00:00Z') });
    await seed({ answers: { typesafe: { dog_on_property: true } }, at: new Date('2026-10-06T10:00:00Z') });
    await expect(tap('dog_on_property', 'right', { subjectHash: old })).resolves.toEqual({ conflict: true });
    // no yes answer for this question: no card, so no verdict
    await expect(tap('needs_code_key_or_person', 'right')).resolves.toEqual({ conflict: true });
    await expect(tap('dog_on_property', 'right', { subjectHash: 'f'.repeat(64) })).resolves.toEqual({ conflict: true });
    expect(await labeledCount()).toBe(0);
    expect(await pets()).toBeUndefined();
  });

  test('a Right that loses to an already-confirmed Wrong saves nothing and labels nothing', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: true } } });
    await database('decision_reviews').where({ provider: 'typesafe', question_id: 'dog_on_property' }).update({
      label_status: 'confirmed_error', labeled_by: 'owner@example.test', label: JSON.stringify({ verdict: 'jev_wrong', correct_value: false }),
    });
    expect(await flags.accessFlagsFor(database, visit())).toEqual([]);
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ conflict: true });
    expect(await review('cloudflare', 'dog_on_property')).toMatchObject({ label_status: 'unreviewed' });
    expect(await review('typesafe', 'dog_on_property')).toMatchObject({ labeled_by: 'owner@example.test' });
    expect(await pets()).toBeUndefined();
  });

  test('a Wrong after a confirmed Right is refused: the first confirmation stands', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: true } } });
    await database('decision_reviews').where({ provider: 'typesafe', question_id: 'dog_on_property' }).update({ label_status: 'confirmed_correct', labeled_by: 'owner@example.test' });
    await expect(tap('dog_on_property', 'wrong')).resolves.toEqual({ status: 'right', saved: false });
    expect(await review('cloudflare', 'dog_on_property')).toMatchObject({ label_status: 'unreviewed' });
  });

  test('the pet line is written only while the locked profile holds no pets, whatever the card said', async () => {
    await seed();
    await database('property_preferences').insert({ customer_id: customerId, pet_count: 2, pet_details: null });
    expect((await flags.accessFlagsFor(database, visit()))[0].saveToFile).toBeNull();
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: false });
    expect(await pets()).toMatchObject({ pet_count: 2, pet_details: null });

    // The card was read while nothing was on file; the profile gained a pet before the tap.
    await database('decision_reviews').update({ label_status: 'unreviewed', label: null, labeled_by: null });
    await database('property_preferences').update({ pet_count: 0, pet_details: null });
    expect((await flags.accessFlagsFor(database, visit()))[0]).toMatchObject({ saveToFile: 'pets', status: 'open' });
    await database('property_preferences').update({ pet_details: 'Cat, indoors' });
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: false });
    expect((await pets()).pet_details).toBe('Cat, indoors');
  });

  test('a profile with no row, or a blank pet line and no count, takes the save', async () => {
    await seed();
    await database('property_preferences').insert({ customer_id: customerId, pet_count: 0, pet_details: '   ' });
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: true });
    expect((await pets()).pet_details).toMatch(PET_LINE);

    await database('property_preferences').del();
    await database('decision_reviews').update({ label_status: 'unreviewed', label: null, labeled_by: null });
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: true });
    expect((await pets()).pet_details).toMatch(PET_LINE);
  });

  test('the labels and the pet save commit together: a failed save audit takes the labels back', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false } } });
    mockAudit.mockImplementation(async (event) => { if (event.action === 'visit_access_flag.pet_saved') throw new Error('audit down'); return 'audit-1'; });
    await expect(tap('dog_on_property', 'right')).rejects.toThrow('audit down');
    expect(await labeledCount()).toBe(0);
    expect(await pets()).toBeFalsy();
    expect((await database('property_preferences').where({ customer_id: customerId }).first())).toBeUndefined();
  });

  test('a Right confirmed on an earlier state carries forward to the newest; a Wrong does not', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true, past_access_problem: true } }, at: new Date('2026-10-06T09:00:00Z') });
    await tap('dog_on_property', 'right');
    await tap('past_access_problem', 'wrong');
    // The pet save changed the state: a newer read asks again, both questions unlabeled and yes.
    const second = await seed({ answers: { typesafe: { dog_on_property: true, past_access_problem: true } }, at: new Date('2026-10-06T10:00:00Z') });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out.map((f) => [f.questionId, f.status, f.subjectHash])).toEqual([
      ['dog_on_property', 'right', second], ['past_access_problem', 'open', second],
    ]);
    expect(out[0].saveToFile).toBeNull();
  });

  test('a carried Right still shows when the newest state holds no row for the question (labeled rows are never re-asked)', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true } }, at: new Date('2026-10-06T09:00:00Z') });
    await tap('dog_on_property', 'right');
    const second = await seed({ answers: {}, at: new Date('2026-10-06T10:00:00Z') });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ questionId: 'dog_on_property', status: 'right', subjectHash: second });
  });

  test('a tap is refused for a visit that is not the technician\'s, and the lock holds a reassignment until the tap is done', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true } } });
    const mine = (q) => q.where('scheduled_services.technician_id', 'tech-1');
    await expect(tap('dog_on_property', 'right', { visitId: randomUUID(), scope: mine })).resolves.toEqual({ notFound: true });
    await database('scheduled_services').update({ technician_id: 'tech-2' });
    await expect(tap('dog_on_property', 'right', { scope: mine })).resolves.toEqual({ notFound: true });
    expect(await labeledCount()).toBe(0);

    // A reassignment already holding the row waits the tap out, and the tap then sees the new assignment.
    await database('scheduled_services').update({ technician_id: 'tech-1' });
    const mover = await database.transaction();
    await mover('scheduled_services').where({ id: visitId }).update({ technician_id: 'tech-2' });
    let settled = false;
    const racing = tap('dog_on_property', 'right', { scope: mine }).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    await mover.commit();
    await expect(racing).resolves.toEqual({ notFound: true });
    expect(await labeledCount()).toBe(0);

    // The other way round: a tap that holds its share lock makes the reassignment wait.
    await database('scheduled_services').update({ technician_id: 'tech-1' });
    const holder = await database.transaction();
    await mine(holder('scheduled_services').where({ id: visitId })).forShare().first('id');
    const move = database('scheduled_services').where({ id: visitId }).update({ technician_id: 'tech-2' }).then(() => 'moved');
    const first = await Promise.race([move, new Promise((resolve) => setTimeout(() => resolve('waiting'), 400))]);
    expect(first).toBe('waiting');
    await holder.commit();
    await expect(move).resolves.toBe('moved');
  });
});
