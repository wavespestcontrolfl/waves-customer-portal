/**
 * Source guard: "monthly customer" is never `monthly_rate > 0` on its own.
 *
 * #3140 residue. A monthly_rate on a customer row does NOT mean the row is
 * on the monthly lane — per-visit, annual-prepay and per-application rows
 * carry a monthly_rate too (legacy surfaces write it). Selecting the
 * monthly population with the raw shortcut is what mislabeled 187
 * accounts. The one classifier is server/services/billing-lane.js:
 *   - MONTHLY_LANE_SQL      — SQL mirror, for audience/eligibility queries
 *   - resolveBillingLane()  — the JS resolver, for a row in hand
 *
 * Contract this test pins (deterministic, filesystem only, no DB):
 *   every query predicate of the shape `monthly_rate > 0` (knex
 *   .where('monthly_rate', '>', 0) / .where('c.monthly_rate', '>', 0), raw
 *   SQL `monthly_rate > 0`, `c.monthly_rate > 0`, `monthly_rate::numeric > 0`)
 *   in the server source tree must sit in the SAME query chain as
 *   MONTHLY_LANE_SQL — the rate predicate narrows the lane population, it
 *   never defines it (a chain on MEMBERSHIP_TIER_SQL — the deliberate
 *   real-tier membership audience — passes the same way). AND: any single
 *   statement that tests monthly_rate positivity alongside LANE/MEMBERSHIP
 *   vocabulary (billing_mode, a lane name, tier/membership terms) is a
 *   hand-rolled row-level lane resolver — rows in hand go through
 *   resolveBillingLane() (Codex #3669 r3+r7 P2). A bare numeric
 *   monthly_rate test stays legitimate, and a site already on
 *   resolveBillingLane / customerPreservesMonthlyMembership (within ±6
 *   lines) is exempt — there the rate test rides the canonical verdict.
 *   billing-lane.js itself is exempt (it is the
 *   definition). Comments are ignored. Anything else must be in ALLOWLIST
 *   with a one-line reason — and each entry is keyed to its exact site
 *   (file + predicate + a distinctive `context` string from the query
 *   chain + an exact occurrence `count`), so a NEW shortcut in an
 *   allowlisted file still fails, and a stale entry fails too.
 */

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');

// Explicit exemptions. Default is ZERO; each entry names the file, the
// exact predicate line, and why the raw predicate is legitimate there.
const ALLOWLIST = [
  {
    file: 'services/billing-cron.js',
    match: ".where('monthly_rate', '>', 0)",
    context: ".whereNull('service_paused_at')",
    count: 1,
    // The dues cron deliberately SELECTS the wide rate-bearing population,
    // then runs every row through resolveBillingLane (GUARD 3b/3c) before
    // charging — the JS resolver is the lane filter, applied per row with
    // billing_mode always in the select (autopay-lane-guards-fail-closed).
    reason: 'wide select; lane enforced per row by resolveBillingLane (GUARD 3b/3c)',
  },
  {
    file: 'routes/admin-pricing-strategy.js',
    match: ".where('monthly_rate', '>', 0)",
    context: ".whereIn('waveguard_tier', ['Bronze', 'Silver'])",
    count: 2,
    // Upsell/upgrade audiences (/dashboard topUpgradeOpportunities and
    // /upsell-opportunities) select MEMBERS — the explicit Bronze/Silver tier
    // filter is the membership criterion (sentinel tiers can't match). The
    // monthly-dues lane would wrongly drop per-application / annual-prepay
    // members from tier-upgrade candidacy (Codex #3669 r2); rate > 0 merely
    // narrows to rate-bearing rows for ranking, it doesn't define the lane.
    reason: 'membership (tier) audience for upsell candidacy, not a monthly-lane selection',
  },
  {
    file: 'routes/admin-billing-recovery.js',
    match: 'parseFloat(r.monthly_rate || 0) > 0',
    context: 'const isReview',
    count: 1,
    // OR-widened review triage, fail-safe direction: ANY rate-bearing visit
    // (monthly or not) routes to a human before billing instead of one-click
    // rebilling. It selects rows to hold back, not the monthly lane.
    reason: 'OR-widened needs-review triage (fail-safe hold-back), not a lane selection',
  },
  {
    file: 'routes/admin-automations.js',
    match: 'coalesce(monthly_rate, 0) > 0',
    context: 'ELSE',
    count: 1,
    // MEMBERSHIP_SQL's tierless-fallback arm: the tier-FIRST membership
    // mirror (sentinel tiers excluded outright, real tiers included) falls
    // back to rate-only ONLY for tierless rows — a deliberate, documented
    // audience definition kept in lockstep with billing-lane's
    // NON_MEMBERSHIP_TIER_KEYS, not a monthly-lane query.
    reason: 'MEMBERSHIP_SQL definition: tier-first audience mirror; rate arm is the tierless fallback only',
  },
  {
    file: 'services/intelligence-bar/authorization-contract.js',
    match: 'Number(params?.updates?.monthly_rate) > 0',
    context: 'if (isCustomerUpdate',
    count: 1,
    // Confirm-card disclosure predicate (#3648, merged 25 min before this
    // guard — the two collided only on main): it checks whether the INCOMING
    // update params touch the fields the executor's billing-mode stamp
    // reads, to disclose that ripple on the card. It selects no customers
    // and defines no lane — the stamp itself lives in the executor, which
    // owns the lane semantics.
    reason: 'disclosure trigger on incoming update params (#3648 confirm card), not a lane selection',
  },
  {
    file: 'scripts/audit-churned-accounts-live-state.js',
    match: 'Number(c.monthly_rate) > 0',
    context: 'flags.push',
    count: 1,
    // Read-only ops AUDIT script: the approximate lane label annotates a
    // diagnostic flags line on a churned-accounts report — it drives no
    // billing behavior, and the report's whole point is to surface rows
    // whose fields disagree so a human resolves them.
    reason: 'read-only audit flag annotation on a diagnostic report, not billing behavior',
  },
  {
    file: 'services/customer-offboarding.js',
    match: ".orWhere('monthly_rate', '>', 0)",
    context: "qb.whereNotNull('waveguard_tier')",
    count: 1,
    // Offboarding CLEAR: `tier IS NOT NULL OR rate > 0` widens the residue
    // sweep so a stale rate is nulled too — it selects rows to scrub, not
    // the monthly lane.
    reason: 'OR-widened residue clear on offboarding; not a lane selection',
  },
  {
    file: 'services/irrigation-weekly-email.js',
    match: ".orWhere('c.monthly_rate', '>', 0)",
    context: "this.whereNotNull('c.waveguard_tier')",
    count: 1,
    // Coarse `tier OR rate` SQL prefilter; the exact membership rule runs in
    // JS per row via the shared hasMembership / isAutoDerivedTierLabelRow
    // predicates (billing_mode is in the select).
    reason: 'OR-widened prefilter; exact membership rule applied per row in JS',
  },
  {
    file: 'scripts/align-waveguard-portal-records.js',
    match: ").orWhere('c.monthly_rate', '>', 0)",
    context: ").orWhere('c.monthly_rate', '>', 0)",
    count: 1,
    // Repair-script candidate prefilter (`recognized tier OR rate > 0`);
    // buildCustomerUpdates fail-closes per row via isMembershipCustomerRow,
    // so a sentinel-tier / per-visit row is never mutated.
    reason: 'OR-widened candidate prefilter; per-row fail-close via isMembershipCustomerRow',
  },
  {
    file: 'scripts/align-waveguard-portal-records.js',
    match: ".orWhere('c.monthly_rate', '>', 0)",
    context: "waveguard_tier_source",
    count: 1,
    // Same repair script, notStillLabelOnly(): a positive rate keeps a
    // converted auto-label row ELIGIBLE for repair (an OR arm widening the
    // candidate set); membership itself is decided per row in JS.
    reason: 'OR arm keeping converted label rows repair-eligible; not a lane selection',
  },
];

const SKIP_DIRS = new Set(['node_modules', 'tests', 'migrations', '__tests__', 'coverage', 'dist']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Blank out comments while preserving line structure so reported line
// numbers stay true. Only `//` at line start or after whitespace is treated
// as a comment (a `//` inside 'https://…' is not).
function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

// knex form: .where('monthly_rate', '>', 0) / .where("c.monthly_rate", ">", 0)
// and the andWhere / orWhere / having variants, with or without ::numeric.
const KNEX_PREDICATE = /\.(?:where|andWhere|orWhere|having|andHaving|orHaving)\(\s*['"`](?:\w+\.)?monthly_rate(?:::numeric)?['"`]\s*,\s*['"`]>=?['"`]\s*,\s*['"`]?0(?:\.0+)?['"`]?\s*\)/g;
// raw form: monthly_rate > 0 / c.monthly_rate::numeric >= 0 (SQL strings or
// bare JS comparisons). `Number(x.monthly_rate || 0) > 0` does not match:
// the `|| 0)` sits between the column and the operator.
const RAW_PREDICATE = /\b(?:\w+\.)?monthly_rate(?:::numeric)?\s*>=?\s*'?0(?:\.0+)?'?\b/g;
// COALESCE-wrapped SQL spelling: COALESCE(monthly_rate, 0) > 0 (Codex #3669
// r10 — the wrap moves the operator away from the column token, so the raw
// regex alone would silently pass it).
const COALESCE_PREDICATE = /\bcoalesce\(\s*(?:\w+\.)?monthly_rate\s*,\s*0\s*\)(?:::numeric)?\s*>=?\s*'?0(?:\.0+)?'?\b/gi;
// parameterized raw spelling: whereRaw('monthly_rate > ?', [0]) — the bound
// placeholder hides the zero from the literal regexes (Codex #3669 r14).
// Any bound >-comparison of monthly_rate is treated as a lane-shortcut
// candidate; a genuine variable-threshold filter earns an allowlist entry.
const PARAM_PREDICATE = /\b(?:\w+\.)?monthly_rate(?:::numeric)?\s*>=?\s*\?/g;
// row-level JS lane classifier: monthly_rate positivity (any of the
// `Number(x.monthly_rate) > 0` / `(x.monthly_rate || 0) > 0` wrappings)
// with LANE/MEMBERSHIP vocabulary in the SAME STATEMENT — a hand-rolled
// resolver (Codex #3669 r3+r7 P2). Positivity alone is a legitimate
// numeric test; the lane-vocabulary co-occurrence (billing_mode, a lane
// name, tier/membership terms) is what makes it lane classification. The
// statement window spans a multiline expression (rate test on one line,
// the lane term on the next — Codex r4 P2): it extends from the match line
// in both directions until a line ends the statement (`;`, `{`, `}`),
// capped at 8 lines.
// EXEMPT: a site already ON the canonical resolver — resolveBillingLane or
// the shared customerPreservesMonthlyMembership predicate within ±4 lines
// — where the rate test is an auxiliary numeric guard beside the lane
// verdict, not a replacement for it.
// Known limit: a positivity test itself split mid-expression
// (`Number(\n x.monthly_rate\n ) > 0`) is not recognized — no such
// formatting exists in the tree.
const JS_POSITIVITY = /\bmonthly_rate\s*(?:\|\|\s*0\s*)?\)*\s*>\s*0/;
const LANE_VOCABULARY = /billing_mode|per_application|annual_prepay|per_visit|one_time|waveguard_tier|isMembershipTier|[Mm]embership|[Ll]ane|[Pp]erApplication/;
const RESOLVER_MARKERS = /resolveBillingLane|customerPreservesMonthlyMembership/;
function statementWindow(lines, idx) {
  const ends = (l) => /[;{}]\s*$/.test(l.trim());
  let start = idx;
  while (start > 0 && start > idx - 4 && !ends(lines[start - 1] || '')) start -= 1;
  let end = idx;
  while (end < lines.length - 1 && end < idx + 4 && !ends(lines[end])) end += 1;
  return lines.slice(start, end + 1).join('\n');
}
function isJsLaneClassifier(lines, idx) {
  if (!JS_POSITIVITY.test(lines[idx])) return false;
  if (!LANE_VOCABULARY.test(statementWindow(lines, idx))) return false;
  const near = lines.slice(Math.max(0, idx - 6), idx + 7).join("\n");
  return !RESOLVER_MARKERS.test(near);
}

const LANE_MARKER = 'MONTHLY_LANE_SQL';
// A chain carrying the MEMBERSHIP mirror is a deliberate, documented
// audience choice (real-tier members regardless of dues lane — pricing/
// upsell economics, Codex #3669 r7); the marker itself records the
// decision, so such chains pass like MONTHLY_LANE_SQL ones do.
const MEMBERSHIP_MARKER = 'MEMBERSHIP_TIER_SQL';

// The query chain around a match: the match line, plus adjacent lines that
// continue a builder chain (trimmed line starts with `.`), skipping lines
// that are blank after comment stripping.
function chainAround(lines, idx) {
  const isCont = (l) => l.trim().startsWith('.');
  const isBlank = (l) => l.trim() === '';
  const parts = [lines[idx]];
  // backward: while the current line is a continuation, include the line above
  let i = idx;
  while (i > 0 && isCont(lines[i])) {
    let j = i - 1;
    while (j > 0 && isBlank(lines[j])) j -= 1;
    parts.unshift(lines[j]);
    i = j;
  }
  // forward: include following continuation lines
  let k = idx + 1;
  while (k < lines.length) {
    while (k < lines.length && isBlank(lines[k])) k += 1;
    if (k >= lines.length || !isCont(lines[k])) break;
    parts.push(lines[k]);
    k += 1;
  }
  return parts.join('\n');
}

let cachedOffenders = null;
function findOffenders() {
  if (cachedOffenders) return cachedOffenders;
  const offenders = [];
  for (const abs of walk(SERVER_ROOT)) {
    const rel = path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
    if (rel === 'services/billing-lane.js') continue;
    const src = fs.readFileSync(abs, 'utf8');
    if (!src.includes('monthly_rate')) continue;
    const stripped = stripComments(src);
    const lines = stripped.split('\n');
    const seen = new Set();
    const anyPredicate = (text) => {
      KNEX_PREDICATE.lastIndex = 0;
      RAW_PREDICATE.lastIndex = 0;
      COALESCE_PREDICATE.lastIndex = 0;
      PARAM_PREDICATE.lastIndex = 0;
      return KNEX_PREDICATE.test(text) || RAW_PREDICATE.test(text) || COALESCE_PREDICATE.test(text) || PARAM_PREDICATE.test(text);
    };
    // Window bounds for a given anchor line (mirrors statementWindow).
    const windowBounds = (idx) => {
      const ends = (l) => /[;{}]\s*$/.test(l.trim());
      let start = idx;
      while (start > 0 && start > idx - 4 && !ends(lines[start - 1] || '')) start -= 1;
      let end = idx;
      while (end < lines.length - 1 && end < idx + 4 && !ends(lines[end])) end += 1;
      return [start, end];
    };
    lines.forEach((line, idx) => {
      // Anchor on the line naming the column; a predicate SPLIT across
      // argument/continuation lines (`.where(\n 'monthly_rate', '>', 0\n)`
      // or raw SQL wrapping before the operator) is caught by re-testing
      // the whitespace-normalized statement window (Codex #3669 r15). A
      // window-level match only counts when NO line in the window matches
      // on its own (i.e. the predicate is genuinely split) and only from
      // the window's FIRST monthly_rate line — one offender per predicate,
      // so allowlist count keying holds and a `.whereNotNull` neighbor of a
      // legal chain never rides along.
      if (!line.includes('monthly_rate')) return;
      const jsClassifier = isJsLaneClassifier(lines, idx);
      let hit = jsClassifier || anyPredicate(line);
      if (!hit) {
        const [start, end] = windowBounds(idx);
        const windowLines = lines.slice(start, end + 1);
        const splitOnly = !windowLines.some((l) => anyPredicate(l))
          && anyPredicate(windowLines.join('\n').replace(/\s+/g, ' '));
        const firstAnchor = start + windowLines.findIndex((l) => l.includes('monthly_rate'));
        hit = splitOnly && firstAnchor === idx;
      }
      if (!hit) return;
      if (seen.has(idx)) return;
      seen.add(idx);
      // A JS classifier's "chain" is its statement window, so an ALLOWLIST
      // context can key on surrounding statement text.
      const chain = jsClassifier ? statementWindow(lines, idx) : chainAround(lines, idx);
      // A JS row classifier is never excused by a nearby MONTHLY_LANE_SQL —
      // rows in hand go through resolveBillingLane().
      if (!jsClassifier && (chain.includes(LANE_MARKER) || chain.includes(MEMBERSHIP_MARKER))) return;
      offenders.push({ file: rel, line: idx + 1, snippet: line.trim(), chain });
    });
  }
  cachedOffenders = offenders;
  return offenders;
}

function entryMatches(a, o) {
  return a.file === o.file && o.snippet.includes(a.match) && o.chain.includes(a.context);
}
function isAllowed(o) {
  return ALLOWLIST.some((a) => entryMatches(a, o));
}

describe('monthly-lane source guard (#3140)', () => {
  test('billing-lane.js still exports the canonical SQL mirror the guard requires', () => {
    const lane = require('../services/billing-lane');
    expect(typeof lane.MONTHLY_LANE_SQL).toBe('string');
    expect(lane.MONTHLY_LANE_SQL).toContain("billing_mode = 'monthly_membership'");
    expect(typeof lane.resolveBillingLane).toBe('function');
  });

  test('no raw `monthly_rate > 0` lane predicate outside billing-lane.js / MONTHLY_LANE_SQL chains', () => {
    const offenders = findOffenders();
    const violations = offenders.filter((o) => !isAllowed(o));
    const message = violations
      .map((v) => `  server/${v.file}:${v.line}  ${v.snippet}`)
      .join('\n');
    if (violations.length) {
      throw new Error(
        `Raw monthly-lane predicate(s) found — monthly_rate > 0 is NOT the monthly lane.\n` +
        `Select monthly customers with MONTHLY_LANE_SQL (add .whereRaw(MONTHLY_LANE_SQL) to the same chain) ` +
        `or resolve a row in hand with resolveBillingLane() from server/services/billing-lane.js.\n` +
        `Offending site(s):\n${message}\n` +
        `(#3140 — this shortcut mislabeled 187 accounts. If a site is genuinely exempt, add it to ALLOWLIST ` +
        `in this test with the exact predicate text and a one-line reason.)`,
      );
    }
    expect(violations).toEqual([]);
  });

  test('every ALLOWLIST entry matches EXACTLY its keyed site (no stale entries, no new shortcuts riding an exemption)', () => {
    const offenders = findOffenders();
    for (const entry of ALLOWLIST) {
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(10);
      const hits = offenders.filter((o) => entryMatches(entry, o));
      if (hits.length === 0) {
        throw new Error(`ALLOWLIST entry server/${entry.file} (${entry.match} near ${entry.context}) no longer matches a raw predicate — remove it.`);
      }
      if (hits.length !== entry.count) {
        const where = hits.map((h) => `server/${h.file}:${h.line}`).join(', ');
        throw new Error(
          `ALLOWLIST entry server/${entry.file} (${entry.match} near ${entry.context}) matches ${hits.length} site(s) ` +
          `(${where}) but is keyed to exactly ${entry.count} — a NEW raw monthly-lane predicate is riding this exemption. ` +
          `Fix the new site with MONTHLY_LANE_SQL / resolveBillingLane, or add its own allowlist entry with its own reason.`,
        );
      }
    }
  });

  test('the matcher recognizes every predicate shape it claims to (self-check)', () => {
    const shapes = [
      ".where('monthly_rate', '>', 0)",
      '.where("c.monthly_rate", ">", 0)',
      ".andWhere('monthly_rate', '>=', 0)",
      "whereRaw('c.monthly_rate > 0')",
      'AND monthly_rate::numeric > 0',
      "AND monthly_rate > '0'",
      'if (c.monthly_rate > 0) {',
      'AND COALESCE(monthly_rate, 0) > 0',
      "ELSE coalesce(cu.monthly_rate, 0) > '0'",
      "whereRaw('monthly_rate > ?', [0])",
      "whereRaw('c.monthly_rate >= ?', [0])",
      // split-argument form, tested via the normalized statement window
      // exactly as findOffenders normalizes it (r15)
      ".where(\n  'monthly_rate', '>', 0\n)".replace(/\s+/g, ' '),
      'AND monthly_rate\n  > 0'.replace(/\s+/g, ' '),
    ];
    for (const s of shapes) {
      KNEX_PREDICATE.lastIndex = 0; RAW_PREDICATE.lastIndex = 0; COALESCE_PREDICATE.lastIndex = 0; PARAM_PREDICATE.lastIndex = 0;
      expect(KNEX_PREDICATE.test(s) || RAW_PREDICATE.test(s) || COALESCE_PREDICATE.test(s) || PARAM_PREDICATE.test(s)).toBe(true);
    }
    const nonShapes = [
      'Number(customer?.monthly_rate || 0) > 0',
      "// monthly cron filters monthly_rate > 0",
      ".sum('monthly_rate as total')",
      ".where('monthly_rate', '>', 10)",
    ];
    for (const s of nonShapes) {
      KNEX_PREDICATE.lastIndex = 0; RAW_PREDICATE.lastIndex = 0;
      const stripped = stripComments(s);
      expect(KNEX_PREDICATE.test(stripped) || RAW_PREDICATE.test(stripped)).toBe(false);
    }
    // JS row-level classifier: rate positivity + billing_mode in the same
    // statement — single-line and multiline (r4) forms. The helper takes
    // (lines, idx of the positivity line).
    const classifies = (src) => {
      const lines = stripComments(src).split('\n');
      const idx = lines.findIndex((l) => JS_POSITIVITY.test(l));
      return idx >= 0 && isJsLaneClassifier(lines, idx);
    };
    const classifierShapes = [
      "const monthlyLane = Number(customer.monthly_rate) > 0 && String(customer.billing_mode || '') !== 'per_application';",
      "const monthlyLane = Number(customer?.monthly_rate) > 0 && String(customer?.billing_mode || '') !== 'per_application';",
      "const m = (row.monthly_rate || 0) > 0 && row.billing_mode !== 'annual_prepay';",
      // multiline: rate test first, billing_mode on the continuation line
      "const monthlyLane = Number(customer.monthly_rate) > 0\n  && String(customer.billing_mode || '') !== 'per_application';",
      // multiline, reversed order
      "const monthlyLane = customer.billing_mode !== 'per_application'\n  && Number(customer.monthly_rate) > 0;",
      // rate-only positivity with lane/membership vocabulary in the
      // statement — a rate-derived membership verdict (Codex r7)
      "const isMember = hasMembership && Number(c.monthly_rate) > 0;",
    ];
    for (const s of classifierShapes) expect(classifies(s)).toBe(true);
    const classifierNonShapes = [
      'const positive = Number(customer.monthly_rate) > 0;', // numeric only, no lane vocabulary
      "const lane = resolveBillingLane(customer).mode === 'monthly_membership';",
      "update.billing_mode = 'monthly_membership'; update.monthly_rate = rate;",
      // separate statements: the `;` ends the window before billing_mode
      "const positive = Number(c.monthly_rate) > 0;\nconst mode = c.billing_mode;",
      // ON the canonical resolver (±4 lines): the rate test is an auxiliary
      // numeric guard beside the lane verdict, not a replacement for it
      "const lane = resolveBillingLane(row);\nconst liveDues = lane.mode === 'monthly_membership'\n  && Number(row.monthly_rate) > 0;",
    ];
    for (const s of classifierNonShapes) expect(classifies(s)).toBe(false);
  });
});
