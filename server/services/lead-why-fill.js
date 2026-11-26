/**
 * Lead "why" filler — nightly, deterministic, NO LLM calls.
 *
 * Fills three fields on `leads` from the voice-of-customer corpus
 * (call_research_chunks, mined by call-research-miner.js) using fixed rules
 * over each chunk's normalized topic labels (never raw quote words):
 *
 *   previous_company  — the rival the caller is LEAVING (RIVALS list). Not
 *                       leads.lost_to_competitor, which is the rival that WON.
 *   switch_reason     — why the caller left that provider (SWITCH_RULES).
 *   not_booked_reason — why the lead did not book (NOT_BOOKED_RULES).
 *
 * Rules (owner ruling 2026-11-25, option A):
 *   - The job OWNS the three fields: each run recomputes them from current
 *     evidence and writes only what changed (a value can be cleared). Late
 *     call mining, a later booking or a status change therefore self-correct
 *     on the next run instead of being frozen. There is no office editor for
 *     these fields (option B, not picked); the migration comment that
 *     mentions office edits predates that ruling. Each UPDATE re-checks that
 *     the lead is live and that its status, converted_at and customer link
 *     are the ones the values were computed from.
 *   - switch_reason / previous_company read the caller's chunks on calls
 *     where a caller chunk carries a provider-relationship label ("current
 *     provider", "switching providers"); shopping labels alone never count.
 *     Two different rivals on one lead = ambiguous = previous_company NULL.
 *   - Each reason is the one with the most matching labels (ties: list order).
 *   - not_booked_reason only for lost / unresponsive leads that are not
 *     converted and whose customer has no active visit booked since the lead
 *     (an assessment booking keeps the status and leaves converted_at NULL).
 *     no_response only when the status is 'unresponsive', no other reason
 *     fits, and no linked call from the last 3 days is still waiting to be
 *     mined.
 *   - Each call feeds at most one lead: explicit owners (sid / metadata stamp)
 *     win, conflicting owners are skipped, and the same-customer window is a
 *     fallback only when exactly one live lead of that customer fits.
 *   - Leads of customers who already existed before the lead are skipped:
 *     they are not prospects switching providers.
 *   - why_filled_at is stamped in the same UPDATE as any changed field.
 *   - Idempotent; bounded by LOOKBACK_DAYS and MAX_LEADS_PER_RUN. Each run
 *     scans least-recently-checked leads first (why_checked_at), so a capped
 *     run never starves older leads in the window.
 *
 * The label lists come from the topic labels the miner actually writes
 * (prod sample 2026-11-25) and the research themes of 2026-11-23.
 *
 * Kill switch: LEAD_WHY_FILL=off (read per run in scheduler.js). Not a GATE_*.
 */

const db = require('../models/db');
const { dateOnlyString } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');
const { DEFAULT_EXCLUDE_STATUSES } = require('./scheduling/occupancy');
const { eligibleCallsQuery } = require('./call-research-miner');
const { leadLinkedVisits } = require('./lead-related-visits');
const logger = require('./logger');

const LOOKBACK_DAYS = 120;
const PAGE_SIZE = 200;
const MAX_LEADS_PER_RUN = 2000;
// A call counts for a lead (same customer, no sid/stamp link) when it happened
// from 2 days before the lead was created to 14 days after.
const CALL_WINDOW_BEFORE_DAYS = 2;
const CALL_WINDOW_AFTER_DAYS = 14;
// A linked call this recent that the miner has not stamped yet may still add
// evidence, so no_response waits for it.
const MINING_GRACE_DAYS = 3;
const DAY_MS = 86400000;

// Statuses that never get a not-booked reason (booked, junk, or not a lead).
const LOST_STATUSES = new Set(['lost', 'unresponsive']);

const SWITCH_TAGS = new Set(['competitor_mention', 'churn_signal', 'complaint']);
const NOT_BOOKED_TAGS = new Set(['objection']);

// The rules read the miner's TOPIC LABELS (short normalized phrases such as
// "current provider", "switching providers", "pricing", "one-time treatment",
// "turner"), not raw quote words: the miner already resolved negation, quote
// requests and who did what, so a label is far steadier than a keyword hit.
//
// A chunk is switch evidence only when one of its labels states a relationship
// with a provider the caller had. Shopping labels alone ("comparison
// shopping", "quote comparison") are not.
const SHOPPING_TOPIC = /shopping|comparison|competitor pricing|second opinion|quote|estimate|bid/;
const RELATIONSHIP_TOPIC = /^(current|previous|prior|existing|former|old|other pest|lawn) (pest )?provider$|^provider (dissatisfaction|switch(ing)?|cancellation)$|^switching providers?$|^service cancellation$/;
// The OLD provider specifically: a rival named next to one of these labels is
// the company the caller left. "switching providers" or "replacement
// provider" can name the NEW one, so they never qualify a rival.
const OLD_PROVIDER_TOPIC = /^(current|previous|prior|existing|former|old) (pest )?provider$|^provider (dissatisfaction|cancellation)$/;

// Each reason = labels that state it. The reason a lead gets is the one with
// the most matching labels across its chunks; a tie goes to the earlier entry.
const SWITCH_RULES = [
  ['moved', /\bmov(e|ed|ing)\b|new (home|house)|home (purchase|sale)/],
  ['pests_came_back', /treatment (effectiveness|failure)|failed treatment|ineffective treatment|service (effectiveness|failure|quality)|recurring (infestation|pests?)|re-?infestation/],
  ['no_show', /service gap|missed (service|appointment|visit)|no[- ]?show|service delays?|skipped service/],
  ['no_callback', /call ?back|responsiveness|unresponsive|communication|no response/],
  ['contract', /contract|commitment|cancellation fee|lock[- ]?in/],
  ['bundle', /bundl|consolidat/],
  ['price_creep', /price|pricing|cost|rate increase|monthly price|fee/],
];

const NOT_BOOKED_RULES = [
  ['spouse', /spouse|partner|husband|wife|decision maker|family decision/],
  ['one_visit', /one[- ]?time (treatment|service|visit)|single (treatment|service|visit)/],
  ['no_plan', /commitment|recurring service|contract|annual prepay(ment)?|prepay|service frequency|quarterly service|membership|subscription/],
  ['wants_a_look', /inspection request|in[- ]?person (visit|inspection|assessment)|site visit|see (it )?first/],
  ['price', /price|pricing|afford|budget|cost|fee|expensive/],
  ['timing', /timing|appointment time|schedul|availability|later|seasonal/],
];

// Canonical name -> label pattern. Own-firm name is deliberately absent. The
// miner writes rival names as labels ("turner", "turner pest control",
// "truly nolan", "home team").
const RIVALS = [
  ['Turner', /^turner\b/],
  ['HomeTeam', /^home ?team\b/],
  ['Massey', /^massey\b/],
  ['Orkin', /^orkin\b/],
  ['Terminix', /^terminix\b/],
  ['TruGreen', /^(tru ?green|true green)\b/],
  ['Hughes', /^hughes\b/],
  ['Green Edge', /^green ?edge\b/],
  ['Arrow', /^arrow (pest|exterminat|termite)/],
  ['Keller', /^keller\b/],
  ['Good News', /^good news pest/],
  ['Hobsons', /^hobsons?\b/],
  ['Southern Pride', /^southern pride\b/],
  ['PHS', /^phs\b/],
  ['Pest Bear', /^pest ?bear\b/],
  ['Apex', /^apex pest/],
  ['Venice Pest', /^venice pest control/],
  ['Hawx', /^hawx\b/],
  ['Aptive', /^aptive\b/],
  ['Truly Nolen', /^(truly )?nol[ae]n\b/],
  ['Bug Off', /^bug off\b/],
  ['Rentokil', /^rentokil\b/],
];

const SWITCH_REASONS = SWITCH_RULES.map(([reason]) => reason);
const NOT_BOOKED_REASONS = [...NOT_BOOKED_RULES.map(([reason]) => reason), 'no_response'];
const PREVIOUS_COMPANIES = RIVALS.map(([name]) => name);

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const labels = (c) => (Array.isArray(c.topics) ? c.topics : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);

// The rule with the most matching labels; ties go to the earlier rule.
function topReason(rules, chunkList) {
  const all = chunkList.flatMap(labels);
  let best = null;
  let bestCount = 0;
  for (const [reason, re] of rules) {
    const n = all.filter((t) => re.test(t)).length;
    if (n > bestCount) { best = reason; bestCount = n; }
  }
  return best;
}

const isRelationship = (c) => labels(c).some((t) => RELATIONSHIP_TOPIC.test(t));
const isShopping = (c) => labels(c).some((t) => SHOPPING_TOPIC.test(t));
// A rival counts only from a chunk that itself states the relationship and is
// not about shopping ("current provider" + "orkin"); a rival named in a quote
// chunk elsewhere on the call is a competitor, not the old provider.
const isOldProvider = (c) => labels(c).some((t) => OLD_PROVIDER_TOPIC.test(t));
const rivalsIn = (chunkList) => [...new Set(chunkList.filter((c) => isOldProvider(c) && !isShopping(c)).flatMap(labels)
  .flatMap((t) => RIVALS.filter(([, re]) => re.test(t)).map(([name]) => name)))];

// Switch evidence for one call: the caller's switch-tag chunks on a call where
// at least one caller chunk carries a relationship label. Whole-call scope lets
// "We had Orkin" and a later "they never came" chunk work together.
function switchChunksByCall(callerChunks) {
  const byCall = new Map();
  for (const c of callerChunks) byCall.set(c.call_log_id, [...(byCall.get(c.call_log_id) || []), c]);
  const out = [];
  for (const list of byCall.values()) {
    // Shopping chunks never supply a reason: a quoted price is not why they left.
    if (list.some(isRelationship)) out.push(...list.filter((c) => SWITCH_TAGS.has(c.tag) && !isShopping(c)));
  }
  return out;
}

const clearPatch = (lead) => Object.fromEntries(['previous_company', 'switch_reason', 'not_booked_reason']
  .filter((k) => !isBlank(lead[k])).map((k) => [k, null]));
const sameValue = (a, b) => (isBlank(a) ? null : String(a)) === (isBlank(b) ? null : String(b));

/**
 * Recompute the three fields for one lead. Pure: lead row + its linked chunks
 * + facts in, a patch of ONLY the fields whose value changed out (a field can
 * change to null). facts: { booked, miningPending }.
 */
function planLeadWhy(lead, chunks, facts = {}) {
  const callerChunks = (chunks || []).filter((c) => c.speaker === 'caller');
  const next = { previous_company: null, switch_reason: null, not_booked_reason: null };

  const switchChunks = switchChunksByCall(callerChunks);
  if (switchChunks.length) {
    next.switch_reason = topReason(SWITCH_RULES, switchChunks);
    const rivals = rivalsIn(switchChunks);
    if (rivals.length === 1) next.previous_company = rivals[0];
  }

  // Only a lead whose status says it did not book (lost / unresponsive), that
  // never converted and has no visit booked since, gets a not-booked reason.
  if (!lead.converted_at && !facts.booked && LOST_STATUSES.has(lead.status)) {
    next.not_booked_reason = topReason(NOT_BOOKED_RULES, callerChunks.filter((c) => NOT_BOOKED_TAGS.has(c.tag)))
      || (lead.status === 'unresponsive' && !facts.miningPending ? 'no_response' : null);
  }

  const patch = {};
  for (const [key, value] of Object.entries(next)) if (!sameValue(lead[key], value)) patch[key] = value;
  return patch;
}

const asUuidList = (rows, key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))];

const CALL_COLS = (conn) => ['id', 'customer_id', 'created_at', 'twilio_call_sid', 'call_sid',
  'processing_token', 'processing_status', conn.raw("metadata->>'lead_id' AS stamp_lead_id")];

// Same rule as admin-leads.js (settledLeadStamp / settledDissentingStamp): a
// metadata.lead_id stamp is SETTLED when no processing pass holds the call and
// its status is processed (legacy NULL counts). A provisional stamp can still
// be cleared or repointed, so the call is left alone until it settles.
const stampState = (c) => {
  if (!c.stamp_lead_id) return 'none';
  return c.processing_token == null && (c.processing_status == null || c.processing_status === 'processed') ? 'settled' : 'provisional';
};

// Candidate calls for a page of leads: by the lead's sid, by the lead_id stamp
// on call_log.metadata, and by the same customer.
async function candidateCalls(conn, leads) {
  const sids = [...new Set(leads.map((l) => l.twilio_call_sid).filter(Boolean))];
  const ids = leads.map((l) => l.id);
  const rows = await conn('call_log').where((w) => {
    w.whereIn(conn.raw("metadata->>'lead_id'"), ids);
    if (sids.length) w.orWhereIn('twilio_call_sid', sids).orWhereIn('call_sid', sids);
    // Same-customer calls only inside each lead's window, bounded in SQL.
    for (const l of leads) {
      if (!l.customer_id) continue;
      const t = new Date(l.created_at).getTime();
      w.orWhere((c) => c.where('customer_id', l.customer_id)
        .whereBetween('created_at', [new Date(t - CALL_WINDOW_BEFORE_DAYS * DAY_MS), new Date(t + CALL_WINDOW_AFTER_DAYS * DAY_MS)]));
    }
  }).select(CALL_COLS(conn));
  return [...new Map(rows.map((r) => [r.id, r])).values()];
}

// call id -> Set of live lead ids whose sid is the call's (across ALL leads).
async function sidOwners(conn, calls) {
  const owners = new Map();
  const sids = [...new Set(calls.flatMap((c) => [c.twilio_call_sid, c.call_sid]).filter(Boolean))];
  if (!sids.length) return owners;
  const sidLeads = await conn('leads').whereIn('twilio_call_sid', sids).whereNull('deleted_at').select('id', 'twilio_call_sid');
  for (const c of calls) {
    for (const l of sidLeads) {
      if (l.twilio_call_sid === c.twilio_call_sid || l.twilio_call_sid === c.call_sid) owners.set(c.id, (owners.get(c.id) || new Set()).add(l.id));
    }
  }
  return owners;
}

// Assign each call to at most ONE lead: a settled stamp wins (and supersedes a
// stale sid); a provisional stamp leaves the call unassigned; else a sid owned
// by exactly one live lead; else the customer window, only when exactly one
// live lead of that customer fits it.
async function assignCalls(conn, leads, calls) {
  const bySid = await sidOwners(conn, calls);
  const customerIds = asUuidList(leads, 'customer_id');
  const custLeads = customerIds.length
    ? await conn('leads').whereIn('customer_id', customerIds).whereNull('deleted_at').select('id', 'customer_id', 'created_at')
    : [];
  const inWindow = (call, l) => {
    const delta = (new Date(call.created_at) - new Date(l.created_at)) / DAY_MS;
    return delta >= -CALL_WINDOW_BEFORE_DAYS && delta <= CALL_WINDOW_AFTER_DAYS;
  };
  const owner = new Map(); // call id -> lead id
  const unsettled = new Set(); // lead ids with a call still being (re)processed
  for (const c of calls) {
    const stamp = stampState(c);
    if (stamp === 'settled') { owner.set(c.id, c.stamp_lead_id); continue; }
    if (stamp === 'provisional') {
      unsettled.add(c.stamp_lead_id);
      for (const id of bySid.get(c.id) || []) unsettled.add(id);
      continue;
    }
    const sid = bySid.get(c.id);
    if (sid) { if (sid.size === 1) owner.set(c.id, [...sid][0]); continue; }
    if (!c.customer_id) continue;
    const fits = custLeads.filter((l) => l.customer_id === c.customer_id && inWindow(c, l));
    if (fits.length === 1) owner.set(c.id, fits[0].id);
  }
  return { owner, unsettled };
}

async function loadChunksByLead(conn, leads, now) {
  const byLead = new Map(leads.map((l) => [l.id, new Set()]));
  const calls = new Map(); // call_log id -> row
  const candidates = await candidateCalls(conn, leads);
  const { owner, unsettled } = await assignCalls(conn, leads, candidates);
  for (const c of candidates) {
    const leadId = owner.get(c.id);
    if (byLead.has(leadId)) { calls.set(c.id, c); byLead.get(leadId).add(c.id); }
  }

  const chunksByCall = new Map();
  if (calls.size) {
    // Only calls that are still eligible research calls: one re-classified as
    // a wrong number or spam since it was mined stops supplying reasons.
    const eligible = (await eligibleCallsQuery({ onlyUnmined: false, conn }).whereIn('call_log.id', [...calls.keys()]).select('call_log.id')).map((r) => r.id);
    const chunks = await conn('call_research_chunks')
      .whereIn('call_log_id', eligible)
      .select('call_log_id', 'speaker', 'tag', 'quote', 'context', 'topics');
    for (const c of chunks) chunksByCall.set(c.call_log_id, [...(chunksByCall.get(c.call_log_id) || []), c]);
  }
  // Recent calls the miner WILL still process (its own eligibility query:
  // inbound, transcribed, consented, not yet mined). An outbound follow-up is
  // never mined, so it never holds no_response back.
  const recent = [...calls.values()].filter((c) => now - new Date(c.created_at) < MINING_GRACE_DAYS * DAY_MS).map((c) => c.id);
  const pending = new Set(recent.length
    ? (await eligibleCallsQuery({ onlyUnmined: true, conn }).whereIn('call_log.id', recent).select('call_log.id')).map((r) => r.id)
    : []);
  const out = new Map();
  for (const [leadId, set] of byLead) {
    const ids = [...set];
    out.set(leadId, {
      chunks: ids.flatMap((cid) => chunksByCall.get(cid) || []),
      miningPending: ids.some((cid) => pending.has(cid)),
      unsettled: unsettled.has(leadId),
    });
  }
  return out;
}

// Leads with an active visit linked to THAT lead by exact record evidence
// (lead-related-visits.js, the same rule as the admin lead card). A visit for
// another inquiry of the same customer never counts.
// A checkout slot hold is not a booking: the customer may abandon it. A claimed
// visit has a customer_id (a staff claim can leave the expiry set).
function notUnclaimedHold() {
  this.whereNull('ss.reservation_expires_at').orWhereNotNull('ss.customer_id');
}

async function bookedLeadIds(conn, leads) {
  const out = new Set();
  for (const l of leads) {
    if (!LOST_STATUSES.has(l.status) || l.converted_at) continue; // only these can get a reason
    const active = await leadLinkedVisits(conn, l).whereNotIn('ss.status', DEFAULT_EXCLUDE_STATUSES).where(notUnclaimedHold).first('ss.id')
      // The lead's own funnel row can carry the deal with no visit linked to it
      // (a wizard repeat settles onto the root's row): same rule as lead-staleness.js.
      || await conn('ad_service_attribution').where('lead_id', l.id).whereIn('funnel_stage', ['booked', 'completed']).first('id');
    if (active) out.add(l.id);
  }
  return out;
}

// A lead from someone who was already a customer (a completed visit before the
// lead) is not a prospect switching providers. A customer ROW alone is not
// enough: prospects sit in the pipeline as customer rows before they call.
async function existingCustomerLeadIds(conn, leads) {
  const customerIds = asUuidList(leads, 'customer_id');
  if (!customerIds.length) return new Set();
  const done = await conn('scheduled_services').whereIn('customer_id', customerIds).where('status', 'completed')
    .select('customer_id', 'scheduled_date', 'completed_at');
  // completed_at when stamped (catches a visit done that morning); legacy
  // visits without it fall back to an earlier ET calendar day.
  const before = (v, l) => (v.completed_at
    ? new Date(v.completed_at) < new Date(l.created_at)
    : dateOnlyString(v.scheduled_date) < etDateString(new Date(l.created_at)));
  // Imported / legacy history often lives only in service_records (same two
  // sources as estimate-conversion-guard.js).
  const records = await conn('service_records').whereIn('customer_id', customerIds).where('status', 'completed')
    .select('customer_id', 'service_date');
  const recordBefore = (r, l) => dateOnlyString(r.service_date) < etDateString(new Date(l.created_at));
  return new Set(leads.filter((l) => done.some((v) => v.customer_id === l.customer_id && before(v, l))
    || records.some((r) => r.customer_id === l.customer_id && recordBefore(r, l))).map((l) => l.id));
}

// Write only the changed fields, and only while the lead is still live and its
// status, converted_at and customer link are the ones the values came from.
async function writeLeadWhy(conn, lead, patch, now) {
  const q = conn('leads').where({ id: lead.id }).whereNull('deleted_at');
  for (const col of ['status', 'customer_id']) {
    if (lead[col] == null) q.whereNull(col); else q.where(col, lead[col]);
  }
  // The planner only reads whether the lead converted; an exact timestamp
  // compare would fail on microseconds a JS Date drops.
  if (lead.converted_at == null) q.whereNull('converted_at'); else q.whereNotNull('converted_at');
  return q.update({ ...patch, why_filled_at: now });
}

async function fillLeadWhy({ conn = db, now = new Date(), maxLeads = MAX_LEADS_PER_RUN } = {}) {
  const cutoff = new Date(now - LOOKBACK_DAYS * DAY_MS);
  const stats = { scanned: 0, changed: 0, fields: 0 };

  while (stats.scanned < maxLeads) {
    const leads = await conn('leads')
      .whereNull('deleted_at')
      // In the window, or outside it but still carrying a value the job owns
      // (its outcome can change later, e.g. a day-121 conversion).
      .where((w) => w.where('created_at', '>=', cutoff)
        .orWhereNotNull('previous_company').orWhereNotNull('switch_reason').orWhereNotNull('not_booked_reason'))
      .where((w) => w.whereNull('why_checked_at').orWhere('why_checked_at', '<', now))
      .orderByRaw('why_checked_at ASC NULLS FIRST, created_at DESC, id DESC')
      .limit(Math.min(PAGE_SIZE, maxLeads - stats.scanned))
      .select('id', 'status', 'converted_at', 'created_at', 'customer_id', 'estimate_id', 'twilio_call_sid', 'previous_company', 'switch_reason', 'not_booked_reason');
    if (!leads.length) break;
    stats.scanned += leads.length;

    // Existing-customer and duplicate leads are out of scope: any value the job
    // wrote while they were eligible is cleared.
    const existing = await existingCustomerLeadIds(conn, leads);
    const ineligible = (l) => existing.has(l.id) || l.status === 'duplicate';
    const candidates = leads.filter((l) => !ineligible(l));
    const evidence = candidates.length ? await loadChunksByLead(conn, candidates, now) : new Map();
    const booked = await bookedLeadIds(conn, candidates);

    for (const lead of leads) {
      const ev = evidence.get(lead.id) || { chunks: [], miningPending: false, unsettled: false };
      // A call of this lead is still being (re)processed: keep its values until
      // ownership settles, so a lead past the window is never cleared and lost.
      if (ev.unsettled) continue;
      const patch = ineligible(lead)
        ? clearPatch(lead)
        : planLeadWhy(lead, ev.chunks, { booked: booked.has(lead.id), miningPending: ev.miningPending });
      if (!Object.keys(patch).length) continue;
      if (await writeLeadWhy(conn, lead, patch, now)) {
        stats.changed += 1;
        stats.fields += Object.keys(patch).length;
      }
    }
    // Stamp the page as examined so this run moves on and the next run starts
    // with leads not looked at for the longest time.
    await conn('leads').whereIn('id', leads.map((l) => l.id)).update({ why_checked_at: now });
    if (leads.length < PAGE_SIZE) break;
  }
  logger.info(`[lead-why-fill] scanned=${stats.scanned} leads_changed=${stats.changed} fields=${stats.fields}`);
  return stats;
}

module.exports = {
  fillLeadWhy,
  planLeadWhy,
  SWITCH_REASONS,
  NOT_BOOKED_REASONS,
  PREVIOUS_COMPANIES,
  bookedLeadIds,
  _test: { SWITCH_RULES, NOT_BOOKED_RULES, RIVALS, RELATIONSHIP_TOPIC },
};
