/**
 * Manual prep-guide send (admin Communications page "Send flea prep" button).
 *
 * Mirrors the automated appointment-tagger prep, but deliberately bypasses the
 * first-time-only and booking-dedupe guards: an operator clicking the button
 * wants prep sent NOW for this customer, regardless of prior visits or whether
 * an automated send already fired. It is the manual escape hatch for the case
 * where the automated prep was skipped (e.g. a phone-only booking).
 *
 * Channel is the operator's choice (owner ruling 2026-09-03: text only,
 * email only, or both — replaces the 2026-07-11 smart channel):
 *   • email → the formatted prep guide email (prep.* template).
 *   • sms   → when a matching upcoming visit exists, a short text carrying
 *             the tokened /prep/:token guide page (auto_prep_guide_link —
 *             the same content as the email, with a PDF download);
 *             otherwise the pest's self-contained inline-steps text
 *             (auto_*_no_email, three pests) or reason no_upcoming_visit.
 *   • both  → email + the text above.
 *
 * The Communications route allow-lists every PREP_CONFIG entry — the eight
 * live prep.* guides (prep.wildlife stays archived: wildlife is a prohibited
 * Waves service, migration 20260707000002) plus the sprinkler timer guide.
 * Wire a new one by adding its config here.
 *
 * A `guide` entry (sprinkler_timer) is not visit prep: it is a one-time
 * how-to whose buttons deep-link to the hub, so it looks up no upcoming
 * visit and claims no prep page — a lawn visit's own prep_template_key
 * (prep.lawn) is never touched by it, and its text is always the hub-link
 * standalone. Its email carries a `watering_block` rendered here from the
 * current restriction policy and the customer's minutes per zone (owner
 * scope 2026-09-05, docs/irrigation-controller-guide-scope.md).
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { sendCustomerMessage, normalizeRecipient } = require('./messaging/send-customer-message');
const { isRealProviderSend } = require('./sms-auto-send');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { resolveProjectEmailRecipient, ensureServicePrepToken } = require('./project-email');
const { portalUrl } = require('../utils/portal-url');
const { formatDisplayDate } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { currentRestrictionPolicy, resolveRestrictionCounty } = require('../config/irrigation-restrictions');
const { countyConfirmedAfterMove, parseConfirmedFields } = require('./irrigation-schedule-confirmation');
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const SERVICE_GROUP = 'service_operational';

// A mixed identity that still APPLIES product keeps its treatment prep: an
// inspection-word exclusion below is lifted when any treatment cue is also
// in the name ("Termite Liquid Treatment & Inspection", "Termite Inspection
// & Spot Treatment" — service-line-configs.js TERMITE_TREATMENT_SERVICE_TYPE_RE
// draws the same line; GH Codex #3856 r28 P1). Only an inspection-ONLY
// name is excluded.
const TREATMENT_CUES = Object.freeze(['treatment', 'liquid', 'foam', 'trench', 'spot', 'drill', 'pretreat', 'pre treat', 'pre-treat', 'applic']);
const inspectionOnly = (keyword) => ({ keyword, unless: TREATMENT_CUES });

const PREP_CONFIG = Object.freeze({
  flea: {
    label: 'Flea Treatment',
    serviceKeywords: ['flea'],
    emailTemplateKey: 'prep.flea',
    smsStandaloneKey: 'auto_flea_no_email',
  },
  bed_bug: {
    label: 'Bed Bug Treatment Service',
    serviceKeywords: ['bed bug'],
    emailTemplateKey: 'prep.bed_bug',
    smsStandaloneKey: 'auto_bed_bug_no_email',
  },
  cockroach: {
    label: 'Cockroach Treatment Service',
    serviceKeywords: ['roach'],
    emailTemplateKey: 'prep.cockroach',
    smsStandaloneKey: 'auto_cockroach_no_email',
  },
  // The six guides below have no inline-steps text: their text channel is
  // the guide-page link, which needs an upcoming visit to hang the token on.
  // Service-family keywords mirror VISIT_FAMILY_KEYWORDS in prep-public.js.
  interior_pest: {
    label: 'Interior Pest Treatment',
    serviceKeywords: ['pest'],
    // "Lawn Pest Control" is the one-time turf-pest knockdown — a lawn-line
    // visit the broad %pest% match would otherwise claim for indoor prep
    // (service-line-infer.js special-cases the same name; GH Codex #3856 r11 P2).
    // A rodent-LED name ("Rodent Pest Control", rodent_general_one_time's
    // canonical label) is a rodent service row the broad %pest% match would
    // otherwise claim for indoor prep; only a "pest ... rodent" combined
    // plan ("Pest & Rodent Control") is pest-primary — the same split
    // waveguard-existing-services.js isRodentLedText draws (GH Codex #3856
    // r20 P2).
    // prep.interior_pest describes a scheduled interior treatment (clear
    // the treatment areas, treated surfaces) — the catalog's "Pest
    // Inspection Service" (20260507000002) is a diagnostic walkthrough and
    // gets none of it, like the lawn and termite matchers (GH Codex #3856
    // r26 P1). prep.rodent covers inspections itself, so rodent stays.
    // The catalog's "Waves Pest Control Appointment" (general_appointment,
    // 20260408000001) is the placeholder for a booking whose service type
    // is not yet known — nothing is known to be an interior treatment, so
    // it gets no prep (GH Codex #3856 r31 P1).
    excludeKeywords: ['lawn pest', 'appointment', { keyword: 'rodent', unless: 'pest%rodent' }, inspectionOnly('inspect'), inspectionOnly('assess')],
    emailTemplateKey: 'prep.interior_pest',
    smsStandaloneKey: null,
  },
  lawn: {
    label: 'Lawn Treatment',
    serviceKeywords: ['lawn'],
    // prep.lawn tells the customer to mow, shut off irrigation and keep
    // children and pets off treated turf — a "Lawn Health Inspection" /
    // "Lawn Inspect" evaluation (service library) or a lawn assessment
    // applies nothing, so it gets no treatment prep (GH Codex #3856 r22 P1).
    // Mechanical / material lawn work — "Lawn Dethatching" (catalog: no
    // pesticide application), "Lawn Plugging", "Lawn Top Dressing"
    // (20260808080000) — applies no product either: the guide's dry-time
    // and post-treatment irrigation steps do not describe that visit
    // (GH Codex #3856 r31 P1).
    excludeKeywords: ['dethatch', 'plugging', 'top dress', inspectionOnly('inspect'), inspectionOnly('assess')],
    emailTemplateKey: 'prep.lawn',
    smsStandaloneKey: null,
  },
  mosquito: {
    label: 'Mosquito Treatment',
    serviceKeywords: ['mosquito'],
    emailTemplateKey: 'prep.mosquito',
    smsStandaloneKey: null,
  },
  rodent: {
    label: 'Rodent Service',
    serviceKeywords: ['rodent'],
    // prep.rodent says trapping comes first and describes trap resets and
    // later exclusion work — a standalone "Rodent Sanitation Service"
    // (slot-reservation.js classifies it as its own rodent_sanitation lane)
    // is a cleanup visit and gets none of it; a combined "Rodent Trapping &
    // Sanitation" keeps the prep (GH Codex #3856 r30 P1). Inspections stay:
    // the guide covers them itself.
    excludeKeywords: [{ keyword: 'sanitation', unless: ['trap', 'exclusion', 'bait', 'control'] }],
    emailTemplateKey: 'prep.rodent',
    smsStandaloneKey: null,
  },
  termite: {
    label: 'Termite Service',
    serviceKeywords: ['termite'],
    // prep.termite describes trenching, drilling and bait stations — a
    // termite/WDO INSPECTION or monitoring visit must not receive treatment
    // prep. Mirrors appointment-tagger classifyAppointmentType: wdo /
    // wood destroying / inspection outrank the termite-treatment tag
    // (GH Codex #3856 r20 P1).
    // A "Termite Warranty Renewal" / bond-only visit (service library
    // termite_renewal; service-line-configs treats renewal / warranty as
    // no-application work) applies nothing either — same lift for a
    // treatment cue in the name (GH Codex #3856 r30 P1).
    excludeKeywords: ['inspect', 'monitor', 'wdo', 'wood destroying', 'renew', 'warranty', 'bond'].map(inspectionOnly),
    emailTemplateKey: 'prep.termite',
    smsStandaloneKey: null,
  },
  // One-time how-to, not visit prep (see the header): no serviceKeywords,
  // no visit, no page claim. The text is the hub-link standalone on every
  // channel.
  sprinkler_timer: {
    label: 'Sprinkler Timer Guide',
    guide: true,
    emailTemplateKey: 'prep.sprinkler_timer',
    smsStandaloneKey: 'auto_sprinkler_timer',
  },
});

// The guide email's watering callout, from what exists today: the CURRENT
// restriction policy for the customer's resolved county (day count only —
// the policy names no weekday or hour window) and the minutes per zone on
// file. Fail closed: when coverage cannot be established the block points
// the customer at the county rules and Monday's email instead of guessing.
async function buildWateringBlock(customer, snapshot = {}) {
  let inputs = { minutes: null, policy: null };
  snapshot.moveStamp = null;
  try {
    inputs = await loadWateringInputs(customer, snapshot);
  } catch (err) {
    logger.warn(`[prep-guide-sender] watering block inputs unavailable for customer ${customer.id}: ${err.name} (code=${err.code})`);
  }
  return renderWateringBlock(inputs);
}

// The reads behind the block, as one consistent snapshot: preferences,
// the ACTIVE turf profile only (a retired profile's county is the former
// home's — the weekly sweep joins on tp.active = true; GH Codex #3953 r1
// P1), the address re-read AFTER the preferences (the caller's customer row
// may predate a move), and the move stamp re-read after the address — a
// stamp that moved between the reads means the inputs straddle a move, and
// a legal instruction is not built on that (r2 P1). Minutes saved before a
// move are the former home's until re-confirmed (pre-push P1 on d82831055).
async function loadWateringInputs(customer, snapshot) {
  const prefs = (await db('property_preferences').where({ customer_id: customer.id }).first()) || {};
  const turf = (await db('customer_turf_profiles').where({ customer_id: customer.id, active: true }).first()) || {};
  const home = (await db('customers').where({ id: customer.id }).first('city', 'zip')) || customer;
  const stampAfter = (await db('property_preferences').where({ customer_id: customer.id }).first('irrigation_home_changed_at'))?.irrigation_home_changed_at || null;
  const movedAt = prefs.irrigation_home_changed_at || null;
  const stampMs = (v) => (v ? new Date(v).getTime() : null);
  if (stampMs(stampAfter) !== stampMs(movedAt)) {
    throw new Error('address changed while the watering block was being built');
  }
  // The stamp this block was built against — re-checked at the dispatch
  // boundary (sendPrepEmail's onQueued) before the email leaves.
  snapshot.moveStamp = stampAfter;
  const minutesCurrent = !movedAt || parseConfirmedFields(prefs.irrigation_confirmed_fields).includes('irrigation_run_minutes');
  const runMinutes = Number(prefs.irrigation_run_minutes);
  const minutes = minutesCurrent && Number.isFinite(runMinutes) && runMinutes > 0 ? Math.round(runMinutes) : null;
  const county = resolveRestrictionCounty({
    county: turf.county || null,
    profileCity: turf.city || null,
    city: home.city,
    zip: home.zip,
    homeMoved: !!movedAt,
    movedAt,
    countyConfirmed: countyConfirmedAfterMove(prefs),
  });
  return { minutes, policy: currentRestrictionPolicy(new Date(), { county }) };
}

// The copy. No weekday, no hour window: the policy names neither. Fails
// closed to the county's rules when there is no policy.
function renderWateringBlock({ minutes, policy }) {
  const minutesLine = minutes
    ? `run each grass zone about ${minutes} minutes.`
    : 'each Monday\'s email tells you how many minutes to run each zone.';
  if (!policy) {
    return `Before you run, check your county\'s watering rules for your assigned day and hours. Then ${minutesLine}`;
  }
  const days = Number(policy.maxDaysPerWeek);
  const through = policy.expiresOn ? `, through ${formatDisplayDate(policy.expiresOn, { fallback: policy.expiresOn })}` : '';
  if (days === 0) {
    return `Right now lawn watering is not allowed in your area (${policy.label})${through}. Wait for Monday\'s email to tell you when it opens back up.`;
  }
  const dayWord = days === 1 ? 'one watering day' : `${days} watering days`;
  const hours = policy.hoursNote ? `, ${policy.hoursNote}` : '';
  const onDay = days === 1 ? 'On that day' : 'On each of those days';
  return `Right now your area allows ${dayWord} a week (${policy.label})${hours}${through}. ${onDay}, ${minutesLine}`;
}

// The text that carries the tokened guide page — one template for every
// pest; {prep_label} names the guide, {prep_url} is the /prep/:token link.
const SMS_GUIDE_LINK_KEY = 'auto_prep_guide_link';
// The hub link every sprinkler timer guide text carries (auto_sprinkler_timer,
// 20260905000011) — the durable SMS-log signature of a delivered guide.
const GUIDE_SMS_LINK_SIGNATURE = 'wavespestcontrol.com/sprinkler-timers/';
// The pre-dispatch claim's body (openGuideSend) — settled into the delivered
// marker or released; an unsettled one this old is reclaimed.
const GUIDE_CLAIM_BODY = 'Prep send claimed via Communications — dispatching.';
const GUIDE_EMAIL_DISPATCH_BODY = 'Prep email dispatch started — delivery unconfirmed; not resent.';
const GUIDE_CLAIM_STALE_MS = 10 * 60 * 1000;

const CHANNELS = Object.freeze(['email', 'sms', 'both']);

function isSupportedPestType(pestType) {
  return Object.prototype.hasOwnProperty.call(PREP_CONFIG, pestType);
}

function isSupportedChannel(channel) {
  return CHANNELS.includes(channel);
}

// Upcoming visits of a pest family, soonest first, as the appointment
// page would render them ('upcoming' — a call-created follow-up still
// pending and never customer-confirmed is dispatch-owned and hidden, a
// same-day row past its window came and went, a visit underway is too
// late to prep for; GH Codex #3844 r5 P1 / r10 P2 / r13 P2), so the emailed
// guide's "Service date" row references a real appointment and the prep
// token can hang off a visit row. Paged like the reschedule pick (a fixed
// limit could hide a valid upcoming visit behind elapsed same-day rows);
// soonest by date THEN window, id tie-breaker. Takes one customer id or an
// account's ids (the composer's prep-guide insert looks across siblings).
// Candidates, not one: the soonest visit's page may legitimately belong to
// another guide while a later visit's is free (GH Codex #3856 r16 P2) — the
// manual sender walks the WHOLE family (max Infinity) so a free visit behind
// any number of taken ones is still found (GH Codex #3856 r27 P2). Empty
// when nothing matches; THROWS on a lookup error.
const VISIT_PAGE = 10;
async function upcomingFamilyVisits(customerIds, { serviceKeywords, excludeKeywords = [] }, max) {
  const ids = [].concat(customerIds).filter(Boolean);
  const { pageStateForVisit } = require('../routes/appointment-public');
  const found = [];
  for (let offset = 0; ; offset += VISIT_PAGE) {
    // One raw OR group for the family keywords (the only function predicate
    // on this query is the dispatch-owned one below — the composer's test
    // reads it by shape).
    const q = db('scheduled_services')
      .whereIn('customer_id', ids)
      .whereRaw(`(${serviceKeywords.map(() => 'LOWER(service_type) LIKE ?').join(' OR ')})`, serviceKeywords.map((kw) => `%${kw}%`));
    // An exclusion is a keyword, or { keyword, unless } when a wider LIKE
    // pattern (or any of several) keeps the row anyway — a pest-primary
    // "pest ... rodent" name, a treatment cue beside an inspection word.
    for (const ex of excludeKeywords) {
      if (typeof ex === 'string') { q.whereRaw('LOWER(service_type) NOT LIKE ?', [`%${ex}%`]); continue; }
      const unless = [].concat(ex.unless);
      q.whereRaw(`(LOWER(service_type) NOT LIKE ? OR ${unless.map(() => 'LOWER(service_type) LIKE ?').join(' OR ')})`, [`%${ex.keyword}%`, ...unless.map((u) => `%${u}%`)]);
    }
    const rows = await q
      .whereNotIn('status', ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'])
      // The same null-safe dispatch-owned predicate /api/schedule uses.
      .where((qb) => qb
        .whereNull('source_action')
        .orWhereNotIn('source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
        .orWhereNot('status', 'pending')
        .orWhere('customer_confirmed', true))
      // ET, not CURRENT_DATE: the DB session runs UTC, so between ~8pm and
      // midnight ET "today's" visit would fall before the UTC date and the
      // email would say "To be confirmed" despite a real upcoming appointment.
      .where('scheduled_date', '>=', etDateString())
      .orderBy([
        { column: 'scheduled_date', order: 'asc' },
        { column: 'window_start', order: 'asc' },
        { column: 'id', order: 'asc' },
      ])
      .limit(VISIT_PAGE)
      .offset(offset)
      .select(
        'id', 'customer_id', 'scheduled_date', 'window_start', 'window_end', 'status', 'service_type',
        'visit_id', 'source_action', 'customer_confirmed', 'prep_expires_at',
        'prep_template_key', 'prep_sent_at', 'prep_token', 'created_at', 'prep_first_viewed_at', 'prep_view_count',
      );
    for (const r of rows) {
      if ((await pageStateForVisit(r)).state === 'upcoming') found.push(r);
      if (found.length >= max) return found;
    }
    if (rows.length < VISIT_PAGE) return found;
  }
}

// The composer's pick: the soonest upcoming visit matching one family
// keyword (its config's exclusions apply), across an account. Null when
// none or on a lookup error (logged) — the composer refuses, not throws.
async function nextUpcomingVisit(customerIds, serviceKeyword) {
  const config = Object.values(PREP_CONFIG).find((c) => c.serviceKeywords.includes(serviceKeyword))
    || { serviceKeywords: [serviceKeyword] };
  try {
    const [row] = await upcomingFamilyVisits(customerIds, config, 1);
    return row || null;
  } catch (err) {
    logger.warn(`[prep-guide-sender] next-visit lookup failed for customer ${[].concat(customerIds).filter(Boolean).join(',')}: ${err.name} (code=${err.code})`);
    return null;
  }
}

async function nextUpcomingVisits(customerId, config) {
  return upcomingFamilyVisits([customerId], config, Infinity);
}

// A visit's prep key is never MOVED between guides. The automated lanes
// reserve it before anything delivers (the tagger mints the token at
// enrol/queue time; only a confirmed send stamps prep_sent_at), and every
// attempt to read an unstamped reservation as "abandoned" — from runs,
// enrolments, email_messages, sms_log and the interaction marker — was
// lossy: a real Twilio send survives a failed sms_log insert (twilio.js
// continues on it), the composer's marker write is fail-soft, and an
// inserted-but-unsent composer draft leaves no trace at all, so absence of
// evidence re-keyed tokens the customer already held (GH Codex #3856 r23
// P0 / P2 — after r11, r13, r14, r16, r17 each patched one gap). A keyed
// page is released only by the fresh-claim release when nothing delivers;
// a reservation orphaned by a crash keeps the visit's page for its guide
// (text refuses prep_page_taken, the email still goes with the portal link)
// — rare, operator-visible, recoverable. Sequence enrolments live in the
// runner's PREP_TEMPLATE_BY_SEQUENCE_KEY, mirrored here.
const LIVE_ENROLLMENT_STATUSES = ['queued', 'active'];
const SEQUENCE_KEY_BY_PREP_TEMPLATE = Object.freeze({ 'prep.bed_bug': 'bed_bug', 'prep.cockroach': 'cockroach', 'prep.flea': 'flea' });
// The manual email's trigger id — VISIT-scoped, so a guide emailed for an
// older appointment never reads as this visit's delivery (pre-push Codex
// P1 on b5d05dd14).
function manualPrepTriggerId(customerId, templateKey, visitId) {
  return `manual_prep:${customerId}:${templateKey}:${visitId || 'none'}`;
}

// Is an automated lane still ABOUT to deliver key on this visit — a
// transactional run that is runnable / running (the executor's own set,
// GH Codex #3856 r12 P1) or a live sequence enrolment whose first step
// stamps that key? Refuses a manual send of the SAME guide that would
// duplicate it (pre-push Codex P1 on 52bbb43b1). Throws on a read failure.
async function automationLaneLive(visit, key, customerId) {
  const { RUNNABLE_STATUSES } = require('./email-template-automation-executor');
  const live = [...RUNNABLE_STATUSES, 'running'];
  const run = await db('email_template_automation_runs')
    .where({ entity_type: 'scheduled_service', entity_id: visit.id, template_key: key })
    .whereIn('status', live)
    .first('id');
  if (run) return true;
  const sequenceKey = SEQUENCE_KEY_BY_PREP_TEMPLATE[key];
  if (!sequenceKey) return false;
  // Held enrolments count too: toggling the automation off HOLDS an active
  // enrolment (processDueSteps joins t.enabled; next_send_at stays in the
  // past) and re-enabling resumes it — so a manual send that went ahead
  // while it was held would be followed by the same prep on the next tick
  // (GH Codex #3856 r23 P1, superseding r21's enabled-only read). A
  // confirmed manual delivery settles the enrolment instead
  // (settleHeldEnrollment). Only an enrolment still AWAITING the prep step
  // counts: the runner's stampPrepSentForSequence treats step 0 alone as
  // the prep delivery, so an enrolment advanced onto follow-up steps has
  // already sent it and must not park a manual re-send (GH Codex #3856
  // r25 P2).
  const enrollment = await db('automation_enrollments')
    .where({ customer_id: customerId, template_key: sequenceKey, current_step: 0 })
    .whereIn('status', LIVE_ENROLLMENT_STATUSES)
    .first('id');
  return !!enrollment;
}

// After a confirmed delivery of a sequence-backed guide (flea / bed bug /
// cockroach) — the manual sender's email / text, or the composer's prep-link
// text — the customer's live enrolment still awaiting its prep step is
// settled as DELIVERED: advanced past step 0 through the runner's own
// advanceEnrollment, so a held one cannot resume and send the same prep
// again (GH Codex #3856 r23 P1) while its later follow-up steps keep their
// schedule (a cancel would drop them — pre-push Codex P1 on 47f085038).
// automationLaneLive lets the manual send through only when no enrolment
// still awaits the prep step; this closes the held case (step 0 only — an
// enrolment already on its follow-ups is untouched), and a lost write is
// logged, never a failed send. The runner's step-0 pick consults neither
// prep_sent_at nor the interaction marker, so this is the only fence
// (GH Codex #3856 r30 P1).
async function settleHeldEnrollment(customerId, templateKey) {
  const sequenceKey = SEQUENCE_KEY_BY_PREP_TEMPLATE[templateKey];
  if (!sequenceKey) return;
  try {
    const enrollment = await db('automation_enrollments')
      .where({ customer_id: customerId, template_key: sequenceKey, current_step: 0 })
      .whereIn('status', LIVE_ENROLLMENT_STATUSES)
      .first();
    if (!enrollment) return;
    const { advanceEnrollment } = require('./automation-runner');
    await advanceEnrollment(enrollment);
  } catch (err) {
    logger.warn(`[prep-guide-sender] enrolment settle failed for customer ${customerId} (${sequenceKey}): ${err.name} (code=${err.code})`);
  }
}

function guideLabelForTemplateKey(templateKey) {
  const match = Object.values(PREP_CONFIG).find((c) => c.emailTemplateKey === templateKey);
  return match ? match.label : String(templateKey || '').replace(/^prep\./, '');
}

// Atomic claim of the row's prep page for this guide. A FRESH claim moves
// the key onto this guide only while it is unset (whereNull — two operators
// sending for one unkeyed visit both pass the read above; exactly one
// claims, GH Codex #3856 r3 P1). A key that already matches is owned but
// not fresh: some earlier attempt — possibly a concurrent same-guide send
// still in flight — made it, so this attempt may send on it but must never
// release it (pre-push Codex P1 on 87c0e9e95). Anything else is taken.
async function claimPrepPage(serviceId, templateKey) {
  const fresh = await db('scheduled_services')
    .where({ id: serviceId })
    .whereNull('prep_template_key')
    .update({ prep_template_key: templateKey });
  if (Number(fresh) > 0) return { owned: true, fresh: true };
  const row = await db('scheduled_services').where({ id: serviceId }).first('prep_template_key');
  if (row?.prep_template_key === templateKey) return { owned: true, fresh: false };
  return { owned: false, takenBy: row?.prep_template_key || null };
}

// A FRESH claim is PROVISIONAL until a channel delivers: when nothing went
// out, hand the page back so a failed first attempt neither blocks a later
// guide nor ties the visit to content the customer never received. Only
// our own key is released, and only while no delivery of it was ever
// stamped (markServicePrepSent sets prep_sent_at — the delivered key stays;
// pre-push Codex P1 on dde34633e). Callers release fresh claims only.
// Fenced on the view columns: a page the customer
// opened between the claim and this release must keep resolving (the
// public read stamps the view in the same statement, so the row lock orders
// the two; pre-push Codex P0 on fb2d7d01f).
async function releasePrepPage(serviceId, templateKey) {
  try {
    await db('scheduled_services')
      .where({ id: serviceId, prep_template_key: templateKey })
      .whereNull('prep_sent_at')
      .whereNull('prep_first_viewed_at')
      .whereRaw('COALESCE(prep_view_count, 0) = 0')
      .update({ prep_template_key: null });
  } catch (err) {
    logger.warn(`[prep-guide-sender] prep page release failed for service ${serviceId}: ${err.name} (code=${err.code})`);
  }
}

// The visit the guide hangs on, plus its tokened page URL. A visit row holds
// ONE prep token, and /prep/:token renders the row's prep_template_key — so
// a row that already carries a DIFFERENT guide (a combined "Pest + Lawn"
// visit whose page went out as interior pest) is never re-keyed or linked
// for this guide: every URL already delivered would flip to the new guide
// (GH Codex #3856 r2 P1). The read below is the cheap early-out; the
// conditional claim after the mint is the gate. Such a row still dates the
// email but is not linked or stamped. linkReason says why prepUrl is null:
//   no_upcoming_visit   — nothing for a page to describe
//   prep_page_taken     — the row's page belongs to another guide (takenBy)
//   prep_guide_inactive — the guide has no active version (the page 404s)
//   prep_page_expired   — the visit's page token is past prep_expires_at
//   prep_link_failed    — visit lookup or token mint threw (retryable)
// The page is texted only when it will RENDER: /prep/:token 404s past
// prep_expires_at and without an active template version
// (resolvePrepSource / renderGuideForSource) — the same two predicates the
// composer's buildPrepGuideLink applies before inserting a link, re-run here
// so a text-only send can never report success (and stamp prep_sent_at) on
// a URL the customer opens to a 404 (pre-push Codex P1 on 7f82e7564).
async function resolvePrepVisit(customer, config) {
  let visits;
  try {
    visits = await nextUpcomingVisits(customer.id, config);
  } catch (err) {
    logger.warn(`[prep-guide-sender] next-visit lookup failed for customer ${customer.id}: ${err.name} (code=${err.code})`);
    return { visit: null, prepUrl: null, ownsPage: false, linkReason: 'prep_link_failed' };
  }
  if (!visits.length) return { visit: null, prepUrl: null, ownsPage: false, linkReason: 'no_upcoming_visit' };
  let loaded;
  try {
    loaded = await EmailTemplateLibrary.loadTemplateByKey(config.emailTemplateKey);
  } catch (err) {
    logger.warn(`[prep-guide-sender] template lookup failed for ${config.emailTemplateKey}: ${err.name} (code=${err.code})`);
    return { visit: visits[0], prepUrl: null, ownsPage: false, linkReason: 'prep_link_failed' };
  }
  if (!loaded?.activeVersion) return { visit: visits[0], prepUrl: null, ownsPage: false, linkReason: 'prep_guide_inactive' };
  // Soonest first: a free (or same-guide) page wins; a page another guide
  // owns — delivered or merely reserved — is skipped for the next visit.
  // Nothing usable = the soonest visit's refusal.
  let visit = null;
  let taken = null;
  for (const candidate of visits) {
    if (!candidate.prep_template_key || candidate.prep_template_key === config.emailTemplateKey) {
      // A free page, or our guide's — but an automation for this same guide
      // that is still queued / running will deliver it itself (the executor
      // claims the key before dispatch): a manual send now would send the
      // prep twice (pre-push Codex P1 on 52bbb43b1). The unkeyed case is
      // real, not just the keyed one: an attempt that failed before
      // dispatch hands its fresh claim back and schedules a retry, so the
      // visit sits unkeyed with a runnable run — claimed and sent manually
      // here, the retry would read the key as owned and send again
      // (pre-push Codex P1 on 4f6261cc3). Unknown = in flight.
      let inFlight = true;
      try {
        inFlight = await automationLaneLive(candidate, config.emailTemplateKey, customer.id);
      } catch (err) {
        logger.warn(`[prep-guide-sender] automation liveness check failed for service ${candidate.id}: ${err.name} (code=${err.code})`);
      }
      if (inFlight) return { visit: candidate, prepUrl: null, ownsPage: false, linkReason: 'prep_send_pending' };
      visit = candidate;
      break;
    }
    taken = taken || {
      visit: candidate, prepUrl: null, ownsPage: false, linkReason: 'prep_page_taken',
      takenBy: guideLabelForTemplateKey(candidate.prep_template_key),
    };
  }
  if (!visit) return taken;
  if (visit.prep_expires_at && new Date(visit.prep_expires_at).getTime() <= Date.now()) {
    return { visit, prepUrl: null, ownsPage: false, linkReason: 'prep_page_expired' };
  }
  // Claim BEFORE the mint: ensureServicePrepToken initializes an unset key
  // itself, so a claim after it could never be fresh and a failed first
  // send would reserve the page forever (pre-push Codex P1 on cd6de743e).
  let claim = null;
  try {
    claim = await claimPrepPage(visit.id, config.emailTemplateKey);
    if (!claim.owned) {
      return {
        visit, prepUrl: null, ownsPage: false, linkReason: 'prep_page_taken',
        takenBy: guideLabelForTemplateKey(claim.takenBy),
      };
    }
    const token = await ensureServicePrepToken(visit.id, config.emailTemplateKey);
    return { visit, prepUrl: portalUrl(`/prep/${token}`), ownsPage: true, freshClaim: claim.fresh, linkReason: null };
  } catch (tokenErr) {
    // No token = no page to own: the email still goes out (portal link,
    // dated by the visit) but never stamps the row as a delivered guide
    // (pre-push Codex P1 on c3398fd21); a fresh claim is handed back.
    logger.warn(`[prep-guide-sender] prep token mint failed for service ${visit.id}: ${tokenErr.message}`);
    if (claim?.fresh) await releasePrepPage(visit.id, config.emailTemplateKey);
    return { visit, prepUrl: null, ownsPage: false, linkReason: 'prep_link_failed' };
  }
}

// Confirmed delivery of the guide (either channel): stamp the tracker's
// prep_sent_at proof. Only for a visit whose page this guide owns
// (resolvePrepVisit.ownsPage), and CONDITIONAL on the key still being ours:
// the automated lanes take no lock with this sender, so one may have
// delivered a different guide on this row meanwhile — the executor's
// unconditional markServicePrepSent would retarget that customer's link
// (pre-push Codex P1 on b909d8007). 0 rows = not ours any more; the other
// lane's delivered key stays.
async function stampPrepSent(visit, config) {
  if (!visit?.id) return;
  try {
    const stamped = await db('scheduled_services')
      .where({ id: visit.id, prep_template_key: config.emailTemplateKey })
      .update({ prep_sent_at: db.fn.now() });
    if (!Number(stamped)) logger.warn(`[prep-guide-sender] prep_sent_at stamp skipped for service ${visit.id}: page no longer keyed to ${config.emailTemplateKey}`);
  } catch (stampErr) {
    logger.warn(`[prep-guide-sender] prep_sent_at stamp failed for service ${visit.id}: ${stampErr.message}`);
  }
}

// The email leg. Outcome { sent, uncertain }: the template library can throw
// AFTER SendGrid accepted (its post-dispatch bookkeeping) with no marker on
// the error, so a throw once dispatch was reached is uncertain — a kept
// claim costs an operator "email it instead"; a released page 404s a URL
// the customer may already hold (GH Codex #3856 r5 P1). onQueued fires
// immediately before the provider call: a throw BEFORE it (template
// missing/disabled, no active version) reached no one and is a plain
// failure (GH Codex #3856 r6 P2).
async function sendPrepEmail({ customer, recipient, firstName, config, visit, prepUrl, stampVisit, guide = null }) {
  let dispatched = false;
  try {
    if (config.guide) {
      const snapshot = {};
      const wateringBlock = await buildWateringBlock(customer, snapshot);
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: config.emailTemplateKey,
        to: recipient.email,
        recipientType: 'customer',
        recipientId: customer.id,
        suppressionGroupKey: SERVICE_GROUP,
        categories: ['manual_prep', `prep_${config.emailTemplateKey.replace(/\./g, '_')}`],
        triggerEventId: manualPrepTriggerId(customer.id, config.emailTemplateKey, null),
        // Sent once per CLAIM: the ledger's unique key refuses a second
        // dispatch of this attempt; a released claim (definite miss, a
        // blocked suppression) gets a fresh key so a later retry can reach
        // the provider (GH Codex #3953 r4 P2).
        idempotencyKey: `prep_guide_once:${customer.id}:${config.emailTemplateKey}:${guide?.claimId ?? 'unclaimed'}`,
        suppressProviderErrorLog: true,
        // Dispatch-boundary home check (the weekly sender's own): re-read the
        // move stamp UNDER the property-preferences advisory lock so an
        // in-flight address change commits first; a stamp that moved since
        // the block was built means the email carries the former home's
        // rules — abort (onQueued → false). Unreadable = abort, fail closed
        // (GH Codex #3953 r4 P1).
        onQueued: async () => {
          const stampAt = (v) => (v ? new Date(v).getTime() : null);
          let verdict = false;
          try {
            verdict = await db.transaction(async (trx) => {
              await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(customer.id)]);
              const row = await trx('property_preferences').where({ customer_id: customer.id }).first('irrigation_home_changed_at');
              if (stampAt(row?.irrigation_home_changed_at) !== stampAt(snapshot.moveStamp)) return false;
              // Record the handoff BEFORE the provider call. A crashed process
              // cannot mistake an accepted-but-unlogged email for a free retry.
              return (await trx('customer_interactions')
                .where({ id: guide.claimId, customer_id: customer.id, body: GUIDE_CLAIM_BODY })
                .update({ body: GUIDE_EMAIL_DISPATCH_BODY })) === 1;
            });
          } catch (err) {
            // The library treats a THROWING hook as "keep" — an unreadable
            // home check must abort explicitly (pre-push Codex P1 on 39222b221).
            logger.warn(`[prep-guide-sender] guide email withheld for customer ${customer.id}: move-stamp re-read failed (${err.name} (code=${err.code}))`);
            return false;
          }
          if (!verdict) {
            logger.warn(`[prep-guide-sender] guide email withheld for customer ${customer.id}: address or delivery claim changed before dispatch`);
            return false;
          }
          dispatched = true;
          return true;
        },
        payload: {
          first_name: firstName,
          watering_block: wateringBlock,
          customer_portal_url: portalUrl('/?tab=property'),
          company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
          company_email: CONTACT_EMAIL,
        },
      });
      return { sent: !!result?.sent };
    }
    const portalVisitsUrl = portalUrl('/?tab=visits');
    const address = [customer.address_line1, customer.city, customer.state, customer.zip]
      .map((v) => String(v || '').trim()).filter(Boolean).join(', ');
    // service_date is a REQUIRED prep-template var (PREP_REQUIRED in
    // 20260526000014) — sendTemplate rejects an empty one. Fall back to a
    // non-empty placeholder when the customer has no matching upcoming visit.
    const serviceDate = (visit?.scheduled_date
      ? formatDisplayDate(visit.scheduled_date, { fallback: '' }) : '') || 'To be confirmed';
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: config.emailTemplateKey,
      to: recipient.email,
      recipientType: 'customer',
      recipientId: customer.id,
      suppressionGroupKey: SERVICE_GROUP,
      categories: ['project_prep', 'manual_prep', `prep_${config.emailTemplateKey.replace(/\./g, '_')}`],
      triggerEventId: manualPrepTriggerId(customer.id, config.emailTemplateKey, visit?.id),
      // Provider rejections can echo the recipient address; keep the raw
      // SendGrid body out of the logs (email addresses in logs are a P1).
      suppressProviderErrorLog: true,
      onQueued: () => { dispatched = true; },
      payload: {
        first_name: firstName,
        customer_name: [customer.first_name, customer.last_name].map((v) => String(v || '').trim()).filter(Boolean).join(' '),
        project_type: config.label,
        service_date: serviceDate,
        property_address: address,
        customer_portal_url: portalVisitsUrl,
        // No visit to hang the page on → the portal's visits tab.
        prep_url: prepUrl || portalVisitsUrl,
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: CONTACT_EMAIL,
      },
    });
    if (result?.sent) await stampPrepSent(stampVisit, config);
    return { sent: !!result?.sent };
  } catch (err) {
    // Sanitized: never log err.message — provider errors can carry the email.
    // A SendGrid 4xx after dispatch is a DEFINITE rejection (sendgrid-mail.js),
    // not uncertain: the fresh claim can be released (GH Codex #3856 r17 P2).
    const { isDefiniteRejection } = require('./sendgrid-mail');
    const uncertain = dispatched && !isDefiniteRejection(err);
    logger.error(`[prep-guide-sender] email send failed for customer ${customer.id} (${err?.name || 'Error'}, dispatched=${dispatched}, uncertain=${uncertain})`);
    return { sent: false, uncertain };
  }
}

// The SMS leg. Outcome { sent }. sendCustomerMessage swallows provider
// failures itself and throws in exactly two places: BEFORE the handoff
// (definite — nothing reached Twilio) or while persisting the final audit,
// carrying the provider outcome on the error. Acceptance is a send; a
// provider failure can include a timeout after acceptance, so standalone
// guides retain their claim until provider reconciliation proves absence.
async function sendPrepSms({ customer, firstName, phone, templateKey, vars, variant, purpose = 'appointment', consentBasis = null, pestType, actorId }) {
  let body;
  try {
    body = await renderSmsTemplate(templateKey, { first_name: firstName, ...vars }, {
      workflow: 'manual_prep_send', entity_type: 'customer', entity_id: customer.id,
    });
  } catch (err) {
    // Sanitized: renderer/provider errors can echo the phone or the body.
    logger.warn(`[prep-guide-sender] ${templateKey} render threw for customer ${customer.id} (${err?.name || 'Error'})`);
    return { sent: false };
  }
  if (!body) {
    logger.warn(`[prep-guide-sender] ${templateKey} template missing/disabled; SMS skipped for customer ${customer.id}`);
    return { sent: false };
  }
  let res;
  try {
    res = await sendCustomerMessage({
      to: phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose,
      ...(consentBasis ? { consentBasis } : {}),
      customerId: customer.id,
      identityTrustLevel: 'phone_matches_customer',
      // Sole caller is the admin send-prep route — an operator-clicked send,
      // exempt from the send window (allowlisted entry point).
      entryPoint: 'admin_prep_guide_send',
      metadata: {
        original_message_type: 'prep_info',
        pest_type: pestType,
        prep_variant: variant,
        manual: true,
        // adminUserId is the key the Twilio send path forwards into
        // sms_log.admin_user_id — keeps the manual send attributed to the
        // operator instead of reading as system-authored.
        adminUserId: actorId || undefined,
      },
    });
  } catch (err) {
    const accepted = err.providerOutcome?.sent === true;
    logger.warn(`[prep-guide-sender] prep SMS wrapper threw for customer ${customer.id} (${err?.code || err?.name || 'Error'}, providerAccepted=${accepted})`);
    return { sent: accepted, uncertain: err.providerOutcome?.sent === false };
  }
  // sent:true with a suppression sentinel (gate off, template disabled, owner
  // SMS kill) means nothing left — never record that as a delivery.
  if (!isRealProviderSend(res)) {
    logger.warn(`[prep-guide-sender] prep SMS not sent for customer ${customer.id}: ${res.code || res.reason || res.providerMessageId || 'unknown'}`);
    return { sent: false, uncertain: res.code === 'PROVIDER_FAILURE' };
  }
  return { sent: true };
}

// Who each channel greets: the email goes to the resolved recipient (which
// may be a service contact); the text goes to customer.phone — the primary's
// line — so it greets the customer's own first name, never the contact's.
// A chosen channel with nothing on file is an operator-facing refusal.
function resolvePrepContacts(customer, channel, config) {
  const recipient = config.guide
    ? { email: customer.email || '', name: customer.first_name || '' }
    : resolveProjectEmailRecipient(customer);
  const firstWord = (v) => String(v || '').trim().split(/\s+/)[0] || 'there';
  const contacts = {
    recipient,
    emailFirstName: firstWord(recipient.name || customer.first_name),
    smsFirstName: firstWord(customer.first_name),
    phone: String(customer.phone || '').trim(),
    wantEmail: channel !== 'sms',
    wantSms: channel !== 'email',
    refusal: null,
  };
  if (contacts.wantEmail && !recipient.email) contacts.refusal = 'no_email';
  else if (contacts.wantSms && !contacts.phone) contacts.refusal = 'no_phone';
  return contacts;
}

// Text body: the guide-page link when the visit's page is ours, else the
// pest's inline-steps text, else nothing to text.
function planPrepSms(config, prepUrl, { consentBasis = null } = {}) {
  if (prepUrl) {
    return { templateKey: SMS_GUIDE_LINK_KEY, vars: { prep_label: config.label, prep_url: prepUrl }, variant: 'guide_link' };
  }
  // A standalone guide is a seasonal tip, not appointment prep: its text
  // runs under the marketing_seasonal policy (owner ruling 08-25 — Seasonal
  // Tips consent + the seasonal_tips preference; GH Codex #3953 r1 P1) and
  // carries the verified consent basis the policy requires (r2 P1).
  if (config.smsStandaloneKey) {
    return config.guide
      ? { templateKey: config.smsStandaloneKey, vars: {}, variant: 'standalone', purpose: 'marketing_seasonal', consentBasis }
      : { templateKey: config.smsStandaloneKey, vars: {}, variant: 'standalone', purpose: 'appointment' };
  }
  return null;
}

// Runs the requested legs and settles the outcome on `result`: ok when either
// delivered; 'partial' (+ failedChannel) when Both delivered one; 'send_failed'
// when neither did — then the provisional page claim is handed back, unless
// the email leg is uncertain (GH Codex #3856 r4 P2 / r5 P1).
// Send-time ownership fence: the automated lanes take no lock with this
// sender, so the page could have been re-keyed between the claim and the
// provider calls; a link delivered after that would render another guide.
// Re-read the key as late as possible and, if it moved, deliver WITHOUT the
// link (email → portal fallback, text → skipped with the link's reason;
// pre-push Codex P1 on b36ba5eb7). Unknown (read failed) = moved.
async function pageStillOwned(page, config) {
  if (!page.ownsPage) return true;
  try {
    const row = await db('scheduled_services')
      .where({ id: page.visit.id, prep_template_key: config.emailTemplateKey })
      .first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[prep-guide-sender] prep page ownership re-check failed for service ${page.visit.id}: ${err.name} (code=${err.code})`);
    return false;
  }
}

async function deliverPrep({ customer, config, contacts, page, smsPlan, pestType, actorId, result }) {
  if (!(await pageStillOwned(page, config))) {
    page = { ...page, prepUrl: null, ownsPage: false, stampVisit: null, freshClaim: false, linkReason: 'prep_page_taken' };
    smsPlan = null;
    if (contacts.wantSms) result.smsLinkReason = 'prep_page_taken';
  }
  const { visit, prepUrl, stampVisit } = page;
  let uncertain = false;
  if (contacts.wantEmail) {
    const email = await sendPrepEmail({
      customer, recipient: contacts.recipient, firstName: contacts.emailFirstName, config, visit, prepUrl, stampVisit, guide: page.guide || null,
    });
    result.emailSent = email.sent;
    result.emailUncertain = !!email.uncertain;
    uncertain = result.emailUncertain;
  }
  if (contacts.wantSms && smsPlan) {
    const sms = await sendPrepSms({
      customer, firstName: contacts.smsFirstName, phone: contacts.phone, pestType, actorId, ...smsPlan,
    });
    result.smsSent = sms.sent;
    result.smsUncertain = !!sms.uncertain;
    if (sms.sent && smsPlan.variant === 'guide_link' && !result.emailSent) await stampPrepSent(stampVisit, config);
  }
  result.ok = result.emailSent || result.smsSent;
  if (!result.ok) {
    result.reason = result.smsLinkReason === 'prep_page_taken' && !contacts.wantEmail ? 'prep_page_taken' : 'send_failed';
    if (page.freshClaim && !uncertain) await releasePrepPage(stampVisit.id, config.emailTemplateKey);
  } else if (contacts.wantEmail && contacts.wantSms && result.emailSent !== result.smsSent) {
    // Both: one leg delivered, the other did not — say which, or the
    // operator reads a half-delivered ask as fully sent (GH Codex #3856 r2 P2).
    result.reason = 'partial';
    result.failedChannel = result.emailSent ? 'sms' : 'email';
  }
}

// The send-once fence. Three sources, any one is enough: the interaction
// marker (the pre-dispatch claim, settled on delivery), the email ledger for
// this template (delivered or uncertain attempts), and the SMS log by the
// hub link the text carries (twilio.js keeps no caller metadata; pre-push Codex P1 on 1c5df4ec7). A claim that
// never settled (process exit between the claim and the provider call) is
// in flight while young and reclaimed once stale — never a permanent
// "already sent" (GH Codex #3953 r4 P2).
async function priorGuideDelivery(customer, config, pestType) {
  const [marker, emails, text] = await Promise.all([
    db('customer_interactions')
      .where({ customer_id: customer.id })
      .whereIn('subject', [`${pestType} prep info sent`, `${config.label} prep sent (manual)`])
      .orderBy('created_at', 'desc')
      .first(),
    db('email_messages')
      .where({ recipient_id: customer.id, template_key: config.emailTemplateKey })
      .whereNotIn('status', ['blocked', 'failed'])
      .orderBy('created_at', 'desc')
      .select('status', 'created_at', 'queued_at', 'sent_at', 'provider_message_id'),
    db('sms_log')
      .where({ customer_id: customer.id, direction: 'outbound' })
      .whereRaw('message_body ILIKE ?', [`%${GUIDE_SMS_LINK_SIGNATURE}%`])
      .orderBy('created_at', 'desc')
      .first(),
  ]);
  // A stale queued row is retryable under the email library's own policy.
  // Inspect every attempt: a newer abandoned queue cannot hide an older send.
  const email = emails.find((row) => row.status !== 'queued' || row.sent_at || row.provider_message_id);
  const settledMarker = marker?.body !== GUIDE_CLAIM_BODY ? marker : null;
  const prior = settledMarker || email || text;
  if (prior) return { refusal: { reason: 'guide_already_sent', sentAt: prior.created_at } };
  if (emails.some((row) => EmailTemplateLibrary.queuedRowInFlight(row))) {
    return { refusal: { reason: 'prep_send_busy' } };
  }
  // Older claims lack the durable dispatch fence. Their stale queued row
  // cannot prove that SendGrid did not accept the email.
  if (emails.length && marker?.metadata?.guide_email_fenced !== true) {
    return { refusal: { reason: 'guide_check_failed' } };
  }
  if (marker) {
    const ageMs = Date.now() - Date.parse(marker.created_at);
    if (!Number.isFinite(ageMs) || ageMs < GUIDE_CLAIM_STALE_MS) return { refusal: { reason: 'prep_send_busy' } };
    // Persist the intended recipient so a later phone edit cannot redirect
    // reconciliation. Legacy claims did not record a channel or recipient.
    const smsTo = marker.metadata?.guide_sms_to;
    if (smsTo !== null) {
      const TwilioService = require('./twilio');
      const outcome = await TwilioService.findOutboundMessageSince({
        to: normalizeRecipient(smsTo || customer.phone),
        sentAfter: marker.created_at,
        bodyFragment: GUIDE_SMS_LINK_SIGNATURE,
      });
      if (outcome.found) {
        await db('customer_interactions').where({ id: marker.id, customer_id: customer.id }).update({
          body: 'Prep text confirmed by provider reconciliation — not resent.',
        });
        return { refusal: { reason: 'guide_already_sent', sentAt: marker.created_at } };
      }
      if (outcome.found !== false || outcome.unavailable) return { refusal: { reason: 'guide_check_failed' } };
    }
    await db('customer_interactions').where({ id: marker.id, customer_id: customer.id }).del();
  }
  return { refusal: null };
}

// Why a standalone guide is not sent right now, or null. Reads fail closed:
// an unreadable preference or history is treated as a refusal, never as a
// send (a guide is a courtesy; a second copy or an unwanted one is not).
async function guideGate(customer, config, pestType, { wantEmail = true, wantSms = true } = {}) {
  try {
    // The guide says "every Monday we email you your watering plan" — true
    // only for the Monday sweep's audience: an ACTIVE customer with
    // recurring lawn evidence (the sweep's own predicate). Channel
    // preferences are judged below per leg, not here: the sweep's full query
    // also folds in the email opt-out, which would refuse the text-only
    // fallback outright (GH Codex #3953 r3 P2, r4 P2; pre-push P1 on
    // 39222b221).
    const { hasRecurringLawnEvidence } = require('./irrigation-weekly-email');
    if (customer.active !== true || !(await hasRecurringLawnEvidence(customer.id))) return { refusal: { reason: 'not_recurring_lawn' } };
    const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
    if (prefs && prefs.seasonal_tips === false) return { refusal: { reason: 'seasonal_tips_off' } };
    // History BEFORE the email opt-out: on Both, that opt-out only drops the
    // email leg, so a customer already sent the guide must be caught here
    // or the text goes out twice (pre-push Codex P1 on 71346bab2).
    const history = await priorGuideDelivery(customer, config, pestType);
    if (history.refusal) return { refusal: history.refusal };
    // The text is a seasonal tip: it needs the EXPLICIT Seasonal Tips opt-in
    // (seasonal_tips === true; a never-asked NULL is not consent) and the
    // consent basis the marketing_seasonal policy requires — the same
    // derivation the customer-guide contract texts use (owner ruling 08-25;
    // GH Codex #3953 r2 P1). No basis = no text, never a downgraded purpose.
    let consentBasis = null;
    if (wantSms) {
      const { marketingSmsConsentBasisForContract } = require('./document-contract-delivery');
      consentBasis = await marketingSmsConsentBasisForContract({ customer_id: customer.id });
    }
    // The customer's email opt-out (the weekly irrigation sweep's own
    // np.email_enabled fence); a text-only send is unaffected by it, and on
    // Both the caller keeps the text leg — so the basis rides along.
    if (wantEmail && prefs && prefs.email_enabled === false) return { refusal: { reason: 'email_opted_out' }, consentBasis };
    return { refusal: null, consentBasis };
  } catch (err) {
    logger.warn(`[prep-guide-sender] guide preference / history read failed for customer ${customer.id}: ${err.name} (code=${err.code})`);
    return { refusal: { reason: 'guide_check_failed' } };
  }
}

// Admission for a standalone guide: the gate's refusals, the effective
// channel plan (an email opt-out or a missing Seasonal Tips opt-in drops
// that leg on Both and names it; refuses a single-channel send), then the
// pre-dispatch CLAIM — the marker row the fence reads, written before any
// provider call so a swallowed post-provider write (twilio.js's sms_log
// insert, the marker itself) can never leave an accepted send invisible.
// Released only on a definite miss (settleGuideClaim). No claim = no send
// (GH Codex #3953 r2 P2 + r3 P2).
const NO_GUIDE = Object.freeze({ refusal: null, consentBasis: null, claimId: null, skippedLeg: null });
async function openGuideSend({ customer, config, pestType, contacts, result, actorId }) {
  if (!config.guide) return NO_GUIDE;
  const gate = await guideGate(customer, config, pestType, { wantEmail: contacts.wantEmail, wantSms: contacts.wantSms });
  let skippedLeg = null;
  if (gate.refusal?.reason === 'email_opted_out' && contacts.wantSms) {
    contacts.wantEmail = false;
    result.emailSkipReason = 'email_opted_out';
    skippedLeg = 'email';
  } else if (gate.refusal) {
    return { refusal: gate.refusal };
  }
  const consentBasis = gate.consentBasis || null;
  if (contacts.wantSms && !consentBasis) {
    if (!contacts.wantEmail) return { refusal: { reason: 'seasonal_tips_not_opted_in' } };
    contacts.wantSms = false;
    result.smsLinkReason = 'seasonal_tips_not_opted_in';
    skippedLeg = 'sms';
  }
  try {
    const [claimed] = await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: 'email_outbound',
      admin_user_id: actorId || null,
      subject: `${config.label} prep sent (manual)`,
      body: GUIDE_CLAIM_BODY,
      metadata: { guide_sms_to: contacts.wantSms ? normalizeRecipient(contacts.phone) : null, guide_email_fenced: true },
    }, ['id']);
    return { refusal: null, consentBasis, claimId: claimed?.id ?? claimed ?? null, skippedLeg };
  } catch (err) {
    logger.warn(`[prep-guide-sender] guide send claim failed for customer ${customer.id}: ${err.name} (code=${err.code})`);
    return { refusal: { reason: 'guide_check_failed' } };
  }
}

async function settleGuideClaim({ claimId, customer, config, contacts, result, pestType }) {
  if (claimId == null) return;
  const row = db('customer_interactions').where({ id: claimId, customer_id: customer.id });
  try {
    if (result.ok) {
      await row.update({
        interaction_type: result.smsSent ? 'sms_outbound' : 'email_outbound',
        subject: result.smsSent ? `${pestType} prep info sent` : `${config.label} prep sent (manual)`,
        body: `Prep sent manually via Communications — ${[
          result.emailSent ? `email to ${contacts.recipient.email}` : null,
          result.smsSent ? `text to ${contacts.phone}` : null,
        ].filter(Boolean).join(' + ')}.`,
      });
    } else if (result.emailUncertain) {
      await row.update({ body: 'Prep email dispatched via Communications — delivery uncertain (provider response lost); not resent.' });
    } else if (result.smsUncertain) {
      // Any email attempt definitely failed. Restore the pending text state
      // so reconciliation can release it if Twilio proves no text went.
      await row.update({ body: GUIDE_CLAIM_BODY });
    } else {
      await row.del();
    }
  } catch (err) {
    // A delivered send whose settle failed still holds its claim (the fence
    // reads the subject, which the claim already carries); only a release
    // that failed costs an operator a "already sent" on the next click.
    logger.warn(`[prep-guide-sender] guide claim settle failed for customer ${customer.id} (ok=${result.ok}): ${err.name} (code=${err.code})`);
  }
}

// When the SMS went out, write the SAME marker the appointment tagger's
// replay guard (hasSentPrepSms) looks for — sms_outbound + "<pestType> prep
// info sent" — so a later replay of onServiceScheduled (e.g. regenerate-
// brief) doesn't re-text prep this manual click already delivered.
// Email-only sends keep the descriptive manual subject.
async function logPrepInteraction({ customer, config, contacts, result, pestType, actorId }) {
  try {
    await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: result.smsSent ? 'sms_outbound' : 'email_outbound',
      admin_user_id: actorId || null,
      subject: result.smsSent ? `${pestType} prep info sent` : `${config.label} prep sent (manual)`,
      body: `Prep sent manually via Communications — ${[
        result.emailSent ? `email to ${contacts.recipient.email}` : null,
        result.smsSent ? `text to ${contacts.phone}` : null,
      ].filter(Boolean).join(' + ')}.`,
    });
  } catch (err) {
    logger.warn(`[prep-guide-sender] interaction log failed for customer ${customer.id}: ${err.name} (code=${err.code})`);
  }
}

// Sends prep to a customer on the operator-chosen channel. Returns a
// structured result the route turns into an operator-facing message. Never
// throws — every failure surfaces as { ok: false, reason }.
async function sendPrepToCustomer({ customerId, pestType = 'flea', channel = 'both', actorId = null } = {}) {
  const config = PREP_CONFIG[pestType];
  if (!config) return { ok: false, reason: 'unsupported_pest_type', pestType };
  if (!isSupportedChannel(channel)) return { ok: false, reason: 'unsupported_channel', pestType, channel };

  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return { ok: false, reason: 'customer_not_found', pestType };

  const contacts = resolvePrepContacts(customer, channel, config);
  const result = {
    ok: false,
    pestType,
    channel,
    label: config.label,
    emailSent: false,
    smsSent: false,
    emailAddress: contacts.recipient.email || null,
    phone: contacts.phone || null,
  };
  if (contacts.refusal) return { ...result, reason: contacts.refusal };

  // Per-customer exclusivity of claim → send → release/stamp, across
  // instances (a deploy overlaps two): two sends for this customer within
  // the same seconds are the only way a fresh claim's release can race a
  // sibling's reuse of the same key and un-guide the sibling's delivered
  // URL. The canonical session advisory lock (cron-lock.runExclusive,
  // request-scoped: no health row, non-blocking) serializes them; a held
  // lease is an operator-facing "try again", not a wait (pre-push Codex
  // P1s on 8dbc30cc1 + 87b4cee92).
  const outcome = await runExclusive(`prep-send:${customer.id}`, async () => {
    // A guide hangs on no visit: nothing to look up, claim, link or stamp.
    // It is also a seasonal tip sent ONCE: a customer who turned off Seasonal
    // Lawn Tips does not get it (the weekly irrigation email honors the same
    // preference), and a customer who already received it is not sent it
    // again — the interaction row logPrepInteraction writes is the durable
    // proof (GH Codex #3953 r1 P1 + P2).
    // A guide: admission (audience, preferences, history), the effective
    // channel plan, and the pre-dispatch claim, in one step; neutral for
    // visit prep.
    const guide = await openGuideSend({ customer, config, pestType, contacts, result, actorId });
    if (guide.refusal) return { ...result, ...guide.refusal };
    const page = config.guide
      ? { visit: null, prepUrl: null, ownsPage: false, linkReason: null, guide }
      : await resolvePrepVisit(customer, config);
    // An automation is already sending this very guide for the visit —
    // every channel would duplicate it.
    if (page.linkReason === 'prep_send_pending') return { ...result, reason: 'prep_send_pending' };
    // The stamp target: only a visit whose page this guide owns.
    page.stampVisit = page.ownsPage ? page.visit : null;
    const smsPlan = contacts.wantSms ? planPrepSms(config, page.prepUrl, { consentBasis: guide.consentBasis }) : null;
    // Text-only: refused with the link's own reason (no visit / page taken /
    // link failed), never a blanket "no visit". Both: the email leg is
    // valid, so it goes out and the text is reported as the failed leg
    // carrying that reason (pre-push Codex P1 on 7271142f8) — deliverPrep
    // skips an unplanned text.
    if (contacts.wantSms && !smsPlan) {
      const linkRefusal = { reason: page.linkReason, ...(page.takenBy ? { takenBy: page.takenBy } : {}) };
      if (!contacts.wantEmail) return { ...result, ...linkRefusal };
      result.smsLinkReason = linkRefusal.reason;
      if (linkRefusal.takenBy) result.takenBy = linkRefusal.takenBy;
    }

    await deliverPrep({ customer, config, contacts, page, smsPlan, pestType, actorId, result });
    // A guide leg dropped at admission (email opt-out, no Seasonal Tips
    // opt-in) makes a delivered send partial, naming that leg.
    if (result.ok && guide.skippedLeg) {
      result.reason = 'partial';
      result.failedChannel = guide.skippedLeg;
    }
    if (guide.claimId != null) {
      // Settle the claim: delivered → the tagger-compatible marker
      // (logPrepInteraction's own shape, on the claimed row); uncertain
      // email → kept, marked; definite miss → released so a retry is allowed.
      await settleGuideClaim({ claimId: guide.claimId, customer, config, contacts, result, pestType });
    } else if (result.ok) {
      await logPrepInteraction({ customer, config, contacts, result, pestType, actorId });
      await settleHeldEnrollment(customer.id, config.emailTemplateKey);
    }
    return result;
  }, { recordHealth: false, waitForSlot: false });
  if (wasLockSkipped(outcome)) return { ...result, reason: 'prep_send_busy' };
  return outcome;
}

module.exports = {
  sendPrepToCustomer, isSupportedPestType, isSupportedChannel, nextUpcomingVisit, settleHeldEnrollment, buildWateringBlock, PREP_CONFIG, CHANNELS, SMS_GUIDE_LINK_KEY,
};
