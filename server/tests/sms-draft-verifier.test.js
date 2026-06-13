/**
 * SMS draft verifier (brand-voice loop, drafter v3 convergence loop) —
 * pure prompt + parse coverage. No DB, no LLM.
 */
const {
  buildVerifierSystemPrompt,
  buildVerifierUserPrompt,
  parseVerifierResponse,
  buildReviseAddendum,
} = require('../services/sms-draft-verifier');

describe('verifier — prompt contract', () => {
  test('system prompt enumerates the fabrication classes and pins JSON output', () => {
    const p = buildVerifierSystemPrompt();
    expect(p).toMatch(/arrival window/i);
    expect(p).toMatch(/technician name/i);
    expect(p).toMatch(/found, caught, treated/i);
    expect(p).toMatch(/billing event/i);
    // acknowledgments/deferrals must NOT be treated as violations
    expect(p).toMatch(/confirm.{0,8}follow up are fine/i);
    expect(p).toContain('"supported"');
    expect(p).toContain('"violations"');
  });

  test('v4 verifier is skeptical by default and grounds the literal-only customer source', () => {
    const p = buildVerifierSystemPrompt();
    // skeptical default — must not give the draft the benefit of the doubt
    expect(p).toMatch(/default to flagging/i);
    expect(p).toMatch(/skeptical|UNSAFE unless/i);
    // literal-only customer source — the exact failures it must now catch
    expect(p).toMatch(/literally wrote|literal words/i);
    expect(p).toMatch(/flying bugs/i);   // spiders ≠ flying bugs
    expect(p).toMatch(/pickup/i);        // a name ≠ a pickup request
  });

  test('user prompt carries facts, the customer message, and the draft under check', () => {
    const p = buildVerifierUserPrompt(
      'NEXT SERVICE: Quarterly Pest Friday, Jun 19',
      'Can you come at 3pm instead?',
      'See you Tuesday at 2 PM!'
    );
    expect(p).toContain('NEXT SERVICE: Quarterly Pest Friday, Jun 19');
    // the inbound must be visible so a draft referencing the customer's own
    // stated detail isn't wrongly flagged as fabricated (Codex P1)
    expect(p).toContain('Can you come at 3pm instead?');
    expect(p).toContain('See you Tuesday at 2 PM!');
  });

  test('the customer message is still a valid source — just literal-only', () => {
    // The Codex-P1 fix (verifier sees the inbound) must survive the v4
    // tightening: the customer's words still ground the draft, but only what
    // they literally said.
    const p = buildVerifierSystemPrompt();
    expect(p).toMatch(/customer.{0,30}LITERALLY wrote/i);
  });
});

describe('verifier — verdict parsing (fails safe)', () => {
  test('clean verdict: supported only when true AND no violations', () => {
    expect(parseVerifierResponse('{"supported":true,"violations":[]}')).toEqual({ supported: true, violations: [] });
  });

  test('violations present → not supported, even if model also said supported:true', () => {
    const v = parseVerifierResponse('{"supported":true,"violations":["invents a 2 PM arrival"]}');
    expect(v.supported).toBe(false);
    expect(v.violations).toEqual(['invents a 2 PM arrival']);
  });

  test('explicit unsupported with a list', () => {
    const v = parseVerifierResponse('{"supported":false,"violations":["names tech Adam","invents Tuesday"]}');
    expect(v.supported).toBe(false);
    expect(v.violations).toHaveLength(2);
  });

  test('fenced and prose-embedded verdicts are recovered', () => {
    expect(parseVerifierResponse('```json\n{"supported":true,"violations":[]}\n```').supported).toBe(true);
    expect(parseVerifierResponse('Here: {"supported":false,"violations":["x"]} done').supported).toBe(false);
  });

  test('missing/ambiguous supported flag fails safe to not-supported', () => {
    // no 'supported' key, no violations → cannot confirm clean → false
    expect(parseVerifierResponse('{"violations":[]}').supported).toBe(false);
    expect(parseVerifierResponse('{"supported":"yes","violations":[]}').supported).toBe(false);
  });

  test('any flagged violation shape with supported:true still fails safe (Codex P2 + P2-r2)', () => {
    // The model can slip the schema several ways; none may wave a draft
    // through as converged when it clearly flagged something.
    // (a) bare string
    let v = parseVerifierResponse('{"supported":true,"violations":"invents a 9am arrival"}');
    expect(v.supported).toBe(false);
    expect(v.violations).toEqual(['invents a 9am arrival']);
    // (b) array of objects — the common slip; extract the claim text
    v = parseVerifierResponse('{"supported":true,"violations":[{"claim":"invents 9am"},{"violation":"names Adam"}]}');
    expect(v.supported).toBe(false);
    expect(v.violations).toEqual(['invents 9am', 'names Adam']);
    // (c) array of junk we can't read → not supported, placeholder kept
    v = parseVerifierResponse('{"supported":true,"violations":[42, {}]}');
    expect(v.supported).toBe(false);
    expect(v.violations.length).toBeGreaterThan(0);
    // (d) non-empty object
    expect(parseVerifierResponse('{"supported":true,"violations":{"x":1}}').supported).toBe(false);
    // clean pass still works: explicit true + empty array
    expect(parseVerifierResponse('{"supported":true,"violations":[]}').supported).toBe(true);
  });

  test('unusable payloads return null (loop treats as inconclusive, stops)', () => {
    expect(parseVerifierResponse('')).toBeNull();
    expect(parseVerifierResponse(null)).toBeNull();
    expect(parseVerifierResponse('not json')).toBeNull();
  });

  test('non-string violation entries are dropped and entries are length-capped', () => {
    const v = parseVerifierResponse(JSON.stringify({ supported: false, violations: ['ok', 42, '', 'y'.repeat(300)] }));
    expect(v.violations).toHaveLength(2);
    expect(v.violations[1]).toHaveLength(200);
  });
});

describe('verifier — revise addendum', () => {
  test('lists the violations and re-states the deferral instruction', () => {
    const a = buildReviseAddendum(['invents a 2 PM arrival', "names tech 'Adam'"]);
    expect(a).toContain('- invents a 2 PM arrival');
    expect(a).toContain("- names tech 'Adam'");
    expect(a).toMatch(/do NOT invent/i);
    expect(a).toMatch(/confirm and get right back/i);
  });
});
