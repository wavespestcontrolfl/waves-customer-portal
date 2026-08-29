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
const INSTALLATION_NAME_RE = /\b(install|installation|setup|set-up)\b/i;
const DETECTION_NAME_RE = /\bmonitor(?:ing)?\b/i;
const BAIT_NAME_RE = /\bbait\b/i;
function isTermiteBaitServiceName(serviceType) {
  const name = String(serviceType || '');
  if (!TERMITE_NAME_RE.test(name) || !STATION_TOKEN_RE.test(name)) return false;
  // Installation / setup visits and detection-only monitoring programs (no
  // active bait) are not active-bait monitoring checks — the legacy name
  // fallback must not admit them either (codex P2 #3600 r21).
  if (INSTALLATION_NAME_RE.test(name)) return false;
  if (DETECTION_NAME_RE.test(name) && !BAIT_NAME_RE.test(name)) return false;
  // one-time cartridge replacement follow-ons are not the routine check
  if (/\breplacement\b/i.test(name)) return false;
  return true;
}

// Service keys whose completion profile freezes termite_bait_station but
// which are NOT active-bait monitoring checks.
const TERMITE_INSTALLATION_KEY = 'termite_installation_setup';
const TERMITE_DETECTION_KEY = 'termite_monitoring';
const TERMITE_CARTRIDGE_REPLACEMENT_KEY = 'termite_cartridge_replacement';
// 'replacement' = the one-time per-cartridge follow-on: its purpose-built
// typed report stands, like installation and detection-only visits
// (codex P2 #3600 r34).
function stageForServiceKey(key) {
  if (!key) return null;
  if (key === TERMITE_INSTALLATION_KEY) return 'installation';
  if (key === TERMITE_DETECTION_KEY) return 'detection';
  if (key === TERMITE_CARTRIDGE_REPLACEMENT_KEY) return 'replacement';
  return 'monitoring';
}
// Recurring active-bait monitoring keys are the only "next monitoring
// visit" candidates: installation, detection-only, AND the one-time
// per-cartridge replacement follow-on are excluded (codex P2 #3600 r24 —
// a replacement scheduled ahead of the routine check must not hide it).
function isMonitoringServiceKey(key) {
  return Boolean(key)
    && key !== TERMITE_INSTALLATION_KEY
    && key !== TERMITE_DETECTION_KEY
    && key !== TERMITE_CARTRIDGE_REPLACEMENT_KEY;
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
  // Blank optional counts (null / '' / whitespace) are ABSENT, never 0 —
  // Number('') is 0, and an invented zero would fail reconciliation against
  // a positive persisted summary (codex P2 #3600 r24).
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
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
function resolveTermiteStatus({
  termiteActivity, baitConsumption, checked, inaccessible, activitySigns = '',
  // Frozen positive evidence beside a "None observed" select (older
  // snapshots — the pre-V2 composer guarded both fields): a positive
  // activity-station count or a named active station is activity
  // (codex P2 #3600 r23).
  activityCount = null, activeLocation = null,
}) {
  const feeding = FEEDING_VALUES.has(baitConsumption);
  const frozenPositive = (activityCount != null && activityCount > 0) || Boolean(String(activeLocation || '').trim());
  // Positive activity-sign chips are evidence in their own right: legacy
  // snapshots can pair "None observed" with "Live termites in station" (the
  // entry-time validator rejects that today, but the frozen record stands),
  // and those chips still print in the findings card — the status must
  // never contradict them (codex P2 #3600 r13).
  const signs = String(activitySigns || '');
  const liveSigns = /live termites|mud tubing/i.test(signs);
  const priorSigns = /previous feeding/i.test(signs);
  const feedingSigns = /\bbait feeding\b/i.test(signs);
  if (termiteActivity === ACTIVITY_VALUES.ACTIVE || liveSigns) return { key: 'action', tone: 'watch' };
  // "Previous feeding noted" stays historical evidence even beside a frozen
  // count / location — only genuinely current evidence (the select, live
  // signs, activity pins) escalates it (codex P2 #3600 r27).
  if (termiteActivity === ACTIVITY_VALUES.PREVIOUS || priorSigns) return { key: 'evidence', tone: 'watch' };
  if (frozenPositive) return { key: 'action', tone: 'watch' };
  if (feeding || feedingSigns) return { key: 'monitoring', tone: 'watch' };
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
    // Nothing inspected — but a recorded activity finding (the select is
    // required independently of the counts) must not be replaced by neutral
    // copy the metric below contradicts (codex P2 #3600 r20).
    const accessLine = inaccessible
      ? ` ${inaccessible} station${plural(inaccessible)} could not be accessed today and will be checked next visit.`
      : ' Your bait stations could not be inspected today and will be checked next visit.';
    if (statusKey === 'action' || statusKey === 'evidence') {
      const noun = statusKey === 'evidence' ? 'Evidence of termite activity' : 'Termite activity';
      return {
        headline: `${noun} recorded`,
        body: `${noun} was recorded on today's visit.${accessLine}`,
      };
    }
    return {
      headline: 'Bait stations being monitored',
      body: `Your bait station network is in place and being monitored on schedule.${inaccessible ? accessLine : ''}`,
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
  // A recorded total ABOVE the checked count with no inaccessible count is
  // still a partial visit (the counts are not relationally validated) —
  // partial-coverage wording, never "all" (codex P2 #3600 r10).
  if (total && total > checked) {
    return {
      headline: `${checked} of ${total} stations inspected`,
      body: `No termite activity was observed in the ${checked} station${plural(checked)} we inspected today.`,
    };
  }
  // "all N" only when the documented total equals the checked count — a
  // checked count alone never claims the whole network (codex P2 #3600 r8).
  // Property-neutral: the same profile serves commercial bait programs
  // (warehouse, office, multifamily), so never "your home".
  const scope = total && total === checked ? `all ${checked}` : `${checked}`;
  return {
    headline: 'No termite activity observed',
    body: `We inspected ${scope} bait station${plural(checked)} around the property today. No termite activity was observed at the stations inspected.`,
  };
}

/**
 * The three metrics under the headline: inspected / activity / serviced.
 * `activityObserved` covers the uncounted case: activity recorded on the
 * form with no station count renders "Observed", never "None observed"
 * beside a headline that says otherwise.
 */
// Short bait-condition value for the hero metric row. The typed findings
// card drops bait_consumption when the dashboard mounts, so the dashboard
// must print it itself (codex P1 #3600 r6).
const BAIT_CONDITION_METRIC = {
  'None — bait intact': 'Intact',
  'Light feeding': 'Light feeding',
  'Moderate feeding': 'Moderate feeding',
  'Heavy feeding': 'Heavy feeding',
};

function buildTodaysMetrics({ checked, total, activityCount = null, activityObserved = false, feedingNoted = false, servicedCount = 0, servicedToday = false, baitConsumption = null }) {
  if (checked == null) return null;
  // Nothing inspected (every station inaccessible) → no absence claim in
  // the metric either, matching the headline's guard (codex P2 #3600 r9).
  let activityValue = checked > 0 ? 'None observed' : 'Not assessed';
  if (activityCount != null && activityCount > 0) activityValue = `${activityCount} station${plural(activityCount)}`;
  else if (activityObserved) activityValue = 'Observed';
  // Feeding-backed monitoring is evidence, not absence — the metric must
  // not say "None observed" under a "Bait feeding noted" headline
  // (codex P2 #3600 r14).
  else if (feedingNoted && checked > 0) activityValue = 'Feeding noted';
  // Form-documented bait/station work with no per-station serviced pins
  // (fail-soft sync) proves service happened but gives no count — never
  // print "0" under a body that says service was performed.
  let servicedValue = String(servicedCount || 0);
  if (!servicedCount && servicedToday) servicedValue = 'Performed';
  // No documented denominator → count only, never an invented "N of N".
  let inspectedValue = String(checked);
  if (total) inspectedValue = `${checked} of ${total}`;
  const metrics = [
    { label: 'Stations inspected', value: inspectedValue },
    { label: 'Termite activity', value: activityValue },
    { label: 'Stations serviced', value: servicedValue },
  ];
  // No station was opened → no current bait-condition claim (codex P2
  // #3600 r14).
  const baitValue = checked > 0
    ? BAIT_CONDITION_METRIC[baitConsumption] || (baitConsumption ? String(baitConsumption) : null)
    : null;
  if (baitValue) metrics.push({ label: 'Bait condition', value: baitValue });
  return metrics;
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
 * Visit-backed COUNTS may replace the frozen typed counts only when they
 * reconcile with them: completion sync can skip an invalid / foreign /
 * over-cap station entry while applying the rest, and a summary of 11
 * successful rows must not turn a documented 12-of-12 visit into "all 11"
 * (codex P2 #3600 r18). Status evidence (activity / serviced pins) still
 * escalates from the raw visit-backed summary; only the numbers are
 * gated here.
 */
function reconciledSummary(stationSummary, values = {}) {
  const summary = visitBackedSummary(stationSummary);
  if (!summary) return null;
  const typedChecked = toCount(values.stations_checked);
  const typedInaccessible = toCount(values.stations_inaccessible);
  const typedTotal = toCount(values.total_stations);
  if (typedChecked != null && Number(summary.checked) !== typedChecked) return null;
  if (typedInaccessible != null && Number(summary.inaccessible) !== typedInaccessible) return null;
  if (typedTotal != null && Number(summary.total) !== typedTotal) return null;
  return summary;
}

/**
 * Denominator for "N of M": the recorded total, else — when stations were
 * explicitly inaccessible — checked + inaccessible. total_stations is
 * optional on the form, so a null total must never turn a partial visit into
 * "all N stations" (codex P2 #3600 r2).
 */
function stationDenominator({ total, checked, inaccessible }) {
  // Never smaller than the documented counts: the typed validator checks
  // each count's shape, not their relationship, so a recorded total below
  // checked (+ inaccessible) would print "10 of 8" (codex P2 #3600 r7).
  const documented = checked != null ? checked + (inaccessible || 0) : null;
  if (total != null && total > 0) return documented != null ? Math.max(total, documented) : total;
  if (checked != null && inaccessible > 0) return documented;
  return null;
}

function buildStationNetwork({ values = {}, stationSummary = null }) {
  const summary = reconciledSummary(stationSummary, values);
  const checked = summary?.checked ?? toCount(values.stations_checked);
  // An explicitly recorded activity count is preserved when the per-station
  // statuses do not reconcile with it (an affected station saved as
  // `serviced` reads as zero activity on the map) — never understate:
  // the larger of the two documented counts stands (codex P2 #3600 r35).
  const typedActivity = toCount(values.stations_with_activity);
  let activityCount = summary
    ? (typedActivity != null ? Math.max(typedActivity, Number(summary.activity) || 0) : (summary.activity ?? null))
    : typedActivity;
  // The typed validator checks each count's shape, not their relationship:
  // an activity count above the inspected count is impossible, so it is
  // treated as UNCOUNTED (activity still reads "observed", never
  // "12 of the 10 stations") — codex P2 #3600 r9.
  if (activityCount != null && checked != null && activityCount > checked) activityCount = null;
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
    // "Bait engaged" only when feeding was actually recorded — station
    // activity can be live termites or mud tubing with the bait intact
    // (codex P2 #3600 r5).
    const engaged = FEEDING_VALUES.has(values.bait_consumption);
    items.push({
      key: 'activity',
      label: 'Stations with termite activity',
      status: 'active',
      detail: `${activityCount} station${plural(activityCount)} — ${engaged ? 'bait engaged' : 'activity observed'}`,
    });
  }
  // Bait condition is a claim about stations that were opened — none when
  // nothing was inspected (codex P2 #3600 r14).
  const consumptionDetail = checked > 0 ? CONSUMPTION_DETAIL[values.bait_consumption] : null;
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
  // True only when an actual termite station map RENDERS (pins with
  // labels) — the only thing that can replace the typed location as the
  // customer-visible location evidence (codex P2 #3600 r31).
  stationMapRendered = false,
} = {}) {
  if (typedReportType !== TERMITE_BAIT_TYPED_TYPE) return null;
  const values = typedSnapshotValues && typeof typedSnapshotValues === 'object' ? typedSnapshotValues : {};

  const network = buildStationNetwork({ values, stationSummary });
  // Visit-backed rows exist but disagree with the frozen typed counts
  // (partial station sync): the counts above come from the typed record, so
  // the map / station record — which would draw the partial rows — must not
  // render beside them (codex P2 #3600 r20). Surfaced to the client.
  // Also partial: a map that exists but carries ZERO persisted statuses
  // while the typed form documents checks — the sync failed or skipped every
  // entry, and the registry-only fallback rows would read "on file, not
  // checked" beside a 12-inspected hero (codex P2 #3600 r35).
  const typedChecked = toCount(values.stations_checked);
  const zeroCheckSync = Boolean(stationSummary && typeof stationSummary === 'object')
    && !visitBackedSummary(stationSummary)
    && typedChecked != null && typedChecked > 0;
  const stationSyncPartial = (Boolean(visitBackedSummary(stationSummary)) && !reconciledSummary(stationSummary, values))
    || zeroCheckSync;
  const checked = network?.counts?.checked ?? toCount(values.stations_checked);
  const total = network?.counts?.total ?? toCount(values.total_stations);
  const activityCount = network?.counts?.activity ?? null;
  const inaccessible = network?.counts?.inaccessible || 0;
  // Serviced pins are status evidence (a count of documented work), read
  // from the raw visit-backed summary like the activity escalation.
  // Serviced pins: a NUMERIC count only from a reconciled summary; a
  // partial sync still proves service happened (count-neutral "Performed")
  // but its number is not trustworthy (codex P2 #3600 r26).
  const reconciled = reconciledSummary(stationSummary, values);
  const rawServiced = visitBackedSummary(stationSummary)?.serviced ?? 0;
  const servicedCount = reconciled ? (Number(reconciled.serviced) || 0) : 0;
  // "Serviced today" is a VISIT fact claimed only on documented evidence:
  // serviced pins on the station map, or bait/station work recorded on the
  // typed form. Never attributed to individual activity stations.
  const servicedToday = rawServiced > 0
    || Boolean(String(values.bait_actions || '').trim())
    || Boolean(String(values.station_actions || '').trim());
  const formStatus = resolveTermiteStatus({
    termiteActivity: values.termite_activity || null,
    baitConsumption: values.bait_consumption || null,
    checked,
    inaccessible,
    activitySigns: values.activity_signs || '',
    activityCount: toCount(values.stations_with_activity),
    activeLocation: values.active_station_location || null,
  });
  // Visit-backed activity pins can ESCALATE the status, never downgrade it:
  // the form select and the per-station checks are entered separately and
  // the completion guard does not reconcile them, so "None observed" beside
  // two activity pins must not headline a clean visit (codex P2 #3600 r6).
  // The pin legend reads "Termite activity observed", so pins escalate to
  // 'action'. A tech's explicit activity selection is never understated
  // because pins were left unmarked.
  const pinActivity = visitBackedSummary(stationSummary)?.activity || 0;
  // Current activity pins escalate every lesser state — including the
  // historical "Previous feeding noted" evidence state (codex P2 #3600 r29):
  // red pins labelled "Termite activity observed" are current evidence.
  const statusEscalatedByPins = pinActivity > 0 && formStatus.key !== 'action';
  const statusBase = statusEscalatedByPins ? { key: 'action', tone: 'watch' } : formStatus;
  // ANY reconciliation away from the select-derived status — pins, frozen
  // count / location / sign chips, or feeding data promoting an explicit
  // "None observed" — means the activity gauge (score / trend computed from
  // that select) and a frozen "No action needed" step describe a reading the
  // report no longer shows (codex P2 #3600 r22 / r25).
  const statusReconciled = statusEscalatedByPins
    || (values.termite_activity === ACTIVITY_VALUES.NONE && statusBase.key !== 'protected');
  const activityObserved = statusBase.key === 'action' || statusBase.key === 'evidence';
  const feedingNoted = statusBase.key === 'monitoring'
    && (FEEDING_VALUES.has(values.bait_consumption) || /\bbait feeding\b/i.test(String(values.activity_signs || '')));
  const copy = buildTodaysResultCopy({
    statusKey: statusBase.key,
    checked,
    total,
    activityCount,
    servicedCount,
    servicedToday,
    inaccessible,
    // The hand-typed location is not reconciled against the check rows, so
    // whenever visit-backed pins are authoritative for the count/status the
    // body uses count wording instead of naming stations the pins may not
    // agree with (codex P2 #3600 r16).
    // …only when the visit-backed counts were ACCEPTED AND a station map
    // actually renders to carry the location instead: a partial sync keeps
    // the frozen location with the frozen counts (codex P2 r26), and so
    // does a reconciled visit whose basemap / marks cannot draw (r31).
    activeLocation: !(reconciled && stationMapRendered) && values.active_station_location
      ? String(values.active_station_location).trim()
      : null,
    baitFeeding: FEEDING_VALUES.has(values.bait_consumption) || /\bbait feeding\b/i.test(String(values.activity_signs || '')),
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

  let nextStepText = typeof nextStep === 'string' && nextStep.trim() ? nextStep.trim() : null;
  // A frozen clean selection can legitimately carry "No action needed";
  // when station pins escalated the status, that commitment contradicts
  // the headline — replace it with a monitoring commitment (codex P2 #3600
  // r23). Genuine follow-up wording passes through untouched.
  if (statusReconciled && nextStepText && /\bno (further )?action\b|\bnothing (further |else )?(is )?needed\b|\bno follow[- ]?up\b/i.test(nextStepText)) {
    nextStepText = 'We will re-check the active stations at your next monitoring visit.';
  }

  return {
    status,
    statusSummary,
    metrics: buildTodaysMetrics({ checked, total, activityCount, activityObserved, feedingNoted, servicedCount, servicedToday, baitConsumption: values.bait_consumption || null }),
    supportingMetric,
    defense: network ? { summary: network.summary, items: network.items } : null,
    stationSyncPartial,
    // The activity gauge (score / trend) is computed from the FROZEN
    // termite_activity select; when the status was reconciled away from it
    // (pins, frozen evidence, feeding), that trend describes a reading the
    // report no longer shows — the client must not print it (codex P2
    // #3600 r22 / r25).
    statusReconciled,
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

function serviceDataOf(service = {}) {
  const raw = service.service_data;
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { data = null; }
  }
  return data && typeof data === 'object' ? data : null;
}

/**
 * The bait-station snapshot this record carries, with where it came from:
 * the PRIMARY typed snapshot, or — on a combined-service completion (e.g. a
 * pest visit with a termite bait companion) — the customer-visible
 * (auto_send) COMPANION snapshot (codex P1 #3600 r13). internal_only
 * companions never qualify: the customer never receives them. Null when the
 * record has no bait-station snapshot at all.
 */
function termiteBaitSnapshotOf(service = {}) {
  const data = serviceDataOf(service);
  if (!data) return null;
  const primary = data.typedReportSnapshot;
  if (primary && typeof primary === 'object' && primary.type === TERMITE_BAIT_TYPED_TYPE) {
    return { snapshot: primary, source: 'primary' };
  }
  const companions = Array.isArray(data.companionReportSnapshots) ? data.companionReportSnapshots : [];
  const companion = companions.find((snap) => snap && typeof snap === 'object'
    && snap.type === TERMITE_BAIT_TYPED_TYPE && snap.delivery === 'auto_send');
  return companion ? { snapshot: companion, source: 'companion' } : null;
}

/**
 * Attach the Termite V2 payload to a built report payload — the ONE
 * composition point shared by the public route (live / direct PDF) and the
 * queued PDF renderer (pdf-queue.js), which builds its payload outside the
 * route helper. Both cache keys carry termiteReportV2PdfSignature, so both
 * renders must carry the dashboard (codex P1 #3600 r11). Gate + typed-type
 * predicate live here so the two callers cannot drift. Best-effort: never
 * throws, never blocks a report. Consumes and removes the live-only
 * `termiteNextMonitoringVisit` field (the customer surface carries it as
 * termiteReportV2.nextVisit only). Not gated on the name-derived service
 * line — see the applicability note inside.
 */
function attachTermiteReportV2(data, service = {}) {
  if (!data || typeof data !== 'object') return data;
  const nextVisit = data.termiteNextMonitoringVisit || null;
  delete data.termiteNextMonitoringVisit;
  // Applicability = the frozen typed identity ONLY (the same predicate as
  // the PDF signature). The name-derived serviceLine is not consulted: a
  // catalog short name such as "Bait Annual" detects as 'pest' while its
  // profile and snapshot are termite_bait_station (codex P1 #3600 r12).
  // report-data resolves the visit STAGE from the completion profile: the
  // termite_installation_setup profile also freezes termite_bait_station,
  // and an installation is not a monitoring check — its pins and counts
  // must never read as "stations inspected" (codex P1 #3600 r15). The
  // typed cards stand for installations; the dashboard is monitoring-only.
  const stage = data.termiteBaitStage || null;
  delete data.termiteBaitStage;
  if (process.env.TERMITE_REPORT_V2 !== 'true') return data;
  // Installation visits and detection-only monitoring programs (no active
  // bait) keep the typed record — the dashboard speaks active-bait language
  // (codex P1 #3600 r15 / r18). The PDF signature stays a superset: a
  // record it keys as -termv2 that renders without the dashboard only
  // re-renders once on the flip, never serves a stale render as current.
  if (stage === 'installation' || stage === 'detection' || stage === 'replacement') return data;
  const resolved = termiteBaitSnapshotOf(service);
  if (!resolved) return data;
  // The customer-visible report entry that matches the snapshot: the
  // primary typedReport, or the auto_send companion entry. A companion the
  // payload filtered out (internal_only, or a delivery posture this viewer
  // can't see) yields no entry → no dashboard.
  const report = resolved.source === 'primary'
    ? (data.typedReport?.type === TERMITE_BAIT_TYPED_TYPE ? data.typedReport : null)
    : (Array.isArray(data.companionReports) ? data.companionReports : [])
      .find((c) => c && c.type === TERMITE_BAIT_TYPED_TYPE && !c.internalOnly) || null;
  if (!report) return data;
  try {
    const termiteReportV2 = buildTermiteReportV2({
      typedSnapshotValues: resolved.snapshot.values || null,
      typedReportType: TERMITE_BAIT_TYPED_TYPE,
      // Visit-check evidence rides the map when it rendered and
      // `checkSummary` when only the basemap failed — either way the
      // persisted check rows reconcile the status (codex P2 #3600 r15).
      // …and ONLY a termite-program map: a rodent primary with a termite
      // companion renders the rodent program's pins, whose capture /
      // activity statuses must never escalate the termite dashboard
      // (codex P1 #3600 r21).
      stationSummary: data.stationMap?.program === 'termite'
        ? data.stationMap?.summary || data.stationMap?.checkSummary || null
        : null,
      stationMapRendered: data.stationMap?.program === 'termite' && data.stationMap?.available === true
        && Array.isArray(data.stationMap.stations) && data.stationMap.stations.length > 0,
      visitSequence: report.visitSequence || 1,
      // The dashboard replaces the typed Today's Result card, so it must
      // carry the tech's required next-step commitment itself.
      nextStep: report.todaysResult?.nextStep || null,
      // First upcoming BAIT-STATION appointment, selected by report-data
      // over the full candidate window; null in pdf/static builds.
      nextVisit,
      // The dashboard suppresses BOTH legacy summary surfaces (Visit
      // Summary + typed Today's Result), so the approved narrative rides
      // the hero: the accepted technician-report body or the live typed
      // narrative (report-data sets summarySource for each).
      // The narrative belongs to the story that ACCEPTED it: the primary's
      // summary for a primary dashboard; for a companion dashboard, the
      // companion's own accepted technician-report body (completion stores
      // it on the auto_send companion when the primary has no typed
      // snapshot — codex P1 #3600 r26). Never a separate primary's prose.
      technicianReport: (() => {
        if (resolved.source === 'primary') {
          return (data.summarySource === 'technician_report' || data.summarySource === 'typed_narrative')
            && typeof data.summary === 'string'
            ? data.summary
            : null;
        }
        return report.todaysResult?.bodySource === 'technician_report' && typeof report.todaysResult.body === 'string'
          ? report.todaysResult.body
          : null;
      })(),
    });
    // `source` tells the client which typed section the dashboard replaces:
    // the primary cards, or the bait-station companion block.
    if (termiteReportV2) data.termiteReportV2 = { ...termiteReportV2, source: resolved.source };
  } catch { /* best-effort — never block the report */ }
  return data;
}

/**
 * PDF cache-key component. Same contract as mosquitoReportV2PdfSignature:
 * empty string when the gate is off or the record does not apply, so a gate
 * flip never mass-invalidates cached PDFs for other lines. Keyed on the SAME
 * predicate as the render gate — the frozen bait-station snapshot, primary
 * or auto_send companion — never the service display name (a renamed termite service still completes on the
 * bait-station profile; codex P2 #3600 r1). Bump the suffix whenever the
 * termite-line report COMPOSITION changes.
 */
/**
 * Stage from the record alone (no DB): the completion-FROZEN service key
 * first — the same identity report-data's render stage reads — and the
 * display name only for legacy records with no frozen identity (codex P1
 * #3600 r20). Keeps the signature and the render gate on one predicate.
 */
/**
 * The record's FROZEN service key: the top-level completedServiceKey
 * (newer completions), else the applicable typed snapshot's own immutable
 * serviceKey (every typed snapshot persists it — codex P0 #3600 r21). Null
 * only for legacy records that froze neither.
 */
function frozenTermiteServiceKey(service = {}) {
  const data = serviceDataOf(service);
  if (data && Object.prototype.hasOwnProperty.call(data, 'completedServiceKey') && data.completedServiceKey) {
    return String(data.completedServiceKey);
  }
  const resolved = termiteBaitSnapshotOf(service);
  const snapshotKey = resolved?.snapshot?.serviceKey;
  return snapshotKey ? String(snapshotKey) : null;
}

function recordStage(service = {}) {
  const frozenStage = stageForServiceKey(frozenTermiteServiceKey(service));
  if (frozenStage) return frozenStage;
  const name = String(service.service_type || '');
  if (INSTALLATION_NAME_RE.test(name)) return 'installation';
  if (DETECTION_NAME_RE.test(name) && !BAIT_NAME_RE.test(name)) return 'detection';
  if (/\breplacement\b/i.test(name)) return 'replacement';
  return 'monitoring';
}

function termiteReportV2PdfSignature(service = {}) {
  if (process.env.TERMITE_REPORT_V2 !== 'true') return '';
  if (!termiteBaitSnapshotOf(service)) return '';
  return recordStage(service) === 'monitoring' ? '-termv2' : '';
}

module.exports = {
  TERMITE_BAIT_TYPED_TYPE,
  buildTermiteReportV2,
  attachTermiteReportV2,
  termiteBaitSnapshotOf,
  frozenTermiteServiceKey,
  stageForServiceKey,
  isMonitoringServiceKey,
  recordStage,
  termiteReportV2PdfSignature,
  isTermiteBaitServiceName,
  // exported for tests
  resolveTermiteStatus,
  buildStationNetwork,
  buildTodaysResultCopy,
  buildTodaysMetrics,
  buildPrimaryMove,
};
