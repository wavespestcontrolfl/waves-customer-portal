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

const { BAR_DECLINE_RE, BY_DESIGN_REFUSAL_CODES, recordableRefusalCode } = gapReports._private;

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
    ['routes/admin-intelligence-bar.js', "code: 'cancel_with_effects_unsupported'", 3],
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
    expect(at).toBeLessThan(src.indexOf("code: 'frozen_visit_move_unsupported'", at - 2000));
  });
});
