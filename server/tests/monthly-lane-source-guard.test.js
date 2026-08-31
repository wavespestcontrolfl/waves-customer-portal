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
 *   never defines it. billing-lane.js itself is exempt (it is the
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

const LANE_MARKER = 'MONTHLY_LANE_SQL';

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
    lines.forEach((line, idx) => {
      KNEX_PREDICATE.lastIndex = 0;
      RAW_PREDICATE.lastIndex = 0;
      if (!KNEX_PREDICATE.test(line) && !RAW_PREDICATE.test(line)) return;
      if (seen.has(idx)) return;
      seen.add(idx);
      const chain = chainAround(lines, idx);
      if (chain.includes(LANE_MARKER)) return;
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
    ];
    for (const s of shapes) {
      KNEX_PREDICATE.lastIndex = 0; RAW_PREDICATE.lastIndex = 0;
      expect(KNEX_PREDICATE.test(s) || RAW_PREDICATE.test(s)).toBe(true);
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
  });
});
