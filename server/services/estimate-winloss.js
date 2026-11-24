/**
 * Estimate win/loss slicing by property-lookup fieldVerifyFlags and price
 * band (estimator backlog, final item).
 *
 * The question this answers: do estimates built on UNVERIFIED property
 * facts (the lookup profile's fieldVerifyFlags review nudges) lose more
 * often — and in which price bands does verification matter most? That
 * tells Adam where field-verify effort buys conversion.
 *
 * Resolved-only semantics match the client's PipelineAnalytics exactly:
 * won = accepted OR booked another way (disposition group 'won_elsewhere',
 * e.g. an estimate that expired before its customer converted), lost =
 * declined or expired; open offers never count.
 * Resolution date uses the same fallback chain as resolutionDate() there.
 *
 * Aggregation is plain JS over a slim knex select: resolved volume in a
 * 7-365 day window is small, estimate_data is jsonb (pg pre-parses), and
 * the profile lives under BOTH historical shapes (engineRequest.profile —
 * admin creates — and flattened engineInputs — public/lead creates), same
 * dual-shape rule estimate-actuals handles. No raw SQL.
 */

const db = require('../models/db');
const logger = require('./logger');
const { DISPOSITIONS, dispositionGroup, dispositionFromDeclineReason, expiredDispositionFor } = require('./estimate-disposition');
const { inferEstimateServiceLines, SERVICE_LINE_LABELS } = require('./estimate-service-lines');
const {
  SELF_SERVE_ESTIMATE_SOURCES, isUndeliveredSelfServe, countableViewAtSql, firstDeliveredAtMs,
} = require('./self-serve-estimates');

const RESOLVED_STATUSES = ['accepted', 'declined', 'expired'];

// Sent-cohort maturities (estimator audit 2026-08-29 §5): conversion is
// measured from SENT date at fixed ages so a 3-day-old open estimate is
// neither a loss nor silently dropped from the denominator.
const COHORT_MATURITY_DAYS = [7, 14, 30, 60, 90];
const DAY_MS = 86400000;

// Fixed, documented ANALYTICS bands — display buckets only, deliberately
// not pricing config. Re-banding is a copy change, not a pricing decision.
const RECURRING_BANDS = [
  { key: 'under_60', label: '<$60/mo', min: 0, max: 60 },
  { key: '60_90', label: '$60–89/mo', min: 60, max: 90 },
  { key: '90_130', label: '$90–129/mo', min: 90, max: 130 },
  { key: '130_plus', label: '$130+/mo', min: 130, max: Infinity },
];
const ONETIME_BANDS = [
  { key: 'under_150', label: '<$150', min: 0, max: 150 },
  { key: '150_300', label: '$150–299', min: 150, max: 300 },
  { key: '300_600', label: '$300–599', min: 300, max: 600 },
  { key: '600_plus', label: '$600+', min: 600, max: Infinity },
];

function parseEstimateData(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  } catch {
    return {};
  }
}

function profileFromEstimateData(data) {
  // THREE persisted generations: admin creates nest the enriched profile at
  // engineRequest.profile, quote-wizard estimates store it at
  // estimate_data.enriched (public-quote.js writes `enriched: ep`), and v1
  // rows flatten pricing inputs as engineInputs. The first two are enriched
  // profiles by construction. engineInputs is just the pricing-input shape —
  // often manual/AI/user-entered values with NO lookup provenance — so it
  // only counts as a lookup profile when enrichment markers actually
  // survived on it; otherwise the row is "no lookup profile", never "clean".
  const direct = data?.engineRequest?.profile || data?.enriched;
  if (direct) return direct;
  const inputs = data?.engineInputs;
  if (
    inputs
    && (Array.isArray(inputs.fieldVerifyFlags)
      || inputs.propertyDataQuality
      || inputs.dataSources)
  ) {
    return inputs;
  }
  return null;
}

function verifyFlagsFrom(profile) {
  const flags = profile?.fieldVerifyFlags;
  if (!Array.isArray(flags)) return [];
  return flags.filter((f) => f && typeof f.field === 'string' && f.field.length);
}

// Mirror of the client's resolutionDate() fallback chain, on snake_case
// row columns. Returns NaN-safe ms or null.
function resolutionDateMs(row) {
  const pick = (...candidates) => {
    for (const value of candidates) {
      if (!value) continue;
      const ts = new Date(value).getTime();
      if (Number.isFinite(ts)) return ts;
    }
    return null;
  };
  if (row.status === 'accepted') return pick(row.accepted_at, row.created_at);
  if (row.status === 'declined') return pick(row.declined_at, row.updated_at, row.created_at);
  // An expired row reclaimed as booked another way (converted_other_path)
  // keeps its expires_at: the win lands in the same window the loss would
  // have, so a later reclaim never re-writes the window it is counted in.
  if (row.status === 'expired') return pick(row.expires_at, row.updated_at, row.created_at);
  // A live sent/viewed row archived with a disposition (archived_unresolved,
  // a staff reason, converted_other_path) resolved when it was classified —
  // codex pre-push P1: these rows must reach byDisposition or the archive
  // route's "stays in the loss picture" guarantee is false.
  if (row.disposition && row.archived_at) return pick(row.disposition_at, row.archived_at, row.updated_at, row.created_at);
  return null;
}

function bandFor(bands, amount) {
  return bands.find((b) => amount >= b.min && amount < b.max) || null;
}

function emptyCell() {
  return { won: 0, lost: 0, total: 0, winRatePct: null };
}

function tally(cell, isWon) {
  cell.total += 1;
  if (isWon) cell.won += 1;
  else cell.lost += 1;
}

function finalize(cell) {
  cell.winRatePct = cell.total > 0
    ? Math.round((cell.won / cell.total) * 1000) / 10
    : null;
  return cell;
}

// Disposition for a resolved row: the stamped column when present, else the
// same derivation the sweep/backfill use (pre-migration rows, or a decline
// that came through an older client), so the slice never shows a hole.
function effectiveDisposition(row) {
  if (row.disposition) return row.disposition;
  if (row.status === 'expired') return expiredDispositionFor(row);
  // A declined row with no reason at all predates the disposition layer's
  // required-reason PATCH — only the public customer button wrote those.
  if (row.status === 'declined') return dispositionFromDeclineReason(row.decline_reason) || 'declined_by_customer';
  return null;
}

// Rows that are not real demand (invalid/duplicate/out-of-area) must not
// sit in a win-RATE denominator. A customer who converted another way is
// NOT excluded here: an unarchived such row (an expired offer the daily
// reclaim stamped) is a win (isBookedOtherWay).
function excludedFromRates(disposition) {
  return dispositionGroup(disposition) === 'dead';
}

// The customer bought some other way after the offer expired: counts as WON
// in every win rate.
function isBookedOtherWay(disposition) {
  return dispositionGroup(disposition) === 'won_elsewhere';
}

// The open sweep ARCHIVES the live offers of customers who converted another
// way. Those rows stay out of every rate and cohort exactly as before (the
// archive-symmetric rule): only an unarchived one counts as won.
function isArchivedBookedOtherWay(row, disposition) {
  return Boolean(row.archived_at) && isBookedOtherWay(disposition);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}

function ms(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function tallyKeyed(map, key, isWon) {
  if (!map.has(key)) map.set(key, emptyCell());
  tally(map.get(key), isWon);
}

function keyedToList(map, labelFor = (k) => k, sortByTotal = true) {
  const list = [...map.entries()].map(([key, cell]) => ({ key, label: labelFor(key), ...finalize(cell) }));
  return sortByTotal ? list.sort((a, b) => b.total - a.total) : list;
}

function lostAtMs(row, sentAt, archivedLoss) {
  if (row.status === 'declined') return ms(row.declined_at) ?? ms(row.updated_at) ?? sentAt;
  if (row.status === 'expired') return ms(row.expires_at) ?? ms(row.updated_at) ?? sentAt;
  return archivedLoss ? (ms(row.disposition_at) ?? ms(row.archived_at) ?? sentAt) : null;
}

// When a row was won and/or lost, for the cohort funnel. Booked another way
// is won when the system classified it (disposition_at, the customer's
// earliest conversion signal). An expired row keeps its expiry as lostAt, so a cohort
// mature before the booking still reads lost and one mature after it reads
// won. Only an accept or a decline counts as a "decision" for timing.
function outcomeTimes(row, disposition, sentAt) {
  const acceptedAt = row.status === 'accepted' ? (ms(row.accepted_at) ?? sentAt) : null;
  const bookedAt = isBookedOtherWay(disposition)
    ? (ms(row.disposition_at) ?? ms(row.expires_at) ?? sentAt)
    : null;
  const archivedLoss = Boolean(row.archived_at && disposition) && bookedAt == null;
  const lostAt = lostAtMs(row, sentAt, archivedLoss);
  return {
    acceptedAt,
    wonAt: acceptedAt ?? bookedAt,
    lostAt,
    decidedAt: acceptedAt ?? (row.status === 'declined' ? lostAt : null),
  };
}

// Sent-cohort funnel: each maturity M reports every estimate sent in the
// M-days-shifted window [now-(days+M), now-M] — a full `days`-wide cohort
// that has had exactly M days to resolve, so even the M=days bucket has a
// real population (codex pre-push P1: filtering to the base window made
// the longest bucket structurally empty). Sent-volume/view/timing stats
// come from the unshifted base window (the recent story).
function sentCohorts(rows, { days, nowMs }) {
  const maturities = COHORT_MATURITY_DAYS.filter((m) => m <= days);
  const cohorts = maturities.map((maturityDays) => ({
    maturityDays, sent: 0, won: 0, lost: 0, open: 0, winRatePct: null, lossRatePct: null,
  }));
  const hoursToFirstView = [];
  const daysToDecision = [];
  let sentTotal = 0;
  let viewedTotal = 0;

  const baseCutoff = nowMs - days * DAY_MS;
  for (const row of rows) {
    const sentAt = sentAnchorMs(row);
    if (sentAt == null) continue;
    const disposition = effectiveDisposition(row);
    if (excludedFromRates(disposition) || isArchivedBookedOtherWay(row, disposition)) continue;
    // Archived rows KEEP their historical outcome — dropping them re-wrote
    // past cohort rates every time a row was tidied away (codex pre-push
    // P1, survivorship bias). Only an archived live row with no
    // classification at all is skipped: it has no outcome to report.
    if (row.archived_at && !disposition && !RESOLVED_STATUSES.includes(row.status)) continue;
    const inBaseWindow = sentAt >= baseCutoff;
    // CTA mints self-redirect to the page at mint time, stamping view
    // signals BEFORE any real delivery — for that source only a view at or
    // after the delivery anchor counts as an opened send (GH codex P2).
    // plan_restart shares the publish-without-delivery shape (C4): its
    // self-serve redirect stamps view signals at mint too. So does plan_start
    // (portal pricing card, GATE_PORTAL_PLAN_START). countable_view_at
    // (countableViewAtSql) is the earliest open since delivery in the open log
    // or the row, so a later reopen never stands in for their first view
    // (codex pre-push P1). It is their only view stamp: SQL bounds it by the
    // delivery at full precision, while a raw viewed_at or last_viewed_at
    // can sit in the delivery's own millisecond (codex pre-push P1). Every
    // other row keeps main's view stamps.
    const isCtaMint = SELF_SERVE_ESTIMATE_SOURCES.includes(String(row.source || ''));
    const viewCandidates = (isCtaMint ? [ms(row.countable_view_at)] : [ms(row.viewed_at), ms(row.last_viewed_at)])
      .filter((ts) => ts != null && (!isCtaMint || ts >= sentAt));
    const firstView = viewCandidates.length ? Math.min(...viewCandidates) : null;
    if (inBaseWindow) {
      sentTotal += 1;
      const opened = firstView != null
        || (!isCtaMint && ((Number(row.view_count) || 0) > 0 || row.status === 'viewed'));
      if (opened) viewedTotal += 1;
      if (firstView != null && firstView >= sentAt) hoursToFirstView.push((firstView - sentAt) / 3600000);
    }

    const { wonAt, lostAt, decidedAt } = outcomeTimes(row, disposition, sentAt);
    if (inBaseWindow && decidedAt != null && decidedAt >= sentAt) daysToDecision.push((decidedAt - sentAt) / DAY_MS);

    for (const cohort of cohorts) {
      const horizon = sentAt + cohort.maturityDays * DAY_MS;
      if (horizon > nowMs) continue; // not mature yet for this age
      if (sentAt < nowMs - (days + cohort.maturityDays) * DAY_MS) continue; // outside this bucket's shifted window
      cohort.sent += 1;
      if (wonAt != null && wonAt <= horizon) cohort.won += 1;
      else if (lostAt != null && lostAt <= horizon) cohort.lost += 1;
      else cohort.open += 1;
    }
  }

  for (const cohort of cohorts) {
    cohort.winRatePct = cohort.sent > 0 ? Math.round((cohort.won / cohort.sent) * 1000) / 10 : null;
    cohort.lossRatePct = cohort.sent > 0 ? Math.round((cohort.lost / cohort.sent) * 1000) / 10 : null;
  }
  return {
    sentTotal,
    viewedTotal,
    viewRatePct: sentTotal > 0 ? Math.round((viewedTotal / sentTotal) * 1000) / 10 : null,
    medianHoursToFirstView: median(hoursToFirstView),
    medianDaysToDecision: median(daysToDecision),
    cohorts,
  };
}

// Cohort anchor = FIRST real delivery, not sent_at (GH codex P1, mirroring
// estimate-source-performance): every resend overwrites sent_at (resetting
// cohort age and stranding viewed_at before it), and service_report_cta
// mints stamp sent_at with NOTHING delivered — those anchor on the
// deliveryState.firstDeliveredAt an operator's later real handoff wrote,
// or drop out entirely. Generic rows anchor on the EARLIEST surviving
// delivery evidence (a view or accept cannot precede first delivery).
function sentAnchorMs(row) {
  const data = parseEstimateData(row.estimate_data);
  // sendEstimateNow persists the FIRST handoff durably at
  // deliveryState.firstDeliveredAt — the one witness a resend can't move
  // (GH codex P1: an unopened resend must keep its original cohort age).
  // A self-serve mint anchors where the Intelligence Bar dates its send
  // (self-serve-estimates.js deliveredAtSql, codex pre-push P1): its first
  // delivery read by the shared strict rule, sent_at when the stamp is
  // there but unreadable, none while undelivered.
  if (SELF_SERVE_ESTIMATE_SOURCES.includes(String(row.source || ''))) {
    return isUndeliveredSelfServe(row.source, data) ? null : (firstDeliveredAtMs(data) ?? ms(row.sent_at));
  }
  // Every other source keeps main's lenient read of the stamp (codex
  // pre-push P1): the strict rule exists for the self-serve report anchor
  // only, and must not move a staff quote to another cohort.
  const candidates = [ms(data?.deliveryState?.firstDeliveredAt), ms(row.sent_at), ms(row.viewed_at), ms(row.accepted_at)]
    .filter((ts) => ts != null);
  return candidates.length ? Math.min(...candidates) : null;
}

const SLICE_COLUMNS = [
  'id', 'status', 'accepted_at', 'declined_at', 'expires_at',
  'created_at', 'updated_at', 'archived_at', 'monthly_total',
  'onetime_total', 'estimate_data',
  // Disposition / cohort / slice inputs (estimator audit 2026-08-29).
  'sent_at', 'viewed_at', 'last_viewed_at', 'view_count',
  'lead_source', 'source', 'waveguard_tier', 'disposition', 'disposition_at',
  'decline_reason', 'service_interest', 'notes',
];

// Estimate ids that carry the customer's "still deciding" signal. Best-effort:
// an activity_log read failure degrades the card to "no signals", never to a
// failed slice build.
async function stillDecidingEstimateIds(estimateIds) {
  const ids = (estimateIds || []).map(String).filter(Boolean);
  if (!ids.length) return new Set();
  try {
    const marks = await db('activity_log')
      .whereIn('estimate_id', ids)
      .where({ action: 'estimate_customer_still_deciding' })
      .select('estimate_id');
    return new Set((Array.isArray(marks) ? marks : []).map((m) => String(m?.estimate_id || '')).filter(Boolean));
  } catch (err) {
    logger.warn(`[estimate-winloss] still-deciding read skipped: ${err.message}`);
    return new Set();
  }
}

async function winLossSlices({ days = 90 } = {}) {
  const cutoffMs = Date.now() - days * 86400000;
  const cutoff = new Date(cutoffMs);
  // Window prefilter is a deliberate SUPERSET built from every column the
  // resolution-date chain can pick (the admin decline patch stamps
  // declined_at WITHOUT touching updated_at, so updated_at alone would drop
  // a freshly-declined old estimate); the precise resolution-date filter
  // below trims to the real window.
  const rows = await db('estimates')
    // Resolved statuses, PLUS archived live rows that carry a disposition —
    // their loss classification lives only in that column (status stays
    // sent/viewed on archive).
    .where((q) => q.whereIn('status', RESOLVED_STATUSES).orWhereNotNull('disposition'))
    .where((q) => q
      .where('accepted_at', '>=', cutoff)
      .orWhere('declined_at', '>=', cutoff)
      .orWhere('expires_at', '>=', cutoff)
      .orWhere('disposition_at', '>=', cutoff)
      .orWhere('updated_at', '>=', cutoff)
      .orWhere('created_at', '>=', cutoff))
    .select(...SLICE_COLUMNS);
  // Second, status-agnostic read for the sent-cohort funnel: everything sent
  // inside the window, open offers included (they are the "open" bar).
  // Archived rows deliberately INCLUDED — sentCohorts keeps their
  // historical outcome (see the survivorship note there). The read reaches
  // back days + the longest applicable maturity so every cohort bucket has
  // its full shifted window (codex pre-push P1).
  const maxMaturity = COHORT_MATURITY_DAYS.filter((m) => m <= days).pop() || 0;
  const cohortWindowStart = new Date(cutoffMs - maxMaturity * DAY_MS);
  const sentRows = await db('estimates')
    // Delivery evidence, not just sent_at (GH codex P1): a customer accept
    // that wins the in-flight 'sending' claim finalizes WITHOUT sent_at but
    // persists deliveryState.firstDeliveredAt — same evidence set
    // estimate-source-performance uses. Superset prefilter; sentAnchorMs
    // does the precise anchoring in JS.
    .where((q) => q
      .whereNotNull('sent_at')
      .orWhereNotNull('accepted_at')
      .orWhereIn('status', ['sent', 'viewed', 'accepted'])
      .orWhereRaw("estimate_data #>> '{deliveryState,firstDeliveredAt}' IS NOT NULL"))
    .where((q) => q
      .where('sent_at', '>=', cohortWindowStart)
      .orWhere('viewed_at', '>=', cohortWindowStart)
      .orWhere('accepted_at', '>=', cohortWindowStart)
      .orWhere('updated_at', '>=', cohortWindowStart)
      .orWhere('created_at', '>=', cohortWindowStart))
    .select(...SLICE_COLUMNS, db.raw(`${countableViewAtSql('estimates')} AS countable_view_at`));

  const totals = emptyCell();
  const byFlagPresence = {
    clean: emptyCell(),
    flagged: emptyCell(),
    // Estimates with no lookup profile at all (manual/legacy) — kept out of
    // clean so "clean" genuinely means "looked up and nothing to verify".
    noProfile: emptyCell(),
  };
  const byFlagField = new Map();
  const byFlagPriority = { HIGH: emptyCell(), MEDIUM: emptyCell(), LOW: emptyCell() };
  const byPriceBand = {
    recurring: RECURRING_BANDS.map((b) => ({ key: b.key, label: b.label, ...emptyCell() })),
    oneTime: ONETIME_BANDS.map((b) => ({ key: b.key, label: b.label, ...emptyCell() })),
  };
  // The headline cross-slice: recurring price band × flagged/clean.
  const recurringBandsByFlag = RECURRING_BANDS.map((b) => ({
    key: b.key,
    label: b.label,
    clean: emptyCell(),
    flagged: emptyCell(),
  }));
  // Audit slices: why we lose, and win rate by service line / lead source /
  // WaveGuard tier. Every input is a persisted column or the persisted
  // estimate_data — never today's price constants.
  const byDispositionCount = new Map();
  // "Still deciding" — the soft-exit sheet's one-tap signal (activity_log,
  // never an estimate write). Joined here so an expired estimate whose
  // customer said "still deciding" can be told apart from one that went
  // silent (GH codex P2 on #3706). Read AFTER both estimate reads.
  const stillDecidingIds = await stillDecidingEstimateIds(rows.map((r) => r.id));
  const stillDeciding = { signaled: 0, wonAfter: 0, lostAfter: 0, expiredViewedAfter: 0 };
  const byServiceLine = new Map();
  const byLeadSource = new Map();
  const byWaveguardTier = new Map();
  let wonBookedOtherWay = 0;
  let archivedBookedOtherWayCount = 0;

  for (const row of rows) {
    // This card reports RATES, so archived rows drop symmetrically —
    // PipelineAnalytics computes close-rate from activeRows (non-archived)
    // for exactly this reason: archived losses are never fetched, so
    // counting archived wins would skew rates upward. (Its archived-accepted
    // carve-out feeds only the VOLUME funnel/MRR KPIs, not rates.)
    const resolvedAt = resolutionDateMs(row);
    if (resolvedAt == null || resolvedAt < cutoffMs) continue;
    const accepted = row.status === 'accepted';
    const estimateData = parseEstimateData(row.estimate_data);

    const disposition = accepted ? null : effectiveDisposition(row);
    const archivedWin = isArchivedBookedOtherWay(row, disposition);
    if (archivedWin) archivedBookedOtherWayCount += 1;
    const bookedOtherWay = isBookedOtherWay(disposition) && !archivedWin;
    const isWon = accepted || bookedOtherWay;
    if (disposition) byDispositionCount.set(disposition, (byDispositionCount.get(disposition) || 0) + 1);
    if (stillDecidingIds.has(String(row.id))) {
      stillDeciding.signaled += 1;
      // Only a REAL loss counts as lost — a reclaimed booked-another-way row
      // is a win; dead and archived converted rows leave every loss metric
      // (GH codex r3 P2).
      if (isWon) stillDeciding.wonAfter += 1;
      else if (disposition && !excludedFromRates(disposition) && !archivedWin) stillDeciding.lostAfter += 1;
      if (disposition === 'expired_viewed') stillDeciding.expiredViewedAfter += 1;
    }
    // Archived rows still drop from every RATE symmetrically (archived
    // losses and wins leave together — same reasoning as PipelineAnalytics'
    // activeRows), but their classification above stays in "why we lose":
    // archiving no longer erases a loss from the story (codex pre-push P1).
    if (row.archived_at) continue;
    // Dead rows are counted in "why we lose" above but leave every RATE
    // denominator — they were never a winnable offer.
    if (disposition && excludedFromRates(disposition)) continue;
    tally(totals, isWon);
    if (bookedOtherWay) wonBookedOtherWay += 1;

    const lines = inferEstimateServiceLines({
      ...row,
      estimateData,
      serviceInterest: row.service_interest,
      monthlyTotal: parseFloat(row.monthly_total || 0),
      onetimeTotal: parseFloat(row.onetime_total || 0),
    });
    // One estimate can carry several lines; each line records the outcome
    // of the estimate it rode on (a bundle loss is a loss for every line).
    for (const key of new Set(lines.map((l) => l.key || 'unknown'))) tallyKeyed(byServiceLine, key, isWon);
    tallyKeyed(byLeadSource, String(row.lead_source || '').trim().toLowerCase() || 'unknown', isWon);
    // Quote-wizard drafts omit the column and persist the calculated tier
    // at engineResult.waveGuard.tier (GH codex P2) — read every shape.
    const tier = String(
      row.waveguard_tier
      || estimateData?.result?.recurring?.tier
      || estimateData?.engineResult?.recurring?.tier
      || estimateData?.engineResult?.waveGuard?.tier
      || estimateData?.result?.waveGuard?.tier
      || '',
    ).trim().toLowerCase();
    tallyKeyed(byWaveguardTier, tier && tier !== 'none' ? tier : 'none', isWon);

    const profile = profileFromEstimateData(estimateData);
    const flags = verifyFlagsFrom(profile);
    const presence = !profile ? 'noProfile' : (flags.length ? 'flagged' : 'clean');
    tally(byFlagPresence[presence], isWon);

    for (const flag of flags) {
      if (!byFlagField.has(flag.field)) byFlagField.set(flag.field, emptyCell());
      tally(byFlagField.get(flag.field), isWon);
      const priority = String(flag.priority || '').toUpperCase();
      if (byFlagPriority[priority]) tally(byFlagPriority[priority], isWon);
    }

    const monthly = parseFloat(row.monthly_total || 0);
    const oneTime = parseFloat(row.onetime_total || 0);
    if (monthly > 0) {
      const band = bandFor(RECURRING_BANDS, monthly);
      if (band) {
        tally(byPriceBand.recurring.find((b) => b.key === band.key), isWon);
        if (presence !== 'noProfile') {
          tally(recurringBandsByFlag.find((b) => b.key === band.key)[presence], isWon);
        }
      }
    } else if (oneTime > 0) {
      const band = bandFor(ONETIME_BANDS, oneTime);
      if (band) tally(byPriceBand.oneTime.find((b) => b.key === band.key), isWon);
    }
  }

  finalize(totals);
  Object.values(byFlagPresence).forEach(finalize);
  Object.values(byFlagPriority).forEach(finalize);
  byPriceBand.recurring.forEach(finalize);
  byPriceBand.oneTime.forEach(finalize);
  recurringBandsByFlag.forEach((b) => {
    finalize(b.clean);
    finalize(b.flagged);
  });

  const flagFields = [...byFlagField.entries()]
    .map(([field, cell]) => ({ field, ...finalize(cell) }))
    .sort((a, b) => b.total - a.total);

  // The percentage denominator is REAL losses only — dead leads and
  // customers who converted another way are listed for visibility but must
  // not dilute pctOfLosses (codex pre-push P1).
  // The never-winnable count is derived from the disposition counts so
  // ARCHIVED dead rows are counted too (GH codex P2); the archived-row skip
  // above runs first. It also counts the archived converted-another-way rows
  // (the open sweep's output), still out of every rate as before; a reclaimed
  // unarchived one is a win, not excluded.
  const excludedFromRatesCount = archivedBookedOtherWayCount + DISPOSITIONS
    .filter((d) => d.group === 'dead')
    .reduce((sum, d) => sum + (byDispositionCount.get(d.code) || 0), 0);
  const lossTotal = DISPOSITIONS
    .filter((d) => d.group === 'lost')
    .reduce((sum, d) => sum + (byDispositionCount.get(d.code) || 0), 0);
  const byDisposition = DISPOSITIONS
    .map((d) => ({
      code: d.code,
      label: d.label,
      group: d.group,
      count: byDispositionCount.get(d.code) || 0,
      pctOfLosses: d.group === 'lost' && lossTotal > 0
        ? Math.round(((byDispositionCount.get(d.code) || 0) / lossTotal) * 1000) / 10
        : null,
    }))
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count);

  return {
    days,
    resolved: totals.total,
    won: totals.won,
    // How many of `won` were booked another way (not accepted online).
    wonBookedOtherWay,
    lost: totals.lost,
    winRatePct: totals.winRatePct,
    excludedFromRates: excludedFromRatesCount,
    byFlagPresence,
    byFlagField: flagFields,
    byFlagPriority,
    byPriceBand,
    recurringBandsByFlag,
    byDisposition,
    stillDeciding,
    byServiceLine: keyedToList(byServiceLine, (k) => SERVICE_LINE_LABELS[k] || k),
    byLeadSource: keyedToList(byLeadSource),
    byWaveguardTier: keyedToList(byWaveguardTier, (k) => (k === 'none' ? 'No bundle' : k.charAt(0).toUpperCase() + k.slice(1))),
    sentCohorts: sentCohorts(sentRows, { days, nowMs: Date.now() }),
  };
}

module.exports = {
  winLossSlices,
  // Shared with estimate-source-performance so every card on the page uses
  // ONE denominator rule (GH codex P1): never-winnable rows leave rates.
  effectiveDisposition,
  excludedFromRates,
  isBookedOtherWay,
  // Canonical sent anchor (first durable delivery evidence) and resolution
  // date — shared with the dashboard's service-line card so no second copy of
  // the fallback chains can drift from Pipeline Analytics.
  sentAnchorMs,
  resolutionDateMs,
  // Canonical triple-shape resolver for the persisted lookup profile
  // (engineRequest.profile → enriched → marker-bearing engineInputs) —
  // shared with estimate-pricing-audit's send-time provenance block so the
  // two never diverge on which rows count as "looked up".
  profileFromEstimateData,
  _private: {
    bandFor,
    effectiveDisposition,
    sentAnchorMs,
    sentCohorts,
    COHORT_MATURITY_DAYS,
    profileFromEstimateData,
    resolutionDateMs,
    verifyFlagsFrom,
    RECURRING_BANDS,
    ONETIME_BANDS,
  },
};
