// READ-ONLY. Pricing funnel report — the standing instrument for pricing
// decisions (owner directive 2026-08-04, born from the pest-base/lawn-grid
// funnel reviews that required per-session payload archaeology).
//
// What it computes, per service lane:
//   • Close rate DEDUPED BY CUSTOMER (an accepted quote wins the customer;
//     otherwise their latest non-draft outcome stands) — per-quote rates
//     are diluted by re-quotes and NOT reported as headline numbers.
//   • Close-rate bands by size (pest: home footprint; lawn: treatable sqft)
//     and by price ($/visit for pest; $/1k-sqft/app for lawn).
//   • Accepted-vs-expired price medians (identical medians = losses are not
//     price losses).
//   • Bundles (pest+lawn on one estimate) split out and compared to solo.
//
// Usage (from repo root):
//   railway run --service Postgres node ops/agents/pricing-funnel-report.js
//   ... [--since=YYYY-MM-DD]     only quotes created on/after the date
//       [--lane=pest|lawn|all]   default all
//
// Reads estimates.estimate_data across all three historical payload shapes
// (client fallback `result.results`, estimator-engine `engineResult`,
// server `result.lineItems`). Connects via DATABASE_PUBLIC_URL (see
// ops/agents/README.md prod access recipe). Prints to stdout only.

const { Client } = require('pg');

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const SINCE = args.since ? new Date(`${args.since}T00:00:00Z`) : null;
const LANE = ['pest', 'lawn', 'all'].includes(args.lane) ? args.lane : 'all';

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (n) => (n == null ? '—' : Math.round(n * 100) / 100);
const pct = (num, den) => (den > 0 ? `${Math.round((num / den) * 100)}%` : '—');
const FREQ_KEY_TO_APPS = { quarterly: 4, bimonthly: 6, monthly: 12 };
const LAWN_FREQ_KEY_TO_V = { '6x': 6, '9x': 9, '12x': 12 };

function outcomeOf(row) {
  if (row.status === 'accepted' || row.accepted_at) return 'accepted';
  if (row.status === 'expired') return 'expired';
  if (row.status === 'declined') return 'declined';
  return 'pending';
}

function identOf(row) {
  return row.customer_id
    || (row.address || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30)
    || row.customer_phone || row.customer_email || row.id;
}

function extractPest(row) {
  const d = row.estimate_data || {};
  const engRoot = d?.engineResult?.lineItems ? d.engineResult : (d?.result?.lineItems ? d.result : null);
  const engLine = engRoot?.lineItems?.find((l) => l?.service === 'pest_control');
  if (engLine) {
    const sqft = Number(engLine.footprintUsed ?? engRoot.property?.footprint ?? engRoot.property?.homeSqFt);
    const wantApps = FREQ_KEY_TO_APPS[row.accepted_frequency_key] ?? null;
    const tier = Array.isArray(engLine.tiers)
      ? (wantApps ? engLine.tiers.find((t) => Number(t.freq) === wantApps)
        : engLine.tiers.find((t) => t.selected || t.isSelected))
      : null;
    const perVisit = Number(tier?.perApp ?? engLine.perApp);
    return sqft > 0 && perVisit > 0 ? { sqft, perVisit } : null;
  }
  if (d?.result?.results?.pestTiers || d?.result?.results?.pest) {
    const tiers = d.result.results.pestTiers || [];
    const wantApps = FREQ_KEY_TO_APPS[row.accepted_frequency_key] ?? (Number(d.inputs?.pestFreq) || 4);
    const tier = tiers.find((t) => Number(t.apps ?? t.v) === wantApps) || d.result.results.pest || tiers[0];
    const perVisit = Number(tier?.pa);
    const sqft = Number(d.inputs?.homeSqFt) || Number(d.result?.property?.footprint);
    return sqft > 0 && perVisit > 0 ? { sqft, perVisit } : null;
  }
  return null;
}

function extractLawn(row) {
  const d = row.estimate_data || {};
  const engRoot = d?.engineResult?.lineItems ? d.engineResult : (d?.result?.lineItems ? d.result : null);
  const engLine = engRoot?.lineItems?.find((l) => l?.service === 'lawn_care');
  if (engLine) {
    const sqft = Number(engLine.turfSf ?? engLine.lawnSqFt ?? engRoot.property?.turfSf);
    const acceptedV = LAWN_FREQ_KEY_TO_V[row.accepted_frequency_key] ?? Number(row.accepted_frequency_key);
    const tier = Array.isArray(engLine.tiers)
      ? engLine.tiers.find((t) => Number(t.freq ?? t.v) === acceptedV)
      : null;
    const perApp = Number(tier?.perApp ?? engLine.perApp);
    return sqft > 0 && perApp > 0 ? { sqft, perApp } : null;
  }
  if (d?.result?.results?.lawn) {
    const tiers = d.result.results.lawn;
    const acceptedV = LAWN_FREQ_KEY_TO_V[row.accepted_frequency_key] ?? Number(row.accepted_frequency_key);
    const wantV = Number.isFinite(acceptedV) && acceptedV > 0 ? acceptedV : (Number(d.inputs?.lawnFreq) || 9);
    const tier = tiers.find((t) => Number(t.v) === wantV)
      || tiers.find((t) => t.recommended) || tiers.find((t) => Number(t.v) === 9) || tiers[0];
    const perApp = Number(tier?.pa);
    let sqft = Number(d.result?.lawnMeta?.lsf);
    if (!(sqft > 0)) sqft = Number(d.inputs?.measuredTurfSf);
    if (!(sqft > 0)) sqft = Number(d.result?.property?.lawnSqFt ?? d.result?.property?.turfSf);
    return sqft > 0 && perApp > 0 ? { sqft, perApp } : null;
  }
  return null;
}

// Dedup by customer: an accepted row wins the customer; otherwise the most
// recent non-draft row stands (input must be sorted created_at DESC).
function dedupe(rows) {
  const byIdent = new Map();
  for (const r of rows) {
    const cur = byIdent.get(r.ident);
    if (!cur) { byIdent.set(r.ident, r); continue; }
    if (cur.outcome !== 'accepted' && r.outcome === 'accepted') byIdent.set(r.ident, r);
  }
  return [...byIdent.values()];
}

function bandReport(rows, bands, valueOf, label) {
  console.log(`  ${label}:`);
  for (const [name, min, max] of bands) {
    const b = rows.filter((r) => valueOf(r) >= min && valueOf(r) < max);
    if (!b.length) continue;
    const acc = b.filter((r) => r.outcome === 'accepted').length;
    const pend = b.filter((r) => r.outcome === 'pending').length;
    const closed = b.length - pend;
    console.log(`    ${name.padEnd(14)} n=${String(b.length).padStart(3)}  accepted=${String(acc).padStart(2)}  close(closed)=${pct(acc, closed).padStart(4)}`);
  }
}

function laneSummary(rows, priceOf, priceLabel) {
  const acc = rows.filter((r) => r.outcome === 'accepted');
  const exp = rows.filter((r) => r.outcome === 'expired');
  const pend = rows.filter((r) => r.outcome === 'pending');
  const closed = rows.length - pend.length;
  console.log(`  customers=${rows.length}  accepted=${acc.length}  pending=${pend.length}  CLOSE RATE (closed)=${pct(acc.length, closed)}`);
  console.log(`  ${priceLabel} medians — accepted: ${r2(median(acc.map(priceOf)))} | expired: ${r2(median(exp.map(priceOf)))}  (identical medians = losses are not price losses)`);
}

(async () => {
  const conn = process.env.DATABASE_PUBLIC_URL;
  if (!conn) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres node ops/agents/pricing-funnel-report.js');
    process.exit(2);
  }
  const c = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = await c.query(`
    SELECT id, customer_id, address, customer_phone, customer_email, status,
           created_at, accepted_at, accepted_frequency_key, estimate_data
    FROM estimates
    WHERE status <> 'draft'
    ORDER BY created_at DESC`);
  await c.end();

  const all = [];
  for (const row of q.rows) {
    if (SINCE && row.created_at < SINCE) continue;
    const pest = extractPest(row);
    const lawn = extractLawn(row);
    if (!pest && !lawn) continue;
    all.push({ ident: identOf(row), outcome: outcomeOf(row), created: row.created_at, pest, lawn });
  }
  console.log(`Pricing funnel report — ${new Date().toISOString().slice(0, 10)}${SINCE ? ` (quotes since ${args.since})` : ' (all time)'}`);
  console.log(`quotes analyzed: ${all.length} (non-draft, pest and/or lawn priced)\n`);

  if (LANE !== 'lawn') {
    const pestSolo = dedupe(all.filter((r) => r.pest && !r.lawn));
    console.log('== PEST (solo — pest+lawn bundles excluded) ==');
    laneSummary(pestSolo, (r) => r.pest.perVisit, '$/visit');
    bandReport(pestSolo, [['<1,200', 0, 1200], ['1,200-1,799', 1200, 1800], ['1,800-2,499', 1800, 2500], ['2,500-3,499', 2500, 3500], ['3,500+', 3500, Infinity]], (r) => r.pest.sqft, 'by home sqft');
    bandReport(pestSolo, [['<$95', 0, 95], ['$95-109', 95, 110], ['$110-124', 110, 125], ['$125-149', 125, 150], ['$150+', 150, Infinity]], (r) => r.pest.perVisit, 'by $/visit');
    console.log('');
  }

  if (LANE !== 'pest') {
    const lawnAll = dedupe(all.filter((r) => r.lawn)).map((r) => ({ ...r, per1k: r.lawn.perApp / (r.lawn.sqft / 1000) }));
    console.log('== LAWN (bundled or solo) ==');
    laneSummary(lawnAll, (r) => r.per1k, '$/1k-sqft/app');
    bandReport(lawnAll, [['<2,000', 0, 2000], ['2,000-2,999', 2000, 3000], ['3,000-4,499', 3000, 4500], ['4,500-6,499', 4500, 6500], ['6,500-9,999', 6500, 10000], ['10,000+', 10000, Infinity]], (r) => r.lawn.sqft, 'by treatable sqft');
    bandReport(lawnAll, [['<$12/1k', 0, 12], ['$12-16', 12, 16], ['$16-20', 16, 20], ['$20-28', 20, 28], ['$28+', 28, Infinity]], (r) => r.per1k, 'by $/1k-sqft/app (dead zone was $20-28)');
    console.log('');
  }

  if (LANE === 'all') {
    const bundles = dedupe(all.filter((r) => r.pest && r.lawn));
    console.log('== PEST+LAWN BUNDLES ==');
    laneSummary(bundles, (r) => r.pest.perVisit, 'pest $/visit');
    console.log('');
  }

  console.log('Decision guide: identical accepted/expired medians = losses are not price');
  console.log('losses. A 0% band with n>=10 = structural (shape) problem. Compare any');
  console.log('--since cut against the all-time run before moving a bracket cell.');
})().catch((e) => { console.error(e.message); process.exit(1); });
