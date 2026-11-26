/**
 * Visit access flags for the technician (services/visit-access-flags.js). Behavior under proof:
 *  - a card shows when ANY provider answered yes on the visit's NEWEST stored state and the technician has not
 *    marked it Wrong on that evidence; an older state's yes never shows, but a Right on an earlier state carries
 *    forward and a Wrong does not; a visit no longer proven to be at one premises has no flags;
 *  - the quote and its source are picked from the stored redacted state by fixed keyword lists, no model, and a
 *    generated redaction marker is never quoted;
 *  - a tap writes ONLY one visit_access_verdicts row (decision_reviews is untouched), bound to the evidence the
 *    card came from, in one transaction under a FOR SHARE lock on the visit row; a second tap returns the stored
 *    verdict and writes nothing;
 *  - the pet line is saved only by the tap that created the Right on a dog flag, on the locked profile row and
 *    only while it holds no pets, so a replay never restores a field staff cleared.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAudit = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));
// The single-premises proof has its own suite (typed-decisions-visit-access.test.js); here only its answer.
const mockPremises = jest.fn(async () => true);
jest.mock('../services/typed-decisions/visit-access-shadow', () => ({
  ...jest.requireActual('../services/typed-decisions/visit-access-shadow'),
  visitSinglePremises: (...a) => mockPremises(...a),
}));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const statesMigration = require('../models/migrations/20261003140000_visit_access_states');
const verdictsMigration = require('../models/migrations/20261126170000_visit_access_verdicts');
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

  test('a generated redaction marker is never quoted: the card falls back to the source line', () => {
    const marked = { recent_texts: '- [access detail withheld: mentions code, gate]\n- [follow-up to an access detail withheld]\n- Our dog [redacted] is friendly.' };
    expect(flags.pickQuote(marked, 'needs_code_key_or_person')).toEqual({ quote: null, source: 'Read: customer text' });
    expect(flags.pickQuote(marked, 'dog_on_property')).toEqual({ quote: null, source: 'Read: customer text' });
    // a real sentence next to a marker line is still quoted
    expect(flags.pickQuote({ recent_texts: '- [access detail withheld: mentions gate]\n- Our dog Biscuit is in the yard.' }, 'dog_on_property'))
      .toEqual({ quote: 'Our dog Biscuit is in the yard.', source: 'Customer text' });
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
  const techId = randomUUID();
  const who = { labeledBy: 'tech@example.test', actorId: techId, ip: '127.0.0.1', userAgent: 'jest' };
  const QUESTIONS = ['dog_on_property', 'needs_code_key_or_person', 'contact_before_arrival', 'person_home_needs_notice', 'past_access_problem', 'access_fact_not_on_file'];
  const PET_LINE = /^Animal on property \(tech confirmed \d{1,2}\/\d{1,2}\)$/;
  let visitId;
  let seq = 0;
  let lastHash;

  const visit = () => ({ id: visitId, customer_id: customerId });
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
    lastHash = hash;
    return hash;
  }
  const tap = (questionId, verdict, over = {}) => flags.tapAccessFlag(database, {
    visitId, scope: (q) => q, questionId, verdict, subjectHash: lastHash, ...over,
  }, who);
  const verdicts = () => database('visit_access_verdicts').where({ scheduled_service_id: visitId }).orderBy('created_at');
  const pets = () => database('property_preferences').where({ customer_id: customerId }).first();
  const unlabeled = async () => Number((await database('decision_reviews').where({ subject_id: visitId, label_status: 'unreviewed' }).count('* as n').first()).n);
  const reviewCount = async () => Number((await database('decision_reviews').where({ subject_id: visitId }).count('* as n').first()).n);

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 5 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.decision_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), capability varchar(60) NOT NULL,
      package_id varchar(80) NOT NULL, provider varchar(30) NOT NULL, subject_type varchar(30) NOT NULL, subject_id uuid NOT NULL,
      question_id varchar(60) NOT NULL, jev_answer jsonb NOT NULL, subject_hash varchar(64), label jsonb,
      label_status varchar(20) NOT NULL DEFAULT 'unreviewed', labeled_by varchar(120), labeled_at timestamptz, created_at timestamptz DEFAULT now())`, [schema]);
    await database.raw(`CREATE TABLE ??.property_preferences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid UNIQUE,
      pet_count integer, pet_details text, updated_at timestamptz DEFAULT now(), irrigation_revision integer DEFAULT 0)`, [schema]);
    await database.raw('CREATE TABLE ??.scheduled_services (id uuid PRIMARY KEY, customer_id uuid, technician_id text)', [schema]);
    await statesMigration.up(database);
    await verdictsMigration.up(database);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  });
  beforeEach(async () => {
    mockAudit.mockReset();
    mockAudit.mockResolvedValue('audit-1');
    mockPremises.mockReset();
    mockPremises.mockResolvedValue(true);
    visitId = randomUUID();
    for (const t of ['visit_access_verdicts', 'visit_access_states', 'decision_reviews', 'property_preferences', 'scheduled_services']) await database(t).del();
    await database('scheduled_services').insert({ id: visitId, customer_id: customerId, technician_id: 'tech-1' });
  });

  test('any provider saying yes shows a card that names its evidence; the quote comes from the stored state', async () => {
    const hash = await seed({
      state: { recent_texts: '- Our dog Biscuit will be in the yard\n- Please text first' },
      answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false, contact_before_arrival: true } },
    });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out.map((f) => f.questionId)).toEqual(['dog_on_property', 'contact_before_arrival']);
    expect(out[0]).toEqual({
      questionId: 'dog_on_property', title: 'Dog or other animal may be loose', tone: 'amber', status: 'open', subjectHash: hash,
      quote: 'Our dog Biscuit will be in the yard', source: 'Customer text', saveToFile: 'pets',
    });
    expect(out[0]).not.toHaveProperty('readAt');
    expect(out[1]).toMatchObject({ tone: 'plain', title: 'Customer asked for a call or text before you arrive', quote: 'Please text first', saveToFile: null, subjectHash: hash });
  });

  test('only the newest stored state counts: an older state\'s yes does not show', async () => {
    await seed({ answers: { typesafe: { needs_code_key_or_person: true } }, at: new Date('2026-10-05T10:00:00Z') });
    await seed({ answers: { typesafe: { past_access_problem: true } }, at: new Date('2026-10-06T10:00:00Z') });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out.map((f) => f.questionId)).toEqual(['past_access_problem']);
    expect(out[0].tone).toBe('amber');
  });

  test('a visit with no stored state has no flags, and one no longer proven to be at one premises has none either', async () => {
    await expect(flags.accessFlagsFor(database, visit())).resolves.toEqual([]);
    await seed();
    expect(await flags.accessFlagsFor(database, visit())).toHaveLength(1);
    mockPremises.mockResolvedValue(false);
    await expect(flags.accessFlagsFor(database, visit())).resolves.toEqual([]);
  });

  test('Right writes one verdict row and the pet line, touches no provider answer, and a replay writes nothing', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false } } });
    const before = await reviewCount();
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: true });
    expect(await verdicts()).toMatchObject([{ question_id: 'dog_on_property', subject_hash: lastHash, verdict: 'right', technician_id: techId }]);
    // decision_reviews is exactly as the sweep left it
    expect(await reviewCount()).toBe(before);
    expect(await unlabeled()).toBe(before);
    expect((await pets()).pet_details).toMatch(PET_LINE);
    expect((await pets()).pet_details).not.toMatch(/dog|customer text/i);
    expect(mockAudit.mock.calls.map(([e]) => e.action)).toEqual(['visit_access_flag.pet_saved']);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ resource_type: 'property_preferences', critical: true, trx: expect.anything() });

    expect((await flags.accessFlagsFor(database, visit()))[0]).toMatchObject({ questionId: 'dog_on_property', status: 'right', saveToFile: null });

    // Staff clear the pet field; a replay (a retry, or a second tap) must not bring it back.
    await database('property_preferences').update({ pet_details: null });
    mockAudit.mockClear();
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: false });
    expect(await verdicts()).toHaveLength(1);
    expect((await pets()).pet_details).toBeNull();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('Wrong writes one verdict row, hides the card and saves nothing; a replay returns the stored verdict, even a different one', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true }, cloudflare: { dog_on_property: false } } });
    await expect(tap('dog_on_property', 'wrong')).resolves.toEqual({ status: 'wrong', saved: false });
    expect(await flags.accessFlagsFor(database, visit())).toEqual([]);
    expect(await pets()).toBeUndefined();
    await expect(tap('dog_on_property', 'wrong')).resolves.toEqual({ status: 'wrong', saved: false });
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'wrong', saved: false });
    expect(await verdicts()).toHaveLength(1);
    expect(await pets()).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('two taps at once leave one verdict and one pet save', async () => {
    await seed();
    const both = await Promise.all([tap('dog_on_property', 'right'), tap('dog_on_property', 'right')]);
    expect(both.map((r) => r.status)).toEqual(['right', 'right']);
    expect(both.filter((r) => r.saved)).toHaveLength(1);
    expect(await verdicts()).toHaveLength(1);
  });

  test('a tap for evidence that moved, or for a question that shows no card, is a conflict and writes nothing', async () => {
    const old = await seed({ answers: { typesafe: { dog_on_property: true } }, at: new Date('2026-10-06T09:00:00Z') });
    await seed({ answers: { typesafe: { dog_on_property: true } }, at: new Date('2026-10-06T10:00:00Z') });
    await expect(tap('dog_on_property', 'right', { subjectHash: old })).resolves.toEqual({ conflict: true });
    await expect(tap('needs_code_key_or_person', 'right')).resolves.toEqual({ conflict: true });
    await expect(tap('dog_on_property', 'right', { subjectHash: 'f'.repeat(64) })).resolves.toEqual({ conflict: true });
    expect(await verdicts()).toEqual([]);
    expect(await pets()).toBeUndefined();
  });

  test('the pet line is written only while the locked profile holds no pets, whatever the card said', async () => {
    await seed();
    await database('property_preferences').insert({ customer_id: customerId, pet_count: 2, pet_details: null });
    expect((await flags.accessFlagsFor(database, visit()))[0].saveToFile).toBeNull();
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: false });
    expect(await pets()).toMatchObject({ pet_count: 2, pet_details: null });

    // The card was read while nothing was on file; the profile gained a pet before the tap.
    await database('visit_access_verdicts').del();
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

    await database('visit_access_verdicts').del();
    await database('property_preferences').del();
    await expect(tap('dog_on_property', 'right')).resolves.toEqual({ status: 'right', saved: true });
    expect((await pets()).pet_details).toMatch(PET_LINE);
  });

  test('the verdict and the pet save commit together: a failed save audit takes the verdict back', async () => {
    await seed();
    mockAudit.mockRejectedValue(new Error('audit down'));
    await expect(tap('dog_on_property', 'right')).rejects.toThrow('audit down');
    expect(await verdicts()).toEqual([]);
    expect(await database('property_preferences').where({ customer_id: customerId }).first()).toBeUndefined();
  });

  test('a Right carries forward to newer evidence; a Wrong does not; a verdict on the newest evidence wins', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true, past_access_problem: true, contact_before_arrival: true } }, at: new Date('2026-10-06T09:00:00Z') });
    await tap('dog_on_property', 'right');
    await tap('past_access_problem', 'wrong');
    // The pet save changed the state: a newer read asks again.
    const second = await seed({ answers: { typesafe: { dog_on_property: true, past_access_problem: true, contact_before_arrival: true } }, at: new Date('2026-10-06T10:00:00Z') });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out.map((f) => [f.questionId, f.status, f.subjectHash])).toEqual([
      ['dog_on_property', 'right', second], ['contact_before_arrival', 'open', second], ['past_access_problem', 'open', second],
    ].sort((a, b) => QUESTIONS.indexOf(a[0]) - QUESTIONS.indexOf(b[0])));
    expect(out.find((f) => f.questionId === 'dog_on_property').saveToFile).toBeNull();
    // a Wrong on the newest evidence beats the carried Right
    await tap('dog_on_property', 'wrong');
    expect((await flags.accessFlagsFor(database, visit())).map((f) => f.questionId)).not.toContain('dog_on_property');
  });

  test('a carried Right still shows when the newest state holds no yes for the question', async () => {
    await seed({ answers: { typesafe: { dog_on_property: true } }, at: new Date('2026-10-06T09:00:00Z') });
    await tap('dog_on_property', 'right');
    const second = await seed({ answers: {}, at: new Date('2026-10-06T10:00:00Z') });
    const out = await flags.accessFlagsFor(database, visit());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ questionId: 'dog_on_property', status: 'right', subjectHash: second });
  });

  test('a visit that is not the technician\'s, or no longer at one premises, is not found and writes nothing', async () => {
    await seed();
    const mine = (q) => q.where('scheduled_services.technician_id', 'tech-1');
    await expect(tap('dog_on_property', 'right', { visitId: randomUUID(), scope: mine })).resolves.toEqual({ notFound: true });
    await database('scheduled_services').update({ technician_id: 'tech-2' });
    await expect(tap('dog_on_property', 'right', { scope: mine })).resolves.toEqual({ notFound: true });
    await database('scheduled_services').update({ technician_id: 'tech-1' });
    mockPremises.mockResolvedValue(false);
    await expect(tap('dog_on_property', 'right', { scope: mine })).resolves.toEqual({ notFound: true });
    expect(await verdicts()).toEqual([]);
    expect(await pets()).toBeUndefined();
  });

  test('the lock holds a reassignment until the tap is done, and a tap waits for a reassignment already under way', async () => {
    await seed();
    const mine = (q) => q.where('scheduled_services.technician_id', 'tech-1');
    // A reassignment already holding the row waits the tap out, and the tap then sees the new assignment.
    const mover = await database.transaction();
    await mover('scheduled_services').where({ id: visitId }).update({ technician_id: 'tech-2' });
    let settled = false;
    const racing = tap('dog_on_property', 'right', { scope: mine }).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    await mover.commit();
    await expect(racing).resolves.toEqual({ notFound: true });
    expect(await verdicts()).toEqual([]);

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
