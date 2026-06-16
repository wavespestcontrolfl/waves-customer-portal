// CI-safe tests for the Lawn Diagnostic naming-gate eval. The pure scorers
// (evaluateFindings / evaluateNarrative) take no model and no I/O, so they verify the
// scoring logic itself; the orchestration test injects fake deps + a temp fixture dir,
// so nothing here calls the live model.
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  evaluateFindings,
  evaluateNarrative,
  runLawnDiagnosticEval,
} = require('../services/eval/lawn-diagnostic-naming-gate');

const checkPass = (result, name) => result.checks.find((c) => c.name === name)?.pass;

describe('evaluateFindings (naming gate)', () => {
  test('a named cause at moderate+ fails forbidNamedCause; a low differential passes', () => {
    const named = evaluateFindings(
      [{ name: 'Chinch bug pressure', confidence: 'moderate' }],
      { forbidNamedCause: ['chinch'] },
    );
    expect(named.ok).toBe(false);
    expect(checkPass(named, 'forbid-named:chinch')).toBe(false);

    const differential = evaluateFindings(
      [{ name: 'Chinch (differential)', confidence: 'low' }],
      { forbidNamedCause: ['chinch'] },
    );
    expect(checkPass(differential, 'forbid-named:chinch')).toBe(true);
  });

  test('maxConfidence caps the worst finding', () => {
    expect(evaluateFindings([{ name: 'Browning', confidence: 'high' }], { maxConfidence: 'low' }).ok).toBe(false);
    expect(evaluateFindings([{ name: 'Browning', confidence: 'low' }], { maxConfidence: 'low' }).ok).toBe(true);
  });

  test('expectSymptomPrimary requires a symptom name, not a cause', () => {
    expect(checkPass(evaluateFindings([{ name: 'Browning along the sunny edge', confidence: 'low' }], { expectSymptomPrimary: true }), 'symptom-primary')).toBe(true);
    expect(checkPass(evaluateFindings([{ name: 'Chinch bug pressure', confidence: 'low' }], { expectSymptomPrimary: true }), 'symptom-primary')).toBe(false);
  });

  test('allowNamedCause guards against over-correction (signature present → still names it)', () => {
    expect(checkPass(evaluateFindings([{ name: 'Chinch bug pressure', confidence: 'moderate' }], { allowNamedCause: ['chinch'] }), 'names-cause:chinch')).toBe(true);
    expect(checkPass(evaluateFindings([{ name: 'Edge browning', confidence: 'low' }], { allowNamedCause: ['chinch'] }), 'names-cause:chinch')).toBe(false);
  });

  test('requireConfirmationStep and forbidBrandsInWording', () => {
    expect(checkPass(evaluateFindings([{ name: 'Browning', confidence: 'low', confirmation_step: 'cut-and-pull test' }], { requireConfirmationStep: true }), 'confirmation-step')).toBe(true);
    expect(checkPass(evaluateFindings([{ name: 'Browning', confidence: 'low' }], { requireConfirmationStep: true }), 'confirmation-step')).toBe(false);
    expect(checkPass(evaluateFindings([{ name: 'Weed pressure', confidence: 'low', customer_wording: 'We applied Talstar P.' }], { forbidBrandsInWording: true }), 'no-brands-in-wording')).toBe(false);
  });
});

describe('evaluateNarrative (naming gate)', () => {
  test('forbids naming a below-threshold cause, brands, and overpromises', () => {
    const bad = evaluateNarrative('We confirmed chinch and applied Talstar — results guaranteed.', {
      forbidNamedCause: ['chinch'], forbidBrands: true, forbidOverpromise: true, nonEmpty: true,
    });
    expect(bad.ok).toBe(false);
    expect(checkPass(bad, 'narrative-no-named:chinch')).toBe(false);
    expect(checkPass(bad, 'narrative-no-brands')).toBe(false);
    expect(checkPass(bad, 'narrative-no-overpromise')).toBe(false);

    const good = evaluateNarrative('We saw browning along the sunny edge and treated it as suspected insect pressure; we will re-check the area.', {
      forbidNamedCause: ['chinch'], forbidBrands: true, forbidOverpromise: true, nonEmpty: true,
    });
    expect(good.ok).toBe(true);
  });
});

describe('runLawnDiagnosticEval orchestration (injected deps, temp fixtures)', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawn-eval-'));
    fs.mkdirSync(path.join(dir, 'photos'));
    fs.writeFileSync(path.join(dir, 'photos', 'present.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({
      promptVersion: 'lawn-diagnostic-v0.4',
      cases: [
        { id: 'has-photo', photos: ['present.png'], expect: { forbidNamedCause: ['chinch'], expectSymptomPrimary: true } },
        { id: 'no-photo', photos: ['missing.jpg'], expect: { forbidNamedCause: ['chinch'] } },
      ],
    }));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('scores cases with photos, skips those without, and computes pass-rate over scored only', async () => {
    const deps = {
      runDiagnosis: async () => ({ ok: true, findings: [{ name: 'Browning along the edge', confidence: 'low' }] }),
      runNarrative: async () => ({ ok: true, customer_summary: 'ok' }),
      buildDiagnosticReportContract: () => ({}),
    };
    const summary = await runLawnDiagnosticEval({ fixtureDir: dir, deps });
    const byId = Object.fromEntries(summary.results.map((r) => [r.id, r.status]));
    expect(byId['has-photo']).toBe('pass');
    expect(byId['no-photo']).toBe('skipped');
    expect(summary.scored).toBe(1);
    expect(summary.passRate).toBe(1);
  });

  test('a fail-then-pass case is reported as flaky (retry-once), not fail', async () => {
    let calls = 0;
    const deps = {
      runDiagnosis: async () => {
        calls += 1;
        return calls === 1
          ? { ok: true, findings: [{ name: 'Chinch bug pressure', confidence: 'moderate' }] } // violates the gate
          : { ok: true, findings: [{ name: 'Edge browning', confidence: 'low' }] };            // clean on retry
      },
      runNarrative: async () => ({ ok: true, customer_summary: 'ok' }),
      buildDiagnosticReportContract: () => ({}),
    };
    const summary = await runLawnDiagnosticEval({ caseId: 'has-photo', fixtureDir: dir, deps });
    expect(summary.results[0].status).toBe('flaky');
    expect(calls).toBe(2);
  });
});
