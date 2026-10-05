/**
 * Service report "Ask Waves" AI answers (owner 2026-10-05, GATE_REPORT_ASK_AI):
 * the fact sheet, the prompt, the output screen, the fallback to the fixed-rule
 * answer, the gate, and the route. The model call is mocked everywhere; every
 * name, address and number here is synthetic.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
  jwt: { secret: 'test-jwt-secret' },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  runAndSwallowErrors: jest.fn().mockResolvedValue(null),
  calculateAndPersistForServiceRecord: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/service-report/report-data', () => ({
  buildReportV1Data: jest.fn(),
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  dispatchWithFallback: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('../services/llm/call');
const { buildReportV1Data } = require('../services/service-report/report-data');
const reportsRouter = require('../routes/reports-public');
const featureGates = require('../config/feature-gates');
const {
  SYSTEM_PROMPT,
  buildReportAskFacts,
  buildReportAskPrompt,
  screenAskAnswer,
  placeOfApplication,
  answerReportQuestionWithAI,
} = require('../services/service-report/report-ask-ai');
const { routeServiceReportQuestion } = require('../services/service-report/report-assistant');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

// A synthetic quarterly pest report: a customer who called about a cockroach,
// five products with rates, totals, EPA numbers and target lists.
function reportData(overrides = {}) {
  const app = (id, name, extra = {}) => ({
    id,
    product: {
      name,
      epa_reg: `99999-${id}`,
      active_ingredient: extra.active || 'Test Active',
      facts_approved: true,
      precaution_summary: extra.precaution || null,
      reentry_summary: extra.reentry || null,
      report_copy: extra.copy || undefined,
    },
    method: 'spray',
    methodLabel: 'Spray',
    rate: '2.75',
    rateUnit: 'oz/gal',
    totalAmount: '31.5',
    amountUnit: 'oz',
    applicationArea: extra.area || 'Foundation perimeter',
    targets: extra.targets || ['ghost_ants', 'big_headed_ants', 'crazy_ants'],
  });
  return {
    serviceType: 'Quarterly Pest Control',
    serviceDisplayName: 'Quarterly Pest Control',
    serviceLine: 'pest',
    serviceDate: '2026-10-02',
    technician: { name: 'Jordan Testwell' },
    customerName: 'Pat Tester',
    customerPhone: '+19415550100',
    customerEmail: 'pat@example.test',
    serviceAddress: '100 Example Lane, Testville',
    customerConcern: 'I saw a cockroach in the kitchen last week.',
    reportSections: [
      { key: 'found', title: 'What we found', paragraphs: ['Light roach activity near the kitchen and no ant trails.'] },
      { key: 'did', title: 'What we did and why', paragraphs: ['We treated the outside of the home and the kitchen cracks.'] },
    ],
    conditions: { temp_f: 86.4, wind_mph: 6, rain_24h_in: 0 },
    pestPressure: { label: 'Low', trend: 'improving' },
    applications: [
      app('1', 'Alpine WSG', {
        active: 'Dinotefuran',
        area: 'Foundation perimeter',
        copy: {
          how_it_works: 'Alpine WSG slows ants and roaches at the entry points.',
          also_labeled_for: 'Labeled for 25+ Testville pests',
          pets_kids: 'Keep pets and kids off treated areas until dry.',
        },
      }),
      app('2', 'Taurus SC', { area: 'Outside', targets: ['termites'], copy: { how_it_works: 'Taurus SC builds an outdoor barrier.' } }),
      app('3', 'Advion Roach Gel', { area: 'Kitchen', targets: ['german_roaches'] }),
    ],
    dynamicContext: {
      reentry: {
        displayTimezone: 'America/New_York',
        targets: [{ key: 'exterior', label: 'Exterior', readyAt: '2026-10-02T15:00:00.000Z' }],
        customerSummary: 'Treated areas are ready for normal use.',
      },
    },
    ...overrides,
  };
}

const nextAppointment = { service_type: 'Quarterly Pest Control', scheduled_date: '2027-01-05', window_start: '09:00:00' };
const NOW = new Date('2026-10-05T14:00:00Z');

function withPetData() {
  return { serviceLine: 'pest', applications: [], dynamicContext: { reentry: { petAdvisory: 'Keep pets off treated zones until dry.' } } };
}

describe('buildReportAskFacts', () => {
  const facts = buildReportAskFacts({ data: reportData(), nextAppointment, now: NOW });
  const sheet = JSON.stringify(facts);

  test('carries the pressure trend summary and bare index when there is no labeled gauge', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], pressureIndex: 2.4, dynamicContext: { pressureTrend: { customerSummary: 'Pressure is down from your last visit.' } } } });
    expect(facts.pest_pressure).toEqual({ label: null, trend: null, score_out_of_5: 2.4, what_it_means: null, trend_summary: 'Pressure is down from your last visit.' });
  });

  test('a missing pressure reading stays missing, never zero', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], pressureIndex: null, pestPressure: { label: 'Low', score: null } } });
    expect(facts.pest_pressure.score_out_of_5).toBeNull();
    expect(buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], pressureIndex: null } }).pest_pressure).toBeUndefined();
  });

  test('scrubs contact details and digit runs from the customer concern', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: 'Call Pat at 941-555-0100 or pat@example.com, gate 4821, roaches in kitchen' } });
    expect(facts.customer_concern).not.toMatch(/555|example\.com|4821/);
    expect(facts.customer_concern).toMatch(/roaches in kitchen/);
  });

  test('a full product name wins over a shared first word; an ambiguous first word names none', () => {
    const apps = [
      { product: { name: 'Advion Ant Bait Gel' }, applicationArea: 'Kitchen' },
      { product: { name: 'Advion Cockroach Gel Bait' }, applicationArea: 'Kitchen' },
    ];
    const exact = buildReportAskFacts({ question: 'Why was Advion Cockroach Gel Bait used?', data: { serviceLine: 'pest', applications: apps } });
    expect(exact.products.map((p) => p.name)).toEqual(['Advion Cockroach Gel Bait']);
    const vague = buildReportAskFacts({ question: 'Why was Advion used?', data: { serviceLine: 'pest', applications: apps } });
    expect(vague.products).toHaveLength(2);
  });

  test('strips the concentration from the active ingredient', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [{ product: { name: 'Alpine WSG', active_ingredient: 'Dinotefuran 40.0%' }, applicationArea: 'Kitchen' }] } });
    expect(facts.products[0].active_ingredient).toBe('Dinotefuran');
  });

  test('reads a pg-hydrated DATE as its calendar date', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], serviceDate: new Date(2026, 9, 2) } });
    expect(facts.service_date).toBe('Friday, October 2, 2026');
  });

  test('carries the visit\'s recorded pet precaution', () => {
    const withPet = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], dynamicContext: { reentry: { petAdvisory: 'Keep pets off treated zones until dry.' } } } });
    expect(withPet.pet_precaution_today).toBe('Keep pets off treated zones until dry.');
    // A fixed wait does not survive the timing strip as a fact; it reaches the
    // model only as a required line, word for word.
    const timed = { serviceLine: 'pest', applications: [], advisory: { pet_advisory: 'Keep pets indoors for 2 hours.' } };
    expect(buildReportAskFacts({ data: timed }).pet_precaution_today).toBeUndefined();
    // A precaution that is already a required line is not sent twice.
    const asLine = buildReportAskFacts({ data: withPetData(), requiredLines: ['Keep pets off treated zones until dry.'] });
    expect(asLine.pet_precaution_today).toBeUndefined();
    expect(asLine.required_lines).toEqual(['Keep pets off treated zones until dry.']);
  });

  test('carries the visit facts the answer needs', () => {
    expect(facts.service).toBe('Quarterly Pest Control');
    expect(facts.service_date).toBe('Friday, October 2, 2026');
    expect(facts.technician_first_name).toBe('Jordan');
    expect(facts.customer_concern).toMatch(/cockroach/);
    expect(facts.report_sections).toHaveLength(2);
    expect(facts.weather_during_visit).toBe('about 86°F, wind about 6 mph, no rain in the last 24 hours');
    expect(facts.pest_pressure).toEqual({ label: 'Low', trend: 'improving', score_out_of_5: null, what_it_means: null, trend_summary: null });
    expect(facts.next_visit).toEqual({ service: 'Quarterly Pest Control', date: 'Tuesday, January 5, 2027', arrival_window: '9 to 11 AM' });
    expect(facts.reentry).toEqual([{ area: 'outside', status: 'dry time has passed' }]);
  });

  test('never carries amounts, rates, EPA numbers, per-product targets or contact details', () => {
    expect(sheet).not.toMatch(/2\.75|31\.5|oz\/gal|99999|EPA|epa_reg/i);
    expect(sheet).not.toMatch(/ghost|big_headed|big headed|crazy|german_roaches|termites/i);
    expect(sheet).not.toMatch(/Pat|Tester|Example Lane|pat@|941555|Testwell/);
  });

  test('keeps the approved plain wording and says inside or outside per product', () => {
    const alpine = facts.products.find((p) => p.name === 'Alpine WSG');
    expect(alpine).toMatchObject({
      active_ingredient: 'Dinotefuran',
      applied_where: 'outside',
      what_it_does: 'Alpine WSG slows ants and roaches at the entry points.',
      labeled_for: 'Labeled for 25+ Testville pests',
      pets_and_kids_wording: 'Keep pets and kids off treated areas until dry.',
    });
    expect(facts.products.find((p) => p.name === 'Taurus SC').applied_where).toBe('outside');
    expect(facts.products.find((p) => p.name === 'Advion Roach Gel').applied_where).toBe('inside');
  });

  test('inside or outside from the chip vocabulary and the Fast Complete chips', () => {
    expect(placeOfApplication('Inside')).toBe('inside');
    expect(placeOfApplication('Outside')).toBe('outside');
    // Garage and entry points sit between the sides: alone they name the
    // place; beside a room or a perimeter, that decides.
    expect(placeOfApplication('Garage')).toBe('the garage');
    expect(placeOfApplication('Perimeter, Garage, Entry points')).toBe('outside');
    expect(placeOfApplication('Kitchen, Bathrooms, Entry points')).toBe('inside');
    expect(placeOfApplication('Inside, Outside')).toBe('inside and outside');
    expect(placeOfApplication('Foundation perimeter, Kitchen')).toBe('inside and outside');
    expect(placeOfApplication('some free text')).toBe('not recorded');
    expect(placeOfApplication(null)).toBe('not recorded');
  });

  test('a fixed re-entry minute figure in a label line is stripped, not handed on', () => {
    const data = reportData();
    data.applications[0].product.precaution_summary = 'Keep pets off treated areas for 30 minutes after application. Wash hands after use.';
    const out = buildReportAskFacts({ data, now: NOW });
    const alpine = out.products.find((p) => p.name === 'Alpine WSG');
    expect(JSON.stringify(alpine)).not.toMatch(/30 minutes/);
  });

  test('a report with no applications says so', () => {
    const out = buildReportAskFacts({ data: reportData({ applications: [] }), now: NOW });
    expect(out.products).toEqual([]);
    expect(out.products_note).toMatch(/No product applications/);
  });
});

describe('buildReportAskPrompt', () => {
  test('the user text holds the question and the sheet; the system text holds the rules', () => {
    const prompt = buildReportAskPrompt({ question: 'Is it safe for my dog?', data: reportData(), nextAppointment, now: NOW });
    expect(prompt.system).toBe(SYSTEM_PROMPT);
    expect(prompt.user).toContain('"Is it safe for my dog?"');
    expect(prompt.user).toContain('FACTS:');
    expect(prompt.system).toMatch(/Never use the word "safe"/);
    expect(prompt.system).toContain(WAVES_SUPPORT_PHONE_DISPLAY);
    expect(prompt.system).toMatch(/Never list which pests a product targets/);
  });

  test('a question that names one product gets only that product facts', () => {
    const prompt = buildReportAskPrompt({ question: 'Why was Alpine WSG used?', data: reportData(), nextAppointment, now: NOW });
    expect(prompt.user).toContain('Alpine WSG');
    expect(prompt.user).not.toContain('Taurus SC');
    expect(prompt.user).not.toContain('Advion Roach Gel');
  });

  test('a question that names no product gets every product', () => {
    const prompt = buildReportAskPrompt({ question: 'What did you do about the cockroach?', data: reportData(), nextAppointment, now: NOW });
    expect(prompt.user).toContain('Alpine WSG');
    expect(prompt.user).toContain('Taurus SC');
    expect(prompt.user).toContain('Advion Roach Gel');
    expect(prompt.user).toContain('cockroach in the kitchen');
  });
});

describe('screenAskAnswer', () => {
  const data = reportData();
  const facts = buildReportAskFacts({ data, now: NOW });
  const screen = (answer, question = 'What was done?') => screenAskAnswer(answer, { question, data, facts });

  test('passes a plain grounded answer', () => {
    expect(screen('We treated the outside of your home and the kitchen cracks for the cockroach you saw.')).toBeNull();
    expect(screen('Keep pets and kids off treated areas until dry, then they can go back out.', 'Is it ok for my dog?')).toBeNull();
    expect(screen(`The report does not say. Text us or call ${WAVES_SUPPORT_PHONE_DISPLAY} and we will check.`)).toBeNull();
  });

  test.each([
    ['Your dog will be safe once it dries.', 'safe'],
    ['It is a safer option for pets.', 'safe'],
    ['The product is non-toxic.', 'safety claim'],
    ['This is harmless to pets.', 'safety claim'],
    ['We used 2.75 oz per gallon.', 'amount'],
    ['It is 40% active.', 'amount'],
    ['EPA Reg. 99999-1 covers it.', 'epa'],
    ['That visit was free.', 'free'],
    ['It costs $99 a visit.', 'price'],
    ['We guarantee the roaches are gone.', 'guarantee'],
    ['The roaches are eliminated.', 'overclaim'],
    ['Call us at (555) 010-0199.', 'phone'],
    ['See https://example.test/page for more.', 'link'],
    ['It works on ghost ants and crazy ants.', 'target_list'],
    ['', 'empty'],
  ])('rejects %j (%s)', (answer, reason) => {
    expect(screen(answer)).toBe(reason);
  });

  test('a target pest the customer named is not a leak', () => {
    expect(screen('We did treat for ghost ants as you asked.', 'Did you treat for ghost ants?')).toBeNull();
  });

  test('the company phone number is allowed', () => {
    expect(screen(`Call ${WAVES_SUPPORT_PHONE_DISPLAY} and we will help.`)).toBeNull();
  });

  test('an answer that runs long is rejected', () => {
    expect(screen('We treated the yard. '.repeat(40))).toBe('too_long');
  });
});

describe('answerReportQuestionWithAI', () => {
  const base = { question: 'What did you do about the cockroach?', data: reportData(), nextAppointment, now: NOW };
  const ok = (answer) => ({ ok: true, json: { answer }, provider: 'anthropic', model: MODELS.REPORT_ASK });

  test('returns the screened answer and sends the lane, the prompt and a hard deadline', async () => {
    const callModel = jest.fn().mockResolvedValue(ok('We treated the kitchen cracks and the outside of the home for the cockroach.'));
    const out = await answerReportQuestionWithAI(base, { callModel });
    expect(out.answer).toBe('We treated the kitchen cracks and the outside of the home for the cockroach.');
    const [payload, options] = callModel.mock.calls[0];
    expect(payload).toMatchObject({ laneId: 'report_ask', jsonMode: true, timeoutMs: 8000, system: SYSTEM_PROMPT });
    expect(payload.text).toContain('What did you do about the cockroach?');
    expect(options.hardDeadline).toBe(true);
    expect(options.maxAttemptMs).toBeLessThan(payload.timeoutMs);
    // The chain's own validate hook is the same screen.
    expect(options.validate({ json: { answer: 'Your dog will be safe.' } })).toBe('safe');
    expect(options.validate({ json: {} })).toBe('no_answer');
    expect(options.validate({ json: { answer: 'We treated the kitchen.' } })).toBeNull();
  });

  test.each([
    ['the call throws', () => jest.fn().mockRejectedValue(new Error('boom'))],
    ['the chain times out', () => jest.fn().mockResolvedValue({ ok: false, reason: 'all_providers_failed' })],
    ['the answer is empty', () => jest.fn().mockResolvedValue(ok(''))],
    ['the answer has no text', () => jest.fn().mockResolvedValue({ ok: true, json: {} })],
    ['the answer says safe', () => jest.fn().mockResolvedValue(ok('Your dog will be safe after it dries.'))],
    ['the answer lists rates', () => jest.fn().mockResolvedValue(ok('We used 2.75 oz per gallon of Alpine WSG.'))],
  ])('returns null (caller falls back to the rules) when %s', async (_label, make) => {
    expect(await answerReportQuestionWithAI(base, { callModel: make() })).toBeNull();
  });

  test('the default call goes through TEXT_POLICIES.reportAsk on the Sonnet 5.5 entry', async () => {
    dispatchWithFallback.mockResolvedValueOnce(ok('We treated the kitchen cracks for the cockroach.'));
    const out = await answerReportQuestionWithAI(base);
    expect(out.answer).toMatch(/cockroach/);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallback.mock.calls[0][0]).toBe(MODELS.TEXT_POLICIES.reportAsk);
    expect(MODELS.TEXT_POLICIES.reportAsk.primary).toMatchObject({ provider: 'anthropic', model: MODELS.REPORT_ASK });
    expect(MODELS.TEXT_POLICIES.reportAsk.fallback.provider).toBe('openai');
    expect(MODELS.REPORT_ASK).toBe('claude-sonnet-5-5');
  });

  test('the question text is never logged', async () => {
    const logger = require('../services/logger');
    logger.warn.mockClear();
    await answerReportQuestionWithAI({ ...base, question: 'My secret question about Jane' }, {
      callModel: jest.fn().mockResolvedValue({ ok: false, reason: 'anthropic_timeout' }),
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/secret question|Jane/);
  });
});

describe('GATE_REPORT_ASK_AI', () => {
  const saved = process.env.GATE_REPORT_ASK_AI;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_REPORT_ASK_AI;
    else process.env.GATE_REPORT_ASK_AI = saved;
  });

  test('on only for exactly "true", read at call time', () => {
    delete process.env.GATE_REPORT_ASK_AI;
    expect(featureGates.reportAskAiLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', 'on', ' true', 'false', '']) {
      process.env.GATE_REPORT_ASK_AI = v;
      expect(featureGates.reportAskAiLive()).toBe(false);
    }
    process.env.GATE_REPORT_ASK_AI = 'true';
    expect(featureGates.reportAskAiLive()).toBe(true);
  });
});

// ── The route ─────────────────────────────────────────────────────────────
function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

function mockDb() {
  const structuredNotes = JSON.stringify({});
  const serviceRead = chain({
    first: jest.fn()
      .mockResolvedValueOnce({ id: 'service-1', structured_notes: structuredNotes })
      .mockResolvedValueOnce({
        id: 'service-1',
        customer_id: 'customer-1',
        report_template_version: 'service_report_v1',
        structured_notes: structuredNotes,
        first_name: 'Pat',
        last_name: 'Tester',
      }),
  });
  const eventInsert = chain();
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'service_report_events') return eventInsert;
    if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { eventInsert };
}

async function ask(baseUrl, question) {
  const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /reports/:token/ask with GATE_REPORT_ASK_AI', () => {
  const saved = process.env.GATE_REPORT_ASK_AI;
  const QUESTION = 'What was applied today?';
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockResolvedValue({ serviceLine: 'pest', applications: [] });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_REPORT_ASK_AI;
    else process.env.GATE_REPORT_ASK_AI = saved;
  });

  const rulesAnswer = routeServiceReportQuestion({ question: QUESTION, data: { serviceLine: 'pest', applications: [] } }).answer;

  test('gate off: the fixed-rule answer, byte for byte, and no model call', async () => {
    delete process.env.GATE_REPORT_ASK_AI;
    const { eventInsert } = mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl, QUESTION);
      expect(status).toBe(200);
      expect(body).toEqual({ answer: rulesAnswer });
    });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(JSON.parse(eventInsert.insert.mock.calls[0][0].metadata)).toEqual({ question_length: QUESTION.length, topic: 'applied' });
  });

  // A lawn report with a recorded pet precaution: the re-entry question now
  // reaches the AI, which must carry the precaution word for word.
  const PET_LINE = 'Keep pets off treated zones until fully dry.';
  const lawnReport = (petAdvisory = PET_LINE) => ({
    serviceLine: 'lawn',
    applications: [],
    advisory: { pet_advisory: petAdvisory },
    lawnAssessment: { scores: { overallScore: 82 }, snapshot: { summary: 'Your lawn is thickening.' } },
  });

  test('gate on, a lawn report, a re-entry question: AI answer only when it carries the pet precaution verbatim', async () => {
    process.env.GATE_REPORT_ASK_AI = 'true';
    buildReportV1Data.mockResolvedValue(lawnReport());
    const q = 'Can my dog go back out on the lawn?';
    const rules = routeServiceReportQuestion({ question: q, data: lawnReport() }).answer;
    expect(rules).toContain(PET_LINE);

    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { answer: `Soon. ${PET_LINE}` }, provider: 'anthropic' });
    const { eventInsert } = mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl, q);
      expect(status).toBe(200);
      expect(body).toEqual({ answer: `Soon. ${PET_LINE}` });
    });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    // The model was handed the precaution as a required line.
    expect(dispatchWithFallback.mock.calls[0][1].text).toContain('"required_lines"');
    expect(dispatchWithFallback.mock.calls[0][1].text).toContain(PET_LINE);
    expect(JSON.parse(eventInsert.insert.mock.calls[0][0].metadata)).toEqual({ question_length: q.length, topic: 'reentry' });

    // The same call, but the model drops the precaution: the rule answer wins.
    jest.clearAllMocks();
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { answer: 'Your dog can go out once the lawn is dry.' }, provider: 'anthropic' });
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await ask(baseUrl, q);
      expect(body).toEqual({ answer: rules });
    });
  });

  test('gate on, a recorded fixed wait trips the screen: the rule answer states it, no model call', async () => {
    process.env.GATE_REPORT_ASK_AI = 'true';
    const wait = 'Keep pets inside for 2 hours.';
    buildReportV1Data.mockResolvedValue(lawnReport(wait));
    const q = 'Can my dog go back out on the lawn?';
    const rules = routeServiceReportQuestion({ question: q, data: lawnReport(wait) }).answer;
    expect(rules).toContain(wait);
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await ask(baseUrl, q);
      expect(body).toEqual({ answer: rules });
    });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('gate off, a lawn report: the fixed-rule answer, byte for byte, no model call', async () => {
    delete process.env.GATE_REPORT_ASK_AI;
    buildReportV1Data.mockResolvedValue(lawnReport());
    const q = 'Can my dog go back out on the lawn?';
    const rules = routeServiceReportQuestion({ question: q, data: lawnReport() }).answer;
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await ask(baseUrl, q);
      expect(body).toEqual({ answer: rules });
    });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test.each(['lawn', 'tree_shrub', 'mosquito', 'termite', 'rodent'])('gate on, a %s report reaches the AI for a plain question', async (line) => {
    process.env.GATE_REPORT_ASK_AI = 'true';
    buildReportV1Data.mockResolvedValue({ serviceLine: line, applications: [] });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { answer: 'No products were recorded on this report.' }, provider: 'anthropic' });
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await ask(baseUrl, QUESTION);
      expect(body).toEqual({ answer: 'No products were recorded on this report.' });
    });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('gate on: the model answer, same reply shape, same event (length and topic only)', async () => {
    process.env.GATE_REPORT_ASK_AI = 'true';
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { answer: 'No products were recorded on this report.' }, provider: 'anthropic' });
    const { eventInsert } = mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl, QUESTION);
      expect(status).toBe(200);
      expect(body).toEqual({ answer: 'No products were recorded on this report.' });
    });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(JSON.parse(eventInsert.insert.mock.calls[0][0].metadata)).toEqual({ question_length: QUESTION.length, topic: 'applied' });
  });

  test.each([
    ['the chain fails', { ok: false, reason: 'all_providers_failed' }],
    ['the answer says safe', { ok: true, json: { answer: 'It is safe.' } }],
  ])('gate on, %s: the fixed-rule answer', async (_label, result) => {
    process.env.GATE_REPORT_ASK_AI = 'true';
    dispatchWithFallback.mockResolvedValueOnce(result);
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl, QUESTION);
      expect(status).toBe(200);
      expect(body).toEqual({ answer: rulesAnswer });
    });
  });

  test('gate on, the call throws: the fixed-rule answer', async () => {
    process.env.GATE_REPORT_ASK_AI = 'true';
    dispatchWithFallback.mockRejectedValueOnce(new Error('network'));
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await ask(baseUrl, QUESTION);
      expect(body).toEqual({ answer: rulesAnswer });
    });
  });
});
