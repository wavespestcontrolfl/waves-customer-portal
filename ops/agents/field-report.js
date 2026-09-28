#!/usr/bin/env node
// READ-ONLY — quarterly "Waves Field Report": anonymized local pest-activity
// counts for the owner to review before anything is shared publicly (work
// order D5, research report: "Large — needs your sign-off" / "You decide
// what gets shared"). This script only PREPARES the numbers; it never
// publishes, drafts, or sends anything. Nothing here is wired into any
// public page — see wavespestcontrol-astro's src/data/fieldReport.ts, which
// ships committed as `null` (unapproved) until the owner hand-picks numbers
// from this report's output and a person edits that file.
//
// What it counts: completed service visits (`scheduled_services.status =
// 'completed'`), grouped by month x county x service category. Counts only
// — never names, addresses, streets, ZIPs, or revenue.
//
// PRIVACY RULES (enforced in code, covered by field-report.test.js):
//   1. No customer names, addresses, street-level location, or ZIP codes
//      anywhere in the output — county is the finest geography reported.
//   2. Any reported cell (a month x county x category count, or a rollup
//      total) with a TRUE count < MIN_CELL (default 10) prints as "<10"
//      instead of the number, so a small true count is never disclosed as
//      an exact figure. This is PRIMARY suppression only: each number is
//      checked independently against the true underlying count before
//      display. It does NOT run secondary/complementary suppression (where
//      a shown total minus other shown parts could still expose a
//      suppressed cell by subtraction) — for the county x month x category
//      grain this report uses, that is a known limitation of a v1 draft
//      tool, not a guarantee. The owner reviews the actual numbers before
//      any external framing; this script does not decide what is safe to
//      publish, it only aggregates and suppresses obviously-small cells.
//   3. No price, revenue, or billing figures of any kind are read, joined,
//      or printed.
//   4. Internal/test customers (server/services/internal-test-customers.js
//      — the same exclusion list the pricing funnel report and MRR metrics
//      use) are dropped before aggregation so a demo account never appears
//      as a "pest sighting".
//
// GEOGRAPHY: county only, for Sarasota / Manatee / Charlotte (the three
// counties named in the work order). County is resolved from the VISIT'S
// OWN saved service address first (`scheduled_services.service_address_zip`
// / `_city` — the per-visit property, set for multi-property customers and
// for a customer who has moved since), falling back to the customer's own
// zip/city only for legacy rows with no stamped service address — the same
// `COALESCE(ss.service_address_zip, c.zip)` pattern
// `serviceLocationSelects` uses in server/services/scheduling/day-stops.js,
// so a visit at a second property or a former address is never misattributed
// to the customer's CURRENT home county. That zip is matched using the SAME
// canonical zip->county lists the watering-restriction resolver and
// property lookup use
// (server/config/county-zips.js SERVICE_AREA_COUNTY_ZIPS) — never a
// separately hand-copied zip list. A ZIP that set lists under MORE THAN ONE
// county (e.g. 34228 Longboat Key straddles Manatee/Sarasota) is NOT
// resolved by guessing; per irrigation-restrictions.js's documented
// approach, it falls through to a small whole-city fallback for cities that
// sit entirely inside one of the three counties, and otherwise the visit is
// EXCLUDED from the county breakdown (counted in `unresolvedGeography`
// instead of attributed to a county — fail closed, never guessed). A visit
// whose service address's county cannot be established this way (out of
// the three counties, e.g. Lee/Collier, or an unresolved straddling ZIP
// with no whole-county city) is also excluded from the by-county tables.
//
// CATEGORY: `scheduled_services.service_category_snapshot` when present
// (a stamped copy of the `services` catalog's `category` column — see
// migration 20260716000000) is authoritative. When it is null (older rows,
// or a visit whose service_type never matched a catalog row), the category
// is inferred by keyword match against the free-text `service_type` column
// into the SAME category vocabulary the `services` catalog uses
// (pest_control, lawn_care, mosquito, termite, rodent, tree_shrub,
// inspection, wdo, specialty, other) — see CATEGORY_KEYWORDS below for the
// exact mapping. This is a best-effort fallback, not a re-derivation of the
// catalog; document any drift you notice when reviewing real output.
//
// DATE WINDOW: `scheduled_services.scheduled_date` is a plain SQL DATE (no
// time, no timezone — see the waves-db skill's schema truth traps), so
// month/quarter bucketing here is a direct string operation
// (`to_char(scheduled_date, 'YYYY-MM')` in SQL) with no Date-object /
// timezone conversion anywhere in the pipeline — the exact trap that has
// shifted ET boundaries elsewhere in this codebase does not apply to this
// column, and this script never constructs a JS Date from it. `--from` is
// inclusive, `--to` is exclusive (the first calendar day AFTER the window),
// both plain YYYY-MM-DD calendar dates.
//
// Usage (repo root):
//   railway run --service Postgres node ops/agents/field-report.js --from 2026-04-01 --to 2026-07-01
//   railway run --service Postgres node ops/agents/field-report.js --from 2026-04-01 --to 2026-07-01 --json
//   railway run --service Postgres node ops/agents/field-report.js --from 2026-04-01 --to 2026-07-01 --min-cell=10
//
// Connects via DATABASE_PUBLIC_URL in a read-only transaction (SET
// default_transaction_read_only). Writes nothing, sends nothing. Prints to
// stdout only.

const path = require('path');
const { validCalendarDate } = require(path.join(__dirname, '..', '..', 'server', 'utils', 'datetime-et'));
const { SERVICE_AREA_COUNTY_ZIPS, LEE_ZIPS, COLLIER_ZIPS } = require(path.join(__dirname, '..', '..', 'server', 'config', 'county-zips'));
const { resolveAddressCounty } = require(path.join(__dirname, '..', '..', 'server', 'config', 'address-county'));
const {
  INTERNAL_TEST_CUSTOMERS,
  isInternalTestCustomerId,
} = require(path.join(__dirname, '..', '..', 'server', 'services', 'internal-test-customers'));

const DEFAULT_MIN_CELL = 10;

// The three counties this report covers (work order D5). Deliberately NOT
// the fuller Manatee/Sarasota/Charlotte/DeSoto/Lee/Collier service-area or
// tax county sets used elsewhere — a customer outside these three counties
// is excluded from the county breakdown regardless of which other list
// might name their county.
const REPORT_COUNTIES = ['Sarasota', 'Manatee', 'Charlotte'];

// Address -> county comes from the SHARED resolver (server/config/
// address-county.js, also used by the irrigation-restriction resolver), so a
// straddling-city or service-area correction lands in one place. On top of
// it, a ZIP that any county list OUTSIDE the three report counties also
// claims (e.g. 33921: Charlotte and Lee) is ambiguous for this report and is
// excluded rather than attributed.
const OUTSIDE_REPORT_ZIPS = new Set([
  ...LEE_ZIPS,
  ...COLLIER_ZIPS,
  ...Object.entries(SERVICE_AREA_COUNTY_ZIPS)
    .filter(([county]) => !REPORT_COUNTIES.includes(county))
    .flatMap(([, zips]) => zips),
]);

function resolveCounty({ zip, city } = {}) {
  const zip5 = String(zip || '').trim().slice(0, 5);
  if (zip5 && OUTSIDE_REPORT_ZIPS.has(zip5)) return null;
  const county = resolveAddressCounty({ zip, city });
  return county && REPORT_COUNTIES.includes(county) ? county : null;
}

// Canonical category vocabulary — the `services` catalog's own `category`
// column (migration 20260401000105_service_library.js). Any snapshot value
// outside this set (drift, a future catalog category) is kept as its own
// bucket rather than silently folded into "other", so real output surfaces
// it for review instead of hiding it.
const CANONICAL_CATEGORIES = [
  'pest_control', 'lawn_care', 'mosquito', 'termite', 'rodent',
  'tree_shrub', 'inspection', 'specialty', 'other',
];

// Fallback keyword map for rows with no service_category_snapshot — matched
// in this order (first match wins) against the lowercased free-text
// service_type. Document any new service_type spelling you see in real
// output here rather than letting it silently fall to "other".
const CATEGORY_KEYWORDS = [
  // Inspections first: the catalog files "Termite Inspection Service",
  // "Rodent Inspection Service" and WDO inspections under `inspection`
  // (migration 20260507000002), so a legacy label must land there too.
  ['inspection', /inspection|\bwdo\b|wood.?destroying/],
  ['mosquito', /mosquito|waveguard mosquito/],
  ['termite', /termite/],
  ['rodent', /rodent|\brat\b|rats\b|\bmice\b|\bmouse\b/],
  // The catalog files Fire Ant, Flea & Tick, Bee / Wasp, Mud Dauber, Wildlife
  // Trapping, Bed Bug, WaveGuard Initial Setup and the general appointment
  // as specialty (migrations 20260401000105, 20260408000001, 20260414000027,
  // 20260611000006) — before the generic ant/pest catch.
  ['specialty', /fire[\s-]*ants?\b|\bflea|\bticks?\b|\bbees?\b|\bwasps?\b|mud[\s-]*dauber|wildlife|bed[\s-]*bugs?\b|initial[\s-]*setup|\bappointment\b/],
  // "Palmetto" is a roach, not a palm (mirrors SchedulePage's classifier).
  ['pest_control', /\bpalmetto\b/],
  ['tree_shrub', /tree|shrub|palm/],
  ['lawn_care', /lawn|turf|fertiliz|dethatch|topdress|plugging|weed|aerat/],
  // Generic pest-control catch: "Quarterly Pest Control", "Pest & Rodent
  // Control" (rodent already matched above), roach/ant/spider one-offs.
  // Ants as a whole word, so "Plant Health" never counts as pest control.
  ['pest_control', /pest|roach|\bants?\b|spider|general/],
];

function resolveCategory({ categorySnapshot, serviceType } = {}) {
  const snap = String(categorySnapshot || '').trim().toLowerCase();
  if (snap) return snap; // keep verbatim even if outside CANONICAL_CATEGORIES — see comment above
  const text = String(serviceType || '').trim().toLowerCase();
  for (const [category, re] of CATEGORY_KEYWORDS) {
    if (re.test(text)) return category;
  }
  return 'other';
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[raw] = next;
      i += 1;
    } else {
      out[raw] = true;
    }
  }
  return out;
}

/**
 * --min-cell: absent -> the default; present -> must be a positive integer
 * (a bare flag or junk value is rejected, never read as 1).
 */
function resolveMinCell(args = {}) {
  if (!Object.prototype.hasOwnProperty.call(args, 'min-cell')) return DEFAULT_MIN_CELL;
  const raw = args['min-cell'];
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`--min-cell must be a positive integer, got "${raw === true ? '(no value)' : raw}"`);
  }
  return Number(raw.trim());
}

/** Validates --from/--to: both real calendar dates, from < to. Throws with a usage message otherwise. */
function resolveWindow({ from, to } = {}) {
  const fromStr = typeof from === 'string' ? validCalendarDate(from) : null;
  const toStr = typeof to === 'string' ? validCalendarDate(to) : null;
  if (!fromStr) throw new Error(`--from must be a calendar date in YYYY-MM-DD format, got "${from}"`);
  if (!toStr) throw new Error(`--to must be a calendar date in YYYY-MM-DD format, got "${to}"`);
  if (!(fromStr < toStr)) throw new Error(`--from (${fromStr}) must be before --to (${toStr})`);
  return { fromStr, toStr };
}

// A true zero discloses nothing about any individual and is shown as "0", not
// suppressed — suppression exists to hide a small NONZERO count (1-9 people),
// not the absence of any activity at all.
function cell(count, minCell) {
  if (count > 0 && count < minCell) return { count: null, suppressed: true, display: `<${minCell}` };
  return { count, suppressed: false, display: String(count) };
}

/**
 * Pure aggregation: rows -> { byCounty, unresolvedGeography, excludedInternal,
 * totalCompleted, months, counties, categories }. `rows` are plain objects:
 * { serviceMonth: 'YYYY-MM', zip, city, categorySnapshot, serviceType,
 *   customerId, customerName }. `customerId`/`customerName` are used ONLY to
 * apply the internal-test-customer exclusion and never appear in the
 * returned aggregation.
 */
function aggregate(rows, { minCell = DEFAULT_MIN_CELL } = {}) {
  const internalTestNames = new Set(INTERNAL_TEST_CUSTOMERS.map((n) => n.toLowerCase()));
  let excludedInternal = 0;
  let unresolvedGeography = 0;
  const raw = new Map(); // "month|county|category" -> count
  const months = new Set();
  const categories = new Set();

  for (const row of rows || []) {
    const nameKey = String(row.customerName || '').trim().toLowerCase();
    if (isInternalTestCustomerId(row.customerId) || internalTestNames.has(nameKey)) {
      excludedInternal += 1;
      continue;
    }
    const county = resolveCounty({ zip: row.zip, city: row.city });
    if (!county) {
      unresolvedGeography += 1;
      continue;
    }
    const category = resolveCategory({ categorySnapshot: row.categorySnapshot, serviceType: row.serviceType });
    const month = row.serviceMonth;
    months.add(month);
    categories.add(category);
    const key = `${month}|${county}|${category}`;
    raw.set(key, (raw.get(key) || 0) + 1);
  }

  const sortedMonths = [...months].sort();
  const sortedCategories = [...categories].sort();

  // Per-county tables: month (rows) x category (columns), each cell
  // independently suppressed. Also a month total per county (own raw count,
  // independently suppressed — see the header comment's suppression
  // limitation note) and a grand total per county.
  const byCounty = {};
  for (const county of REPORT_COUNTIES) {
    let countyRawTotal = 0;
    const monthRows = sortedMonths.map((month) => {
      const cats = {};
      let monthRawTotal = 0;
      for (const category of sortedCategories) {
        const rawCount = raw.get(`${month}|${county}|${category}`) || 0;
        if (rawCount > 0) cats[category] = cell(rawCount, minCell);
        monthRawTotal += rawCount;
      }
      countyRawTotal += monthRawTotal;
      return { month, categories: cats, total: cell(monthRawTotal, minCell) };
    });
    byCounty[county] = { months: monthRows, total: cell(countyRawTotal, minCell) };
  }

  // Every reported number gets the same primary-suppression treatment,
  // including these top-level rollups — a one-visit window must never print
  // totalCompleted: 1 just because it bypassed cell() (codex pre-push r1).
  return {
    byCounty,
    months: sortedMonths,
    categories: sortedCategories,
    counties: REPORT_COUNTIES,
    unresolvedGeography: cell(unresolvedGeography, minCell),
    excludedInternal: cell(excludedInternal, minCell),
    // Internal/test visits are dropped before counting, the headline too.
    totalCompleted: cell((rows ? rows.length : 0) - excludedInternal, minCell),
    minCell,
  };
}

function formatMarkdown(summary, { from, to } = {}) {
  const lines = [];
  lines.push(`## Waves Field Report (DRAFT — unapproved), ${from} to ${to}`);
  lines.push('');
  lines.push('**This is an internal draft. Nothing here is published or shared until the owner approves the numbers.**');
  lines.push('');
  lines.push(`Completed visits in window: ${summary.totalCompleted.display} (internal/test accounts excluded: ${summary.excludedInternal.display}; outside Sarasota/Manatee/Charlotte or unresolved geography: ${summary.unresolvedGeography.display})`);
  lines.push(`Small-cell suppression: any count under ${summary.minCell} prints as "<${summary.minCell}".`);
  lines.push('');
  for (const county of summary.counties) {
    const c = summary.byCounty[county];
    lines.push(`### ${county} County — total: ${c.total.display}`);
    lines.push('');
    const header = ['Month', ...summary.categories, 'Total'];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`|${header.map(() => '---').join('|')}|`);
    for (const m of c.months) {
      const row = [m.month, ...summary.categories.map((cat) => (m.categories[cat] ? m.categories[cat].display : '0')), m.total.display];
      lines.push(`| ${row.join(' | ')} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// Exported as a constant (rather than inlined in fetchRows) so
// field-report.test.js can pin the service-address-first COALESCE without
// needing a live database: a visit at a second property, or a customer who
// has since moved, must be counted at the VISIT's own saved address, never
// silently re-attributed to the customer's current home county. Matches
// serviceLocationSelects in server/services/scheduling/day-stops.js.
const FIELD_REPORT_QUERY = `SELECT to_char(ss.scheduled_date, 'YYYY-MM') AS service_month,
              ss.service_type,
              -- The snapshot first, then the linked catalog row's category
              -- (graduated reservations stamp service_id but no snapshot);
              -- the keyword fallback only sees visits with neither.
              COALESCE(ss.service_category_snapshot, svc.category) AS service_category_snapshot,
              CASE WHEN ss.service_address_zip IS NOT NULL OR ss.service_address_city IS NOT NULL
                   THEN ss.service_address_zip ELSE c.zip END AS zip,
              CASE WHEN ss.service_address_zip IS NOT NULL OR ss.service_address_city IS NOT NULL
                   THEN ss.service_address_city ELSE c.city END AS city,
              c.id AS customer_id,
              c.first_name,
              c.last_name
         FROM scheduled_services ss
         JOIN customers c ON c.id = ss.customer_id
         LEFT JOIN services svc ON svc.id = ss.service_id
        WHERE ss.status = 'completed'
          AND ss.scheduled_date >= $1::date
          AND ss.scheduled_date < $2::date
          -- Non-performed closeouts keep scheduled_services.status='completed':
          -- an incomplete visit records service_records.status='incomplete',
          -- a customer-declined one a 'completed' record whose frozen
          -- structured_notes.visitOutcome is 'customer_declined'. Such a visit
          -- counts only once a genuinely performed record exists.
          AND (
            NOT EXISTS (SELECT 1 FROM service_records sr
                         WHERE sr.scheduled_service_id = ss.id
                           AND (sr.status = 'incomplete'
                                OR sr.structured_notes->>'visitOutcome' = 'customer_declined'))
            OR EXISTS (SELECT 1 FROM service_records sr
                        WHERE sr.scheduled_service_id = ss.id
                          AND sr.status = 'completed'
                          AND COALESCE(sr.structured_notes->>'visitOutcome', '') <> 'customer_declined')
          )`;

async function fetchRows({ fromStr, toStr }) {
  const conn = process.env.DATABASE_PUBLIC_URL;
  if (!conn) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/field-report.js');
    process.exit(2);
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const { rows } = await client.query(FIELD_REPORT_QUERY, [fromStr, toStr]);
    return rows.map((r) => ({
      serviceMonth: r.service_month,
      serviceType: r.service_type,
      categorySnapshot: r.service_category_snapshot,
      zip: r.zip,
      city: r.city,
      customerId: r.customer_id,
      customerName: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    }));
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs();
  const { fromStr, toStr } = resolveWindow(args);
  const minCell = resolveMinCell(args);
  const rows = await fetchRows({ fromStr, toStr });
  const summary = aggregate(rows, { minCell });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ from: fromStr, to: toStr, ...summary }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMarkdown(summary, { from: fromStr, to: toStr }));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`field-report: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  aggregate,
  formatMarkdown,
  parseArgs,
  resolveCategory,
  resolveCounty,
  resolveMinCell,
  resolveWindow,
  CANONICAL_CATEGORIES,
  REPORT_COUNTIES,
  FIELD_REPORT_QUERY,
};
