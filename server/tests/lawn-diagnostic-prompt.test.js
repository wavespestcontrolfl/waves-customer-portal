// Guards the v0.4 "naming gate" intent of the Lawn Diagnostic prompts: a cause is
// named only when its minimum-evidence signature is met; otherwise the finding is a
// symptom at low/unknown confidence, and the customer summary may never upgrade a
// symptom into a named pest/disease. These are deliberate contract markers in the
// system prompts, so assert their presence (not full prose).
const {
  PROMPT_VERSION,
  DIAGNOSIS_SYSTEM_PROMPT,
  NARRATIVE_SYSTEM_PROMPT,
  CURATED_REFERENCE,
  normalizeDiagnosisJson,
} = require('../services/lawn-diagnostic-prompt');

describe('lawn-diagnostic prompt v0.4 naming gate', () => {
  test('prompt version is bumped to v0.4', () => {
    expect(PROMPT_VERSION).toBe('lawn-diagnostic-v0.4');
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
});
