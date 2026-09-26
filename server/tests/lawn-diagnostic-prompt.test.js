// Guards the v0.4 "naming gate" intent of the Lawn Diagnostic prompts: a cause is
// named only when its minimum-evidence signature is met; otherwise the finding is a
// symptom at low/unknown confidence, and the customer summary may never upgrade a
// symptom into a named pest/disease. These are deliberate contract markers in the
// system prompts, so assert their presence (not full prose).
const {
  PROMPT_VERSION,
  DIAGNOSIS_SYSTEM_PROMPT,
  CHALLENGE_SYSTEM_PROMPT,
  PERCEPTION_PROMPT,
  NARRATIVE_SYSTEM_PROMPT,
  CURATED_REFERENCE,
  normalizeDiagnosisJson,
} = require('../services/lawn-diagnostic-prompt');

describe('lawn-diagnostic prompt v0.5 naming gate', () => {
  test('prompt version is bumped to v0.5', () => {
    expect(PROMPT_VERSION).toBe('lawn-diagnostic-v0.5');
  });

  test('perception prompt observes only — it forbids naming/concluding a cause', () => {
    expect(PERCEPTION_PROMPT).toMatch(/Report ONLY what is visually present/);
    expect(PERCEPTION_PROMPT).toMatch(/do NOT\s+diagnose, name a pest\/disease\/weed species, or assign a cause/);
    expect(PERCEPTION_PROMPT).toMatch(/Describe, never conclude/);
  });

  test('challenge prompt is adversarial and enforces the NAME GATE on the observations', () => {
    expect(CHALLENGE_SYSTEM_PROMPT).toMatch(/SKEPTICAL/);
    expect(CHALLENGE_SYSTEM_PROMPT).toMatch(/What ELSE could explain/);
    expect(CHALLENGE_SYSTEM_PROMPT).toMatch(/What CANNOT be determined/);
    expect(CHALLENGE_SYSTEM_PROMPT).toMatch(/NAME GATE:/);
    expect(CHALLENGE_SYSTEM_PROMPT).toMatch(/Required signature is present IN THE\s+OBSERVATIONS/);
  });

  test('curated reference states a hard naming gate with per-cause Required evidence', () => {
    expect(CURATED_REFERENCE).toMatch(/NAMING GATE \(hard\)/);
    // Every curated cause carries an explicit minimum-evidence "Required:" clause.
    const requiredClauses = (CURATED_REFERENCE.match(/Required:/g) || []).length;
    expect(requiredClauses).toBeGreaterThanOrEqual(6);
  });

  test('diagnosis prompt enforces the NAME GATE in the confidence rubric', () => {
    expect(DIAGNOSIS_SYSTEM_PROMPT).toMatch(/NAME GATE:/);
    expect(DIAGNOSIS_SYSTEM_PROMPT).toMatch(/Required signature/);
    // Symptom-vs-cause false-precision rule is shared into the diagnosis pass.
    expect(DIAGNOSIS_SYSTEM_PROMPT).toMatch(/low\/unknown finding is a\s+symptom, never a named pest/);
  });

  test('narrative prompt forbids upgrading a low/unknown symptom into a named cause', () => {
    expect(NARRATIVE_SYSTEM_PROMPT).toMatch(/Naming discipline:/);
    expect(NARRATIVE_SYSTEM_PROMPT).toMatch(/never upgrade a\s+symptom into a named cause/);
  });

  test('normalizeDiagnosisJson keeps only object findings and defaults the summary', () => {
    const out = normalizeDiagnosisJson({ findings: [{ name: 'weed pressure' }, null, 'x', 7] });
    expect(out.findings).toEqual([{ name: 'weed pressure' }]);
    expect(out.customer_summary).toBe('');
    expect(normalizeDiagnosisJson({}).findings).toEqual([]);
  });

  // Finding-level contract gate (Codex reviewer finding on #4884): a finding
  // missing `name`, or carrying a present-but-off-contract confidence /
  // severity / urgency, must be dropped rather than defaulted downstream
  // into "Unspecified lawn finding" / unknown / moderate.
  describe('normalizeDiagnosisJson finding-level contract gate', () => {
    test('drops a finding with no name', () => {
      const out = normalizeDiagnosisJson({ findings: [{}] });
      expect(out.findings).toEqual([]);
      expect(out.droppedFindings).toBe(1);
    });

    test('drops a finding whose name is not a string (e.g. an object)', () => {
      const out = normalizeDiagnosisJson({ findings: [{ name: { x: 1 }, confidence: 'certain', severity: 'critical' }] });
      expect(out.findings).toEqual([]);
      expect(out.droppedFindings).toBe(1);
    });

    test('drops a finding with an off-contract confidence, severity, or urgency', () => {
      expect(normalizeDiagnosisJson({ findings: [{ name: 'Browning', confidence: 'certain' }] }).findings).toEqual([]);
      expect(normalizeDiagnosisJson({ findings: [{ name: 'Browning', severity: 'critical' }] }).findings).toEqual([]);
      expect(normalizeDiagnosisJson({ findings: [{ name: 'Browning', urgency: 'asap' }] }).findings).toEqual([]);
    });

    test('keeps a finding whose optional confidence/severity/urgency are simply absent', () => {
      const out = normalizeDiagnosisJson({ findings: [{ name: 'Browning along the edge' }] });
      expect(out.findings).toEqual([{ name: 'Browning along the edge' }]);
      expect(out.droppedFindings).toBe(0);
    });

    test('keeps on-contract findings and reports the drop count when mixed with malformed ones', () => {
      const out = normalizeDiagnosisJson({
        findings: [
          { name: 'Browning along the edge', confidence: 'low', severity: 'mild', urgency: 'monitor' },
          { name: '   ' }, // blank name
          { confidence: 'high' }, // no name at all
        ],
      });
      expect(out.findings).toEqual([{ name: 'Browning along the edge', confidence: 'low', severity: 'mild', urgency: 'monitor' }]);
      expect(out.droppedFindings).toBe(2);
    });
  });
});

// The finding-level gate accepts exactly what lawn-diagnostic-report.js's
// normalizers read correctly — synonyms and case included — and only drops
// values they would rewrite to a default (review on #4884).
describe('normalizeDiagnosisJson keeps findings the report normalizers read correctly', () => {
  const { normalizeDiagnosisJson } = require('../services/lawn-diagnostic-prompt');
  test.each([
    ['confidence "Medium" / severity "High"', { name: 'Chinch bugs', confidence: 'Medium', severity: 'High' }],
    ['severity "minor"', { name: 'Dollar spot', severity: 'minor' }],
    ['urgency "Follow up" and a null confidence', { name: 'Brown patch', urgency: 'Follow up', confidence: null }],
  ])('%s is kept', (_label, finding) => {
    const out = normalizeDiagnosisJson({ findings: [finding] });
    expect(out.findings).toHaveLength(1);
    expect(out.droppedFindings).toBe(0);
  });

  test('severity "critical" (the report would silently rewrite it to moderate) is dropped', () => {
    const out = normalizeDiagnosisJson({ findings: [{ name: 'Grubs', severity: 'critical' }, { name: 'Chinch bugs' }] });
    expect(out.findings.map((f) => f.name)).toEqual(['Chinch bugs']);
    expect(out.droppedFindings).toBe(1);
  });
});

// Codex r17 on #4884: every other field the report normalizer reads must be
// absent or text — an object confirmation_step crashed the tech diagnostic
// page (rendered as a React child) and object evidence items became
// "[object Object]".
describe('normalizeDiagnosisJson checks every field the report reads', () => {
  const { normalizeDiagnosisJson } = require('../services/lawn-diagnostic-prompt');
  const FULL = {
    finding_id: 'F1', name: 'Chinch bugs', confidence: 'moderate', severity: 'moderate', spread_risk: 'high',
    estimated_area_affected: '10-25%', urgency: 'follow_up', observed_evidence: ['yellowing patches'],
    inferred_context: ['hot, dry week'], negative_evidence: ['no fungal lesions'],
    confirmation_step: 'Flotation test at the patch edge', customer_wording: 'We may be seeing chinch bug activity.',
  };

  test('a full on-contract finding is kept', () => {
    expect(normalizeDiagnosisJson({ findings: [FULL] })).toMatchObject({ findings: [FULL], droppedFindings: 0 });
  });

  test.each([
    ['an object confirmation_step', { confirmation_step: {} }],
    ['an object customer_wording', { customer_wording: { text: 'x' } }],
    ['an object estimated_area_affected', { estimated_area_affected: { pct: 10 } }],
    ['an object evidence item', { observed_evidence: ['patches', { where: 'front' }] }],
    ['an object as the whole evidence list', { negative_evidence: { none: true } }],
    ['an off-enum spread_risk', { spread_risk: 'viral' }],
    ['an object camelCase alias', { confirmationStep: { step: 'x' } }],
  ])('%s drops the finding', (_label, extra) => {
    expect(normalizeDiagnosisJson({ findings: [{ ...FULL, ...extra }] })).toMatchObject({ findings: [], droppedFindings: 1 });
  });

  test('a single-string evidence value, null fields, and a numeric id are still read correctly', () => {
    const out = normalizeDiagnosisJson({ findings: [{ ...FULL, finding_id: 1, observed_evidence: 'yellowing', confirmation_step: null, spread_risk: 'Medium' }] });
    expect(out.droppedFindings).toBe(0);
  });
});
