// GATE_LAWN_REPORT_FACTS: every place the lawn report states re-entry reads the frozen condition, and a record
// without a frozen rule reads exactly as before. Rendering reads the record only, never a gate. Synthetic data only.

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildReentryContextFromRecord, buildReentrySummary } = require('../services/service-report/reentry');
const { buildAftercare } = require('../services/service-report/lawn-report-v2');
const { buildReportAskFacts } = require('../services/service-report/report-ask-ai');
const { answerServiceReportQuestion } = require('../services/service-report/report-assistant');
const { buildServiceReportV1Email } = require('../services/service-report/email-delivery');
const { buildAiSummaryFacts } = require('../services/service-report/ai-summary');

const NOW = new Date('2026-10-08T21:00:00Z');
const APPLIED = '2026-10-08T20:05:00Z';
const block = (reentry) => JSON.stringify({
  lawnReportFacts: { v: 1, reentry, productUse: {}, ties: { assessmentId: null, items: [] } },
});
const DRY = { rule: 'dry', source: 'facts', products: [{ id: 'a', rule: 'dry', source: 'facts' }] };
const WET = { rule: 'watered_in_and_dry', source: 'facts', products: [{ id: 'a', rule: 'watered_in_and_dry', source: 'facts' }] };
const DEFAULTED = { rule: 'default', source: 'default', products: [{ id: 'a', rule: null, source: 'default' }] };
const TIMED = { rule: 'timed', source: 'label', hours: 12, base: 'dry', products: [{ id: 'a', rule: 'dry', source: 'facts' }] };

// A lawn visit as the dynamic context loads it: a spray application at 8:05 PM ET, line default 30 minutes.
const lawnRecord = (notes, extra = {}) => ({
  id: 'sr-1',
  service_line: 'lawn',
  service_type: 'Lawn Care Service',
  service_date: '2026-10-08',
  applications: [{ id: 'sp-1', application_method: 'broadcast_spray', applied_at: APPLIED }],
  advisory: { exterior_reentry_min: 30, pet_advisory: 'Keep pets off treated turf until dry.' },
  structured_notes: notes,
  ...extra,
});

const TODAY = {
  dry: 'Ready to walk on once the spray has dried.',
  wet: 'Ready to walk on once today’s treatment has dried and, after you water it in, the grass is dry again.',
  pets: 'Keep people and pets off the lawn until then.',
};

describe('the re-entry context (the one source every surface reads)', () => {
  test('a frozen spray-only rule is a condition: no targets, no ready-at time, no countdown', () => {
    const ctx = buildReentryContextFromRecord(lawnRecord(block(DRY)), NOW);
    expect(ctx).toMatchObject({
      targets: [],
      condition: { rule: 'dry', text: TODAY.dry, pets: TODAY.pets, statusLabel: 'Once dry' },
      customerSummary: TODAY.dry,
      petAdvisory: TODAY.pets,
    });
    expect(ctx).not.toHaveProperty('irrigationReadyAt');
    expect(JSON.stringify(ctx)).not.toMatch(/readyAt|statusAtGeneratedAt|durationMin/);
  });

  test('a granular or mixed rule says it waits for the water-in', () => {
    const ctx = buildReentryContextFromRecord(lawnRecord(block(WET)), NOW);
    expect(ctx.customerSummary).toBe(TODAY.wet);
    expect(ctx.condition.statusLabel).toBe('After watering in');
  });

  test('there is no timed rule: a stored "timed" block is no rule, and the record keeps today\'s clock', () => {
    const ctx = buildReentryContextFromRecord(lawnRecord(block(TIMED)), NOW);
    expect(ctx).not.toHaveProperty('condition');
    expect(ctx.targets[0]).toMatchObject({ key: 'exterior', durationMin: 30 });
  });

  test('the condition does not depend on the clock or on any gate', () => {
    const early = buildReentryContextFromRecord(lawnRecord(block(DRY)), new Date('2026-10-08T20:06:00Z'));
    const late = buildReentryContextFromRecord(lawnRecord(block(DRY)), new Date('2026-10-12T20:06:00Z'));
    process.env.GATE_LAWN_REPORT_FACTS = 'true';
    const gated = buildReentryContextFromRecord(lawnRecord(block(DRY)), NOW);
    delete process.env.GATE_LAWN_REPORT_FACTS;
    for (const other of [late, gated]) {
      expect(other.condition).toEqual(early.condition);
      expect(other.customerSummary).toBe(early.customerSummary);
    }
  });

  test('a record with no frozen rule reads exactly as before: the 30 minute clock', () => {
    const ctx = buildReentryContextFromRecord(lawnRecord('{}'), NOW);
    expect(ctx.targets).toHaveLength(1);
    expect(ctx.targets[0]).toMatchObject({ key: 'exterior', durationMin: 30 });
    expect(ctx).not.toHaveProperty('condition');
    expect(ctx.customerSummary).toBe(buildReentrySummary(ctx.targets, NOW, ctx.displayTimezone));
  });

  test('gate on, still no frozen rule: the same clock (a render never reads the gate)', () => {
    const off = buildReentryContextFromRecord(lawnRecord('{}'), NOW);
    process.env.GATE_LAWN_REPORT_FACTS = 'true';
    const on = buildReentryContextFromRecord(lawnRecord('{}'), NOW);
    delete process.env.GATE_LAWN_REPORT_FACTS;
    expect(on).toEqual(off);
  });

  test('the marked default (a product with no usable fact) keeps today\'s clock', () => {
    const ctx = buildReentryContextFromRecord(lawnRecord(block(DEFAULTED)), NOW);
    expect(ctx.targets[0]).toMatchObject({ key: 'exterior', durationMin: 30 });
    expect(ctx).not.toHaveProperty('condition');
  });

  describe('the technician\'s re-entry stepper (still shown, seeds unchanged)', () => {
    const stepper = { exterior_reentry_min: 45, pet_advisory: 'Keep pets off treated turf until dry.', reentry_adjusted: { exterior: true, interior: false } };

    test('on a record that carries a frozen condition the override does not change what the customer sees: the condition wins', () => {
      const plain = buildReentryContextFromRecord(lawnRecord(block(DRY)), NOW);
      const overridden = buildReentryContextFromRecord(lawnRecord(block(DRY), { advisory: stepper }), NOW);
      expect(overridden).toEqual(plain);
      expect(overridden.targets).toEqual([]);
      expect(overridden.customerSummary).toBe(TODAY.dry);
    });

    test('on a default record the override works exactly as on a record with no block', () => {
      const withDefault = buildReentryContextFromRecord(lawnRecord(block(DEFAULTED), { advisory: stepper }), NOW);
      const noBlock = buildReentryContextFromRecord(lawnRecord('{}', { advisory: stepper }), NOW);
      expect(withDefault.targets[0]).toMatchObject({ key: 'exterior', durationMin: 45 });
      expect(withDefault).toEqual(noBlock);
    });
  });

  test('an ADMIN correction after the fact (structured_notes.reentryAdjusted) keeps the minutes and the clock for that record', () => {
    const notes = JSON.stringify({ ...JSON.parse(block(DRY)), reentryAdjusted: true, reentryRev: 1 });
    const ctx = buildReentryContextFromRecord(lawnRecord(notes, { advisory: { exterior_reentry_min: 45, reentry_adjusted: { exterior: true, interior: false } } }), NOW);
    expect(ctx.targets[0]).toMatchObject({ durationMin: 45 });
    expect(ctx).not.toHaveProperty('condition');
  });

  test('a malformed or hand-edited rule is no rule', () => {
    for (const bad of [{ rule: 'dry', source: 'facts', products: [] }, { rule: 'whenever', source: 'facts', products: DRY.products }, 'dry']) {
      const ctx = buildReentryContextFromRecord(lawnRecord(block(bad)), NOW);
      expect(ctx).not.toHaveProperty('condition');
      expect(ctx.targets).toHaveLength(1);
    }
  });
});

describe('every surface reads the condition', () => {
  const dynamicContext = (reentry) => ({ reentry, pressureTrend: undefined });
  const frozenCtx = (rule = DRY) => buildReentryContextFromRecord(lawnRecord(block(rule)), NOW);

  test('the aftercare card: the frozen sentence replaces the label\'s line; with no frozen rule the label stays', () => {
    const apps = [{ product: { reentry_summary: 'Keep people and pets off treated areas until dry.' } }];
    expect(buildAftercare(apps, { reentryText: TODAY.dry }).reentry).toBe(TODAY.dry);
    expect(buildAftercare(apps, {}).reentry).toBe('Keep people and pets off treated areas until dry.');
    expect(buildAftercare(apps, { reentryText: null }).reentry).toBe('Keep people and pets off treated areas until dry.');
    const instruction = { state: 'water_in', lines: ['Run every zone by Fri 8 PM.', 'Rain counts.'], waterInInches: 0.25 };
    expect(buildAftercare(apps, { instruction, reentryText: TODAY.wet }).reentry).toBe(TODAY.wet);
  });

  test('the report email: the summary is the condition, with no ready-at row', () => {
    const data = { serviceLine: 'lawn', applications: [], findings: [], dynamicContext: dynamicContext(frozenCtx(WET)) };
    const email = buildServiceReportV1Email({ reportUrl: 'https://example.test/r', data });
    expect(email.text).toContain(TODAY.wet);
    expect(email.text).not.toMatch(/ready at|Exterior re-entry|Exterior ready/i);
  });

  test('Ask Waves facts: the fixed sentence, no time', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'lawn', applications: [], dynamicContext: dynamicContext(frozenCtx()) }, now: NOW });
    expect(facts.reentry).toEqual([{ area: 'outside', status: TODAY.dry }]);
  });

  test('Ask Waves facts without a condition keep the timed rows', () => {
    const clock = buildReentryContextFromRecord(lawnRecord('{}'), NOW);
    const facts = buildReportAskFacts({ data: { serviceLine: 'lawn', applications: [], dynamicContext: dynamicContext(clock) }, now: NOW });
    expect(facts.reentry).toEqual([expect.objectContaining({ area: 'outside', status: expect.stringMatching(/ready at|dry time has passed/) })]);
  });

  test('the report assistant\'s re-entry answer is the frozen sentence', () => {
    const answer = answerServiceReportQuestion({
      question: 'When can I re-enter the treated areas?',
      data: { serviceLine: 'lawn', pressureIndex: null, applications: [], advisory: { pet_advisory: 'old text' }, dynamicContext: dynamicContext(frozenCtx(WET)) },
    });
    expect(answer).toContain(TODAY.wet);
  });

  test('the AI summary facts carry the same context object', () => {
    const ctx = frozenCtx();
    const facts = buildAiSummaryFacts({ record: lawnRecord(block(DRY)), reentry: ctx, findings: [], applications: [] });
    expect(facts.reentry.customerSummary).toBe(TODAY.dry);
    expect(facts.reentry.targets).toEqual([]);
  });
});
