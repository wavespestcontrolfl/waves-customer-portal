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

// Independent-review P1 (round 3, PR #5331, finding 6): the payment-method
// checklist bullet only belongs on a GATE_SMS_REAL_ANSWERS (v12) draft — the
// Payment options / Recent payments facts it references don't exist in a
// gate-off facts block at all. A prior round added it UNCONDITIONALLY,
// changing the gate-off (v11) verifier prompt for every cohort. This hash is
// pinned from buildVerifierSystemPrompt() as it stands on origin/main (re-pinned after the
// PR #5334 LIVE ETA verifier change; this lane's own change leaves it untouched) — the same "pinned hash, not
// gate-unset-vs-gate-false" contract sms-shadow-drafter.test.js already
// enforces for the drafter's own prompt/facts block.
const crypto = require('crypto');
describe('gate-off contract: buildVerifierSystemPrompt() with no args (or {realAnswers:false}) is byte-identical to origin/main', () => {
  test('matches the pinned pre-#5331-round-3 hash', () => {
    const p = buildVerifierSystemPrompt();
    expect(p.length).toBe(3395);
    expect(crypto.createHash('sha256').update(p).digest('hex'))
      .toBe('0d344c10327046f48e38984936097ebe867e084b14c8dc9da16db188b1ee33f3');
    // {realAnswers: false} explicitly must be the SAME byte-identical text —
    // the default parameter and an explicit false must never diverge.
    expect(buildVerifierSystemPrompt({ realAnswers: false })).toBe(p);
    expect(p).not.toMatch(/payment method or contact/i);
    expect(p).not.toMatch(/RECEIPT confirmation/i);
  });
});

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

  test('v5 verifier matches exact date VALUES and flags unverified billing (the v4 residual misses)', () => {
    const p = buildVerifierSystemPrompt();
    // value matching: a date off by a day is a violation, not "close enough"
    expect(p).toMatch(/value matching/i);
    expect(p).toMatch(/even by one day/i);
    expect(p).toMatch(/6\/15.*June 16|June 16.*6\/15/is); // the worked example
    // billing status reassurance not in facts = violation
    expect(p).toMatch(/paid in full/i);
    expect(p).toMatch(/billing is high-stakes|billing status/i);
    // quote-the-source requirement
    expect(p).toMatch(/QUOTE the exact/i);
  });

  test('v6 verifier (real answers on) checks a payment method/contact (Zelle phone/email) against PAYMENT OPTIONS', () => {
    const p = buildVerifierSystemPrompt({ realAnswers: true });
    expect(p).toMatch(/payment method or contact/i);
    expect(p).toMatch(/zelle/i);
    expect(p).toMatch(/Payment options line in BILLING/i);
  });

  // A payment / invoice / refund / balance STATUS is grounded only on a verbatim "Payment status sentences" copy.
  test('real answers on: a payment / invoice / refund / balance STATUS grounds only on a verbatim "Payment status sentences" copy', () => {
    const p = buildVerifierSystemPrompt({ realAnswers: true });
    expect(p).toMatch(/STATUS \(.*"you're all paid up"/i);
    expect(p).toMatch(/word-for-word copy of one "Payment status sentences" line in BILLING/);
    expect(p).toMatch(/adds a method, date, amount or reason the sentence does not state, is a fabrication/);
    expect(p).not.toMatch(/Recent payments/);
  });

  // Codex round-18 P1: COMPANY FACTS ("Paying: technicians accept cards at the visit, never cash. Checks are
  // mailed to <office>") is a second valid source for how-to-pay claims.
  test('real answers on: how-to-pay grounds on Payment options OR the COMPANY FACTS payment policy; an unlisted method stays a fabrication', () => {
    const p = buildVerifierSystemPrompt({ realAnswers: true });
    expect(p).toMatch(/Payment options line in BILLING exactly OR the owner-approved COMPANY FACTS payment policy/);
    expect(p).toMatch(/checks mailed to the office, no cash/);
    expect(p).toMatch(/appears in NEITHER is a fabrication/);
    expect(p).toMatch(/unlisted method[^)]*stays a fabrication/);
    // the facts the rule points at really do carry that policy
    const { renderCompanyFactsSection } = require('../services/sms-company-facts');
    const facts = renderCompanyFactsSection();
    expect(facts).toMatch(/technicians accept cards at the visit, never cash/i);
    expect(facts).toMatch(/Checks are mailed to/);
  });

  test('gate off (real answers not passed): neither payment-method bullet appears', () => {
    const p = buildVerifierSystemPrompt();
    expect(p).not.toMatch(/payment method or contact/i);
    expect(p).not.toMatch(/RECEIPT confirmation/i);
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

describe('verifier — DECLARED OFFERS mapping (PR #5119: the drafter\'s offered_times rides into the verifier user prompt)', () => {
  const { buildVerifierUserPrompt } = require('../services/sms-draft-verifier');
  const base = buildVerifierUserPrompt('FACTS HERE', 'When can you come?', 'How about Tuesday 9:00 AM - 11:00 AM?');

  test('facts WITH an OPEN TIMES section and an empty declaration → the section still appears, declaring "none" (an undeclared offer is then a violation)', () => {
    const facts = 'OPEN TIMES (real, bookable slots, ET — offer ONLY from this list, never invent one):\n- Wednesday, September 30: 9:00 AM - 11:00 AM\n';
    const p = buildVerifierUserPrompt(facts, 'When can you come?', 'You are set for Tuesday 9:00 AM - 11:00 AM.', []);
    expect(p).toContain('DECLARED OFFERS');
    expect(p).toContain('(none — the drafter declares that this draft offers NO new appointment times)');
    expect(p).toMatch(/including ANY offer when the declaration is "none"/);
    expect(buildVerifierUserPrompt(facts, 'When can you come?', 'You are set for Tuesday 9:00 AM - 11:00 AM.')).toBe(p); // omitted == []
  });

  test('a real-answers facts block with NO OPEN TIMES (availability empty/timed out) still gets the section, telling the verifier no time may be offered at all', () => {
    const facts = 'CUSTOMER: x\nFOLLOW-UP SLA RIGHT NOW: within the hour\nBILLING:\n';
    const p = buildVerifierUserPrompt(facts, 'Can you come Tuesday at 9?', 'Sure, Tuesday at 9 works — see you then!', []);
    expect(p).toContain('DECLARED OFFERS');
    expect(p).toContain('NO OPEN TIMES were available for this draft, so it must offer NO appointment time at all');
    expect(p).toMatch(/a time the customer suggested is a request to confirm later, never an offer/);
  });

  test('facts WITHOUT OPEN TIMES or the real-answers marker (gate off): omitted, empty, or malformed offered_times → the prompt is byte-identical to the 3-arg form', () => {
    expect(buildVerifierUserPrompt('FACTS HERE', 'When can you come?', 'How about Tuesday 9:00 AM - 11:00 AM?', [])).toBe(base);
    expect(buildVerifierUserPrompt('FACTS HERE', 'When can you come?', 'How about Tuesday 9:00 AM - 11:00 AM?', 'nope')).toBe(base);
    expect(buildVerifierUserPrompt('FACTS HERE', 'When can you come?', 'How about Tuesday 9:00 AM - 11:00 AM?', [{ date: 'Tuesday' }])).toBe(base);
    expect(base).not.toContain('DECLARED OFFERS');
  });

  test('declared offers are listed verbatim with the day-and-window mapping rule, before the fact-check instruction', () => {
    const p = buildVerifierUserPrompt('FACTS HERE', 'When can you come?', 'How about Tuesday 9:00 AM - 11:00 AM?', [
      { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' },
      { date: 'Wednesday, September 30', window: '2:00 PM - 4:00 PM' },
    ]);
    expect(p).toContain('DECLARED OFFERS');
    expect(p).toContain('- Tuesday, September 29: 9:00 AM - 11:00 AM\n- Wednesday, September 30: 2:00 PM - 4:00 PM');
    expect(p).toMatch(/writes "Wednesday" for a Tuesday declaration/);
    expect(p).toMatch(/restate an already-scheduled visit from UPCOMING SERVICES/);
    expect(p.indexOf('DECLARED OFFERS')).toBeLessThan(p.indexOf('Fact-check the draft now.'));
    expect(p.startsWith(base.slice(0, base.indexOf('Fact-check')))).toBe(true);
  });
});
