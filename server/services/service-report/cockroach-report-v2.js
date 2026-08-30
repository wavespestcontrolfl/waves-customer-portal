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
// Evidence chips that assert CURRENT activity (project-types.js `cockroach`
// evidence_observed). "Dead roaches", "Odor", "Grease / food debris" and
// "Moisture present" are conditions or history, not live activity.
const LIVE_EVIDENCE_RE = /live roaches|droppings|egg cases|cast skins/i;

function hasLiveEvidence(evidence = []) {
  return evidence.some((e) => LIVE_EVIDENCE_RE.test(String(e || '')));
}

function resolveCockroachStatus({ activityLevel, species, activity = null, visitSequence = 1, evidence = [] }) {
  const level = String(activityLevel || '').trim();
  const noun = speciesLabel(species);
  const trend = activity && activity.score != null && !activity.isBaseline ? activity.trend : null;
  if (!level) return { key: 'unknown', tone: 'watch', label: `${noun} treatment completed today` };
  // A "None observed" select beside live-activity evidence chips is a stale
  // combination the typed validator permits (codex P2 #3613 r1). The chips
  // are evidence in their own right and still print — the status must never
  // contradict them, so it escalates (same rule as termite r13) and the
  // caller marks the reading reconciled (gauge trend withheld).
  if (level === 'None observed' && hasLiveEvidence(evidence)) {
    return { key: 'active', tone: 'watch', label: `${noun} activity signs were found today`, reconciled: true };
  }
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
function resolveProgram({ serviceKey = null, treatmentNumber = 1, upcomingRoachVisits = null, laterCompleted = 0 }) {
  // Position UNKNOWN (lineage lookup failed → fail closed, codex P1): no
  // treatment number, no total, never "complete".
  if (treatmentNumber == null) return { treatmentNumber: null, treatmentsTotal: null, complete: false, laterCompleted: 0 };
  const number = Math.max(1, Number(treatmentNumber) || 1);
  const later = Math.max(0, Number(laterCompleted) || 0);
  const packageTotal = PACKAGE_TREATMENTS_BY_KEY[String(serviceKey || '')] || null;
  let total = packageTotal;
  if (!total && upcomingRoachVisits != null) {
    // treatments after this one = still scheduled + already completed later
    const after = upcomingRoachVisits + later;
    total = after > 0 ? number + after : (number > 1 ? number : null);
  }
  if (total != null && total < number + later) total = number + later;
  // "complete" describes THIS treatment: it is the program's last one.
  const complete = total != null ? number >= total : false;
  return { treatmentNumber: number, treatmentsTotal: total, complete, laterCompleted: later };
}

function programTitle(program) {
  const { treatmentNumber: n, treatmentsTotal: total } = program;
  // Position unknown (lookup failed): no completion claim of any kind
  // (codex P2 #3613 r2) — the visit is what the customer already knows.
  if (n == null) return 'Today\'s treatment';
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

// A tech's required next-step chip that promises a follow-up ("Follow-up
// recommended", "Follow-up in 10–14 days") is dropped when the program
// state already answers it — the program is complete, a next treatment is
// booked (the date line is authoritative), or a later treatment has since
// happened (codex P2 #3613 r4).
const FOLLOWUP_STEP_RE = /follow-?up/i;
function nextStepFits({ nextStep, program, nextVisit, laterCompleted = 0 }) {
  if (!nextStep) return null;
  if (FOLLOWUP_STEP_RE.test(nextStep) && (program.complete || nextVisit || laterCompleted > 0)) return null;
  return nextStep;
}

function buildWhatsNext({ program, species, nextVisit = null, scheduleResolved = false, work = [], nextStep: rawNextStep = null, positionReason = null }) {
  const german = isGerman(species);
  const large = isLargeRoach(species);
  const rw = recordedWork(work);
  const lines = [];
  let nextVisitMissing = false;
  const laterCompleted = program.laterCompleted || 0;
  const nextStep = nextStepFits({ nextStep: rawNextStep, program, nextVisit, laterCompleted });
  if (program.treatmentNumber == null) {
    // Unknown position: no numbering, no badge, no completion claim. The
    // next booked treatment still references its date (owner ruling) when
    // the live calendar found one; a FAILED lookup says so honestly.
    if (scheduleResolved && nextVisit) lines.push({ label: 'Next treatment', kind: 'next_visit' });
    lines.push({ label: 'Between now and then', text: betweenVisitsCopy({ german, large, rw }) });
    if (positionReason === 'failed') {
      lines.push({ label: 'Your program', text: 'We could not confirm your treatment position while building this report — the office has the full schedule, text us any time.' });
    }
    if (nextStep) lines.push({ label: 'From your technician', text: nextStep });
    return { title: programTitle(program), badge: null, lines, nextVisitMissing: false };
  }
  if (!program.complete && laterCompleted > 0) {
    // This report is being read after a later treatment already happened:
    // no date to reference, nothing missing — the program moved on.
    lines.push({ label: 'Since this visit', text: `${laterCompleted === 1 ? 'A later treatment in this program has' : `${laterCompleted} later treatments in this program have`} since been completed — each has its own report.` });
  } else if (!program.complete) {
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
  }
  if (program.complete) {
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
  // PACKAGE-scoped treatment number (resolveCockroachProgram); visitSequence
  // stays the customer-wide gauge position used only for the trend
  // sentence. Defaults to 1 for callers with no calendar at all (tests);
  // null = position unknown (lineage lookup failed → no program claims).
  treatmentNumber = 1,
  activity = null,
  technicianReport = null,
  todaysResultBody = null,
  nextStep = null,
  serviceKey = null,
  nextVisit = null,
  scheduleResolved = false,
  upcomingRoachVisits = null,
  laterCompleted = 0,
  positionReason = null,
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

  const status = resolveCockroachStatus({ activityLevel, species, activity, visitSequence, evidence });
  const statusReconciled = Boolean(status.reconciled);
  delete status.reconciled;
  const program = resolveProgram({ serviceKey, treatmentNumber, upcomingRoachVisits, laterCompleted });
  const whatsNext = buildWhatsNext({ program, species, nextVisit, scheduleResolved, work, nextStep, positionReason });

  const metrics = [
    // A reconciled reading reports what the evidence says, not the stale select.
    { label: 'Activity today', value: statusReconciled ? 'Signs found' : (activityLevel ? activityLevel : 'Not recorded') },
    { label: 'Areas with activity', value: status.key === 'clear' ? '0' : (locations.length ? String(locations.length) : 'Not counted') },
  ];
  const treatments = shortTreatments(work);
  if (treatments) metrics.push({ label: 'Treatments applied', value: treatments });

  return {
    status,
    // The activity gauge (score / trend) is computed from the frozen select;
    // when the status was reconciled away from it, that trend describes a
    // reading the report no longer shows — the client withholds it.
    statusReconciled,
    statusSummary: buildStatusSummary({ status, species, locations, evidence, work, todaysResultBody: statusReconciled ? null : todaysResultBody }),
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
    nextStep: nextStepFits({ nextStep, program, nextVisit, laterCompleted: program.laterCompleted }),
    visitSequence: Math.max(1, Number(visitSequence) || 1),
  };
}

/**
 * The typed Today's Result body (activity-indicators.js gauge lane) is
 * composed as `<technician report | what-we-did> <disclosure> <nextStep>`
 * and, when reviewed copy exists, its bodySource is 'technician_report'.
 * The dashboard renders the narrative and the next step in their own
 * slots, so the body is stripped of the trailing next-step sentence and the
 * separate technician summary is dropped whenever the body already carries
 * it (codex P1 #3613 — the hero repeated the narrative, the program card
 * repeated the next step).
 */
function dedupedNarrative({ todaysResult = null, summary = null } = {}) {
  const rawBody = String(todaysResult?.body || '').replace(/\s+/g, ' ').trim();
  const nextStep = String(todaysResult?.nextStep || '').replace(/\s+/g, ' ').trim() || null;
  let body = rawBody;
  if (body && nextStep && body.endsWith(nextStep)) body = body.slice(0, -nextStep.length).trim();
  const summaryText = String(summary || '').replace(/\s+/g, ' ').trim() || null;
  const bodyCarriesSummary = Boolean(summaryText)
    && (todaysResult?.bodySource === 'technician_report' || (body && body.includes(summaryText)));
  return {
    todaysResultBody: body || null,
    technicianReport: bodyCarriesSummary ? null : summaryText,
    nextStep,
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
  // The DATE is live-only (report-data sets the field only in live mode;
  // pdf/static strip it) — its presence means "the calendar was resolved
  // for a date". The same-program upcoming COUNT arrives in every mode
  // (codex P1 #3613 r1): the completion state of the program is a fact the
  // permanent record must carry, only the appointment date is not.
  const scheduleResolved = Object.prototype.hasOwnProperty.call(data, 'cockroachNextTreatmentVisit');
  const nextVisit = data.cockroachNextTreatmentVisit || null;
  const upcomingRoachVisits = Object.prototype.hasOwnProperty.call(data, 'cockroachUpcomingRoachVisits')
    ? data.cockroachUpcomingRoachVisits
    : null;
  // Package-scoped position from report-data (all modes — earlier completed
  // records of the same program are immutable, so the PDF may print it).
  const positionResolved = Object.prototype.hasOwnProperty.call(data, 'cockroachProgramPosition');
  const treatmentNumber = positionResolved
    ? (data.cockroachProgramPosition && data.cockroachProgramPosition.treatmentNumber != null
      && Number.isFinite(Number(data.cockroachProgramPosition.treatmentNumber))
      ? Number(data.cockroachProgramPosition.treatmentNumber)
      : null)
    : 1;
  // null field = the lookup FAILED; { treatmentNumber: null, reason } = no lineage
  const positionReason = positionResolved && treatmentNumber == null
    ? (data.cockroachProgramPosition && data.cockroachProgramPosition.reason) || 'failed'
    : null;
  const laterCompleted = positionResolved && data.cockroachProgramPosition
    ? Math.max(0, Number(data.cockroachProgramPosition.laterCompleted) || 0)
    : 0;
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
      ...dedupedNarrative({
        todaysResult: report.todaysResult || null,
        summary: (data.summarySource === 'technician_report' || data.summarySource === 'typed_narrative')
          && typeof data.summary === 'string'
          ? data.summary
          : null,
      }),
      serviceKey: frozenCockroachServiceKey(service),
      nextVisit,
      scheduleResolved,
      upcomingRoachVisits,
      laterCompleted,
      positionReason,
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
 * Program lineage for a completed record: the sale its scheduled service
 * came from (scheduled_services.source_estimate_id) and the included
 * follow-up chain (followup_source_service_id). `known` is false when the
 * scheduled row carries neither (legacy / hand-booked visits); `failed` is
 * true when the lookup itself errored — callers FAIL CLOSED on that
 * (codex P1 #3613): no program position, no calendar claims.
 */
async function cockroachProgramLineage(service = {}, knex) {
  const selfId = service.scheduled_service_id ? String(service.scheduled_service_id) : null;
  let estimateId = null;
  let sourceId = null;
  let failed = false;
  if (selfId && knex) {
    try {
      const row = await knex('scheduled_services').where('id', selfId).first('source_estimate_id', 'followup_source_service_id');
      estimateId = row?.source_estimate_id ? String(row.source_estimate_id) : null;
      sourceId = row?.followup_source_service_id ? String(row.followup_source_service_id) : null;
    } catch { failed = true; }
  }
  const known = Boolean(estimateId || sourceId);
  const matches = (cand = {}) => {
    const candId = cand?.id ? String(cand.id) : null;
    const candEstimate = cand?.source_estimate_id ? String(cand.source_estimate_id) : null;
    const candSource = cand?.followup_source_service_id ? String(cand.followup_source_service_id) : null;
    if (estimateId && candEstimate && candEstimate === estimateId) return true;
    // an included follow-up of THIS visit, or this visit's own source / siblings
    if (selfId && candSource && candSource === selfId) return true;
    if (sourceId && (candId === sourceId || candSource === sourceId)) return true;
    return false;
  };
  return { known, failed, estimateId, sourceId, selfId, matches };
}

const PROGRAM_WINDOW_DAYS = 120;
const DISCLOSABLE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

function dayOf(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
function shiftDay(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Treatment-program position for a completed cockroach record — the ONE
 * resolver behind the report payload AND the PDF cache-key component, so
 * the two can never disagree (codex P1 #3613: the completion state is
 * calendar-derived and must invalidate the cached PDF when it changes).
 *
 *   treatmentNumber  1 + earlier completed records of the SAME PROGRAM
 *   upcoming         same-program visits still ahead (disclosable statuses)
 *   nextRow          the first of them (the caller decides whether a date
 *                    may render — live view only)
 *
 * Program identity = the sale's lineage when the record has one; records
 * with no lineage fall back to the same frozen service key inside a
 * ±120-day window (packages sit weeks apart). A lineage lookup failure
 * returns { failed: true } and the caller makes no program claims.
 * `upcomingRows` may be passed in when the caller already holds the
 * customer's upcoming appointments (report-data); otherwise queried here.
 */
async function resolveCockroachProgram(service = {}, knex, { upcomingRows = null } = {}) {
  const snapshot = cockroachSnapshotOf(service);
  if (!snapshot || !knex || !service.customer_id) return null;
  const lineage = await cockroachProgramLineage(service, knex);
  if (lineage.failed) return { failed: true };
  const programKey = frozenCockroachServiceKey(service);
  const programLabel = String(service.service_type || '').trim().toLowerCase();
  const serviceDay = dayOf(service.service_date);
  const sameKey = (row) => (programKey
    ? frozenCockroachServiceKey(row) === programKey
    : Boolean(programLabel) && String(row?.service_type || '').trim().toLowerCase() === programLabel);
  try {
    // ── earlier treatments ──
    let priorQuery = knex('service_records')
      .where('customer_id', service.customer_id)
      .whereIn('status', ['completed', 'complete'])
      .select('id', 'service_type', 'service_data', 'scheduled_service_id');
    if (serviceDay) priorQuery = priorQuery.andWhere('service_date', '<', serviceDay);
    if (!lineage.known && serviceDay) priorQuery = priorQuery.andWhere('service_date', '>=', shiftDay(serviceDay, -PROGRAM_WINDOW_DAYS));
    if (service.id) priorQuery = priorQuery.whereNot('id', service.id);
    const priorList = (await priorQuery) || [];
    const scheduledById = new Map();
    const scheduledIds = priorList.map((row) => row?.scheduled_service_id).filter(Boolean);
    if (lineage.known && scheduledIds.length) {
      const scheduledRows = await knex('scheduled_services')
        .whereIn('id', scheduledIds)
        .select('id', 'source_estimate_id', 'followup_source_service_id');
      for (const row of (Array.isArray(scheduledRows) ? scheduledRows : [])) scheduledById.set(String(row.id), row);
    }
    const sameProgramRecord = (row) => {
      if (!sameKey(row)) return false;
      if (!lineage.known) return true;
      const sched = row?.scheduled_service_id ? scheduledById.get(String(row.scheduled_service_id)) : null;
      return sched ? lineage.matches(sched) : false;
    };
    const prior = (Array.isArray(priorList) ? priorList : []).filter(sameProgramRecord).length;

    // ── later treatments already completed (codex P2 #3613 r4) ──
    // An earlier report's total must not shrink as the program progresses:
    // a treatment completed AFTER this one is neither "prior" nor "still
    // scheduled", so it is counted here and folded into the total.
    let laterCompleted = 0;
    if (lineage.known && serviceDay) {
      const laterList = (await knex('service_records')
        .where('customer_id', service.customer_id)
        .whereIn('status', ['completed', 'complete'])
        .andWhere('service_date', '>', serviceDay)
        .modify((qb) => { if (service.id) qb.whereNot('id', service.id); })
        .select('id', 'service_type', 'service_data', 'scheduled_service_id')) || [];
      const laterIds = (Array.isArray(laterList) ? laterList : []).map((row) => row?.scheduled_service_id).filter(Boolean);
      if (laterIds.length) {
        const laterSched = await knex('scheduled_services')
          .whereIn('id', laterIds)
          .select('id', 'source_estimate_id', 'followup_source_service_id');
        for (const row of (Array.isArray(laterSched) ? laterSched : [])) scheduledById.set(String(row.id), row);
      }
      laterCompleted = (Array.isArray(laterList) ? laterList : []).filter(sameProgramRecord).length;
    }

    // ── treatments still ahead ──
    let rows = upcomingRows;
    if (!Array.isArray(rows)) {
      const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      rows = await knex('scheduled_services')
        .where('customer_id', service.customer_id)
        .andWhere('scheduled_date', '>=', todayIso)
        .whereIn('status', DISCLOSABLE_STATUSES)
        .modify((qb) => { if (service.scheduled_service_id) qb.whereNot('id', service.scheduled_service_id); })
        .orderBy('scheduled_date', 'asc')
        .orderBy('window_start', 'asc')
        .limit(200);
      rows = Array.isArray(rows) ? rows : [];
    }
    const { resolveCompletionProfileForScheduledService } = require('../service-completion-profiles');
    const verdictByIdentity = new Map();
    const windowEnd = !lineage.known && serviceDay ? shiftDay(serviceDay, PROGRAM_WINDOW_DAYS) : null;
    let nextRow = null;
    let upcoming = 0;
    for (const row of rows) {
      // Bounded fallback (codex P1): with no lineage, only same-key visits
      // inside the program window count — an old shareable report must
      // never disclose a later, separately purchased booking.
      if (windowEnd && dayOf(row?.scheduled_date) > windowEnd) continue;
      const identity = `${row?.service_id || ''}|${row?.service_key_snapshot || ''}|${String(row?.service_type || '').trim().toLowerCase()}`;
      let keyMatch = verdictByIdentity.get(identity);
      if (keyMatch === undefined) {
        let profile = null;
        let resolutionFailed = false;
        try { profile = await resolveCompletionProfileForScheduledService(row, knex, { strict: true }); } catch { resolutionFailed = true; }
        if (resolutionFailed) keyMatch = false;
        else if (programKey) keyMatch = String(profile?.serviceKey || '') === programKey;
        else keyMatch = Boolean(programLabel) && String(row?.service_type || '').trim().toLowerCase() === programLabel;
        verdictByIdentity.set(identity, keyMatch);
      }
      const sameProgram = keyMatch && (lineage.known ? lineage.matches(row) : true);
      if (sameProgram) {
        upcoming += 1;
        if (!nextRow) nextRow = row;
      }
    }
    // No lineage (legacy / hand-booked): the position is NOT guessed across
    // purchases (codex P2 #3613 r3) — treatmentNumber null, no completion
    // claim; the bounded same-key pick still supplies the next booked date.
    return {
      failed: false,
      treatmentNumber: lineage.known ? prior + 1 : null,
      positionReason: lineage.known ? null : 'no_lineage',
      upcoming,
      laterCompleted,
      nextRow,
      lineageKnown: lineage.known,
    };
  } catch {
    return { failed: true };
  }
}

/**
 * PDF cache-key component. Empty when the gate is off or the record is not a
 * primary cockroach typed report, so a flip never mass-invalidates other
 * lines. `-roachtyped2` (pest-report-v2.js) already keys the OPT-OUT render;
 * this suffix keys the dashboard render AND its calendar-derived program
 * state (treatment number · treatments still ahead · later completed) so
 * scheduling, cancelling or completing a visit re-renders the cached PDF
 * instead of serving a stale COMPLETE / IN PROGRESS (codex P1 #3613). A
 * failed resolution keys `f`, a valid no-lineage result `n` — distinct
 * because they render different copy. Bump the letter whenever the cockroach-line report COMPOSITION
 * changes.
 */
// Program-state key component. A FAILED lookup (`f`) and a valid no-lineage
// result (`n`) render different copy (the failure adds the "could not
// confirm your treatment position" line), so they key separately — a PDF
// rendered during an outage re-renders once the lookup succeeds instead of
// keeping the warning cached (local codex P1).
function cockroachProgramSignature(program) {
  let state = 'f';
  if (program && !program.failed) {
    state = program.treatmentNumber != null
      ? `${program.treatmentNumber}u${program.upcoming}l${program.laterCompleted || 0}`
      : 'n';
  }
  return `-roachv2a-p${state}`;
}

async function cockroachReportV2PdfSignature(service = {}, knex = null) {
  if (process.env.COCKROACH_REPORT_V2 !== 'true') return '';
  if (!cockroachSnapshotOf(service)) return '';
  const program = knex ? await resolveCockroachProgram(service, knex) : null;
  return cockroachProgramSignature(program);
}

/**
 * The signature of the program state a render ACTUALLY used, read from the
 * payload report-data built (it stamps `cockroachReportV2RenderedSignature`
 * at the moment it resolved the program) — never re-resolved from the DB,
 * so a render that fell closed on a transient failure is stored under the
 * unknown key, not under the correct-state key the lookup computed
 * (codex P1 #3613; same contract as treatmentNarrativeRenderedSignature).
 */
function cockroachReportV2RenderedSignature(data, service = {}) {
  if (process.env.COCKROACH_REPORT_V2 !== 'true') return '';
  if (!cockroachSnapshotOf(service)) return '';
  return typeof data?.cockroachReportV2RenderedSignature === 'string' && data.cockroachReportV2RenderedSignature
    ? data.cockroachReportV2RenderedSignature
    : cockroachProgramSignature(null);
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
  cockroachReportV2RenderedSignature,
  cockroachProgramSignature,
  resolveCockroachProgram,
  cockroachProgramLineage,
  cockroachSnapshotOf,
  frozenCockroachServiceKey,
  // exported for tests
  resolveCockroachStatus,
  hasLiveEvidence,
  resolveProgram,
  buildWhatsNext,
  buildHelp,
  buildWork,
  recordedWork,
  dedupedNarrative,
  nextStepFits,
};
