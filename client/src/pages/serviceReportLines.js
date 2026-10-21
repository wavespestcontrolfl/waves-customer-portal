import { isProductApplication } from '../lib/product-application';

// The lines ServiceReportDocument prints under "Re-entry & precautions" and "What we recommend", as pure functions of the
// payload. The document renders these lists, and the web top card (components/report/WebTopCard.jsx) picks its "Do this"
// and "Hold off" lines from the SAME lists, so the two can never disagree: there is one copy of this logic.

const TZ = 'America/New_York';

// ONE compliance sanitizer for EVERY channel that can carry re-entry copy:
// the dynamic context, the V2 aftercare, and the product catalog's
// label-derived precaution/re-entry text (unconstrained free text — the repo
// has fixtures like "...about 1 hour"). This rule has now needed four
// channels closed, so it is enforced at the render site rather than per
// field: any string asserting a clock time or a duration is replaced with
// the approved once-dry idiom instead of being printed.
// What the rule bans is a fixed figure attached to a RE-ENTRY or DRYING
// claim — not every number and not every duration. "Irrigate within 14 days"
// and "water in with 0.25 inches" are label-required agronomic directions
// that must survive, and they carry time units too. So the test is BOTH: a
// time figure AND a re-entry/drying claim in the same sentence.
const REENTRY_NUMBER_WORDS = 'a|an|one|two|three|four|five|six|seven|eight|nine|ten'
  + '|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen'
  + '|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|half|several';
// a clock time (7 PM / 7:03 PM) or a quantity attached to a time unit
const REENTRY_TIME_RX = new RegExp(
  '\\b\\d{1,2}(:\\d{2})?\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b'
  + `|\\b(\\d+(\\.\\d+)?|(${REENTRY_NUMBER_WORDS})([\\s-](${REENTRY_NUMBER_WORDS}))?)`
  + '[\\s-]*(second|sec|minute|min|hour|hr|day|week)s?\\b',
  'i',
);
// ...and the sentence must actually make a re-entry / drying claim. This
// vocabulary is exhaustive on purpose: two earlier attempts failed at the
// extremes (a phrasing blocklist kept missing wordings; an any-quantity
// allowlist erased agronomic instructions).
const REENTRY_CLAIM_RX = new RegExp(
  '\\b(re-?enter|re-?entry|reentry|entry|ready|dry|dries|dried|drying|safe'
  + '|keep\\s+(\\w+\\s+){0,3}(off|out|away|clear)'
  + '|stay\\s+(off|out|away)'
  // "avoid the treated area for five hours" is a re-entry claim too
  // (codex P1 #3176 r18) — scoped to the treated-surface nouns so "avoid
  // watering for 24 hours" stays agronomic.
  + '|avoid\\w*\\s+(the\\s+)?(treated|lawn|grass|yard|area)'
  // "Return after 7 PM" is the clock-time phrasing of the same claim
  // (codex P1 #3176 r20). Mirrors the server context regex's two return
  // forms — person-subject or sentence-leading — NOT a bare "return",
  // which would erase agronomic prose like "results return within two
  // weeks".
  + '|(you|your\\s+family|residents?|occupants?|everyone)\\s+(\\w+\\s+){0,3}return\\w*'
  + '|^\\s*return(ing)?\\b'
  + '|off\\s+(the\\s+)?treated)\\b',
  'i',
);
const REENTRY_SAFE_COPY = 'Ready once dry — your technician confirms timing.';

// DEFENCE IN DEPTH ONLY. Compliance is now enforced server-side at the
// payload boundary (reports-public.js) with stripFixedReentryTiming — the
// same clause-level rule and regression matrix validateContent uses for
// social copy. Five rounds of tuning a second, weaker rule here is what made
// that consolidation necessary; this local pass stays as a backstop for any
// path that reaches the document without going through that boundary, and
// must never become the primary enforcement point again.
export function sanitizeReentryCopy(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let replaced = false;
  const kept = sentences.filter((sentence) => {
    if (REENTRY_TIME_RX.test(sentence) && REENTRY_CLAIM_RX.test(sentence)) {
      replaced = true;
      return false;
    }
    return true;
  });
  if (!replaced) return text;
  return [REENTRY_SAFE_COPY, ...kept].join(' ').trim();
}

// COMPLIANCE (AGENTS.md): never publish a fixed re-entry/drying figure on a
// customer surface — not as a duration ("keep clear for 2 hours") and not as
// the clock time computed from it ("ready after 7:03 PM"), which asserts the
// same thing. The approved idiom is once-dry with the technician confirming
// timing. This document is a NEW surface, so printing readyAt here would ADD
// such copy (AGENTS.md flags diffs that add or extend it) even though the
// live report still renders ready-at chips — that's a remediation item for
// the interactive report, not a licence to repeat it in the record.
function reentryTargetLine(target) {
  return `${target.label}: ready once dry — your technician confirms timing`;
}

export function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

export function fmtDayLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });
}

// The aftercare card's re-entry line for the printed record: only when something was applied, sanitized, and not
// the very sentence the summary above already printed (a frozen lawn condition is both).
function aftercareReentryLine(data, hasActualTreatment, reentrySummary) {
  const line = hasActualTreatment ? sanitizeReentryCopy(data.reportV2?.aftercare?.reentry) : '';
  return line && line !== reentrySummary ? line : '';
}

// ---------- the lines ----------

/**
 * Did something get applied? The server verdicts are authoritative (applicationMade also counts a structured action
 * marked treatmentApplied with no product row; treatmentPerformed covers non-chemical treatment). null means the product
 * load failed: fail closed. Row inference only backs up payloads that carry no verdict at all.
 */
export function hasActualTreatmentFor(data) {
  const applications = Array.isArray(data.applications) ? data.applications : [];
  return data.treatmentPerformed === true || data.applicationMade === true
    || data.applicationMade === null
    || (data.applicationMade === undefined && applications.some(isProductApplication));
}

/**
 * The termite dashboard as the document reads it. A re-service visit that applied nothing (inspection_only /
 * customer_declined) suppresses the program dashboards; a PRIMARY termite dashboard owns the summary and the next step; a
 * COMPANION one rides beside another service's report.
 */
export function termiteContext(data) {
  const reservice = data.reserviceReport && typeof data.reserviceReport === 'object' ? data.reserviceReport : null;
  const suppress = Boolean(reservice && ['inspection_only', 'customer_declined'].includes(reservice.outcome));
  const present = !suppress && Boolean(data.termiteReportV2);
  return {
    suppress,
    primary: present && data.termiteReportV2.source !== 'companion',
    companion: present && data.termiteReportV2.source === 'companion',
    dashboard: suppress ? null : (data.termiteReportV2 || null),
  };
}

// buildPrimaryMove returns { title, why, impact, dueLabel } in the pest, mosquito and termite builders.
function moveText(move) {
  return move?.title
    ? [move.title, move.why, move.impact].filter(Boolean).join(' ') + (move.dueLabel ? ` (${move.dueLabel})` : '')
    : null;
}

// Legacy assessment recommendations render INSTEAD of the lawn V2 section, never beside it.
function legacyAssessmentRecs(data) {
  const recs = data.reportV2 ? null : data.lawnAssessment?.recommendations?.recommendations;
  return (Array.isArray(recs) ? [...recs].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)) : [])
    .map((rec) => rec?.action || rec?.text || rec);
}

// A visit with a watering banner prints it ONCE, through aftercare.watering; the hero task, follow-up and insight actions
// restate banner lines verbatim, so every banner sentence (and its lines) is stripped from them, longest first.
function bannerSentencesFor(v2, treated) {
  if (!treated || !['hold', 'water_in', 'hold_then_water_in', 'water_in_by_rain'].includes(v2?.banner?.state)) return [];
  return (v2.banner.lines || [])
    .filter((line) => typeof line === 'string' && line)
    .flatMap((line) => [line, ...line.split(/(?<=[.!?])\s+/)])
    .sort((a, b) => b.length - a.length);
}

// The typed next step (a primary termite dashboard owns it: its builder reconciles a frozen "No action needed" against
// escalating station pins, and the raw typed step never prints beside it), then the chips that say something new.
function typedLines(data, termite) {
  const typed = data.typedReport || null;
  const nextStep = typed?.todaysResult?.nextStep;
  const step = String((termite.primary ? (termite.dashboard?.nextStep || nextStep) : nextStep) || '').trim();
  const chips = (typed?.nextStepChips || []).filter((chip) => !step.toLowerCase().includes(String(chip).toLowerCase()));
  return [step, ...chips];
}

// data.recommendations is provenance-safe (formRecommendations plus findings recommendations, screened at the payload
// boundary). Finding-derived entries already print inside their "What we found" bullet.
function formRecommendations(data) {
  const findingRecs = new Set((data.findings || []).map((f) => String(f?.recommendation || '').trim()).filter(Boolean));
  return (data.recommendations || []).filter((rec) => !findingRecs.has(String(rec || '').trim()));
}

// Lead mode (lawn, not tree & shrub): the follow-up card's stock "No action is needed..." line is a placeholder, not a task.
function followUpAction(data) {
  const v2 = data.reportV2;
  const lead = v2 && v2.lead && typeof v2.lead === 'object' && data.serviceLine !== 'tree_shrub';
  const text = v2?.followUp?.customerAction;
  return lead && /^\s*no action is needed\b/i.test(String(text || '')) ? null : text;
}

// The V2 customer actions with every watering-banner sentence stripped, the plan's own next step (wavesNext is what
// WAVES will do next: a commitment, so it belongs in the permanent record), the insight plans and the mowing line.
function v2Lines(data, treated) {
  const v2 = data.reportV2 || null;
  const banner = bannerSentencesFor(v2, treated);
  const strip = (text) => (banner.length ? banner.reduce((acc, line) => acc.split(line).join(' '), String(text || '')).replace(/\s+/g, ' ') : text);
  const insights = Array.isArray(v2?.insights) ? v2.insights : [];
  return [
    strip(v2?.snapshot?.customerAction),
    strip(followUpAction(data)),
    v2?.snapshot?.wavesNext || insights.map((i) => i?.nextVisitPlan).find(Boolean),
    ...insights.map((insight) => strip(insight?.customerAction)),
    v2?.mowing?.recommendation,
  ];
}

/**
 * "What we recommend", in the order the document prints it: the typed next step and its chips, the form
 * recommendations, legacy assessment recommendations, the lawn aftercare watering line (never when nothing was applied:
 * buildAftercare([]) still says "No special watering is needed..."), the pest/mosquito and termite primary moves, then
 * the V2 lines. Trimmed, empty lines dropped, repeats dropped.
 */
export function buildRecommendations(data) {
  const termite = termiteContext(data);
  const treated = hasActualTreatmentFor(data);
  const lines = [
    ...typedLines(data, termite),
    ...formRecommendations(data),
    ...legacyAssessmentRecs(data),
    treated ? data.reportV2?.aftercare?.watering : null,
    moveText(data.pestReportV2?.primaryMove || data.mosquitoReportV2?.primaryMove || null),
    moveText(termite.dashboard?.primaryMove),
    ...v2Lines(data, treated),
  ].map((line) => String(line || '').trim());
  return lines.filter((line, i) => line && lines.indexOf(line) === i);
}

/**
 * The bullets of "Re-entry & precautions", or null when the document shows no such section. data.advisory carries
 * service-line defaults, so the default pet advisory counts only when something was applied; a real re-entry context is
 * itself evidence of treatment. A fixed re-entry figure never prints (sanitizeReentryCopy); a lawn V2 report takes its
 * watering from the banner, so the raw irrigation timer is withheld.
 */
export function buildReentryBullets(data) {
  const reentry = data.dynamicContext?.reentry || null;
  const treated = hasActualTreatmentFor(data);
  if (!(reentry || (data.advisory?.pet_advisory && treated))) return null;
  const summary = sanitizeReentryCopy(String(reentry?.customerSummary || '').trim());
  const lawnV2Watering = data.serviceLine === 'lawn' && Boolean(data.reportV2);
  return [
    summary,
    ...(reentry?.targets || []).map(reentryTargetLine),
    sanitizeReentryCopy(reentry?.petAdvisory || (treated ? data.advisory?.pet_advisory : null)),
    reentry?.irrigationReadyAt && !lawnV2Watering
      ? `Hold irrigation until ${fmtTime(reentry.irrigationReadyAt)} on ${fmtDayLabel(reentry.irrigationReadyAt)}.` : '',
    aftercareReentryLine(data, treated, summary),
  ].filter(Boolean);
}

// ---------- the web top card's two lines, picked from those lists ----------

export const NOTHING_NEEDED = 'Nothing needed from you today.';
const WAVES_OWNED = /^(we will|we['\u2019]ll|waves will)\b/i;
const NO_ACTION = /^no (further )?action\b/i;

/**
 * "Do this": the first customer-owned line of "What we recommend". Lines Waves owns ("We will re-check the stations")
 * are skipped, and so is a "no action" line; "Nothing needed" when none is left. When rain has already watered the
 * treatment in, the watering lines (which then only report the rain) give way to the kept sprinkler hold, if the
 * report kept one.
 */
export function doThisLine(data, recommendations = buildRecommendations(data)) {
  let lines = recommendations;
  if (data.reportV2?.banner?.state === 'water_in_by_rain') {
    const aftercare = data.reportV2.aftercare || {};
    lines = [aftercare.holdTask, ...recommendations.filter((line) => line !== aftercare.watering)];
  }
  const mine = lines.filter((line) => typeof line === 'string' && line.trim() && !WAVES_OWNED.test(line.trim()));
  return mine.find((line) => !NO_ACTION.test(line.trim())) || NOTHING_NEEDED;
}

/** "Hold off": the first bullet of the document's re-entry section, or null when the document shows none. */
export function holdOffLine(data, bullets = buildReentryBullets(data)) {
  return bullets && bullets.length ? bullets[0] : null;
}
