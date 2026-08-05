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

const path = require('path');
const { Client } = require('pg');
const {
  INTERNAL_TEST_CUSTOMERS,
  isInternalTestCustomerId,
  isInternalTestEmail,
} = require(path.join(__dirname, '..', '..', 'server', 'services', 'internal-test-customers'));

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
// accepted_frequency_key stores the PUBLIC UI keys (estimate-public):
// pest 'bi_monthly', lawn tier keys 'standard'/'enhanced'/'premium' — not
// the engine spellings (codex #3199). Both key-spaces map here.
const FREQ_KEY_TO_APPS = {
  quarterly: 4, bimonthly: 6, bi_monthly: 6, monthly: 12,
};
const LAWN_FREQ_KEY_TO_V = {
  '6x': 6, '9x': 9, '12x': 12,
  basic: 4, standard: 6, enhanced: 9, premium: 12, every_6_weeks: 9, bi_monthly: 6, monthly: 12,
};

function outcomeOf(row) {
  if (row.status === 'accepted' || row.accepted_at) {
    // A one-time accept clears accepted_frequency_key and stamps
    // accepted_service_mode='one_time' — the RECURRING offer was not
    // bought; count it as a closed non-win, tallied separately
    // (codex #3199).
    return row.accepted_service_mode === 'one_time' ? 'accepted_one_time' : 'accepted';
  }
  if (row.status === 'expired') return 'expired';
  if (row.status === 'declined') return 'declined';
  // Archived sent/viewed rows are closed courtships — the public gate
  // rejects archived tokens, so the offer is dead regardless of status
  // (codex #3199 r3). Count them as expired losses, not pending.
  if (row.archived_at) return 'expired';
  // Sent/viewed rows past their expiry are dead offers the customer can no
  // longer accept — expired in substance even before the sweep flips the
  // status (codex #3199).
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';
  return 'pending';
}

function identOf(row) {
  // customer_id, then normalized CONTACT, then address as a last-resort
  // property fallback — address-first collapsed two different customers at
  // one address and double-counted a customer re-quoted at a corrected
  // address (codex #3199).
  const phone = (row.customer_phone || '').replace(/[^0-9]/g, '');
  const email = (row.customer_email || '').trim().toLowerCase();
  return row.customer_id
    || (phone.length >= 10 ? `p:${phone.slice(-10)}` : '')
    || (email ? `e:${email}` : '')
    || (row.address || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30)
    || row.id;
}

// engineInputs-only payloads (no stored result/engineResult) are
// customer-renderable — the public path replays generateEstimate live. For
// SINGLE-service rows, price from the estimate row's own annual_total (the
// billed number) rather than replaying with today's constants, which would
// re-price history; multi-service engineInputs-only rows stay counted in
// the unpriceable tally (codex #3199 r4).
function extractEngineInputsOnly(row, lane) {
  const d = row.estimate_data || {};
  if (d.result || d.engineResult) return null;
  const services = d.engineInputs?.services;
  if (!services || typeof services !== 'object') return null;
  const keys = Object.keys(services).filter((k) => services[k]);
  if (keys.length !== 1 || keys[0] !== lane) return null;
  const annual = Number(row.annual_total);
  if (!(annual > 0)) return null;
  if (lane === 'pest') {
    const sqft = Number(d.engineInputs?.homeSqFt);
    const visits = FREQ_KEY_TO_APPS[String(services.pest?.frequency || '').toLowerCase()] || 4;
    const perVisit = Math.round((annual / visits) * 100) / 100;
    return sqft > 0 && perVisit > 0 ? { sqft, perVisit } : null;
  }
  const sqft = Number(d.engineInputs?.measuredTurfSf ?? d.engineInputs?.lotSqFt);
  const visits = LAWN_FREQ_KEY_TO_V[String(services.lawn?.lawnFreq ?? '')]
    || Number(services.lawn?.lawnFreq) || 9;
  const perApp = Math.round((annual / visits) * 100) / 100;
  return sqft > 0 && perApp > 0 ? { sqft, perApp } : null;
}

function extractPest(row) {
  const d = row.estimate_data || {};
  const engRoot = d?.engineResult?.lineItems ? d.engineResult : (d?.result?.lineItems ? d.result : null);
  const engLine = engRoot?.lineItems?.find((l) => l?.service === 'pest_control');
  if (engLine) {
    // Quote-wizard mirrors store compact rows without footprint/property —
    // fall back to the quote inputs so that channel stays in the funnel
    // (codex #3199).
    const sqft = Number(engLine.footprintUsed ?? engRoot.property?.footprint
      ?? engRoot.property?.homeSqFt ?? d.engineInputs?.homeSqFt ?? d.inputs?.homeSqFt
      ?? d.enriched?.homeSqFt ?? d.enriched?.footprint);
    // Accepted cadence: bundles persist per-service choices in
    // customerSelection.serviceCadences; the row-level key is the
    // top-level/pest selection (codex #3199 r2).
    const cadenceKey = d.customerSelection?.serviceCadences?.pest_control
      ?? row.accepted_frequency_key;
    const wantApps = FREQ_KEY_TO_APPS[cadenceKey] ?? null;
    const tier = Array.isArray(engLine.tiers)
      ? (wantApps ? engLine.tiers.find((t) => Number(t.freq) === wantApps)
        : engLine.tiers.find((t) => t.selected || t.isSelected))
      : null;
    // Net over gross, TIER-FIRST (codex #3199 r2): the persisted line's
    // annualAfterDiscount belongs to the line's OWN cadence — dividing it
    // by a different accepted tier's visit count invents a price. Price
    // from the accepted tier's own gross, then apply the line's discount
    // as a RATIO.
    const grossLineAnnual = Number(engLine.annualBeforeDiscount ?? engLine.annual);
    // manualFinalAnnual is the post-manual-discount price (stamped after
    // annualAfterDiscount, which is post-WaveGuard only) — prefer it
    // (codex #3199 r3).
    const netLineAnnual = Number(engLine.manualFinalAnnual ?? engLine.annualAfterDiscount);
    // Floor/cap guard (codex #3199 r3): a floor-capped or discount-capped
    // line's net/gross ratio is NOT transferable to another tier (the cap
    // belongs to the stored cadence). Band those rows on gross — an honest
    // approximation for a band-level decision instrument; exact per-tier
    // floor clamping is the production accept path's job, and floors are
    // disarmed since 2026-07-17 so the affected rows are historical.
    const ratioTransferable = engLine.programFloorApplied !== true
      && engLine.marginGuardApplied !== true
      && engLine.discountCapped !== true
      && engLine.programMinimumApplied !== true;
    const discountRatio = ratioTransferable
      && Number.isFinite(netLineAnnual) && Number.isFinite(grossLineAnnual)
      && grossLineAnnual > 0 && netLineAnnual > 0 && netLineAnnual <= grossLineAnnual
      ? netLineAnnual / grossLineAnnual : 1;
    let perVisit;
    if (tier && Number(tier.perApp) > 0) {
      perVisit = Math.round(Number(tier.perApp) * discountRatio * 100) / 100;
    } else {
      // Compact mirror lines can carry frequency as a STRING key
      // ('bimonthly'/'monthly') with visitsPerYear absent — resolve through
      // the cadence map before dividing (codex #3199 r4).
      const visits = Number(engLine.visitsPerYear)
        || FREQ_KEY_TO_APPS[String(engLine.frequency || '').toLowerCase()]
        || Number(engLine.frequency) || 4;
      perVisit = Number.isFinite(netLineAnnual) && netLineAnnual > 0
        ? Math.round((netLineAnnual / visits) * 100) / 100
        : Number(engLine.perApp);
    }
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
  return extractEngineInputsOnly(row, 'pest');
}

function extractLawn(row) {
  const d = row.estimate_data || {};
  const engRoot = d?.engineResult?.lineItems ? d.engineResult : (d?.result?.lineItems ? d.result : null);
  const engLine = engRoot?.lineItems?.find((l) => l?.service === 'lawn_care');
  if (engLine) {
    const sqft = Number(engLine.turfSf ?? engLine.lawnSqFt ?? engRoot.property?.turfSf
      ?? engRoot.property?.lawnSqFt ?? d.engineInputs?.measuredTurfSf ?? d.inputs?.measuredTurfSf
      ?? d.enriched?.measuredTurfSf ?? d.enriched?.turfSf ?? d.enriched?.lawnSqFt);
    const lawnCadenceKey = d.customerSelection?.serviceCadences?.lawn_care
      ?? row.accepted_frequency_key;
    const acceptedV = LAWN_FREQ_KEY_TO_V[lawnCadenceKey] ?? Number(lawnCadenceKey);
    const tier = Array.isArray(engLine.tiers)
      ? engLine.tiers.find((t) => Number(t.freq ?? t.v) === acceptedV)
      : null;
    // Tier-first net pricing — mirror of the pest handling (codex #3199 r2),
    // with the same manualFinalAnnual preference and floor/cap ratio guard
    // (r3): a program-minimum- or margin-floor-capped lawn line's ratio is
    // not transferable to another tier; band those on gross.
    const grossLineAnnual = Number(engLine.annualBeforeDiscount ?? engLine.annual);
    const netLineAnnual = Number(engLine.manualFinalAnnual ?? engLine.annualAfterDiscount);
    const ratioTransferable = engLine.programMinimumApplied !== true
      && engLine.costFloorApplied !== true
      && engLine.marginGuardApplied !== true
      && engLine.discountCapped !== true;
    const discountRatio = ratioTransferable
      && Number.isFinite(netLineAnnual) && Number.isFinite(grossLineAnnual)
      && grossLineAnnual > 0 && netLineAnnual > 0 && netLineAnnual <= grossLineAnnual
      ? netLineAnnual / grossLineAnnual : 1;
    let perApp;
    if (tier && Number(tier.perApp) > 0) {
      perApp = Math.round(Number(tier.perApp) * discountRatio * 100) / 100;
    } else {
      const visits = Number(engLine.frequency)
        || LAWN_FREQ_KEY_TO_V[String(engLine.frequency || '').toLowerCase()]
        || 9;
      perApp = Number.isFinite(netLineAnnual) && netLineAnnual > 0
        ? Math.round((netLineAnnual / visits) * 100) / 100
        : Number(engLine.perApp);
    }
    return sqft > 0 && perApp > 0 ? { sqft, perApp } : null;
  }
  if (d?.result?.results?.lawn) {
    const tiers = d.result.results.lawn;
    const clientLawnKey = d.customerSelection?.serviceCadences?.lawn_care
      ?? row.accepted_frequency_key;
    const acceptedV = LAWN_FREQ_KEY_TO_V[clientLawnKey] ?? Number(clientLawnKey);
    const wantV = Number.isFinite(acceptedV) && acceptedV > 0 ? acceptedV : (Number(d.inputs?.lawnFreq) || 9);
    const tier = tiers.find((t) => Number(t.v) === wantV)
      || tiers.find((t) => t.recommended) || tiers.find((t) => Number(t.v) === 9) || tiers[0];
    const perApp = Number(tier?.pa);
    let sqft = Number(d.result?.lawnMeta?.lsf);
    if (!(sqft > 0)) sqft = Number(d.inputs?.measuredTurfSf);
    if (!(sqft > 0)) sqft = Number(d.result?.property?.lawnSqFt ?? d.result?.property?.turfSf);
    return sqft > 0 && perApp > 0 ? { sqft, perApp } : null;
  }
  return extractEngineInputsOnly(row, 'lawn');
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
  const otAcc = rows.filter((r) => r.outcome === 'accepted_one_time');
  const exp = rows.filter((r) => r.outcome === 'expired');
  const pend = rows.filter((r) => r.outcome === 'pending');
  const closed = rows.length - pend.length;
  console.log(`  customers=${rows.length}  accepted=${acc.length}${otAcc.length ? `  one-time-accepts=${otAcc.length} (closed non-wins for the recurring funnel)` : ''}  pending=${pend.length}  CLOSE RATE (closed)=${pct(acc.length, closed)}`);
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
    SELECT id, customer_id, address, customer_name, customer_phone, customer_email, status,
           created_at, accepted_at, accepted_frequency_key, accepted_service_mode,
           expires_at, archived_at, annual_total, estimate_data
    FROM estimates
    WHERE status IN ('sent', 'viewed', 'accepted', 'declined', 'expired')
    ORDER BY created_at DESC`);
  await c.end();

  const all = [];
  let unpriceable = 0;
  let internalExcluded = 0;
  for (const row of q.rows) {
    if (SINCE && row.created_at < SINCE) continue;
    // Repo-standard internal/test exclusion (shared with the IB dashboard
    // and MRR metrics) so owner test accounts never move the funnel
    // (codex #3199 r4).
    const name = String(row.customer_name || '').trim().toLowerCase();
    if (INTERNAL_TEST_CUSTOMERS.includes(name)
      || isInternalTestCustomerId(row.customer_id)
      || isInternalTestEmail(row.customer_email)) { internalExcluded++; continue; }
    const pest = extractPest(row);
    const lawn = extractLawn(row);
    if (!pest && !lawn) { unpriceable++; continue; }
    all.push({ ident: identOf(row), outcome: outcomeOf(row), created: row.created_at, pest, lawn });
  }
  console.log(`Pricing funnel report — ${new Date().toISOString().slice(0, 10)}${SINCE ? ` (quotes since ${args.since})` : ' (all time)'}`);
  console.log(`quotes analyzed: ${all.length} (sent/viewed/accepted/declined/expired with a priceable pest or lawn line)`);
  if (unpriceable) console.log(`dropped as unpriceable (no pest/lawn line extractable — includes non-pest/lawn service quotes): ${unpriceable}`);
  if (internalExcluded) console.log(`internal/test customer quotes excluded (shared INTERNAL_TEST_CUSTOMERS list): ${internalExcluded}`);
  console.log('');

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
