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
    expect(p).toMatch(/confirm or follow up are NOT violations/i);
    expect(p).toContain('"supported"');
    expect(p).toContain('"violations"');
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

  test('system prompt treats the customer message as a valid fact source', () => {
    expect(buildVerifierSystemPrompt()).toMatch(/customer'?s own current message is also a valid source/i);
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
