/**
 * Cockroach Report V2 — the one-time cockroach TREATMENT PROGRAM dashboard.
 *
 * Owner ruling 2026-08-29 (after termite bait V2): the cockroach family opted
 * OUT of the Pest V2 perimeter dashboard (2026-07-27) because its
 * "where we protected" story is wrong for an interior cleanout; this is the
 * composition that belongs to it. The customer answers four questions in
 * order — did you find activity, where, what did you do about it, and what
 * happens next — and the page ends on the treatment PROGRAM (treatment N of
 * M, the next treatment date on treatment 1 ALWAYS — owner: "typically two
 * treatments, sometimes three, we should always reference the next date").
 *
 * Shape (mirrors termite-report-v2.js — the shape that survived 38 review
 * rounds): a pure builder, ONE attach composer shared by the public route
 * and the queued PDF renderer, and a PDF cache-key signature keyed on the
 * SAME predicate as the render gate. Dark behind COCKROACH_REPORT_V2=true
 * (kill = unset).
 *
 * Truth rules carried over from the termite lane:
 *  - Every sentence traces to a typed field the tech actually filled in or
 *    to the customer's calendar. No invented field observations.
 *  - Absence claims are scoped ("no cockroach activity observed today"),
 *    never "your home is roach-free".
 *  - The next-treatment date is a LIVE-VIEW fact (pdf/static strip schedule
 *    fields): the permanent PDF neither promises nor apologizes for a date.
 *  - The German-cockroach cooperation language is mandatory (owner spec
 *    docs/design/specialty-phase2-owner-spec.md §8 "critical warning"):
 *    even a tech who picked no customer-prep chips ships the defaults.
 */

const COCKROACH_TYPED_TYPE = 'cockroach';

// Package sizes the catalog itself defines. cockroach_control is the
// two-treatment package (TWO_TREATMENT_PACKAGE_KEYS, typed-followup-
// obligation.js); german_roach_initial is sold as three visits
// (migration 20260809000000). german_roach ("cleanout") is severity-priced
// with "the return trips needed" — its size is not a catalog fact, so the
// calendar decides (see resolveProgram).
const PACKAGE_TREATMENTS_BY_KEY = {
  cockroach_control: 2,
  german_roach_initial: 3,
};

const LEVEL_WORDS = {
  'None observed': 'none observed',
  Low: 'low',
  Moderate: 'moderate',
  Heavy: 'heavy',
  Severe: 'severe',
};

const SPECIES_LABEL = {
  German: 'German cockroach',
  American: 'American cockroach',
  'Smoky brown': 'Smoky brown cockroach',
  Mixed: 'Cockroach',
  Unknown: 'Cockroach',
};

// Large / outdoor roaches: the flush disclosure applies (owner spec §8A).
const LARGE_ROACH_SPECIES = new Set(['American', 'Smoky brown']);

// work_completed chips (project-types.js `cockroach`) → what the customer
// reads. Keys are matched case-insensitively on a stable phrase so a chip
// label edit in the schema does not silently drop the row (falls back to
// the chip text itself).
const WORK_COPY = [
  { match: /bait placement/i, short: 'Bait', title: 'Placed gel bait at the active harborage points', detail: 'Roaches feed on the bait and carry it back to the nest, so it keeps working after we leave.' },
  { match: /insect growth regulator/i, short: 'IGR', title: 'Applied an insect growth regulator', detail: 'Stops egg cases from producing the next generation.' },
  { match: /crack\s*&\s*crevice/i, short: 'Crack & crevice', title: 'Crack & crevice treatment', detail: 'Applied into the gaps and voids around the harborage points.' },
  { match: /dust application/i, short: 'Dust', title: 'Dust application', detail: 'Applied into wall voids and hinge gaps where liquid products cannot reach.' },
  { match: /flush-?out/i, short: 'Flush-out', title: 'Flush-out treatment', detail: 'Drives roaches out of hiding so the bait and monitors can reach them.' },
  { match: /exterior perimeter/i, short: 'Exterior', title: 'Exterior perimeter treatment', detail: 'Treated the outside harborage and entry areas.' },
  { match: /glue boards?/i, short: 'Glue boards', title: 'Placed glue boards', detail: 'So the next visit can measure the drop instead of guessing it.' },
  { match: /monitoring stations?/i, short: 'Monitors', title: 'Placed monitoring stations', detail: 'So the next visit can measure the drop instead of guessing it.' },
  { match: /sanitation review/i, short: 'Sanitation review', title: 'Completed a sanitation review', detail: 'Walked the conditions that keep roaches fed and sheltered.' },
];

// customer_prep chips → the customer's sentence.
const PREP_COPY = [
  { match: /over-the-counter sprays/i, key: 'no_sprays', text: 'Do not use store-bought sprays or foggers — they scatter roaches away from the bait.' },
  { match: /do not disturb bait/i, key: 'keep_bait', text: 'Leave the bait placements and monitors undisturbed, including during cleaning.' },
  { match: /remove food debris/i, key: 'food_debris', text: 'Clean food debris and grease behind and under the appliances.' },
  { match: /keep counters clean/i, key: 'counters', text: 'Wipe counters down nightly so the bait is the only food on offer.' },
  { match: /empty trash nightly/i, key: 'trash', text: 'Empty the trash nightly and keep the lid closed.' },
  { match: /fix plumbing leaks/i, key: 'leaks', text: 'Fix plumbing leaks — moisture is what keeps roaches in a kitchen.' },
  { match: /reduce clutter/i, key: 'clutter', text: 'Reduce clutter and cardboard storage where roaches hide and breed.' },
];

// The mandatory German-cockroach cooperation set (owner spec §8B "critical
// warning"): shipped even when the tech picked no prep chips. `keep_bait`
// joins only when bait was actually recorded today (local codex P1 —
// never instruct the customer about placements that were not made).
const GERMAN_DEFAULT_PREP_KEYS = ['no_sprays', 'food_debris'];

function chips(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  return text.split(/\s*[,;|]\s*|\s*\n\s*/).map((v) => v.trim()).filter(Boolean);
}

function lower(s) { return String(s || '').trim().toLowerCase(); }
function plural(n) { return n === 1 ? '' : 's'; }

function speciesLabel(species) {
  return SPECIES_LABEL[String(species || '').trim()] || 'Cockroach';
}

function isLargeRoach(species) { return LARGE_ROACH_SPECIES.has(String(species || '').trim()); }
function isGerman(species) { return String(species || '').trim() === 'German'; }

/**
 * Status ladder. Tones stay navy 'watch' for activity (the copy carries the
 * urgency — same rule as termite: no alarm red for a job that is working as
 * designed); 'good' only for a scoped absence claim on an inspected visit.
 */
function resolveCockroachStatus({ activityLevel, species, activity = null, visitSequence = 1 }) {
  const level = String(activityLevel || '').trim();
  const noun = speciesLabel(species);
  const trend = activity && activity.score != null && !activity.isBaseline ? activity.trend : null;
  if (!level) return { key: 'unknown', tone: 'watch', label: `${noun} treatment completed today` };
  if (level === 'None observed') {
    return {
      key: 'clear',
      tone: 'good',
      label: visitSequence > 1 && (trend === 'improving' || (activity && activity.history && activity.history.length > 1))
        ? 'No cockroach activity observed today'
        : 'No cockroach activity observed during today\'s inspection',
    };
  }
  const word = LEVEL_WORDS[level] || lower(level);
  if (visitSequence > 1 && trend === 'improving') {
    return { key: 'improving', tone: 'watch', label: `${noun} activity has decreased since your last treatment` };
  }
  if (visitSequence > 1 && trend === 'worsening') {
    return { key: 'worsening', tone: 'watch', label: `${noun} activity has increased since your last treatment` };
  }
  if (visitSequence > 1 && trend === 'stable') {
    return { key: 'stable', tone: 'watch', label: `${noun} activity is about the same as your last treatment` };
  }
  return { key: 'active', tone: 'watch', label: `${noun} activity was ${word} today` };
}

function buildWork(workChips) {
  const items = [];
  for (const chip of workChips) {
    const rule = WORK_COPY.find((r) => r.match.test(chip));
    items.push(rule
      ? { key: rule.short, title: rule.title, detail: rule.detail, short: rule.short }
      : { key: chip, title: chip, detail: null, short: chip });
  }
  return items;
}

function buildHelp({ prepChips, species, baitRecorded = false }) {
  const picked = [];
  for (const chip of prepChips) {
    const rule = PREP_COPY.find((r) => r.match.test(chip));
    if (rule) { if (!picked.some((p) => p.key === rule.key)) picked.push({ key: rule.key, text: rule.text }); } else picked.push({ key: chip, text: chip });
  }
  if (isGerman(species)) {
    const defaults = baitRecorded ? ['no_sprays', 'keep_bait', 'food_debris'] : GERMAN_DEFAULT_PREP_KEYS;
    for (const key of defaults) {
      if (!picked.some((p) => p.key === key)) picked.push({ key, text: PREP_COPY.find((r) => r.key === key).text });
    }
  }
  let why = null;
  if (isGerman(species)) {
    why = baitRecorded
      ? 'German cockroach control fails most often when sprays are used between visits. The bait only works if roaches can reach it.'
      : 'German cockroach control fails most often when sprays are used between visits — they scatter roaches into new harborage.';
  } else if (isLargeRoach(species)) {
    why = 'Some activity may be seen temporarily as roaches are flushed from hiding areas. Moisture and exterior entry points are what keep large roaches coming in.';
  } else if (picked.length) {
    why = 'The treatment works best when the conditions that feed and shelter roaches are removed between visits.';
  }
  return { items: picked, why };
}

/**
 * Treatment program position. `treatmentNumber` is PACKAGE-scoped (report-
 * data: 1 + the customer's earlier completed records of the SAME frozen
 * service key inside the program window) — never the customer-wide
 * roach_activity history, which spans other roach services and earlier
 * programs (local codex P1). The total is a catalog fact for the packaged
 * keys; otherwise the calendar decides: upcoming visits of the SAME program
 * (live view only) extend it, and a program with no upcoming visit past
 * treatment 1 is complete.
 */
function resolveProgram({ serviceKey = null, treatmentNumber = 1, upcomingRoachVisits = null }) {
  const number = Math.max(1, Number(treatmentNumber) || 1);
  const packageTotal = PACKAGE_TREATMENTS_BY_KEY[String(serviceKey || '')] || null;
  let total = packageTotal;
  if (!total && upcomingRoachVisits != null) {
    total = upcomingRoachVisits > 0 ? number + upcomingRoachVisits : (number > 1 ? number : null);
  }
  if (total != null && total < number) total = number;
  const complete = total != null ? number >= total : false;
  return { treatmentNumber: number, treatmentsTotal: total, complete };
}

function programTitle(program) {
  const { treatmentNumber: n, treatmentsTotal: total } = program;
  return total ? `Treatment ${n} of ${total} complete` : `Treatment ${n} complete`;
}

/**
 * "What happens next" — mode-aware. `scheduleResolved` is true only when the
 * live payload resolved the customer's calendar (report-data sets the field;
 * pdf/static strip it), so the permanent record never claims OR disclaims a
 * date. `nextVisit` = the first upcoming roach-family appointment.
 */
// Treatment-aware copy (local codex P1): what the next visit "will do" and
// what keeps working after the last one is built ONLY from the work the tech
// recorded today — a report never promises bait or a growth regulator that
// was not applied.
function recordedWork(work = []) {
  const shorts = new Set(work.map((w) => String(w.short || '')));
  return {
    bait: shorts.has('Bait'),
    igr: shorts.has('IGR'),
    monitors: shorts.has('Monitors') || shorts.has('Glue boards'),
    any: work.length > 0,
  };
}

function nextVisitPlan(rw) {
  const refresh = [];
  if (rw.bait) refresh.push('the bait');
  if (rw.igr) refresh.push('the growth regulator');
  const parts = ['Re-check every harborage point'];
  if (refresh.length) parts.push(`refresh ${refresh.join(' and ')}`);
  if (rw.monitors) parts.push('read the monitors');
  parts.push('compare against today');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
}

function betweenVisitsCopy({ german, large, rw }) {
  if (german) {
    return rw.bait
      ? 'Expect to still see some roaches for 7–10 days as the bait spreads through the colony. Text us if activity gets worse rather than better.'
      : 'Expect to still see some roaches for 7–10 days as the treatment works through the harborage. Text us if activity gets worse rather than better.';
  }
  if (large) return 'Some activity may be seen temporarily as roaches are flushed from hiding areas. Text us if it does not taper off within a week.';
  return rw.bait
    ? 'Bait keeps working after we leave, so activity usually tapers over the first week. Text us if it gets worse rather than better.'
    : 'Activity usually tapers over the first week after treatment. Text us if it gets worse rather than better.';
}

function buildWhatsNext({ program, species, nextVisit = null, scheduleResolved = false, work = [], nextStep = null }) {
  const german = isGerman(species);
  const large = isLargeRoach(species);
  const rw = recordedWork(work);
  const lines = [];
  let nextVisitMissing = false;
  if (!program.complete) {
    if (scheduleResolved) {
      if (nextVisit) {
        lines.push({ label: 'Next treatment', kind: 'next_visit' });
      } else {
        nextVisitMissing = true;
        lines.push({ label: 'Next treatment', text: 'We will confirm your next treatment date by text shortly.' });
      }
    }
    lines.push({ label: 'What we will do', text: nextVisitPlan(rw) });
    lines.push({ label: 'Between now and then', text: betweenVisitsCopy({ german, large, rw }) });
  } else {
    lines.push({
      label: 'What to expect',
      text: rw.bait
        ? 'The bait keeps working for several weeks. Occasional sightings over the next 2–3 weeks are normal; a return of steady activity is not.'
        : 'The treatment keeps working for several weeks. Occasional sightings over the next 2–3 weeks are normal; a return of steady activity is not.',
    });
    lines.push({ label: 'If activity returns', text: 'Text us and we will take a look.' });
  }
  if (nextStep) lines.push({ label: 'From your technician', text: nextStep });
  return {
    title: programTitle(program),
    badge: program.complete ? 'COMPLETE' : 'IN PROGRESS',
    lines,
    nextVisitMissing,
  };
}

function shortTreatments(work) {
  const shorts = work.map((w) => w.short).filter(Boolean);
  if (!shorts.length) return null;
  if (shorts.length <= 3) return shorts.join(' · ');
  return `${shorts.slice(0, 3).join(' · ')} +${shorts.length - 3}`;
}

function buildStatusSummary({ status, species, locations, evidence, work, todaysResultBody }) {
  const body = String(todaysResultBody || '').trim();
  if (body) return body;
  const noun = speciesLabel(species);
  const parts = [];
  if (status.key === 'clear') {
    parts.push(`We inspected the areas where ${lower(noun)}es are usually found and saw no live activity today.`);
  } else if (locations.length) {
    parts.push(`${evidence.length ? evidence.join(', ') : 'Activity'} ${evidence.length > 1 ? 'were' : 'was'} found in ${locations.length} area${plural(locations.length)}: ${locations.join(', ').toLowerCase()}.`);
  } else if (evidence.length) {
    parts.push(`${evidence.join(', ')} ${evidence.length > 1 ? 'were' : 'was'} observed today.`);
  }
  if (work.length) parts.push(`We ${work.map((w) => w.title.charAt(0).toLowerCase() + w.title.slice(1)).join(', ')}.`);
  return parts.join(' ') || null;
}

/**
 * Pure builder. Returns null for any typed type other than `cockroach` or
 * when the snapshot carries nothing customer-meaningful.
 */
function buildCockroachReportV2({
  typedSnapshotValues = null,
  typedReportType = null,
  visitSequence = 1,
  // PACKAGE-scoped treatment number (report-data); visitSequence stays the
  // customer-wide gauge position used only for the trend sentence.
  treatmentNumber = null,
  activity = null,
  technicianReport = null,
  todaysResultBody = null,
  nextStep = null,
  serviceKey = null,
  nextVisit = null,
  scheduleResolved = false,
  upcomingRoachVisits = null,
} = {}) {
  if (typedReportType !== COCKROACH_TYPED_TYPE) return null;
  const values = typedSnapshotValues && typeof typedSnapshotValues === 'object' ? typedSnapshotValues : {};
  const species = String(values.species || '').trim() || null;
  const activityLevel = String(values.activity_level || '').trim() || null;
  const locations = chips(values.activity_locations);
  const evidence = chips(values.evidence_observed);
  const conditions = chips(values.conducive_conditions);
  const work = buildWork(chips(values.work_completed));
  const help = buildHelp({ prepChips: chips(values.customer_prep), species, baitRecorded: recordedWork(work).bait });
  if (!species && !activityLevel && !locations.length && !work.length) return null;

  const status = resolveCockroachStatus({ activityLevel, species, activity, visitSequence });
  const program = resolveProgram({ serviceKey, treatmentNumber: treatmentNumber != null ? treatmentNumber : 1, upcomingRoachVisits });
  const whatsNext = buildWhatsNext({ program, species, nextVisit, scheduleResolved, work, nextStep });

  const metrics = [
    { label: 'Activity today', value: activityLevel ? (activityLevel === 'None observed' ? 'None observed' : activityLevel) : 'Not recorded' },
    { label: 'Areas with activity', value: status.key === 'clear' ? '0' : (locations.length ? String(locations.length) : 'Not counted') },
  ];
  const treatments = shortTreatments(work);
  if (treatments) metrics.push({ label: 'Treatments applied', value: treatments });

  return {
    status,
    statusSummary: buildStatusSummary({ status, species, locations, evidence, work, todaysResultBody }),
    aiSummary: technicianReport ? { headline: null, body: technicianReport } : null,
    metrics,
    species,
    speciesLabel: speciesLabel(species),
    activityLevel,
    locations,
    evidence,
    conditions,
    work,
    help,
    program,
    whatsNext,
    nextVisit: nextVisit || null,
    nextStep: nextStep || null,
    visitSequence: Math.max(1, Number(visitSequence) || 1),
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

/** The PRIMARY cockroach snapshot this record carries (companions are out of scope for v1). */
function cockroachSnapshotOf(service = {}) {
  const data = serviceDataOf(service);
  const primary = data && data.typedReportSnapshot;
  return primary && typeof primary === 'object' && primary.type === COCKROACH_TYPED_TYPE ? primary : null;
}

/** Frozen service key: completedServiceKey first, else the snapshot's own serviceKey. */
function frozenCockroachServiceKey(service = {}) {
  const data = serviceDataOf(service);
  if (data && data.completedServiceKey) return String(data.completedServiceKey);
  const snap = cockroachSnapshotOf(service);
  return snap && snap.serviceKey ? String(snap.serviceKey) : null;
}

/**
 * Attach composer — the ONE composition point shared by the public route
 * (live / direct PDF) and the queued PDF renderer. Consumes and removes the
 * live-only `cockroachNextTreatmentVisit` / `cockroachUpcomingRoachVisits`
 * fields (the customer surface carries them as cockroachReportV2.nextVisit
 * and the program position only). Best-effort: never throws.
 */
function attachCockroachReportV2(data, service = {}) {
  if (!data || typeof data !== 'object') return data;
  const scheduleResolved = Object.prototype.hasOwnProperty.call(data, 'cockroachNextTreatmentVisit');
  const nextVisit = data.cockroachNextTreatmentVisit || null;
  const upcomingRoachVisits = Object.prototype.hasOwnProperty.call(data, 'cockroachUpcomingRoachVisits')
    ? data.cockroachUpcomingRoachVisits
    : null;
  // Package-scoped position from report-data (all modes — earlier completed
  // records of the same program are immutable, so the PDF may print it).
  const treatmentNumber = data.cockroachProgramPosition && Number.isFinite(Number(data.cockroachProgramPosition.treatmentNumber))
    ? Number(data.cockroachProgramPosition.treatmentNumber)
    : null;
  delete data.cockroachNextTreatmentVisit;
  delete data.cockroachUpcomingRoachVisits;
  delete data.cockroachProgramPosition;
  if (process.env.COCKROACH_REPORT_V2 !== 'true') return data;
  const snapshot = cockroachSnapshotOf(service);
  if (!snapshot) return data;
  const report = data.typedReport && data.typedReport.type === COCKROACH_TYPED_TYPE ? data.typedReport : null;
  if (!report) return data;
  try {
    const built = buildCockroachReportV2({
      typedSnapshotValues: snapshot.values || null,
      typedReportType: COCKROACH_TYPED_TYPE,
      visitSequence: report.visitSequence || snapshot.visitSequence || 1,
      treatmentNumber,
      activity: data.activity || null,
      technicianReport: (data.summarySource === 'technician_report' || data.summarySource === 'typed_narrative')
        && typeof data.summary === 'string'
        ? data.summary
        : null,
      todaysResultBody: report.todaysResult && report.todaysResult.body ? report.todaysResult.body : null,
      nextStep: report.todaysResult && report.todaysResult.nextStep ? report.todaysResult.nextStep : null,
      serviceKey: frozenCockroachServiceKey(service),
      nextVisit,
      scheduleResolved,
      upcomingRoachVisits,
    });
    if (built) {
      data.cockroachReportV2 = { ...built, source: 'primary' };
      // The dashboard owns the page: the name-derived serviceLine of a roach
      // job is 'pest', so with both gates on the route may have composed
      // Pest V2 — but the cockroach classifier already keeps Pest V2 off
      // roach typed reports (reports-public.js). Belt and braces here.
      if (data.pestReportV2) delete data.pestReportV2;
    }
  } catch { /* best-effort — never block the report */ }
  return data;
}

/**
 * PDF cache-key component. Empty when the gate is off or the record is not a
 * primary cockroach typed report, so a flip never mass-invalidates other
 * lines. `-roachtyped2` (pest-report-v2.js) already keys the OPT-OUT render;
 * this suffix keys the dashboard render. Bump the letter whenever the
 * cockroach-line report COMPOSITION changes.
 */
function cockroachReportV2PdfSignature(service = {}) {
  if (process.env.COCKROACH_REPORT_V2 !== 'true') return '';
  return cockroachSnapshotOf(service) ? '-roachv2a' : '';
}

/** Typed field keys the dashboard renders itself — the typed tiles drop them. */
const COCKROACH_V2_DASHBOARD_FIELD_KEYS = new Set([
  'species',
  'activity_level',
  'activity_locations',
  'evidence_observed',
  'conducive_conditions',
  'work_completed',
  'customer_prep',
]);

module.exports = {
  COCKROACH_TYPED_TYPE,
  COCKROACH_V2_DASHBOARD_FIELD_KEYS,
  PACKAGE_TREATMENTS_BY_KEY,
  buildCockroachReportV2,
  attachCockroachReportV2,
  cockroachReportV2PdfSignature,
  cockroachSnapshotOf,
  frozenCockroachServiceKey,
  // exported for tests
  resolveCockroachStatus,
  resolveProgram,
  buildWhatsNext,
  buildHelp,
  buildWork,
  recordedWork,
};
