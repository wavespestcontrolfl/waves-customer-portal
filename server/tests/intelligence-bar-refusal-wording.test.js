/**
 * Refusal wording in the Intelligence Bar tools (owner 2026-10-20).
 *
 * The owner-direct prompt says "never send the owner to another screen", but
 * tool refusals used to end "... from the Invoices page" and the model relayed
 * them. A refusal now says what the bar cannot do from here, in a phrase the gap
 * reporter's BAR_DECLINE_RE matches, so the gap list records it. A refusal the
 * owner ruled stays on its screen carries code `by_owner_rule` instead, and the
 * gap reporter never records it. No DB, no network.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const gapReports = require('../services/agent-gap-reports');

const { BAR_DECLINE_RE, DECLINE_RE, BY_DESIGN_REFUSAL_CODES, recordableRefusalCode } = gapReports._private;

const DIR = path.join(__dirname, '..', 'services', 'intelligence-bar');
const FILES = [
  'invoice-action-tools.js',
  'closeout-repair-tools.js',
  'reprice-visits-tools.js',
  'schedule-tools.js',
  'tools.js',
  'estimate-accept-tools.js',
  'customer-link-tools.js',
  'comms-tools.js',
  'billing-mode-change.js',
  'customer-lifecycle-tools.js',
  'review-tools.js',
  'void-invoice-tools.js',
  'billing-reader-tools.js',
  'ops-tools.js',
  'outcomes.js',
  'routes/admin-intelligence-bar.js',
];
const fullPath = (file) => (file.startsWith('routes/') ? path.join(__dirname, '..', file) : path.join(DIR, file));

// A string that sends the reader to another place to do the work: the gap
// reporter's own "other screen" classifier, plus the named screens that had no
// "page" or "screen" word after them.
const OTHER_SCREEN_RE = /\b(?:use|on|from|in|via|at) (?:the )?[\w' -]{0,40}?\b(?:screen|page|queue)\b/i;
const NAMED_SCREEN_RE = /\bfrom (?:Dispatch|Billing Recovery|Communications|the project)\b/i;
const BY_OWNER_RULE_TEXT = "by the owner's rule";
const REFUSAL_CONTEXT_ONLY = new Set(['routes/admin-intelligence-bar.js', 'customer-lifecycle-tools.js', 'billing-mode-change.js', 'comms-tools.js', 'review-tools.js', 'billing-reader-tools.js', 'ops-tools.js']);

const PLACE = String.raw`(?:screen|page|Dispatch|queue|modal|editor|dashboard|composer)`;
const DESCRIPTION_REDIRECT_RE = new RegExp(
  String.raw`\b(?:send|do|book|move|cancel|change|accept|mark|resolve|bill|post|text|fix|handle|finish|open|use|go|point|refer|direct|require)\b[^.;]{0,50}?\b(?:from|on|in|at|to|via|through|requires?) (?:the |another |a )?[\w'" -]{0,30}?\b${PLACE}\b`
  + String.raw`|\brequires? (?:the )?[\w' -]{0,20}?\b${PLACE}\b|\bcheck (?:it |them )?(?:on |in )?the [\w' -]{0,30}?\b(?:page|screen)\b`, 'i');
// "do not send the operator to the Invoices page" names a screen to forbid it.
const NEGATED_REDIRECT = /\b(?:do not|don't|never|not)\b[^.;]{0,30}\b(?:send|point|tell|direct|refer)\b[^.;]{0,60}/gi;

// Facts about a page the customer sees or a card, not a place the operator is
// sent to. Each is matched as a substring of the string.
const NOT_A_REFUSAL = [
  'the customer saves a payment method on the page', // the Auto Pay link card
  'regroup from Dispatch if needed', // the address-change card's effects line
  "is on the operator's screen", // the name matcher's ranking note (match.reasons), not a redirect
];

function stringsOf(file) {
  const source = fs.readFileSync(fullPath(file), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 2022, locations: true, allowHashBang: true });
  const found = [];
  // The route and the large tool files also hold prompts and card text, so for
  // them only a string inside a refusal counts: an `error` / `refused` property,
  // the argument of refuse() / refusal(), or a *_REFUSAL / *_MESSAGE constant.
  const refusalOnly = REFUSAL_CONTEXT_ONLY.has(file);
  const walk = (node, parent, inRefusal = false, inDescription = false) => {
    if (!node || typeof node.type !== 'string') return;
    let here = inRefusal;
    const describing = inDescription || (node.type === 'Property' && node.key && (node.key.name === 'description' || node.key.value === 'description'));
    if (node.type === 'Property' && node.key && ['error', 'refused'].includes(node.key.name || node.key.value)) here = true;
    if (node.type === 'CallExpression' && node.callee && ['refuse', 'refusal'].includes(node.callee.name)) here = true;
    if (node.type === 'VariableDeclarator' && node.id && /(REFUSAL|MESSAGE)$/.test(node.id.name || '')) here = true;
    let text = null;
    if (node.type === 'Literal' && typeof node.value === 'string') text = node.value;
    if (node.type === 'TemplateLiteral') text = node.quasis.map((q) => q.value.cooked).join('${}');
    if (text !== null && (describing || here || !refusalOnly)) found.push({ text, line: node.loc.start.line, description: describing });
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => walk(child, node, here, describing));
      else if (value && typeof value.type === 'string') walk(value, node, here, describing);
    }
  };
  walk(ast, null);
  return found;
}

describe('refusal wording: no tool refusal sends the operator to another screen as the answer', () => {
  test.each(FILES)('%s: every string that points to a screen says the bar cannot, or cites the owner rule', (file) => {
    const offenders = stringsOf(file)
      .filter(({ description }) => !description)
      .filter(({ text }) => OTHER_SCREEN_RE.test(text) || NAMED_SCREEN_RE.test(text))
      .filter(({ text }) => !NOT_A_REFUSAL.some((fact) => text.includes(fact)))
      .filter(({ text }) => !BAR_DECLINE_RE.test(text) && !text.toLowerCase().includes(BY_OWNER_RULE_TEXT))
      .map(({ text, line }) => `${file}:${line} ${text.slice(0, 120)}`);
    expect(offenders).toEqual([]);
  });

  // A tool description is model-visible. It may NAME a screen as a fact ("as the
  // Invoices page Send does"), but it must not tell the model to send the
  // operator there: say what the bar cannot do yet, or cite the owner's rule.
  test.each(FILES)('%s: no tool description tells the model to send the operator to a screen', (file) => {
    const offenders = stringsOf(file)
      .filter(({ description }) => description)
      .flatMap(({ text, line }) => text.replace(NEGATED_REDIRECT, ' ').split(/(?<=[.;])\s+/)
        .filter((sentence) => DESCRIPTION_REDIRECT_RE.test(sentence) && !sentence.toLowerCase().includes(BY_OWNER_RULE_TEXT))
        .map((sentence) => `${file}:${line} ${sentence.slice(0, 140)}`));
    expect(offenders).toEqual([]);
  });

  test('the description check catches the old redirect wording', () => {
    for (const old of [
      'When the tool refuses, relay the reason and point the operator to the Dispatch screen; never say',
      'no usable phone (send it from the Invoices page), a customer whose invoices',
      'a billing change the bar never makes — do that from the Customers page.',
      'and "needs reconciliation — check the Invoices page" when a charge state is unresolved',
      'Recurrence templates require the Dispatch editor.',
    ]) {
      expect(DESCRIPTION_REDIRECT_RE.test(old.replace(NEGATED_REDIRECT, ' '))).toBe(true);
    }
    expect(DESCRIPTION_REDIRECT_RE.test('use resend_receipt (it shows a card; do not send the operator to the Invoices page)'.replace(NEGATED_REDIRECT, ' '))).toBe(false);
  });

  test('a refusal the owner ruled stays on its screen carries by_owner_rule, which the gap list skips', () => {
    expect(BY_DESIGN_REFUSAL_CODES.has('by_owner_rule')).toBe(true);
    const ruled = { error: "A billing change that stays on the Customers page by the owner's rule.", code: 'by_owner_rule', rule: 'saved_method_available' };
    expect(recordableRefusalCode(ruled)).toBeNull();
  });

  test('cancelling a visit with an invoice, credit or linked visit is a capability gap, not an owner rule', () => {
    const { CARD_CANCEL_REFUSED_MESSAGE } = require('../services/intelligence-bar/tools');
    expect(BAR_DECLINE_RE.test(CARD_CANCEL_REFUSED_MESSAGE)).toBe(true);
    expect(CARD_CANCEL_REFUSED_MESSAGE).not.toContain(BY_OWNER_RULE_TEXT);
    const refused = { error: CARD_CANCEL_REFUSED_MESSAGE, code: 'cancel_with_effects_unsupported' };
    expect(recordableRefusalCode(refused)).toBe('cancel_with_effects_unsupported');
  });
});

describe('refusal wording: the gap reporter records a "the bar cannot" refusal', () => {
  const declines = [
    ['an annual-plan invoice', { error: "This is an annual-plan invoice, and the bar can't send those from here yet.", code: 'annual_plan_invoice' }],
    ['a grouped estimate', { error: "This estimate is part of a group, and the bar can't accept a grouped estimate from here yet. Nothing was changed.", code: 'grouped_estimate' }],
    ['a package visit 2 move', { error: "The bar can't move it from here yet. Nothing was changed.", code: 'package_visit_two_linked' }],
  ];

  test.each(declines)('%s is recorded under its own code', (_label, result) => {
    expect(BAR_DECLINE_RE.test(result.error)).toBe(true);
    expect(recordableRefusalCode(result)).toBe(result.code);
  });

  test('an uncoded failure is a fault, never a gap, whatever its text says', () => {
    expect(recordableRefusalCode({ error: "The bar can't do this from here." })).toBeNull();
  });

  test('a by_owner_rule refusal is never recorded, even when its text names a screen', () => {
    const result = { error: "A billing change that stays on the Customers page by the owner's rule.", code: 'by_owner_rule' };
    expect(recordableRefusalCode(result)).toBeNull();
  });

  test('a switched-off capability (gate_off) adds no build work, even in decline wording', () => {
    const result = { error: "Merging customers from the bar is not enabled (GATE_IB_MERGE_CUSTOMERS), so the bar can't merge customers from here yet.", code: 'gate_off' };
    expect(BAR_DECLINE_RE.test(result.error)).toBe(true);
    expect(recordableRefusalCode(result)).toBeNull();
  });

  test('codes that were never gap rows stay unrecorded after the text rule', () => {
    const result = { error: "The bar can't rerun these from here.", code: 'no_rerunnable_checks' };
    expect(recordableRefusalCode(result)).toBeNull();
  });
});

describe('refusal wording: rewritten refusals carry a stable snake_case code', () => {
  const sources = Object.fromEntries(FILES.map((file) => [file, fs.readFileSync(fullPath(file), 'utf8')]));

  test.each([
    ['schedule-tools.js', "code: 'package_visit_two_linked'", 3],
    ['tools.js', "code: 'package_visit_two_linked'", 1],
    ['tools.js', "code: 'cancel_with_effects_unsupported'", 2],
    ['tools.js', "code: 'collective_move_unsupported'", 1],
    ['routes/admin-intelligence-bar.js', "code: 'collective_move_unsupported'", 1],
    ['tools.js', 'booking.code', 4],
    ['tools.js', "code: 'addon_by_name_unsupported'", 1],
    ['routes/admin-intelligence-bar.js', "code: 'cancel_with_effects_unsupported'", 1],
    ['routes/admin-intelligence-bar.js', "'cancel_gate_off'", 2],
    ['reprice-visits-tools.js', "code: 'free_visit_unsupported'", 1],
    ['customer-link-tools.js', "code: 'by_owner_rule'", 2],
    ['customer-lifecycle-tools.js', "code: 'by_owner_rule'", 1],
    ['ops-tools.js', "code: 'by_owner_rule'", 1],
    ['outcomes.js', "code: 'package_visit_two_linked'", 1],
])('%s has %s x%i', (file, needle, count) => {
    expect(sources[file].split(needle).length - 1).toBe(count);
  });
});

describe('refusal wording: a thrown move refusal is mapped at the bar side to a lowercase refusal', () => {
  const { moveRefusalFromThrown, isPolicyRefusal } = require('../services/intelligence-bar/outcomes');

  test.each([
    ['PACKAGE_CHILD_PRESENT', 'package_visit_two_linked'],
    ['VISIT_EDIT_SCHEDULE_UNSUPPORTED', 'grouped_visit_move_unsupported'],
    ['VISIT_FROZEN_MOVE_UNSUPPORTED', 'frozen_visit_move_unsupported'],
  ])('%s becomes %s, a refusal Tool Health does not count as a fault', (thrown, code) => {
    const refusal = moveRefusalFromThrown(Object.assign(new Error('The bar can\'t move it from here yet.'), { code: thrown }));
    expect(refusal.code).toBe(code);
    expect(isPolicyRefusal(refusal)).toBe(true);
    expect(refusal.error).toMatch(BAR_DECLINE_RE);
    expect(OTHER_SCREEN_RE.test(refusal.error)).toBe(false);
  });

  test('any other thrown error is not mapped', () => {
    expect(moveRefusalFromThrown(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBeNull();
    // A frozen check that could not read the visit stays a fault (Codex #6371 r3).
    expect(moveRefusalFromThrown(Object.assign(new Error('x'), { code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason: 'unreadable' }))).toBeNull();
    expect(moveRefusalFromThrown(Object.assign(new Error('x'), { code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason: 'has_records' }))).toMatchObject({ code: 'frozen_visit_move_unsupported' });
    expect(moveRefusalFromThrown(null)).toBeNull();
  });
});

describe('informational read reasons are not capability declines (Codex #6371 r3)', () => {
  test('the billing reader reconciliation reasons do not match BAR_DECLINE_RE', () => {
    const { _private: { BAR_DECLINE_RE } } = require('../services/agent-gap-reports');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/intelligence-bar/billing-reader-tools.js'), 'utf8');
    const reasons = [...src.matchAll(/^const [A-Z_]+_(?:REASON|POINTER) = '((?:[^'\\]|\\.)*)';$/gm)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(3);
    for (const reason of reasons) expect(BAR_DECLINE_RE.test(reason)).toBe(false);
  });
});

describe('proposal-time frozen check (Codex #6371 r4)', () => {
  test('an unreadable frozen verdict at proposal is an uncoded fault, not frozen_visit_move_unsupported', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-intelligence-bar.js'), 'utf8');
    const at = src.indexOf("verdict.frozen && verdict.reason === 'unreadable'");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('}', src.indexOf('return', at)) + 1);
    expect(block).not.toContain('code:');
    // The unreadable branch returns before the frozen refusal (now built by frozenMoveRefusal) is reached.
    expect(at).toBeLessThan(src.indexOf('frozenMoveRefusal(verdict.reason)', at));
  });
});

describe('batch move unreadable checks stay faults (Codex #6371 r4 audit)', () => {
  test('the batch preview and commit keep unreadable group checks uncoded', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/intelligence-bar/schedule-tools.js'), 'utf8');
    // The all-skipped refusal reads the unreadable flag first and sets no code.
    const refusal = require('../services/intelligence-bar/schedule-tools')._private.allSkippedRefusal({
      skippedGrouped: [{ id: 'x', kind: 'unreadable', unreadable: true }], skippedCollective: [], skippedUnchanged: [], skippedElapsed: [],
    });
    expect(refusal).toEqual({ error: expect.stringMatching(/could not check/) });
    expect(src).toContain("err.reason === 'unreadable') throw err");
  });
});

describe('Codex #6371 r5 audit findings', () => {
  const { _private: { UNRECORDED_DECLINE_CODES } } = gapReports;

  test('a successful link plan\'s send_how text is information, not a decline', () => {
    const { CUSTOMER_LINK_KINDS: KINDS } = require('../services/intelligence-bar/customer-link-tools');
    expect(Object.keys(KINDS).length).toBeGreaterThan(5);
    for (const spec of Object.values(KINDS)) {
      expect(BAR_DECLINE_RE.test(spec.sendHow)).toBe(false);
      expect(gapReports._private.DECLINE_RE.test(spec.sendHow)).toBe(false);
      expect(recordableRefusalCode({ error: spec.sendHow, code: 'x_y' })).toBeNull();
    }
  });

  test('cancel with the gate off is an unrecorded code; the real effects case still records', () => {
    expect(UNRECORDED_DECLINE_CODES.has('cancel_gate_off')).toBe(true);
    const gateOff = { error: "Cancelling a visit can charge a fee, so the bar can't cancel this visit from here yet.", code: 'cancel_gate_off' };
    expect(require('../services/intelligence-bar/outcomes').isPolicyRefusal(gateOff)).toBe(true);
    expect(recordableRefusalCode(gateOff)).toBeNull();
    const effects = { error: "The bar can't cancel a visit that carries an invoice from here yet.", code: 'cancel_with_effects_unsupported' };
    expect(recordableRefusalCode(effects)).toBe('cancel_with_effects_unsupported');
    const src = fs.readFileSync(fullPath('routes/admin-intelligence-bar.js'), 'utf8');
    const at = src.indexOf("if (!ibCancelAppointmentLive()) {");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toContain("code: 'cancel_gate_off'");
  });

  test('a batch move keeps grouped, frozen, busy and series skips apart (Codex #6371 r21)', () => {
    const { _private: { allSkippedRefusal } } = require('../services/intelligence-bar/schedule-tools');
    const refuse = (skippedGrouped, skippedCollective = []) => allSkippedRefusal({ skippedGrouped, skippedCollective, skippedUnchanged: [], skippedElapsed: [] });
    const grouped = { id: 'a', kind: 'grouped' };
    const frozen = { id: 'b', kind: 'frozen', reason: 'has_records' };
    const busy = { id: 'd', kind: 'busy', reason: 'completion_in_flight' };
    const series = { id: 'e', reason: 'collective_move_required' };
    const onlyFrozen = refuse([frozen]);
    expect(onlyFrozen.code).toBe('frozen_visit_move_unsupported');
    expect(onlyFrozen.error).toContain('has_records');
    expect(onlyFrozen.error).not.toMatch(/grouped|busy/);
    expect(refuse([grouped]).code).toBe('grouped_visit_move_unsupported');
    const mixed = refuse([grouped, frozen]);
    expect(mixed.code).toBe('grouped_visit_move_unsupported');
    expect(mixed.error).toMatch(/grouped/);
    expect(mixed.error).toMatch(/issued link, records or a payment in progress/);
    // Busy beside frozen: both named, the structural code wins, the retry hint shows.
    const busyFrozen = refuse([busy, frozen]);
    expect(busyFrozen.code).toBe('frozen_visit_move_unsupported');
    expect(busyFrozen.error).toMatch(/issued link, records or a payment in progress/);
    expect(busyFrozen.error).toMatch(/busy right now/);
    expect(busyFrozen.error).toMatch(/Try again in a moment/);
    // Busy beside grouped: the grouped code, and the busy stop is not called grouped.
    const groupedBusy = refuse([grouped, busy]);
    expect(groupedBusy.code).toBe('grouped_visit_move_unsupported');
    expect(groupedBusy.error).toMatch(/grouped visit/);
    expect(groupedBusy.error).toMatch(/busy right now/);
    // Only waits: the wait code, which files no gap, and no capability_gaps.
    const onlyBusy = refuse([busy]);
    expect(onlyBusy.code).toBe('visit_busy_move');
    expect(onlyBusy).not.toHaveProperty('capability_gaps');
    expect(recordableRefusalCode({ error: onlyBusy.error, code: onlyBusy.code })).toBeNull();
    // A series beside a wait: the series code.
    expect(refuse([busy], [series]).code).toBe('collective_move_unsupported');
    expect(refuse([], [series]).code).toBe('collective_move_unsupported');
    for (const r of [onlyFrozen, mixed, busyFrozen, groupedBusy, refuse([grouped])]) {
      expect(recordableRefusalCode({ error: r.error, code: r.code })).toBe(r.code);
    }
    // An unreadable check stays a fault, even beside frozen and grouped skips.
    const fault = refuse([grouped, frozen, { id: 'c', kind: 'unreadable', unreadable: true }]);
    expect(fault.code).toBeUndefined();
    expect(fault).not.toHaveProperty('capability_gaps');
    expect(recordableRefusalCode({ error: fault.error })).toBeNull();
  });
});

describe('a switched-off gate is not a gap (Codex #6371 r6)', () => {
  test.each(['accept_estimate_not_enabled', 'autopay_off_not_enabled', 'cancel_gate_off', 'gate_off', 'void_invoice_not_enabled'])('%s records nothing', (code) => {
    expect(recordableRefusalCode({ success: false, code, error: "The bar can't accept this estimate from here yet." })).toBeNull();
  });
  test('a real capability code with the same wording still records', () => {
    expect(recordableRefusalCode({ success: false, code: 'cancel_with_effects_unsupported', error: "The bar can't cancel a visit with an invoice from here yet." })).toBe('cancel_with_effects_unsupported');
  });
});

describe('mixed batch refusals with an unreadable check stay faults (Codex #6371 r7)', () => {
  test('the unreadable check outranks the collective and grouped codes', () => {
    const { _private: { allSkippedRefusal } } = require('../services/intelligence-bar/schedule-tools');
    const refusal = allSkippedRefusal({
      skippedGrouped: [{ id: 'g', kind: 'grouped' }, { id: 'u', kind: 'unreadable', unreadable: true }],
      skippedCollective: [{ id: 's' }], skippedUnchanged: [], skippedElapsed: [],
    });
    expect(refusal).not.toHaveProperty('code');
    expect(refusal).not.toHaveProperty('capability_gaps');
  });
});

describe('successful results and switched-off steps stay out of the gap list (Codex #6371 r9)', () => {
  const fs = require('fs'); const path = require('path');
  test('the account summary reconciliation warning does not read as a decline', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/billing-reader-tools.js'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('need reconciliation and are NOT in total_due'));
    expect(line).toBeTruthy();
    expect(BAR_DECLINE_RE.test(line)).toBe(false);
    // The processing note on a successful invoice read is a fact too (pre-push audit).
    const note = src.split('\n').find((l) => l.includes('needs_reconciliation are not'));
    expect(note).toBeTruthy();
    expect(BAR_DECLINE_RE.test(note.replace(/\\'/g, "'"))).toBe(false);
    expect(DECLINE_RE.test(note.replace(/\\'/g, "'"))).toBe(false);
  });
  test('closeout: a skipped step (blocked right now) is never promoted into the gap text', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/closeout-repair-tools.js'), 'utf8');
    expect(src).not.toMatch(/NOT_A_GAP_FIX/);
    expect(src).toMatch(/plan\.manual\.filter\(\(m\) => !m\.blockedNow\)/);
  });
});

describe('a coded refusal is a gap only under a gap code (Codex #6371 r10)', () => {
  test.each([
    ['an ownership lookup outage', 'payer_owned', "The bar can't check who pays this invoice right now, so it can't send it from here."],
    ['a public reply that failed the safety check', 'verifier_reject', "The bar can't post that reply from here: it failed the safety check."],
    ['a send already scheduled', 'invoice_send_queued', "The bar can't send it again from here: a send is already scheduled."],
    ['an armed dues retry', 'dues_retry_armed', "The bar can't change the billing lane from here while a dues retry is armed."],
    ['a switched-off invoice text template', 'invoice_no_channel', "The bar can't text this invoice from here: the template is off."],
    ['any other business code', 'some_new_refusal', "The bar can't do that from here."],
  ])('%s is not recorded', (_label, code, error) => {
    expect(BAR_DECLINE_RE.test(error)).toBe(true);
    expect(recordableRefusalCode({ success: false, code, error })).toBeNull();
  });

  test('*_unsupported codes and the listed gap codes still record; an uncoded refused marker records as other_screen', () => {
    expect(recordableRefusalCode({ success: false, code: 'free_visit_unsupported', error: "The bar can't book a free visit from here yet." })).toBe('free_visit_unsupported');
    expect(recordableRefusalCode({ success: false, code: 'grouped_estimate', error: "The bar can't accept a grouped estimate from here yet." })).toBe('grouped_estimate');
    expect(recordableRefusalCode({ success: false, refused: "Use the Billing Recovery page for this." })).toBe('other_screen');
  });
});

describe('a coded refusal is classified by its code, not its wording (Codex #6371 r13)', () => {
  test('annual_prepay_lane records with wording that has no decline phrase', () => {
    const result = { success: false, code: 'annual_prepay_lane', error: 'The billing type was not changed from the bar. Nothing was changed.' };
    expect(BAR_DECLINE_RE.test(result.error)).toBe(false);
    expect(recordableRefusalCode(result)).toBe('annual_prepay_lane');
  });
  test('an _unsupported code records without decline wording', () => {
    expect(recordableRefusalCode({ success: false, code: 'free_visit_unsupported', error: 'Free visits go through the office.' })).toBe('free_visit_unsupported');
  });
  test('by-design, unlisted, gate-off and unrecorded codes stay null whatever the wording', () => {
    for (const code of ['by_owner_rule', 'invoice_send_queued', 'void_invoice_not_enabled', 'gate_off', 'no_rerunnable_checks']) {
      expect(recordableRefusalCode({ success: false, code, error: "The bar can't do this from here yet." })).toBeNull();
    }
  });
  test('nothing_repairable still needs decline wording', () => {
    expect(recordableRefusalCode({ success: false, code: 'nothing_repairable', error: 'Nothing here is repairable by this command.' })).toBeNull();
    expect(recordableRefusalCode({ success: false, code: 'nothing_repairable', error: "The bar can't repair this from here yet." })).toBe('nothing_repairable');
  });
});

describe('r14: the email link refusal is a safety rule; the lookup faults state the fault', () => {
  const decline = (code) => ({ success: false, code, error: "The bar can't send this from here yet." });
  test('an email reply with an owned portal link is not a gap; the SMS composer-only refusal is', () => {
    expect(recordableRefusalCode(decline('email_link_identity_refused'))).toBeNull();
    expect(recordableRefusalCode(decline('customer_link_composer_only'))).toBe('customer_link_composer_only');
    const src = fs.readFileSync(fullPath('comms-tools.js'), 'utf8');
    expect(src).toMatch(/email \? 'email_link_identity_refused' : 'customer_link_composer_only'/);
  });
  test('the void tool: a capability refusal says the bar cannot; a lookup failure states the fault and records nothing', () => {
    const src = fs.readFileSync(fullPath('void-invoice-tools.js'), 'utf8');
    expect(src).not.toMatch(/Void it from the Invoices page/);
    expect(recordableRefusalCode({ success: false, code: 'needs_invoices_page', error: "Invoice X has a setup-fee claim. The bar can't void this invoice from here yet. Nothing was changed." })).toBe('needs_invoices_page');
    const lookup = { error: 'The bar could not check for a card charge in progress, so nothing was offered. Nothing was changed. Try again in a moment.', code: 'unverified' };
    expect(BAR_DECLINE_RE.test(lookup.error)).toBe(false);
    expect(recordableRefusalCode(lookup)).toBeNull();
  });
});

describe('r15: a page-size limit is not a gap; the billing-type hard limit is', () => {
  const decline = (code) => ({ success: false, code, error: "The bar can't change this from here yet." });
  test('reprice_page_limit records nothing; too_many_visits (billing type) still records', () => {
    expect(recordableRefusalCode(decline('reprice_page_limit'))).toBeNull();
    expect(recordableRefusalCode(decline('too_many_visits'))).toBe('too_many_visits');
  });
});

describe('r19: a wait is not a freeze', () => {
  test('visit_busy_move records nothing, and the thrown-move mapper turns a transient frozen reason into it', () => {
    expect(recordableRefusalCode({ success: false, code: 'visit_busy_move', error: "The bar can't move this right now. Try again in a moment." })).toBeNull();
    const { moveRefusalFromThrown } = require('../services/intelligence-bar/outcomes');
    for (const reason of ['visit_not_open', 'completion_in_flight', 'reminder_in_flight']) {
      expect(moveRefusalFromThrown({ code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason }).code).toBe('visit_busy_move');
    }
    for (const reason of ['packet_in_flight', 'child_artifacts', 'link_issued', 'payment_attempted']) {
      expect(moveRefusalFromThrown({ code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason }).code).toBe('frozen_visit_move_unsupported');
    }
    expect(moveRefusalFromThrown({ code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason: 'unreadable' })).toBeNull();
  });
});

describe('r23: writes switched off is an operator state', () => {
  test('the loop result carries writes_disabled, which records nothing', () => {
    const src = fs.readFileSync(fullPath('routes/admin-intelligence-bar.js'), 'utf8');
    expect(src).toMatch(/result = \{ error: IB_WRITES_DISABLED_MESSAGE, code: 'writes_disabled' \}/);
    const text = "Intelligence Bar writes are currently disabled by the operator (IB_WRITES_DISABLED). Reads still work, but the bar can't make changes from here until writes are switched back on.";
    expect(BAR_DECLINE_RE.test(text)).toBe(true);
    expect(recordableRefusalCode({ error: text, code: 'writes_disabled' })).toBeNull();
  });
});

describe('every code main recorded is classified once (pre-push audit on Codex #6371 r10)', () => {
  const decline = (code) => ({ success: false, code, error: "The bar can't do this from here yet." });
  test.each([
    'commercial_proposal', 'commercial_recurring', 'existing_service_extension', 'grouped_estimate', 'termite_program',
    'termite_annual_requires_prepay', 'booked_from_estimate', 'recurring_unnamed', 'side_effect', 'side_effect_outside_plan',
    'annual_prepay_lane', 'bill_to_payer', 'billing_visits_payer_owned', 'billing_visits_priced', 'too_many_visits',
    'annual_prepay_customer', 'annual_plan_invoice', 'package_visit_two_linked', 'nothing_repairable',
    'billing_mode_clear', 'needs_invoices_page', 'invoice_copy_too_long', 'invoice_channel_unsupported', 'booking_with_credit_unsupported',
    'address_conflict', 'customer_link_composer_only',
  ])('%s stays a gap', (code) => { expect(recordableRefusalCode(decline(code))).toBe(code); });
  test.each([
    'billing_visits_held', 'billing_completion_pending', 'live_annual_prepay_term', 'property_not_linked', 'per_application_unresolved',
    'dues_retry_armed', 'invoice_send_queued', 'invoice_channel', 'invoice_no_channel', 'verifier_reject', 'prefs_unavailable',
    'post_commit', 'already_accepted', 'invalid_target', 'invalid_value', 'no_change', 'payer_owned',
    'charge_in_progress', 'collection_hold', 'held_for_reconciliation', 'release_failed', 'returned_to_queue', 'nothing_due',
    'awaiting_signature', 'signature_expired', 'visit_terminal', 'prefs_unreadable',
  ])('%s is the bar working as built', (code) => { expect(recordableRefusalCode(decline(code))).toBeNull(); });
});

describe('lookup outages carry their own unrecorded code (Codex #6371 r16)', () => {
  test('invoice_lookup_failed is never a gap; the capability codes still are', () => {
    expect(recordableRefusalCode({ success: false, code: 'invoice_lookup_failed', error: "The bar could not check how this customer gets invoices, so it can't offer a send from here." })).toBeNull();
    expect(recordableRefusalCode({ success: false, code: 'annual_plan_invoice', error: "This is an annual-plan invoice, and the bar can't send those from here yet." })).toBe('annual_plan_invoice');
    expect(recordableRefusalCode({ success: false, code: 'invoice_channel_unsupported', error: "The bar can't send by that channel from here yet." })).toBe('invoice_channel_unsupported');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/intelligence-bar/invoice-action-tools.js'), 'utf8');
    expect(src).toMatch(/planText === ANNUAL_PLAN_UNVERIFIED_TEXT \? 'invoice_lookup_failed' : 'annual_plan_invoice'/);
    expect(src).toMatch(/gets invoices, so it can\\'t offer a send from here\.', 'invoice_lookup_failed'/);
  });
});
