/**
 * Source guard: no NEW "price > 0, else per_application_fee / monthly_rate"
 * charge fallback outside billing-lane.js's resolver.
 *
 * GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28, waves-billing skill
 * invariant #8): a scheduled_services.estimated_price stamped exactly 0
 * bills nothing, in every lane — never NULL/blank, which still falls
 * through to the fee/rate fallback. The ONE place that decides this is
 * hasAuthoritativeZeroPrice / completionInvoiceAmount in billing-lane.js.
 * Every prior attempt at this rule regressed because a NEW site kept
 * computing "price > 0 ? price : fee-or-rate" on its own, bypassing that
 * resolver — Codex found one more such site every round (#5161, #5181).
 *
 * Contract this test pins (deterministic, filesystem only, no DB): no file
 * under server/services or server/routes — other than billing-lane.js and
 * the files on ALLOWLIST below — may contain the shape
 *   <price-like identifier> > 0 ? <price> : ... (per_application_fee | monthly_rate)
 * or the SQL idiom NULLIF(estimated_price, 0) beside per_application_fee /
 * monthly_rate (the same bypass in a raw query — it turns a stamped 0 back
 * into NULL so COALESCE falls to the fee/rate). Price-like identifiers:
 * estimated_price, estimatedPrice, rowPrice, visitPrice, finishPrice — the
 * exact names every bypass site found so far has used.
 *
 * This is a narrow, literal-shape scan, not a general "monthly_rate /
 * per_application_fee usage" audit (most references to those columns —
 * eligibility checks, disclosures, audits, the dues cron's own population
 * query — are unrelated to charge-amount fallback and are not flagged;
 * confirmed by running this scan's own pattern over the whole server/
 * tree before writing this allowlist). Each ALLOWLIST entry names the file
 * and why every occurrence there is already correctly gated or provably
 * unreachable — allowlisted at the FILE level (not line number) per the
 * PR's own instructions, since these sites reference the columns in more
 * than one legitimate spot and a line-keyed allowlist would be brittle to
 * ordinary nearby edits.
 */

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'routes'];
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist']);

// Files permitted to contain the "price > 0, else fee/rate" shape, each
// with a one-line reason. Default is ZERO — a new file hitting the pattern
// fails until reviewed and added here.
const ALLOWLIST = {
  'services/billing-lane.js':
    'the resolver itself (hasAuthoritativeZeroPrice / completionInvoiceAmount / attachedInvoiceAutoChargeLikely) — every occurrence here IS the one definition, gated internally by stampedZeroFreeLive()',
  'services/completion-charge-verdict.js':
    'the extended-lane and per-application auto-charge cap anchors call hasAuthoritativeZeroPrice directly, explicitly guarded by stampedZeroFreeLive() at each site, before falling to the dues/fee number',
  'services/billing-recovery-bill.js':
    'priceRefusalOrAmount checks hasAuthoritativeZeroPrice, explicitly guarded by stampedZeroFreeLive(), before falling to the per-application fee',
  'routes/admin-billing-recovery.js':
    "the leak query's effectivePriceSql drops its NULLIF under stampedZeroFreeLive() so a stamped 0 never reaches the fee at all; the GET /leaks display mapper (effectivePrice) never sees such a row once the query excludes it, so its own narrow rowPrice>0 check is provably unreachable for a stamped 0 under the gate",
  'routes/admin-schedule.js':
    'every fallback here calls the resolver (completionInvoiceAmount / predictCompletionBilling / attachedInvoiceAutoChargeLikely) with the row\'s own values — no independent fallback of its own',
  'routes/estimate-public.js':
    'the one hit here is an "unpriced appointment" filter feeding an office completeness ALERT (notifyAdmin bell) — it never computes or mints a charge amount; the actual completion charge is decided later by the resolver',
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const PRICE_ID_RE = /(estimated_price|estimatedPrice|rowPrice|visitPrice|finishPrice)/;
const GT_ZERO_RE = />\s*0\b/;
const NULLIF_RE = /NULLIF\([^)]*(estimated_price|estimatedPrice)[^)]*,\s*0\)/;
const FEE_RE = /(per_application_fee|perApplicationFee|monthly_rate|monthlyRate)/;
const WINDOW_BEFORE = 1;
const WINDOW_AFTER = 4;

function findOffenders() {
  const offenders = [];
  for (const dirName of SCAN_DIRS) {
    const files = walk(path.join(SERVER_ROOT, dirName));
    for (const abs of files) {
      const rel = path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
      const src = fs.readFileSync(abs, 'utf8');
      const lines = stripComments(src).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isCandidate = (PRICE_ID_RE.test(line) && GT_ZERO_RE.test(line)) || NULLIF_RE.test(line);
        if (!isCandidate) continue;
        const start = Math.max(0, i - WINDOW_BEFORE);
        const end = Math.min(lines.length, i + WINDOW_AFTER + 1);
        const window = lines.slice(start, end).join('\n');
        if (FEE_RE.test(window)) {
          offenders.push({ file: rel, line: i + 1, snippet: line.trim() });
        }
      }
    }
  }
  return offenders;
}

describe('stamped-zero charge-fallback guard (GATE_STAMPED_ZERO_FREE)', () => {
  test('billing-lane.js still exports the canonical predicate this guard requires', () => {
    const lane = require('../services/billing-lane');
    expect(typeof lane.hasAuthoritativeZeroPrice).toBe('function');
    expect(typeof lane.completionInvoiceAmount).toBe('function');
  });

  test('no NEW "price > 0, else per_application_fee / monthly_rate" fallback outside the allowlist', () => {
    const offenders = findOffenders();
    const violations = offenders.filter((o) => !Object.prototype.hasOwnProperty.call(ALLOWLIST, o.file));
    if (violations.length) {
      const message = violations.map((v) => `  server/${v.file}:${v.line}  ${v.snippet}`).join('\n');
      throw new Error(
        'A charge-amount fallback of the shape "price > 0 ? price : per_application_fee/monthly_rate" was found ' +
        'outside billing-lane.js and its reviewed allowlist. Route the amount through completionInvoiceAmount / ' +
        'hasAuthoritativeZeroPrice (server/services/billing-lane.js) instead, or add the file to ALLOWLIST in this ' +
        `test with a one-line reason once it is confirmed gated on stampedZeroFreeLive().\nOffending site(s):\n${message}`,
      );
    }
    expect(violations).toEqual([]);
  });

  test('every ALLOWLIST entry still matches at least one site (no stale entries)', () => {
    const offenders = findOffenders();
    const filesHit = new Set(offenders.map((o) => o.file));
    for (const file of Object.keys(ALLOWLIST)) {
      expect(filesHit.has(file)).toBe(true);
    }
  });

  test('the matcher recognizes the known bypass shapes (self-check)', () => {
    const positives = [
      "const price = rowPrice > 0 ? rowPrice : (billing.mode === 'per_application' ? billing.perApplicationFee : 0);",
      'const anchor = svc.estimated_price != null && Number(svc.estimated_price) > 0\n  ? Number(svc.estimated_price)\n  : (Number(svc.cust_monthly_rate) > 0 ? Number(svc.cust_monthly_rate) : null);',
      "COALESCE(NULLIF(ss.estimated_price, 0), CASE WHEN c.billing_mode = 'per_application' THEN c.per_application_fee END, 0)",
      'const visitPrice = Number(scheduledService?.estimated_price);\nif (Number.isFinite(visitPrice) && visitPrice > 0) return round2(visitPrice);\nconst monthly = Number(customer?.monthly_rate);\nif (!isCallback && Number.isFinite(monthly) && monthly > 0) return round2(monthly);',
    ];
    for (const src of positives) {
      const tmpLines = stripComments(src).split('\n');
      const hit = tmpLines.some((line, i) => {
        const isCandidate = (PRICE_ID_RE.test(line) && GT_ZERO_RE.test(line)) || NULLIF_RE.test(line);
        if (!isCandidate) return false;
        const start = Math.max(0, i - WINDOW_BEFORE);
        const end = Math.min(tmpLines.length, i + WINDOW_AFTER + 1);
        return FEE_RE.test(tmpLines.slice(start, end).join('\n'));
      });
      expect(hit).toBe(true);
    }
  });
});
