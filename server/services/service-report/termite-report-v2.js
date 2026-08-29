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
 * termites on the property". Counts are never invented: an undocumented
 * activity-station count renders as "observed", not as "1 station"
 * (codex P1 #3600 r1).
 */

const TERMITE_BAIT_TYPED_TYPE = 'termite_bait_station';

// Bait-station SERVICE names (appointments only carry a service name, not a
// completion profile). Liquid / trench / spot treatments and inspections are
// termite work but not monitoring visits — an upcoming one must never render
// as the "next monitoring visit" (codex P2 #3600 r2).
const TERMITE_NAME_RE = /termite/i;
const STATION_TOKEN_RE = /\b(bait|station|stations|monitor|monitoring|cartridge)\b/i;
function isTermiteBaitServiceName(serviceType) {
  const name = String(serviceType || '');
  return TERMITE_NAME_RE.test(name) && STATION_TOKEN_RE.test(name);
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

function plural(n) { return n === 1 ? '' : 's'; }

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
 * Visit-scoped "what we did" sentence. Servicing evidence is a VISIT fact
 * (serviced pins, bait/station actions on the form) — a pin is either
 * 'activity' or 'serviced', never both, so the copy must not attach
 * "serviced" to the activity stations themselves (codex P2 #3600 r1).
 */
function servicedSentence({ servicedCount, servicedToday, statusKey }) {
  // "Previous feeding noted" is historical evidence — never escalate it to
  // "active" stations in the continuation (codex P2 #3600 r4).
  const which = statusKey === 'evidence' ? 'affected' : 'active';
  if (servicedCount > 0) {
    return ` Bait was serviced at ${servicedCount} station${plural(servicedCount)} today, and the ${which} stations will continue to be monitored.`;
  }
  if (servicedToday) return ` Bait service was performed today, and the ${which} stations will continue to be monitored.`;
  return ' They will continue to be monitored closely.';
}

/**
 * Today's-result copy — the customer answers four questions immediately
 * (owner 2026-08-29): Did you inspect my whole system? Did you find
 * activity? What did you do about it? What happens next?
 * Three shapes: clean full inspection, activity observed, partial access.
 * `activityCount` is null when the tech recorded activity without a station
 * count (the count field is optional) — the copy then says "observed"
 * without a number.
 */
function buildTodaysResultCopy({
  statusKey, checked, total, activityCount = null, servicedCount = 0, servicedToday = false,
  inaccessible = 0, activeLocation = null, baitFeeding = false,
}) {
  if (checked == null || checked <= 0) {
    return {
      headline: 'Bait stations being monitored',
      body: 'Your bait station network is in place and being monitored on schedule.',
    };
  }
  const accessNote = inaccessible
    ? ` ${inaccessible} station${plural(inaccessible)} could not be accessed today and will be checked next visit.`
    : '';
  if (statusKey === 'action' || statusKey === 'evidence') {
    // Three customer-safe levels (owner 2026-08-29): active termites
    // observed vs evidence of activity (previous feeding) — bait consumption
    // alone never escalates to an "active termites" claim.
    const noun = statusKey === 'evidence' ? 'Evidence of termite activity' : 'Termite activity';
    const counted = activityCount != null && activityCount > 0;
    let where;
    if (activeLocation) where = `${noun} was observed at ${activeLocation}.`;
    else if (counted) where = `${noun} was observed at ${activityCount} of the ${checked} stations inspected.`;
    else where = `${noun} was observed at the stations inspected today.`;
    return {
      headline: counted ? `${noun} observed at ${activityCount} station${plural(activityCount)}` : `${noun} observed`,
      body: `${where}${servicedSentence({ servicedCount, servicedToday, statusKey })}${accessNote}`,
    };
  }
  // 'monitoring' with stations inspected: either bait feeding was recorded
  // (legacy snapshots can pair it with "None observed" — the feeding
  // evidence must not vanish under a clean headline, codex P2 #3600 r4) or
  // the visit carries no usable activity reading. Neither may claim "No
  // termite activity observed".
  if (statusKey === 'monitoring') {
    const scope = total && total > checked ? `${checked} of ${total}` : `${checked}`;
    if (baitFeeding) {
      return {
        headline: 'Bait feeding noted — monitoring continues',
        body: `We inspected ${scope} bait station${plural(checked)} today. Bait feeding was noted, which means foraging termites have found a station and are taking the bait — that is the system working. We will keep monitoring it.${accessNote}`,
      };
    }
    return {
      headline: `${scope} station${plural(checked)} inspected`,
      body: `We inspected ${scope} bait station${plural(checked)} today and will continue monitoring your system on schedule.${accessNote}`,
    };
  }
  if (inaccessible > 0) {
    // `total` is already a safe denominator (recorded total, else
    // checked + inaccessible) — a partial visit never reads as "all".
    const denominator = total || checked + inaccessible;
    return {
      headline: `${checked} of ${denominator} stations inspected`,
      body: `No termite activity was observed in the ${checked} station${plural(checked)} we were able to inspect.${accessNote}`,
    };
  }
  return {
    headline: 'No termite activity observed',
    // Property-neutral: the same profile serves commercial bait programs
    // (warehouse, office, multifamily), so never "your home".
    body: `We inspected all ${checked} bait station${plural(checked)} around the property today. No termite activity was observed at the stations inspected.`,
  };
}

/**
 * The three metrics under the headline: inspected / activity / serviced.
 * `activityObserved` covers the uncounted case: activity recorded on the
 * form with no station count renders "Observed", never "None observed"
 * beside a headline that says otherwise.
 */
function buildTodaysMetrics({ checked, total, activityCount = null, activityObserved = false, servicedCount = 0, servicedToday = false }) {
  if (checked == null) return null;
  let activityValue = 'None observed';
  if (activityCount != null && activityCount > 0) activityValue = `${activityCount} station${plural(activityCount)}`;
  else if (activityObserved) activityValue = 'Observed';
  // Form-documented bait/station work with no per-station serviced pins
  // (fail-soft sync) proves service happened but gives no count — never
  // print "0" under a body that says service was performed.
  let servicedValue = String(servicedCount || 0);
  if (!servicedCount && servicedToday) servicedValue = 'Performed';
  return [
    { label: 'Stations inspected', value: total && total !== checked ? `${checked} of ${total}` : `${checked} of ${checked}` },
    { label: 'Termite activity', value: activityValue },
    { label: 'Stations serviced', value: servicedValue },
  ];
}

/**
 * Station-network card. Shape matches pestV2.defense / mosquitoV2.habitat —
 * { summary, items: [{ key, label, status, detail }] } — so the PDF
 * defenseBlock chain renders it without a new branch shape. `counts.activity`
 * stays null when neither the map nor the form documents a count.
 */
/**
 * The station-map summary counts only when it is backed by per-visit
 * statuses. The fail-soft station sync can leave a visit with registry pins
 * and no check rows — the map then summarises as 0 checked / 0 activity,
 * which must not overwrite a frozen 12-checked / 2-active snapshot
 * (codex P2 #3600 r2).
 */
function visitBackedSummary(stationSummary) {
  if (!stationSummary || typeof stationSummary !== 'object') return null;
  const statused = (Number(stationSummary.checked) || 0) + (Number(stationSummary.inaccessible) || 0);
  return statused > 0 ? stationSummary : null;
}

/**
 * Denominator for "N of M": the recorded total, else — when stations were
 * explicitly inaccessible — checked + inaccessible. total_stations is
 * optional on the form, so a null total must never turn a partial visit into
 * "all N stations" (codex P2 #3600 r2).
 */
function stationDenominator({ total, checked, inaccessible }) {
  if (total != null && total > 0) return total;
  if (checked != null && inaccessible > 0) return checked + inaccessible;
  return null;
}

function buildStationNetwork({ values = {}, stationSummary = null }) {
  const summary = visitBackedSummary(stationSummary);
  const checked = summary?.checked ?? toCount(values.stations_checked);
  const activityCount = summary?.activity ?? toCount(values.stations_with_activity);
  const inaccessible = summary?.inaccessible ?? toCount(values.stations_inaccessible);
  const total = stationDenominator({ total: summary?.total ?? toCount(values.total_stations), checked, inaccessible: inaccessible || 0 });
  if (checked == null) return null;

  const items = [];
  items.push({
    key: 'inspected',
    label: 'Stations inspected',
    status: 'clear',
    detail: total && total > checked ? `${checked} of ${total} stations` : `${checked} station${plural(checked)}`,
  });
  if (activityCount != null && activityCount > 0) {
    items.push({
      key: 'activity',
      label: 'Stations with termite activity',
      status: 'active',
      detail: `${activityCount} station${plural(activityCount)} — bait engaged`,
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
      detail: `${inaccessible} station${plural(inaccessible)} — we will re-check next visit`,
    });
  }
  const summaryParts = [`${checked} inspected`];
  if (activityCount) summaryParts.push(`${activityCount} with activity`);
  if (inaccessible) summaryParts.push(`${inaccessible} inaccessible`);
  return {
    summary: `Your protective ring: ${summaryParts.join(' · ')}.`,
    items,
    counts: { total, checked, activity: activityCount ?? null, inaccessible: inaccessible || 0 },
  };
}

/**
 * Primary move: the single most useful thing the customer can do, drawn from
 * the tech's conducive-condition and recommendation chips (first chip wins —
 * the completion form orders them by importance as entered). The full chip
 * lists still render in the typed findings card; this card is the highlight.
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
  // The tech's REQUIRED next-step commitment for this typed type
  // (todaysResult.nextStep) — carried into the dashboard because it replaces
  // the typed Today's Result card that used to print it (codex P1 #3600 r1).
  nextStep = null,
  // Same-LINE next appointment only. The report's top-level nextAppointment
  // falls back to the customer's next visit of ANY line, which must never
  // render as the next termite monitoring visit (codex P2 #3600 r1).
  nextVisit = null,
} = {}) {
  if (typedReportType !== TERMITE_BAIT_TYPED_TYPE) return null;
  const values = typedSnapshotValues && typeof typedSnapshotValues === 'object' ? typedSnapshotValues : {};

  const network = buildStationNetwork({ values, stationSummary });
  const checked = network?.counts?.checked ?? toCount(values.stations_checked);
  const total = network?.counts?.total ?? toCount(values.total_stations);
  const activityCount = network?.counts?.activity ?? null;
  const inaccessible = network?.counts?.inaccessible || 0;
  const servicedCount = visitBackedSummary(stationSummary)?.serviced ?? 0;
  // "Serviced today" is a VISIT fact claimed only on documented evidence:
  // serviced pins on the station map, or bait/station work recorded on the
  // typed form. Never attributed to individual activity stations.
  const servicedToday = servicedCount > 0
    || Boolean(String(values.bait_actions || '').trim())
    || Boolean(String(values.station_actions || '').trim());
  const statusBase = resolveTermiteStatus({
    termiteActivity: values.termite_activity || null,
    baitConsumption: values.bait_consumption || null,
    checked,
    inaccessible,
  });
  const activityObserved = statusBase.key === 'action' || statusBase.key === 'evidence';
  const copy = buildTodaysResultCopy({
    statusKey: statusBase.key,
    checked,
    total,
    activityCount,
    servicedCount,
    servicedToday,
    inaccessible,
    activeLocation: values.active_station_location ? String(values.active_station_location).trim() : null,
    baitFeeding: FEEDING_VALUES.has(values.bait_consumption),
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

  const nextStepText = typeof nextStep === 'string' && nextStep.trim() ? nextStep.trim() : null;

  return {
    status,
    statusSummary,
    metrics: buildTodaysMetrics({ checked, total, activityCount, activityObserved, servicedCount, servicedToday }),
    supportingMetric,
    defense: network ? { summary: network.summary, items: network.items } : null,
    nextStep: nextStepText,
    nextVisit: nextVisit && nextVisit.scheduledDate ? nextVisit : null,
    primaryMove: buildPrimaryMove({ values }),
    visitSequence: visitSequence || 1,
    // Tech-reviewed narrative (accepted "Generate AI report" body or the
    // live typed narrative). Same { headline, body } shape as the pest and
    // mosquito heroes; the dashboard is the report's ONE summary surface,
    // so it must carry it (codex P2 #3600 r4).
    aiSummary: typeof technicianReport === 'string' && technicianReport.trim()
      ? { headline: null, body: technicianReport.trim() }
      : null,
  };
}

function typedSnapshotType(service = {}) {
  const raw = service.service_data;
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { data = null; }
  }
  const snapshot = data && typeof data === 'object' ? data.typedReportSnapshot : null;
  return snapshot && typeof snapshot === 'object' ? snapshot.type || null : null;
}

/**
 * PDF cache-key component. Same contract as mosquitoReportV2PdfSignature:
 * empty string when the gate is off or the record does not apply, so a gate
 * flip never mass-invalidates cached PDFs for other lines. Keyed on the SAME
 * predicate as the render gate — the frozen typed snapshot type — never the
 * service display name (a renamed termite service still completes on the
 * bait-station profile; codex P2 #3600 r1). Bump the suffix whenever the
 * termite-line report COMPOSITION changes.
 */
function termiteReportV2PdfSignature(service = {}) {
  if (process.env.TERMITE_REPORT_V2 !== 'true') return '';
  return typedSnapshotType(service) === TERMITE_BAIT_TYPED_TYPE ? '-termv2' : '';
}

module.exports = {
  TERMITE_BAIT_TYPED_TYPE,
  buildTermiteReportV2,
  termiteReportV2PdfSignature,
  isTermiteBaitServiceName,
  // exported for tests
  resolveTermiteStatus,
  buildStationNetwork,
  buildTodaysResultCopy,
  buildTodaysMetrics,
  buildPrimaryMove,
};
