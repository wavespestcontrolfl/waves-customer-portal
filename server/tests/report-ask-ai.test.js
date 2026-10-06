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
  medicalExposureAnswer,
  MEDICAL_EXPOSURE_ANSWER,
  exposureSafetyLine,
  EXPOSURE_SAFETY_LINE,
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
    expect(facts.pest_pressure).toEqual({ label: null, trend: null, score_out_of_5: 2.4, what_it_means: null, trend_summary: 'Pressure is down from your last visit.', scale: '0 to 5, lower is better' });
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

  test('technician recommendations never reach the model (they can hold a customer name)', () => {
    const data = { serviceLine: 'pest', applications: [], recommendations: ['Ask Mrs. Example to trim the shrubs.', 'Keep the pantry sealed.'] };
    const out = buildReportAskFacts({ data });
    expect(out.recommendations).toBeUndefined();
    expect(buildReportAskPrompt({ question: 'What was applied?', data }).user).not.toMatch(/Mrs\. Example|pantry/);
  });

  test('the Waves summary headline and body are carried when the report has no summary text', () => {
    const dynamicContext = { aiSummary: { headline: 'A calm visit.', body: 'Light activity near the kitchen.' } };
    const out = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], dynamicContext } });
    expect(out.waves_summary).toEqual({ headline: 'A calm visit.', body: 'Light activity near the kitchen.' });
    expect(buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], summary: 'Plain summary.', dynamicContext } }).waves_summary).toBeUndefined();
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

  test('masks a lettered access code in the concern and keeps missing weather unknown', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: 'gate code A1B2, roaches in the garage', conditions: { temp_f: 88, rain_24h_in: null, rainfall_in: null } } });
    expect(facts.customer_concern).not.toMatch(/A1B2/);
    expect(facts.weather_during_visit).toBe('about 88°F');
  });

  test('humidity is in words, the recorded method rides with the product, markdown forms are rejected', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', conditions: { humidity_pct: 82 }, applications: [{ product: { name: 'Taurus SC' }, applicationArea: 'Perimeter', method: 'perimeter_spray' }] } });
    expect(facts.weather_during_visit).toBe('humid');
    expect(facts.products[0].how_applied).toBe('perimeter spray');
    for (const bad of ['# Treatment summary', '1. We treated the kitchen.', '*We treated the kitchen.*']) {
      expect(screenAskAnswer(bad, { question: 'q', data: {} })).toBe('markdown');
    }
    expect(screenAskAnswer('We treated the kitchen and the bathrooms.', { question: 'q', data: {} })).toBeNull();
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
    // No appointment reaches the model: next-visit questions keep the rule answer.
    expect(facts.next_visit).toBeUndefined();
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
    expect(out.products).toBeUndefined();
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

  test('the question is scrubbed like the concern before it reaches the prompt', () => {
    const question = 'Call me at 941-555-0100 or pat@example.com, gate code A1B2, I live at 4821 Example Lane. Was the kitchen done?';
    const { user } = buildReportAskPrompt({ question, data: reportData(), nextAppointment, now: NOW });
    const questionLine = user.split('\n')[0];
    expect(questionLine).not.toMatch(/555|example\.com|A1B2|4821/);
    expect(questionLine).toMatch(/Was the kitchen done\?/);
  });

  test('every free-text field of the fact sheet is scrubbed at the one chokepoint', () => {
    const data = reportData({
      reportSections: [{ title: 'Notes from Jane', paragraphs: ['Call Jane at 941-555-0100 or jane@example.com, she lives at 12 Example Lane.'] }],
      summary: null,
      findings: [{ title: 'Entry at 4821 Sample Court', detail: 'Gate code A1B2 at the side door', recommendation: 'Email tech@example.com' }],
      recommendations: ['Text 941-555-0111 before the next visit'],
      customerConcern: 'Roaches near 77 Test Avenue',
      dynamicContext: { aiSummary: { headline: 'Visit at 900 Example Trail', body: 'Reach us at pat@example.com' } },
    });
    const { user } = buildReportAskPrompt({ question: 'I live at 12 Example Lane. What did you find?', data, nextAppointment, now: NOW });
    // House numbers are masked; a street name without its number may stay.
    expect(user).not.toMatch(/555|example\.com|A1B2|4821|\b900\b|\b12 Example|\b77 Test/);
    expect(user).toMatch(/\[number\] Example Lane/);
    expect(user).toMatch(/What did you find\?/);
    // The fixed lines and the calendar date are left as built.
    expect(user).toContain('Waves Pest Control');
    expect(user).toContain(WAVES_SUPPORT_PHONE_DISPLAY);
    expect(user).toContain('Friday, October 2, 2026');
    expect(user).not.toContain('January 5, 2027');
    expect(user).toContain('Alpine WSG');
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
  const facts = buildReportAskFacts({ data, nextAppointment, now: NOW });
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
    ['It works on a ghost ant problem.', 'target_list'],
    ['That visit was ninety dollars.', 'price'],
    ['We used two ounces of it.', 'amount'],
    ['We put down twenty-five grams.', 'amount'],
    ['About half a gallon went down.', 'amount'],
    ['A couple of ounces covered it.', 'amount'],
    ['We placed twelve bait stations.', 'count'],
    ['We set a dozen traps.', 'count'],
    ['We placed 12 bait stations.', 'count'],
    ['', 'empty'],
  ])('rejects %j (%s)', (answer, reason) => {
    expect(screen(answer)).toBe(reason);
  });

  test('a target named in the selected products approved wording is allowed; one known only from the targets is not', () => {
    const wording = reportData();
    wording.applications[1].product.report_copy.how_it_works = 'Taurus SC builds an outdoor barrier that stops ants.';
    wording.applications[1].targets = ['ants', 'termites'];
    const wordingFacts = buildReportAskFacts({ data: wording, now: NOW });
    const run = (answer) => screenAskAnswer(answer, { question: 'What is Taurus SC?', data: wording, facts: wordingFacts });
    expect(run('Taurus SC builds an outdoor barrier that stops ants.')).toBeNull();
    expect(run('Taurus SC also works on termites.')).toBe('target_list');
  });

  test('number words: prose passes, an invented duration does not', () => {
    expect(screen('A few days after this you may still see a roach.')).toBeNull();
    expect(screen('Half the kitchen was done first.')).toBeNull();
    // A spelled duration the report never states is a claim like its digits (Codex P1 #5964 r14).
    expect(screen('Expect it to take two or three days.')).toBe('unstated_number');
  });

  test('a target is matched by its singular or plural form', () => {
    expect(screen('It also covers the ghost ant.')).toBe('target_list');
    expect(screen('It also covers German roach.')).toBe('target_list');
    expect(screen('We did treat for the ghost ant as you asked.', 'Did you treat for ghost ants?')).toBeNull();
  });

  test('more than four sentences is rejected', () => {
    expect(screen('We treated the outside. We treated the kitchen. We checked the garage. We looked at the entry points.')).toBeNull();
    expect(screen('We treated the outside. We treated the kitchen. We checked the garage. We looked at the entry points. We wrote it up.')).toBe('too_many_sentences');
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

  // The shared owner screen (report-writer-rules.js writerRulesRejection) runs
  // on every answer: its reasons come through unchanged.
  test.each([
    ['The retired brand "Waves Lawn & Pest" shows up.', 'We treated it for you at Waves Lawn & Pest.', 'company_name'],
    ['The retired brand "Waves Pest Control & Lawn Care"', 'Waves Pest Control & Lawn Care treated the outside.', 'company_name'],
    ['The retired brand "Waves Lawn Care"', 'Waves Lawn Care handled the outside.', 'company_name'],
    ['a "-proof" claim', 'The bait is roach-proof.', 'owner_phrase'],
    ['a property-wide absence', 'No pest activity was observed today.', 'unscoped_absence'],
    ['a price word', 'The follow-up charge is on your invoice.', 'price'],
    ['a per-visit price phrase', 'It is billed per visit.', 'per_visit'],
  ])('shared screen: %s is rejected (%s)', (_label, answer, reason) => {
    expect(screen(answer)).toBe(reason);
  });

  test('shared screen: a local absence, recorded re-entry words, a timeframe, a date and a product name pass', () => {
    expect(screen('None were seen at the dishwasher today.')).toBeNull();
    expect(screen('Keep pets off the treated areas until they are dry.', 'Can my dog go out?')).toBeNull();
    expect(screen('Activity can stay up for a few days, and we check again at your next visit.')).toBeNull();
    expect(screen('Your next visit is Tuesday, January 5, 2027.')).toBe('states_a_date');
    expect(screen('Alpine WSG with dinotefuran went on the outside of the home.', 'Why was Alpine WSG used?')).toBeNull();
  });

  test.each([
    'Your home is child-friendly now.',
    'The treatment is children friendly.',
    'It is family-friendly.',
    'The product is people friendly.',
    "It is kid-friendly.",
    'The mix is pet-friendly.',
  ])('rejects a friendly claim: %s', (answer) => {
    expect(screen(answer)).toBe('safety claim');
  });

  test.each([
    'This will get rid of them.',
    'The treatment will definitely stop the ants.',
    'The bait will kill all of the roaches.',
    'You will not see any more roaches.',
    "You won't see any more ants after this.",
    'There will be no more ants in the kitchen.',
    'After this, no more roaches.',
  ])('rejects a promise of results: %s', (answer) => {
    expect(screen(answer)).toBe('result promise');
  });

  test('"will eliminate" is rejected too (the older overclaim rule names it)', () => {
    expect(screen('The treatment will eliminate the problem.')).not.toBeNull();
  });

  test('a plain statement of what the product does is not a promise', () => {
    expect(screen('It slows ants and roaches at the entry points.')).toBeNull();
    expect(screen('You may still see a few ants for a few days.')).toBeNull();
  });

  test.each([
    'We used three products.',
    'We used 3 products.',
    'We made two applications.',
    'There were four treatments.',
    'We put down two sprays.',
  ])('counts of products and applications are rejected: %s', (answer) => {
    expect(screen(answer)).toBe('count');
  });

  test('"a few days" and a single product still pass', () => {
    expect(screen('Activity may stay up for a few days.')).toBeNull();
    expect(screen('This product goes on the outside of the home.')).toBeNull();
  });

  test('a list is rejected even though the model put its line breaks first', () => {
    expect(screen('Summary:\n1. We treated the kitchen.\n2. We checked the garage.')).toBe('markdown');
    expect(screen('Summary: 1. We treated the kitchen. 2. We checked the garage.')).toBe('markdown');
    expect(screen('We treated the kitchen.\n- We checked the garage.')).toBe('markdown');
  });

  test.each([
    'See wavespestcontrol.com for more.',
    'Go to example.org/page.',
    'Visit report.io today.',
    'Read about it on example.net.',
  ])('a bare domain is a link: %s', (answer) => {
    expect(screen(answer)).toBe('link');
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

describe('schedule questions keep the rule answer', () => {
  const { asksAboutSchedule } = require('../services/service-report/report-ask-ai');
  test.each([
    'When are you returning?', 'When will the technician return?', 'When are you coming again?',
    'Can I reschedule?', 'When is my next appointment?',
    'What time will you be here?', 'What day are you coming?',
    'Will the technician visit tomorrow?', 'Is my service tomorrow?', 'When is my service?', 'Can you tell me when my visit is?', 'What is my service date?', 'Am I booked for tomorrow?', 'Is somebody coming tomorrow?', 'Is anyone coming tomorrow?', 'Will somebody be here tomorrow?', 'Can you make it tomorrow?', 'Will you make it tomorrow?', 'When is the follow-up?', 'Are we booked for tomorrow?', 'Are we confirmed for tomorrow?', 'Are we set for tomorrow?', 'Am I booked tomorrow?', 'Are we still on for tomorrow?', 'When can I expect you?', "When's my service?", 'When is my visit?', 'Will you come tomorrow?', 'Can you come tomorrow?', 'Are you able to come tomorrow?', 'Are you treating tomorrow?', 'Is there a visit tomorrow?', 'Are there any visits tomorrow?', 'When am I scheduled?', 'Are you visiting tomorrow?', 'Is the tech stopping by tomorrow?', 'Are you coming tomorrow?', 'Will the technician be here tomorrow?',
  ])('schedule: %s', (question) => {
    expect(asksAboutSchedule(question)).toBe(true);
  });
  test.each(['What did you spray?', 'Why was Alpine WSG used?', 'Will the ants come back?', 'Are the ants coming back?', 'Will ants come back tomorrow?', 'Will ants come back next week?', 'What did this visit cover?', 'What did you see when you visited?', 'Where did you visit?', 'Did you come into the house?', 'What time of year are ants most active?', 'I booked this service for ants. What was applied?', 'Could ants be here because of the rain?', 'Why would roaches be here?', 'Could the pests be back next week?', 'Why are you treating the lawn?', 'The service was completed as scheduled. What was applied?', 'What was applied during the scheduled service?', 'What was applied at my last appointment?', "Which product did you use at today's appointment?", 'Where are the ants coming from?', 'How do roaches arrive in the house?', 'Will the ants return?', 'Will roaches return after treatment?'])('not schedule: %s', (question) => {
    expect(asksAboutSchedule(question)).toBe(false);
  });
});

describe('symptoms and exposure never reach the model', () => {
  test.each([
    'The spray made me dizzy',
    "I am vomiting after today's treatment",
    'My dog ate something in the yard',
    'The cat licked the bait station',
    'I got it in my eyes',
    "I can't breathe since you sprayed",
    'My son has a rash on his arm',
    'My toddler swallowed some of it',
    'Is it normal that my daughter feels sick after the spray?',
    'The kids got sick after the treatment',
    'It burned my skin',
    'I am having trouble breathing',
    'I feel lightheaded since this morning',
    'He passed out in the kitchen',
    'My child is coughing after the pesticide treatment',
    'My dog is shaking after the treatment',
    'It sprayed on my face',
    'I was sprayed in the eyes',
    'He was sprayed on the skin',
    'The technician sprayed me in the face',
    'The technician sprayed my eyes',
    'You sprayed my skin',
    'The pesticide splashed my eyes',
    'The pesticide splashed me in the eyes',
    'The chemical hit me in the eye',
    'The pesticide hit me in both eyes',
    'The chemical got into my left eye',
    'It splashed into her right eye',
    'My dog consumed the bait',
    'My partner swallowed some bait',
    'John swallowed some bait',
    'The bait was swallowed by John',
    'john swallowed some bait',
    'JOHN swallowed some bait',
    'the bait was swallowed by john',
    'The ant bait was swallowed by John',
    'The rat poison was eaten by John',
    'Ants were nearby when John ate the bait',
    'Roaches were there and John swallowed the bait',
    'My partner is sick after the spray',
    'My cousin ate some granules',
    'My coworker drank pesticide',
    'The bait was eaten by my dog',
    'The bait was swallowed by my partner',
    'The granules were eaten by my cousin',
    'The baby sucked on the bait',
    'My dog lapped up the pesticide',
    'Accidentally swallowed some bait',
    'Ingested some spray',
    'The product touched my skin',
    'My eyes were sprayed',
    'My skin was sprayed',
    "The dog's eyes were sprayed",
    "You sprayed my dog's face",
    "The spray got in the baby's eyes",
    "The product got on the cat's skin",
  ])('a fixed answer for: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBe(MEDICAL_EXPOSURE_ANSWER);
  });

  // Spray plus a person, pet or body part: the safety line goes before the
  // normal answer (owner 2026-10-05, option A); the answer is not replaced.
  test.each([
    'You sprayed my dog by accident',
    'The tech sprayed me',
    'My cat got sprayed',
    'The tech sprayed my neck',
    'Some got sprayed on my ear',
    'You sprayed my back by the door',
    'The tech sprayed my partner',
    'You sprayed my roommate',
    'The tech sprayed my hamster',
    'My roommate got sprayed',
    'I got sprayed in the yard',
    'The tech sprayed my hamster inside',
    'You sprayed my partner yesterday',
    'My kids ran outside and the tech sprayed them',
    'My dogs were in the yard and he sprayed them',
    'I was accidentally sprayed',
    'The tech sprayed my neck area',
    'The tech sprayed my left side',
    'You sprayed my arm and hand',
    'What was sprayed on the arm chair?',
    'Can my dog go out after the spray?',
    'Can I go out after the spray?',
    'Can we go outside after you spray?',
    'The technician sprayed her',
    'She was sprayed',
    'You got sprayed',
    'The technician sprayed you',
    'The technician sprayed my cousin',
    'You sprayed my coworker',
    'My snake was sprayed',
    "I've been sprayed",
    "We've been sprayed",
    "She's been sprayed",
    'They were sprayed',
    'They got sprayed',
  ])('a safety line before the answer for: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeNull();
    expect(exposureSafetyLine(question)).toBe(EXPOSURE_SAFETY_LINE);
  });

  test.each([
    'What was sprayed on my lawn?',
    'What was sprayed on the fence?',
    'Which product was sprayed on my garage?',
    'What was sprayed on the outside of the house?',
    'Can you tell me what was sprayed?',
    'I want to know what you sprayed',
    'We need to know what product you sprayed',
    'Can I ask what you sprayed?',
    'Can you explain to me what was sprayed?',
    'Please reply to me with what you sprayed',
    'Could you message me the product you sprayed?',
    'Text us what you sprayed',
    'When can my dog go back outside?',
    'Why was Alpine WSG used?',
    '',
  ])('no safety line for: %s', (question) => {
    expect(exposureSafetyLine(question)).toBeNull();
  });

  test('the safety line: Poison Control and 911, nothing about safety', () => {
    expect(EXPOSURE_SAFETY_LINE).toBe('If anyone or a pet was exposed or feels unwell, call Poison Control at 1-800-222-1222 (free, confidential, 24/7). In an emergency, call 911.');
    expect(EXPOSURE_SAFETY_LINE).not.toMatch(/\bsaf/i);
  });

  test.each([
    'Why was Alpine WSG used?',
    'What did you do about the cockroach?',
    'Is my lawn looking sick this year?',
    'My lawn is sick',
    'My grass is looking sick',
    'My palm is looking ill',
    'My azalea is sick',
    'My orchid is sick',
    'My fern is looking ill',
    'The ants ate the bait. Is that normal?',
    'When can my dog go back outside?',
    'Are there bee hives near my shed?',
    'How many numbers are on the pressure scale?',
    'What was sprayed on the face of the house?',
    'Ate breakfast before the service. What did you spray?',
    'Just drank water. What was applied?',
    'Were the ants poisoned by the bait?',
    'The ants ate the bait. Is that good?',
    'Was the bait eaten by the roaches?',
    'Was the bait eaten?',
    'Was the rodent bait eaten?',
    'Was any bait consumed?',
    'Was the rat poisoned?',
    'What was sprayed on my lawn?',
    'What was sprayed on the fence?',
    'Was anything sprayed on my patio?',
    'Which product was sprayed on my garage?',
    'What was sprayed on the dog bed?',
    'Was the bird cage sprayed?',
    "What was sprayed on the kids' playset?",
    'The weeds were brown after they were sprayed. What product did you use?',
    'The ants disappeared after they were sprayed',
    'The bushes were sprayed on Monday, right?',
    "Was my dog's bowl sprayed?",
    'The dog bed was sprayed',
    'The bird cage was sprayed',
    'My front lawn was sprayed',
    'I got it sprayed last week',
    'We got outside sprayed',
    'I got everything sprayed',
    'You sprayed my front lawn today',
    'What was sprayed on the outside of the house?',
    'What was sprayed on the inside?',
    'The product was sprayed outside; what was it?',
    'The chemical was sprayed near the door',
    'Was the treatment sprayed on the front?',
    'What was sprayed on my back yard?',
    'You sprayed the back door',
    'What was sprayed on the side of the house?',
    'Was the front door sprayed?',
    'You sprayed my left side of the yard',
    '',
  ])('no fixed answer for: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeNull();
  });

  test('the fixed answer: Poison Control, 911, then the office, nothing about safety', () => {
    expect(MEDICAL_EXPOSURE_ANSWER).toBe(
      `Please call Poison Control at 1-800-222-1222 now (free, confidential, 24/7). In a medical emergency, call 911. If a pet is affected, call your veterinarian or an emergency animal hospital. Then text us or call Waves Pest Control at ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
    );
    expect(MEDICAL_EXPOSURE_ANSWER).not.toMatch(/\bsaf/i);
  });

  test('the AI entry point answers it without building a fact sheet or calling the model', async () => {
    const callModel = jest.fn();
    const out = await answerReportQuestionWithAI({ question: 'The spray made me dizzy', data: reportData(), nextAppointment, now: NOW }, { callModel });
    expect(out).toEqual({ answer: MEDICAL_EXPOSURE_ANSWER, provider: null, model: null });
    expect(callModel).not.toHaveBeenCalled();
  });
});

describe('prompt and facts, review round 5', () => {
  test('the prompt lists the garage and entry point values the fact sheet can carry', () => {
    expect(placeOfApplication('Garage, Entry points')).toBe('the garage and the entry points');
    expect(placeOfApplication('Entry points')).toBe('the entry points');
    for (const value of ['the garage', 'the entry points', 'the garage and the entry points']) {
      expect(SYSTEM_PROMPT).toContain(value);
    }
  });

  test('the prompt bans the friendly claims and result promises it screens', () => {
    expect(SYSTEM_PROMPT).toMatch(/child-, family- or people-friendly/);
    expect(SYSTEM_PROMPT).toMatch(/you will not see any more/);
  });

  test('a bare pressure index carries its scale; a labeled gauge does not need one', () => {
    const bare = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], pressureIndex: 1.5 } });
    expect(bare.pest_pressure).toMatchObject({ score_out_of_5: 1.5, scale: '0 to 5, lower is better' });
    const gauge = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], pestPressure: { label: 'Low', score: 1 } } });
    expect(gauge.pest_pressure.scale).toBeUndefined();
  });

  test.each([
    ['12 Example Boulevard', '12 Example Boulevard'],
    ['44 Palm Terrace', '44 Palm Terrace'],
    ['55 State Parkway', '55 State Parkway'],
    ['7 Oak Trail', '7 Oak Trail'],
    ['9 Bay Pointe', '9 Bay Pointe'],
    ['21 Harbor Crossing', '21 Harbor Crossing'],
    ['30 Heron Cove', '30 Heron Cove'],
    ['4 Sample Hwy', '4 Sample Hwy'],
    ['18 Test Ln', '18 Test Ln'],
    ['18 Test Ave', '18 Test Ave'],
    ['18 Test St.', '18 Test St'],
  ])('masks the street address %s', (address) => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: `Ants at ${address}, near the lanai` } });
    // The house number is masked; the street name alone is not an address.
    expect(facts.customer_concern).toBe(`Ants at ${address.replace(/^\d+/, '[number]')}, near the lanai`);
  });
});

describe('scripts/dev/report-ask-prompt.js', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const script = path.resolve(__dirname, '../../scripts/dev/report-ask-prompt.js');
  const run = (payload) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-prompt-'));
    const file = path.join(dir, 'report.json');
    fs.writeFileSync(file, JSON.stringify(payload));
    try {
      return JSON.parse(execFileSync('node', [script, file, 'When is my next visit?'], { encoding: 'utf8' }));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const camel = { serviceType: 'Quarterly Pest Control', scheduledDate: '2027-01-05', windowStart: '09:00:00' };

  test('a bare report and a wrapped one give the same prompt, with no appointment', () => {
    const bare = run({ serviceLine: 'pest', applications: [], nextAppointment: camel });
    const wrapped = run({ data: { serviceLine: 'pest', applications: [] }, nextAppointment: camel });
    // The prompt carries no appointment (next-visit questions keep the rule answer).
    expect(bare.user).not.toContain('January 5, 2027');
    expect(wrapped.user).toBe(bare.user);
  });

  test('a wrapped route-shaped (snake_case) appointment still works', () => {
    const wrapped = run({ data: { serviceLine: 'pest', applications: [] }, nextAppointment: { service_type: 'Quarterly Pest Control', scheduled_date: '2027-01-05', window_start: '09:00:00' } });
    expect(wrapped.user).not.toContain('January 5, 2027');
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
  // Each test request comes from its own client address (ask() below), so the
  // route's 20-a-minute limiter does not count across tests.
  app.set('trust proxy', 'loopback');
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

let askCount = 0;
async function ask(baseUrl, question) {
  askCount += 1;
  const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.${Math.floor(askCount / 250)}.${askCount % 250}` },
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

  // Termite, rodent, mosquito and specialty reports, a typed-snapshot report
  // and a report with a visible companion section keep the rule answer.
  test.each([
    ['termite', { serviceLine: 'termite' }],
    ['rodent', { serviceLine: 'rodent' }],
    ['mosquito', { serviceLine: 'mosquito' }],
    ['specialty', { serviceLine: 'specialty' }],
    ['typed pest', { serviceLine: 'pest', typedReport: { type: 'cockroach_service' } }],
    ['pest with a companion section', { serviceLine: 'pest', companionReports: [{ type: 'rodent_trapping', internalOnly: false }] }],
  ])('gate on, a %s report keeps the fixed-rule answer, no model call', async (_label, extra) => {
    process.env.GATE_REPORT_ASK_AI = 'true';
    const report = { applications: [], ...extra };
    buildReportV1Data.mockResolvedValue(report);
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl, QUESTION);
      expect(status).toBe(200);
      expect(body).toEqual({ answer: routeServiceReportQuestion({ question: QUESTION, data: report }).answer });
    });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test.each(['lawn', 'tree_shrub'])('gate on, a %s report reaches the AI for a plain question', async (line) => {
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

  test.each(['on', 'off'])('gate %s, a symptom question: the fixed Poison Control answer and no model call', async (gate) => {
    if (gate === 'on') process.env.GATE_REPORT_ASK_AI = 'true'; else delete process.env.GATE_REPORT_ASK_AI;
    const { eventInsert } = mockDb();
    const q = 'The spray made me dizzy';
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl, q);
      expect(status).toBe(200);
      expect(body).toEqual({ answer: MEDICAL_EXPOSURE_ANSWER });
    });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(JSON.parse(eventInsert.insert.mock.calls[0][0].metadata)).toEqual({ question_length: q.length, topic: 'applied' });
  });

  test('a spray question naming a person: the safety line, then the normal answer', async () => {
    process.env.GATE_REPORT_ASK_AI = 'true';
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'all_providers_failed' });
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl, 'The tech sprayed my arm, what was it?');
      expect(status).toBe(200);
      expect(body.answer.startsWith(`${EXPOSURE_SAFETY_LINE} `)).toBe(true);
      expect(body.answer.length).toBeGreaterThan(EXPOSURE_SAFETY_LINE.length + 1);
    });
  });

  test('a symptom question on a lawn report gets the fixed answer too', async () => {
    delete process.env.GATE_REPORT_ASK_AI;
    buildReportV1Data.mockResolvedValue({ serviceLine: 'lawn', applications: [] });
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await ask(baseUrl, 'My dog ate some of the granules');
      expect(body).toEqual({ answer: MEDICAL_EXPOSURE_ANSWER });
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

describe('report Ask hotfix (Codex on #5964 against live #5957 code)', () => {
  const m = require('../services/service-report/report-ask-ai');
  it('a question about what was sprayed on the lawn is a report question, not an exposure', () => {
    expect(m.medicalExposureAnswer('What was sprayed on my lawn?')).toBeNull();
    expect(m.medicalExposureAnswer('What did you spray on my bushes?')).toBeNull();
    // Option A (owner 2026-10-05): a spray + pet question keeps its answer, with the safety line first.
    expect(m.exposureSafetyLine('They sprayed my dog')).toBe(m.EXPOSURE_SAFETY_LINE);
    expect(m.medicalExposureAnswer('It got sprayed in my eyes')).toBeTruthy();
  });
  it('masks two-digit addresses on Pass, View and Walk streets', () => {
    for (const address of ['18 Bay Pass', '7 Harbor View', '22 Palm Walk']) {
      expect(m.buildReportAskPrompt({ question: `I live at ${address}`, data: { serviceLine: 'pest', applications: [] } }).user).not.toContain(address);
    }
  });
  it('an AI answer states no date, weekday or time of its own', () => {
    const facts = { service_date: 'Sunday, October 4, 2026', next_visit: { date: 'Monday, January 4, 2027', arrival_window: 'between 9:00 AM and 11:00 AM' } };
    const screen = (a, requiredLines = []) => m.screenAskAnswer(a, { question: 'q', data: {}, facts, requiredLines });
    // Even a date the facts hold: a near miss ("January 1" for "January 10",
    // a wrong year, a weekday from another date) cannot be told apart (#6020).
    expect(screen('Your next visit is Monday, January 4, 2027, between 9:00 AM and 11:00 AM.')).toBe('states_a_date');
    expect(screen('Your next visit is January 8 at 2 PM.')).toBe('states_a_date');
    expect(screen('Your next visit is Friday.')).toBe('states_a_date');
    expect(screen('It keeps working for weeks.')).toBeNull();
    // A required line keeps its own date or time.
    expect(screen('Not yet. Skip your turf watering until Thu 3 PM.', ['Skip your turf watering until Thu 3 PM.'])).toBeNull();
  });

});

describe('street-address scrub keeps prose', () => {
  const { buildReportAskFacts } = require('../services/service-report/report-ask-ai');
  test.each([
    ['Pressure index 2 is improving.', 'Pressure index 2 is improving.'],
    ['Ants at 18 Bay Pass by the lanai.', 'Ants at [number] Bay Pass by the lanai.'],
    ['Ants at 21 Harbor Crossing.', 'Ants at [number] Harbor Crossing.'],
    ['Ants at 21 heron bluff.', 'Ants at [number] heron bluff.'],
    ['Ants at 21 HERON BLUFF.', 'Ants at [number] HERON BLUFF.'],
    ['Ants at 21 Palm Is.', 'Ants at [number] Palm Is.'],
    ['Ants at 12 1/2 Example Street.', 'Ants at [number] Example Street.'],
    ['Ants at 88B Example Street.', 'Ants at [number] Example Street.'],
    ['Ants at 12-14 Main Street.', 'Ants at [number] Main Street.'],
    ['Ants at 12 SR 70.', 'Ants at [number] SR 70.'],
    ['Ants at 12 FL-70.', 'Ants at [number] FL-70.'],
    ['Ants at 12 US 41.', 'Ants at [number] US 41.'],
    ['Ants at 12-14 US 41.', 'Ants at [number] US 41.'],
    ['Ants at 12 N US 41.', 'Ants at [number] N US 41.'],
    ['Ants at 12 U.S. 41.', 'Ants at [number] U.S. 41.'],
    ['Ants at 12 U S 41.', 'Ants at [number] U S 41.'],
    ['Ants at Twelve Main Street.', 'Ants at [number] Main Street.'],
    ['Ants at One Hundred Bay Drive.', 'Ants at [number] Bay Drive.'],
    ['Ants at Twelve U S 41.', 'Ants at [number] U S 41.'],
    ['Ants at 12 S.R. 70.', 'Ants at [number] S.R. 70.'],
    ['Ants at 12/14 SR 70.', 'Ants at [number] SR 70.'],
    ['Ants at 12 1/2 FL-70.', 'Ants at [number] FL-70.'],
    ['Ants at 12 José Lane.', 'Ants at [number] José Lane.'],
    ['Ants at 12 O’Neil Street.', 'Ants at [number] O’Neil Street.'],
    ['Ants at 18 North Martin Luther King Boulevard.', 'Ants at [number] North Martin Luther King Boulevard.'],
    // Everyday nouns in the USPS table lose only the count.
    ['We saw 2 rats by the lake.', 'We saw [number] rats by the lake.'],
  ])('%s', (concern, expected) => {
    expect(buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: concern } }).customer_concern).toBe(expected);
  });
});
