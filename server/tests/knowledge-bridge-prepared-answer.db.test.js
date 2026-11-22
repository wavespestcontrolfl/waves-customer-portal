// Report speed plan step 4 (owner 2026-11-19): the lawn recommendation answer made before the Complete tap.
// Behavior: the completion's grounded run (generateAssessmentRecommendations on a linked assessment) makes no
// model call when prepareAssessmentRecommendations already asked the same prompt (the same scores, products and
// reference pages), and it makes its own call in every other case.
// Regression this guards: a prepared answer used for a visit whose saved rows differ from the planned ones, used
// after a reference page it read was withdrawn, or shown before the visit's rows are saved; and a prepared answer
// that skips the checks a new answer gets.
// Gap in existing proof: no suite runs the real generator's read, checks and locked write against PostgreSQL.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');

let mockKnex;
jest.mock('../models/db', () => mockKnex);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatch: jest.fn(), rejectCall: jest.fn() };
});
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

const answer = (summary, extra = {}) => ({
  summary,
  recommendations: [{ priority: 1, action: 'Water deeply twice a week.', reason: 'Dry spots near the drive.', timeframe: 'Next 2 weeks' }],
  nextVisitFocus: 'Dry spots',
  customerTip: 'Water early in the morning.',
  ...extra,
});
const FUNGICIDE = { product_name: 'Fixture Azoxy 2SC', product_category: 'fungicide' };
const FERTILIZER = { product_name: 'Fixture 24-0-11', product_category: 'fertilizer' };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

(SKIP ? describe.skip : describe)('lawn recommendation answer prepared before completion (real PostgreSQL)', () => {
  let db;
  let KnowledgeBridge;
  let dispatch;

  beforeAll(async () => {
    db = await createLawnVisitDb();
    mockKnex = db.knex;
    for (const table of ['service_products', 'products_catalog', 'knowledge_base', 'knowledge_entries', 'customer_turf_profiles']) {
      await db.knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [db.schema, table, table]);
    }
    ({ dispatch } = require('../services/llm/call'));
    KnowledgeBridge = require('../services/knowledge-bridge');
  }, 60000);
  afterAll(async () => { if (db) await db.dispose(); });
  beforeEach(async () => {
    dispatch.mockReset();
    mockCreate.mockReset();
    KnowledgeBridge._test.preparedAnswers.clear();
    await db.knex('knowledge_base').del();
  });

  async function seedAssessment() {
    const customerId = randomUUID();
    await db.knex('customers').insert({ id: customerId, first_name: 'Prepared', last_name: 'Fixture', phone: `+1555${String(parseInt(customerId.slice(0, 6), 16) % 10000000).padStart(7, '0')}` });
    const [assessment] = await db.knex('lawn_assessments').insert({
      customer_id: customerId, service_date: '2026-11-21', season: 'fall',
      turf_density: 80, weed_suppression: 82, color_health: 76, fungus_control: 85, thatch_level: 90, stress_damage: 85,
      overall_score: 81, confirmed_by_tech: true, service_id: randomUUID(),
    }).returning('*');
    return assessment;
  }
  // What the completion does before its grounded run: the visit's product rows are saved and the assessment is linked.
  async function saveVisitRows(assessmentId, products) {
    const serviceRecordId = randomUUID();
    for (const product of products) await db.knex('service_products').insert({ service_record_id: serviceRecordId, ...product });
    await db.knex('lawn_assessments').where({ id: assessmentId }).update({ service_record_id: serviceRecordId });
  }
  const stored = async (id) => {
    const row = await db.knex('lawn_assessments').where({ id }).first('recommendations', 'ai_summary');
    const recommendations = typeof row.recommendations === 'string' ? JSON.parse(row.recommendations) : row.recommendations;
    return { recommendations, summary: row.ai_summary };
  };
  const answersWith = (...summaries) => summaries.forEach((summary) => dispatch.mockResolvedValueOnce({ ok: true, json: answer(summary) }));

  test('the same scores and products: the grounded run makes no call and stores the prepared answer as grounded', async () => {
    const assessment = await seedAssessment();
    // The prepared answer defers a fungicide: the grounded run must drop that line against the SAVED fungicide row.
    dispatch.mockResolvedValueOnce({ ok: true, json: answer('Prepared summary.', {
      recommendations: [
        { priority: 1, action: 'Hold off on fungicide until disease is confirmed.', reason: 'No lesions seen.', timeframe: 'Next visit' },
        { priority: 2, action: 'Water deeply twice a week.', reason: 'Dry spots near the drive.', timeframe: 'Next 2 weeks' },
      ],
    }) });

    await expect(KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FUNGICIDE, FERTILIZER])).resolves.toEqual({ started: true });
    await KnowledgeBridge._test.preparedAnswers.get(assessment.id).answer;
    // Nothing is stored before the visit's rows are saved.
    expect(await stored(assessment.id)).toEqual({ recommendations: null, summary: null });

    // Saved in another order than the sheet named them, with one product on two rows.
    await saveVisitRows(assessment.id, [FERTILIZER, FUNGICIDE, FUNGICIDE]);
    const result = await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result._groundedInApplications).toBe(true);
    const copy = await stored(assessment.id);
    expect(copy.summary).toBe('Prepared summary.');
    expect(copy.recommendations._groundedInApplications).toBe(true);
    expect(copy.recommendations.recommendations.map((rec) => rec.action)).toEqual(['Water deeply twice a week.']);
    expect(copy.recommendations._generationRuns).toBeUndefined();
  });

  test('a product added after the early call: the grounded run makes its own call', async () => {
    const assessment = await seedAssessment();
    answersWith('Prepared summary.', 'Completion summary.');
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    await saveVisitRows(assessment.id, [FERTILIZER, FUNGICIDE]);

    await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1][1].text).toContain('- Fixture Azoxy 2SC (fungicide)');
    expect((await stored(assessment.id)).summary).toBe('Completion summary.');
    // The answer for the other product list can serve no later run.
    expect(KnowledgeBridge._test.preparedAnswers.has(assessment.id)).toBe(false);
  });

  test('a score changed after the early call: the grounded run makes its own call', async () => {
    const assessment = await seedAssessment();
    answersWith('Prepared summary.', 'Completion summary.');
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    await db.knex('lawn_assessments').where({ id: assessment.id }).update({ stress_damage: 40 });
    await saveVisitRows(assessment.id, [FERTILIZER]);

    await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await stored(assessment.id)).summary).toBe('Completion summary.');
  });

  test('a run on an assessment with no saved rows never takes the prepared answer, and leaves it for the grounded run', async () => {
    const assessment = await seedAssessment();
    // No products: the early prompt and the confirm-time prompt name the same visit facts.
    answersWith('Prepared summary.', 'Confirm-time summary.');
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, []);

    const unlinked = await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(unlinked._groundedInApplications).toBe(false);
    expect((await stored(assessment.id)).summary).toBe('Confirm-time summary.');

    await saveVisitRows(assessment.id, []);
    const grounded = await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(grounded._groundedInApplications).toBe(true);
    expect((await stored(assessment.id)).summary).toBe('Prepared summary.');
  });

  test('an early call still running at completion: the grounded run waits for it and makes no second call', async () => {
    const assessment = await seedAssessment();
    const early = deferred();
    dispatch.mockReturnValueOnce(early.promise);
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    await saveVisitRows(assessment.id, [FERTILIZER]);

    const run = KnowledgeBridge.generateAssessmentRecommendations(assessment.id);
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    early.resolve({ ok: true, json: answer('Prepared summary.') });
    const result = await run;

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result._groundedInApplications).toBe(true);
    expect((await stored(assessment.id)).summary).toBe('Prepared summary.');
  });

  test('a reference page withdrawn after the early call: the grounded run makes its own call, without that page', async () => {
    const assessment = await seedAssessment();
    const [page] = await db.knex('knowledge_base')
      .insert({ path: `fixture/${randomUUID()}`, title: 'Fixture fall watering page', category: 'seasonal', content: 'Water twice a week in fall.', status: 'active' })
      .returning('id');
    answersWith('Prepared summary.', 'Completion summary.');
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    expect(dispatch.mock.calls[0][1].text).toContain('Fixture fall watering page');

    await db.knex('knowledge_base').where({ id: page.id }).update({ active: false });
    await saveVisitRows(assessment.id, [FERTILIZER]);
    await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1][1].text).not.toContain('Fixture fall watering page');
    expect((await stored(assessment.id)).summary).toBe('Completion summary.');
  });

  test('an early answer the report copy screen refuses is not held: the grounded run asks again', async () => {
    const assessment = await seedAssessment();
    dispatch.mockResolvedValueOnce({ ok: true, json: answer('Prepared summary.', { customerTip: 'This treatment is safe for pets.' }) });
    dispatch.mockResolvedValueOnce({ ok: true, json: answer('Completion summary.') });
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    await expect(KnowledgeBridge._test.preparedAnswers.get(assessment.id).answer).resolves.toBeNull();
    await saveVisitRows(assessment.id, [FERTILIZER]);

    await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await stored(assessment.id)).summary).toBe('Completion summary.');
  });

  test('one answer is used once: a later regeneration asks the model again', async () => {
    const assessment = await seedAssessment();
    answersWith('Prepared summary.', 'Regenerated summary.');
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    await saveVisitRows(assessment.id, [FERTILIZER]);

    await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await stored(assessment.id)).summary).toBe('Regenerated summary.');
  });

  test('an answer older than 30 minutes is not used', async () => {
    const assessment = await seedAssessment();
    answersWith('Prepared summary.', 'Completion summary.');
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    KnowledgeBridge._test.preparedAnswers.get(assessment.id).at -= KnowledgeBridge._test.PREPARED_ANSWER_TTL_MS + 1;
    await saveVisitRows(assessment.id, [FERTILIZER]);

    await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await stored(assessment.id)).summary).toBe('Completion summary.');
  });

  test('an early answer the grounded run would refuse is not held: the grounded run asks again', async () => {
    const assessment = await seedAssessment();
    // Both legs of the early call answer with no summary.
    dispatch.mockResolvedValueOnce({ ok: true, json: { recommendations: [] } });
    mockCreate.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"recommendations":[]}' }] });
    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    await expect(KnowledgeBridge._test.preparedAnswers.get(assessment.id).answer).resolves.toBeNull();
    await saveVisitRows(assessment.id, [FERTILIZER]);

    answersWith('Completion summary.');
    const result = await KnowledgeBridge.generateAssessmentRecommendations(assessment.id);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result._groundedInApplications).toBe(true);
    expect((await stored(assessment.id)).summary).toBe('Completion summary.');
  });

  test('the same visit facts are asked once, and one assessment gets at most 5 early calls in a row', async () => {
    const assessment = await seedAssessment();
    dispatch.mockResolvedValue({ ok: true, json: answer('Prepared summary.') });

    await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER]);
    await expect(KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER])).resolves.toEqual({ started: true });
    expect(dispatch).toHaveBeenCalledTimes(1);

    for (let n = 2; n <= 5; n += 1) {
      await KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [{ product_name: `Fixture product ${n}`, product_category: 'herbicide' }]);
    }
    expect(dispatch).toHaveBeenCalledTimes(5);
    await expect(KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FUNGICIDE])).resolves.toEqual({ started: false });
    expect(dispatch).toHaveBeenCalledTimes(5);
  });

  test('one prompt has one key whatever the order of its rows; the prompt lists the rows as they came', async () => {
    const assessment = await seedAssessment();
    const PAGE_A = { category: 'seasonal', title: 'Fixture page A', content: 'Water twice a week in fall.' };
    const PAGE_B = { category: 'protocol', title: 'Fixture page B', content: 'Feed in October.' };
    const OUTCOME = { title: 'Fixture outcome', data_point_count: 12, confidence: 'high', summary: 'Color improved.' };
    const pages = (protocolEntries = [PAGE_A, PAGE_B], outcomeEntries = [OUTCOME]) => ({
      customer: { first_name: 'Prepared', last_name: 'Fixture' }, grassType: 'St. Augustine', grassTrack: null, protocolEntries, outcomeEntries,
    });
    const NOON = new Date('2026-11-21T17:00:00Z');
    const prompt = (appliedProducts, { row = assessment, context = pages(), now = NOON } = {}) => KnowledgeBridge._test.recommendationPrompt({ assessment: row, appliedProducts }, context, now);

    const saved = prompt([FUNGICIDE, FERTILIZER, FUNGICIDE]);
    expect(saved.userPrompt).toContain('- Fixture Azoxy 2SC (fungicide)\n- Fixture 24-0-11 (fertilizer)\n- Fixture Azoxy 2SC (fungicide)\nHARD RULE');
    expect(saved.userPrompt).toContain('[seasonal] Fixture page A: Water twice a week in fall.\n[protocol] Fixture page B: Feed in October.');
    expect(prompt([FERTILIZER, FUNGICIDE]).promptKey).toBe(saved.promptKey);
    expect(prompt([FERTILIZER, FUNGICIDE], { context: pages([PAGE_B, PAGE_A]) }).promptKey).toBe(saved.promptKey);

    const others = [
      prompt([FERTILIZER]),
      prompt([]),
      prompt([FUNGICIDE, { ...FERTILIZER, product_category: null }]),
      prompt([FUNGICIDE, FERTILIZER], { row: { ...assessment, weed_suppression: 81 } }),
      prompt([FUNGICIDE, FERTILIZER], { row: { ...assessment, observations: 'Dry spots near the drive.' } }),
      prompt([FUNGICIDE, FERTILIZER], { context: pages([PAGE_A]) }),
      prompt([FUNGICIDE, FERTILIZER], { context: pages([PAGE_A, { ...PAGE_B, content: 'Feed in November.' }]) }),
      prompt([FUNGICIDE, FERTILIZER], { context: pages([PAGE_A, PAGE_B], []) }),
      prompt([FUNGICIDE, FERTILIZER], { now: new Date('2026-12-01T17:00:00Z') }),
    ];
    expect(new Set([saved.promptKey, ...others.map((other) => other.promptKey)]).size).toBe(others.length + 1);

    // The month is the Eastern one: 02:00 UTC on December 1 is the evening of November 30 in Florida.
    const evening = prompt([FUNGICIDE, FERTILIZER], { now: new Date('2026-12-01T02:00:00Z') });
    expect(evening.userPrompt).toContain('Month: November (Season: fall)');
    expect(evening.promptKey).toBe(saved.promptKey);
  });

  test('an assessment whose visit rows are saved gets no early call', async () => {
    const assessment = await seedAssessment();
    await saveVisitRows(assessment.id, [FERTILIZER]);

    await expect(KnowledgeBridge.prepareAssessmentRecommendations(assessment.id, [FERTILIZER])).resolves.toEqual({ started: false });
    await expect(KnowledgeBridge.prepareAssessmentRecommendations(randomUUID(), [FERTILIZER])).resolves.toEqual({ started: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
