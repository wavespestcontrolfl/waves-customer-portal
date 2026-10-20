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
];

// A string that sends the reader to another place to do the work: the gap
// reporter's own "other screen" classifier, plus the named screens that had no
// "page" or "screen" word after them.
const OTHER_SCREEN_RE = /\b(?:use|on|from|in|via|at) (?:the )?[\w' -]{0,40}?\b(?:screen|page|queue)\b/i;
const NAMED_SCREEN_RE = /\bfrom (?:Dispatch|Billing Recovery|Communications|the project)\b/i;
const BY_OWNER_RULE_TEXT = "by the owner's rule";

// Facts about a page the customer sees or a card, not a place the operator is
// sent to. Each is matched as a substring of the string.
const NOT_A_REFUSAL = [
  'the customer saves a payment method on the page', // the Auto Pay link card
  'regroup from Dispatch if needed', // the address-change card's effects line
];

function stringsOf(file) {
  const source = fs.readFileSync(path.join(DIR, file), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 2022, locations: true, allowHashBang: true });
  const found = [];
  const walk = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    let text = null;
    if (node.type === 'Literal' && typeof node.value === 'string') text = node.value;
    if (node.type === 'TemplateLiteral') text = node.quasis.map((q) => q.value.cooked).join('${}');
    const isDescription = parent && parent.type === 'Property' && parent.key
      && (parent.key.name === 'description' || parent.key.value === 'description');
    if (text !== null && !isDescription) found.push({ text, line: node.loc.start.line });
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => walk(child, node));
      else if (value && typeof value.type === 'string') walk(value, node);
    }
  };
  walk(ast, null);
  return found;
}

describe('refusal wording: no tool refusal sends the operator to another screen as the answer', () => {
  test.each(FILES)('%s: every string that points to a screen says the bar cannot, or cites the owner rule', (file) => {
    const offenders = stringsOf(file)
      .filter(({ text }) => OTHER_SCREEN_RE.test(text) || NAMED_SCREEN_RE.test(text))
      .filter(({ text }) => !NOT_A_REFUSAL.some((fact) => text.includes(fact)))
      .filter(({ text }) => !BAR_DECLINE_RE.test(text) && !text.includes(BY_OWNER_RULE_TEXT))
      .map(({ text, line }) => `${file}:${line} ${text.slice(0, 120)}`);
    expect(offenders).toEqual([]);
  });

  test('a string that cites the owner rule is a refusal with code by_owner_rule that the gap list skips', () => {
    expect(BY_DESIGN_REFUSAL_CODES.has('by_owner_rule')).toBe(true);
    const { CARD_CANCEL_REFUSED_MESSAGE } = require('../services/intelligence-bar/tools');
    expect(CARD_CANCEL_REFUSED_MESSAGE).toContain(BY_OWNER_RULE_TEXT);
    const ruled = { error: CARD_CANCEL_REFUSED_MESSAGE, code: 'by_owner_rule', rule: 'bare_visits_only' };
    expect(recordableRefusalCode(ruled)).toBeNull();
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

  test('codes that were never gap rows stay unrecorded after the text rule', () => {
    const result = { error: "It cannot be flipped from here — change it in the Railway dashboard.", code: 'not_a_boolean_gate' };
    expect(recordableRefusalCode(result)).toBeNull();
  });
});

describe('refusal wording: rewritten refusals carry a stable snake_case code', () => {
  const sources = Object.fromEntries(FILES.map((file) => [file, fs.readFileSync(path.join(DIR, file), 'utf8')]));

  test.each([
    ['schedule-tools.js', "code: 'package_visit_two_linked'", 2],
    ['tools.js', "code: 'package_visit_two_linked'", 1],
    ['tools.js', "code: 'by_owner_rule'", 3],
    ['reprice-visits-tools.js', "code: 'free_visit_unsupported'", 1],
    ['invoice-action-tools.js', "'by_owner_rule'", 1],
    ['customer-link-tools.js', "code: 'by_owner_rule'", 2],
  ])('%s has %s x%i', (file, needle, count) => {
    expect(sources[file].split(needle).length - 1).toBe(count);
  });
});
