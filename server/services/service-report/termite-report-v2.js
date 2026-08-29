/**
 * Termite Report V2 — station-protection dashboard for termite bait /
 * monitoring visits (flag-gated: TERMITE_REPORT_V2).
 *
 * Pure module: no DB, no env reads in the builder body (the gate lives in
 * the route call site and in termiteReportV2PdfSignature, mirroring
 * mosquito-report-v2.js). Consumes the raw typed-snapshot `values` from
 * termite_bait_station completions plus the station-map summary, and returns
 * the customer payload rendered by TermiteReportV2Section.jsx and
 * ServiceReportDocument.jsx.
 *
 * Wording rule (see project-types.js termite_bait_station header): absence
 * claims are scoped to the ACCESSIBLE stations inspected today — never "no
 * termites on the property".
 */

const { detectServiceLine } = require('./service-line-configs');

// Station-based termite service names. Liquid / trench / spot treatments and
// inspections keep their existing render (typed cards) — this dashboard only
// speaks bait-station language.
const TERMITE_BAIT_NAME_RE = /termite/i;
const STATION_TOKEN_RE = /\b(bait|station|monitor|monitoring|cartridge)\b/i;

function isTermiteBaitServiceType(serviceType) {
  const name = String(serviceType || '');
  return TERMITE_BAIT_NAME_RE.test(name) && STATION_TOKEN_RE.test(name);
}

const ACTIVITY_VALUES = {
  NONE: 'None observed',
  ACTIVE: 'Active termites present',
  PREVIOUS: 'Previous feeding noted',
};

const CONSUMPTION_DETAIL = {
  'None — bait intact': 'Bait intact — stations are armed and waiting.',
  'Light feeding': 'Light bait feeding — foragers have found a station.',
  'Moderate feeding': 'Moderate bait feeding — the colony is actively taking bait.',
  'Heavy feeding': 'Heavy bait feeding — strong colony uptake of the bait.',
};

const FEEDING_VALUES = new Set(['Light feeding', 'Moderate feeding', 'Heavy feeding']);

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Honest status ladder (tones only — the headline is plain language from
 * buildTodaysResultCopy). Bait-system truth: termites feeding on a station
 * is the system working, so activity renders waves navy 'watch', never alarm
 * red (owner 2026-08-29); the copy carries the urgency. Absence claims stay
 * scoped to what was inspected today.
 */
function resolveTermiteStatus({ termiteActivity, baitConsumption, checked, inaccessible }) {
  const feeding = FEEDING_VALUES.has(baitConsumption);
  if (termiteActivity === ACTIVITY_VALUES.ACTIVE) return { key: 'action', tone: 'watch' };
  if (termiteActivity === ACTIVITY_VALUES.PREVIOUS) return { key: 'evidence', tone: 'watch' };
  if (feeding) return { key: 'monitoring', tone: 'watch' };
  if (termiteActivity === ACTIVITY_VALUES.NONE && (checked ?? 0) > 0) {
    return { key: 'protected', tone: 'good' };
  }
  // No usable activity reading — never claim protection we didn't verify.
  return { key: 'monitoring', tone: 'watch' };
}

/**
 * Today's-result copy — the customer answers four questions immediately
 * (owner 2026-08-29): Did you inspect my whole system? Did you find
 * activity? What did you do about it? What happens next?
 * Three shapes: clean full inspection, activity observed, partial access.
 */
function buildTodaysResultCopy({
  statusKey, checked, total, activityCount, servicedToday, inaccessible, activeLocation,
}) {
  if (checked == null || checked <= 0) {
    return {
      headline: 'Bait stations being monitored',
      body: 'Your bait station network is in place and being monitored on schedule.',
    };
  }
  const s = (n) => (n === 1 ? '' : 's');
  const accessNote = inaccessible
    ? ` ${inaccessible} station${s(inaccessible)} could not be accessed today and will be checked next visit.`
    : '';
  if (statusKey === 'action' || statusKey === 'evidence') {
    const n = activityCount || 1;
    // Three customer-safe levels (owner 2026-08-29): active termites
    // observed vs evidence of activity (previous feeding) — bait consumption
    // alone never escalates to an "active termites" claim.
    const noun = statusKey === 'evidence' ? 'Evidence of termite activity' : 'Termite activity';
    const where = activeLocation
      ? `${noun} was observed at ${activeLocation}.`
      : `${noun} was observed at ${n} of the ${checked} stations inspected.`;
    const servicedSentence = servicedToday
      ? ` ${n === 1 ? 'The station was' : n === 2 ? 'Both stations were' : 'These stations were'} serviced today and will continue to be monitored.`
      : ' They will continue to be monitored closely.';
    return {
      headline: `${noun} observed at ${n} station${s(n)}`,
      body: `${where}${servicedSentence}${accessNote}`,
    };
  }
  if (inaccessible > 0 && total) {
    return {
      headline: `${checked} of ${total} stations inspected`,
      body: `No termite activity was observed in the ${checked} station${s(checked)} we were able to inspect.${accessNote}`,
    };
  }
  return {
    headline: 'No termite activity observed',
    body: `We inspected all ${checked} bait station${s(checked)} around your home today. No termite activity was observed at the stations inspected.`,
  };
}

/** The three metrics under the headline: inspected / activity / serviced. */
function buildTodaysMetrics({ checked, total, activityCount, servicedCount }) {
  if (checked == null) return null;
  return [
    { label: 'Stations inspected', value: total && total !== checked ? `${checked} of ${total}` : `${checked} of ${checked}` },
    { label: 'Termite activity', value: activityCount > 0 ? `${activityCount} station${activityCount === 1 ? '' : 's'}` : 'None observed' },
    { label: 'Stations serviced', value: String(servicedCount || 0) },
  ];
}

/**
 * Station-network card. Shape matches pestV2.defense / mosquitoV2.habitat —
 * { summary, items: [{ key, label, status, detail }] } — so the PDF
 * defenseBlock chain renders it without a new branch shape.
 */
function buildStationNetwork({ values = {}, stationSummary = null }) {
  const total = stationSummary?.total ?? toCount(values.total_stations);
  const checked = stationSummary?.checked ?? toCount(values.stations_checked);
  const activityCount = stationSummary?.activity ?? toCount(values.stations_with_activity);
  const inaccessible = stationSummary?.inaccessible ?? toCount(values.stations_inaccessible);
  if (checked == null) return null;

  const items = [];
  items.push({
    key: 'inspected',
    label: 'Stations inspected',
    status: 'clear',
    detail: total && total > checked ? `${checked} of ${total} stations` : `${checked} station${checked === 1 ? '' : 's'}`,
  });
  if (activityCount != null && activityCount > 0) {
    items.push({
      key: 'activity',
      label: 'Stations with termite activity',
      status: 'active',
      detail: `${activityCount} station${activityCount === 1 ? '' : 's'} — bait engaged`,
    });
  }
  const consumptionDetail = CONSUMPTION_DETAIL[values.bait_consumption];
  if (consumptionDetail) {
    items.push({
      key: 'bait',
      label: 'Bait condition',
      status: FEEDING_VALUES.has(values.bait_consumption) ? 'watched' : 'clear',
      detail: consumptionDetail,
    });
  }
  if (inaccessible != null && inaccessible > 0) {
    items.push({
      key: 'access',
      label: 'Not accessible this visit',
      status: 'watched',
      detail: `${inaccessible} station${inaccessible === 1 ? '' : 's'} — we will re-check next visit`,
    });
  }
  const summaryParts = [`${checked} inspected`];
  if (activityCount) summaryParts.push(`${activityCount} with activity`);
  if (inaccessible) summaryParts.push(`${inaccessible} inaccessible`);
  return {
    summary: `Your protective ring: ${summaryParts.join(' · ')}.`,
    items,
    counts: { total, checked, activity: activityCount || 0, inaccessible: inaccessible || 0 },
  };
}

/**
 * Primary move: the single most useful thing the customer can do, drawn from
 * the tech's conducive-condition and recommendation chips (first chip wins —
 * the completion form orders them by importance as entered).
 */
function buildPrimaryMove({ values = {} }) {
  const firstChip = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || null;
  const recommendation = firstChip(values.customer_recommendations);
  const conducive = firstChip(values.conducive_conditions);
  if (!recommendation && !conducive) return null;
  if (recommendation) {
    return {
      title: recommendation,
      why: conducive
        ? `We noted: ${conducive.toLowerCase()}. This keeps the station ring working at full strength.`
        : 'This keeps your bait station ring working at full strength.',
      impact: 'Protects the monitoring system between visits',
      dueLabel: 'Before your next visit',
    };
  }
  return {
    title: 'Reduce conditions termites love',
    why: `We noted: ${conducive.toLowerCase()}. Correcting it lowers termite pressure on the structure.`,
    impact: 'Lowers termite pressure near the foundation',
    dueLabel: 'Before your next visit',
  };
}

function buildTermiteReportV2({
  typedSnapshotValues = null,
  typedReportType = null,
  stationSummary = null,
  visitSequence = 1,
  technicianReport = null,
} = {}) {
  if (typedReportType !== 'termite_bait_station') return null;
  const values = typedSnapshotValues && typeof typedSnapshotValues === 'object' ? typedSnapshotValues : {};

  const network = buildStationNetwork({ values, stationSummary });
  const checked = network?.counts?.checked ?? toCount(values.stations_checked);
  const total = network?.counts?.total ?? toCount(values.total_stations);
  const activityCount = network?.counts?.activity || 0;
  const inaccessible = network?.counts?.inaccessible || 0;
  const servicedCount = stationSummary?.serviced ?? 0;
  // "Serviced today" is claimed only on documented evidence: serviced pins
  // on the station map, or bait/station work recorded on the typed form.
  const servicedToday = servicedCount > 0
    || Boolean(String(values.bait_actions || '').trim())
    || Boolean(String(values.station_actions || '').trim());
  const statusBase = resolveTermiteStatus({
    termiteActivity: values.termite_activity || null,
    baitConsumption: values.bait_consumption || null,
    checked,
    inaccessible,
  });
  const copy = buildTodaysResultCopy({
    statusKey: statusBase.key,
    checked,
    total,
    activityCount,
    servicedToday,
    inaccessible,
    activeLocation: values.active_station_location ? String(values.active_station_location).trim() : null,
  });
  const status = { ...statusBase, label: copy.headline };
  const statusSummary = copy.body;

  // Nothing meaningful to show — let the generic report stand rather than
  // rendering an empty dashboard.
  if (!network && !values.termite_activity) return null;

  const supportingMetric = checked != null
    ? {
      label: 'Stations inspected today',
      value: total && total > checked ? `${checked} of ${total}` : String(checked),
    }
    : null;

  return {
    status,
    statusSummary,
    metrics: buildTodaysMetrics({ checked, total, activityCount, servicedCount }),
    supportingMetric,
    defense: network ? { summary: network.summary, items: network.items } : null,
    servicedToday,
    primaryMove: buildPrimaryMove({ values }),
    visitSequence: visitSequence || 1,
    aiSummary: technicianReport || null,
  };
}

/**
 * PDF cache-key component. Same contract as mosquitoReportV2PdfSignature:
 * empty string when the gate is off or the line does not apply, so a gate
 * flip never mass-invalidates cached PDFs for other lines. Bump the suffix
 * whenever the termite-line report COMPOSITION changes.
 */
function termiteReportV2PdfSignature(service = {}) {
  if (process.env.TERMITE_REPORT_V2 !== 'true') return '';
  const line = service.service_line || detectServiceLine(service.service_type);
  if (line !== 'termite') return '';
  return isTermiteBaitServiceType(service.service_type) ? '-termv2' : '';
}

module.exports = {
  buildTermiteReportV2,
  termiteReportV2PdfSignature,
  isTermiteBaitServiceType,
  // exported for tests
  resolveTermiteStatus,
  buildStationNetwork,
  buildTodaysResultCopy,
  buildTodaysMetrics,
  buildPrimaryMove,
};
