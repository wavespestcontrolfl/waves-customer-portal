/**
 * Public lead webhook — the quiz pages' answers.
 *
 * The site's two quiz pages post the shared quote form's lead with an extra
 * `quiz` object ({ kind, seeing, property }) and the existing `timeline`.
 *  - buildLeadWebhookIntake reduces `quiz` to allowlisted tokens;
 *  - "Business" marks the lead commercial through the readiness gate, so no
 *    residential draft is priced for it;
 *  - the answers ride on extracted_data.quiz (kept when the AI triage
 *    replaces extracted_data, and never replaced by a model-returned key),
 *    both Customer 360 notes, the unverified hold and the new-lead bell.
 */

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { _test } = require('../routes/lead-webhook');
const { evaluateLeadEstimateAutomationReadiness } = require('../services/lead-estimate-automation');

const { buildLeadWebhookIntake, commercialLeadFields, TRIAGE_REPLACE_EXTRACTED_SQL, triageExtractedForWrite } = _test;

const quizBody = (extra = {}) => ({
  name: 'Pat Sample',
  phone: '(941) 555-0123',
  email: 'pat.sample@example.com',
  address: '4516 Greenbrook Dr, Bradenton, FL 34203',
  interest: 'pest',
  specific_service: 'cockroach_control',
  service_interest: 'Cockroach Control',
  timeline: 'now',
  quiz: { kind: 'pest', seeing: 'roaches', property: 'condo' },
  source: 'astro-pest-quiz',
  ...extra,
});

describe('buildLeadWebhookIntake', () => {
  test('carries the allowlisted quiz answers beside the declared timeline', () => {
    const intake = buildLeadWebhookIntake(quizBody());
    expect(intake.quiz).toEqual({ kind: 'pest', seeing: 'roaches', property: 'condo' });
    expect(intake.timeline).toBe('now');
    expect(intake.serviceInterest).toBe('Cockroach Control');
    expect(intake.isCommercial).toBeUndefined();
  });

  test('a form with no quiz, or a malformed one, has none', () => {
    expect(buildLeadWebhookIntake(quizBody({ quiz: undefined })).quiz).toBeNull();
    expect(buildLeadWebhookIntake(quizBody({ quiz: 'pest' })).quiz).toBeNull();
    expect(buildLeadWebhookIntake(quizBody({ quiz: { kind: 'tree' } })).quiz).toBeNull();
  });

  test('the quiz never changes the parsed name, phone, address, service or message', () => {
    const withQuiz = buildLeadWebhookIntake(quizBody());
    const without = buildLeadWebhookIntake(quizBody({ quiz: undefined }));
    for (const key of ['firstName', 'lastName', 'rawPhone', 'email', 'fullAddress', 'serviceInterest', 'message', 'formName']) {
      expect(withQuiz[key]).toEqual(without[key]);
    }
  });

  describe('"Business" on the property question', () => {
    const prev = process.env.GATE_UNIT_SCOPE_GUARDRAILS;
    beforeEach(() => { process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true'; });
    afterEach(() => {
      if (prev === undefined) delete process.env.GATE_UNIT_SCOPE_GUARDRAILS;
      else process.env.GATE_UNIT_SCOPE_GUARDRAILS = prev;
    });
    const readinessFor = (body) => {
      const intake = buildLeadWebhookIntake(body);
      return evaluateLeadEstimateAutomationReadiness({ intake, body, phone: '+19415550123', serviceInterest: intake.serviceInterest });
    };

    test('marks the lead commercial and blocks the residential draft', () => {
      const body = quizBody({ quiz: { kind: 'pest', seeing: 'roaches', property: 'business' } });
      expect(buildLeadWebhookIntake(body).isCommercial).toBe(true);
      const readiness = readinessFor(body);
      expect(readiness.ready).toBe(false);
      expect(readiness.missing).toContain('commercial_category_conflict');
      expect(commercialLeadFields(readiness)).toEqual({ is_commercial: true, is_residential: false });
    });

    test('a house, townhome or condo stays residential', () => {
      for (const property of ['house', 'townhome', 'condo']) {
        const readiness = readinessFor(quizBody({ quiz: { kind: 'pest', seeing: 'roaches', property } }));
        expect(readiness.missing).not.toContain('commercial_category_conflict');
        expect(commercialLeadFields(readiness)).toEqual({});
      }
    });
  });
});

describe('route wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/lead-webhook.js'), 'utf8');

  test('the lead record stores the quiz answers in extracted_data', () => {
    const stage = src.slice(src.indexOf('const webhookStageBase = {'));
    expect(stage.slice(0, stage.indexOf('\n    };'))).toMatch(/\.\.\.\(quiz \? \{ quiz \} : \{\}\),/);
  });

  test('the AI triage replace carries the quiz, and a model-returned quiz key is dropped first', () => {
    const carried = "'quiz', COALESCE(extracted_data, '{}'::jsonb)->'quiz'";
    const triageAt = TRIAGE_REPLACE_EXTRACTED_SQL.indexOf("|| ((?::jsonb - 'attribution') - 'source_evidence') ||");
    expect(TRIAGE_REPLACE_EXTRACTED_SQL.indexOf(carried)).toBeGreaterThan(-1);
    expect(triageAt).toBeGreaterThan(TRIAGE_REPLACE_EXTRACTED_SQL.indexOf(carried));
    const triage = src.slice(src.indexOf('if (triageResult.extractedData) {'));
    const block = triage.slice(0, triage.indexOf('if (Object.keys(updates).length > 0)'));
    expect(block).toMatch(/const safeTriageExtracted = triageExtractedForWrite\(triageResult\.extractedData\);/);
    // Both branches write the stripped object, never the raw triage output.
    expect(block.match(/JSON\.stringify\(safeTriageExtracted\)/g)).toHaveLength(2);
    expect(block).not.toMatch(/JSON\.stringify\(triageResult\.extractedData\)/);
  });

  test('a model-returned quiz, timeline or source_evidence never reaches a triage write', () => {
    // The third quiz answer is `timeline`, and leads.urgency is set from the
    // declared one: a model value would leave the two in disagreement.
    expect(triageExtractedForWrite({
      summary: 'Roaches in a condo',
      timeline: 'browsing',
      quiz: { kind: 'lawn', seeing: 'weeds', property: 'house' },
      source_evidence: { kind: 'google_ads' },
      pest_type: 'roaches',
    })).toEqual({ summary: 'Roaches in a condo', pest_type: 'roaches' });
    // Nothing else is touched, and the input is not mutated.
    const triage = { summary: 's', timeline: 'now' };
    expect(triageExtractedForWrite(triage)).toEqual({ summary: 's' });
    expect(triage).toEqual({ summary: 's', timeline: 'now' });
    expect(triageExtractedForWrite({})).toEqual({});
  });

  test('both Customer 360 notes carry the quiz line', () => {
    const existing = src.slice(src.indexOf("subject: 'Form submission (existing customer)'"));
    expect(existing.slice(0, existing.indexOf('metadata:'))).toMatch(/\(quizNote \? `\\n\$\{quizNote\}` : ''\)/);
    const fresh = src.slice(src.indexOf('subject: `New lead from ${leadSource.detail || leadSource.source}`'));
    expect(fresh.slice(0, fresh.indexOf('metadata:'))).toMatch(/\$\{quizNote \? `\$\{quizNote\}\. ` : ''\}/);
  });

  test('the new-lead bell names the quiz and its answers; the lead keeps its real source row', () => {
    const bell = src.slice(src.indexOf("await triggerNotification('new_lead', {"));
    const block = bell.slice(0, bell.indexOf('});'));
    expect(block).toMatch(/source: quizName\(quiz\) \|\| leadSource\.detail \|\| leadSource\.source,/);
    expect(block).toMatch(/\.\.\.\(quizAnswers \? \{ quizAnswers, quizNamesProblem: quizNamesProblem\(quiz\) \} : \{\}\),/);
    expect(src).toMatch(/lead_source_id: leadSourceId,/);
  });
});

describe('the unverified hold keeps the quiz answers', () => {
  test('the held stage stores them like the verified path', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/lead-unverified-hold.js'), 'utf8');
    const stage = src.slice(src.indexOf('const stage = {'));
    expect(stage.slice(0, stage.indexOf('\n  };'))).toMatch(/\.\.\.\(intake\.quiz \? \{ quiz: intake\.quiz \} : \{\}\),/);
  });
});
