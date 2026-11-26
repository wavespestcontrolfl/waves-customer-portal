/**
 * Lead "why" filler — nightly, deterministic, NO LLM calls.
 *
 * Fills three fields on `leads` from the voice-of-customer corpus
 * (call_research_chunks, mined by call-research-miner.js) using fixed keyword
 * rules over each chunk's quote + context + topics:
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
 *   - switch_reason / previous_company read caller speech only, on calls that
 *     carry competitor_mention / churn_signal / complaint chunks about a prior
 *     provider. Two different rivals named on one lead = ambiguous = left NULL.
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
 * Rule lists are ported from the research scripts of 2026-11-23 (switch
 * themes, objection themes, rival name patterns); the order of each list is
 * the priority — the first rule that matches wins.
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
// Evidence the caller actually USED another provider. A rival named only as a
// quote ("Orkin quoted me $99") is not a prior relationship.
const PRIOR_PROVIDER_RE = /(current|previous|prior|existing|former|old|last) (pest |lawn )?(provider|company|exterminator|guy|service)|switch(ing|ed)? (from|over from|providers|companies)|provider switch|currently (with|using) (a|an|another|them)|cancel+(ed|ing)? (with|our|my) (provider|company|service)/i;
// A rival counts as the previous company only when a use phrase names it:
// "we had Turner", "switching from Orkin", "been with Hughes".
// Only "the" may sit between the phrase and the name ("had the Turner guy"),
// so "we had ants and Orkin quoted us" and "had called Orkin" never link.
// A negated use ("have not used Orkin", "never had Turner") is not use.
const RIVAL_USE_LEAD = String.raw`(?<!(?:\bnot|\bnever|n't|\bno)\s+)(?<!(?:\bnot|\bnever|n't)\s+(?:been|ever)\s+)\b(?:had|have had|used|been using|been with|was with|were with|leaving|left|cancel+(?:ed|ing)?|switch(?:ing|ed)? from|currently (?:have|use|with))\s+(?:the\s+)?`;
// The caller says they never had a provider: no switch evidence at all.
const NO_PRIOR_PROVIDER_RE = /never (used|had|been with)|first time|no (current|previous|prior) (provider|company)|don'?t have (a|any) (provider|company|pest)/i;
// A rival named for a quote ("had Orkin quote me") is shopping, not use. This
// only blocks that rival link; "we left Orkin ... now we want a quote" stays.
// The look-ahead skips the rest of the company name ("Orkin Pest Control quote me").
const RIVAL_SHOPPING_TAIL = String.raw`(?!(?:\s+(?:pest|lawn|termite|control|services?|company|exterminat\w*|inc\.?))*\s+(?:to\s+)?(?:quot|give|gave|come|came|bid|estimat|send|sent|look))`;

// First match wins. Specific complaint themes sit before the broad price theme.
const SWITCH_RULES = [
  ['moved', /\bmoved\b|new (home|house)|just (bought|purchased)|bought (a|the|our) (new )?(home|house)|closing on|offer on the home/],
  ['pests_came_back', /still (seeing|have|got)|came back|coming back|not work|didn'?t work|ineffective|failed treatment|treatment effectiveness|recurring infestation|keep seeing|getting worse/],
  ['no_show', /no[- ]show|didn'?t show|never show|never came|miss(ed|ing) (an? |our |the )?(appointment|service|visit)|service gap|skipp|didn'?t come|haven'?t been out|haven'?t come/],
  ['no_callback', /(never|didn'?t|don'?t|did not|do not|won'?t|wouldn'?t|would not|no one|nobody) (ever )?(call(ed)? (me |us )?back|return(ed)? (my|our) calls?|answer(s|ed)?)|no callback|not getting back|can'?t reach|cannot reach|unresponsive/],
  ['contract', /contract|commitment|locked in|cancel(lation)? fee/],
  ['bundle', /bundle|consolidat|both lawn and pest|lawn and pest|one company/],
  ['price_creep', /price|pricing|cost|expensive|cheaper|afford|paying|raised|increase|went up|\$|dollar/],
];

// First match wins. Run over caller speech in objection chunks only: a `need`
// chunk is the caller's problem ("I want quarterly service"), not a rejection.
const NOT_BOOKED_RULES = [
  // A spouse or partner must be named; "I'll think about it" alone is no reason.
  ['spouse', /\b(husband|wife|spouse|partner|boyfriend|girlfriend|fianc[eé]e?)\b/],
  ['one_visit', /one[- ]time|just once|single (visit|treatment|service)|one visit|just the one/],
  // Needs words that turn the plan down: "the quarterly plan is too expensive" is a price objection.
  ['no_plan', /(don'?t|do not|not|no|never) (want|interested in|looking for|need|sign(ing)? up for|do) (a |any |the |to )?(plan|contract|commitment|commit|recurring|quarterly|annual|subscription|membership|ongoing)|(don'?t|do not|won'?t|not going to|can'?t) (want to )?(commit|sign (a |any )?contract|prepay|pay (up ?front|in advance))|no (contracts?|commitments?|plans?)\b/],
  ['wants_a_look', /in[- ]person|come out (and|to) (look|see|take)|look at (it|the)|take a look|see it first|inspect|walk ?through|before (i|we) (commit|decide|agree)/],
  ['price', /price|pricing|cost|expensive|afford|budget|cheaper|too much|\$|dollar/],
  ['timing', /not right now|next (month|week)|\blater\b|not ready|\bwait|after (the )?(holiday|summer|season)|timing|out of town|busy|schedul/],
];
const NOT_BOOKED_TAGS = new Set(['objection']);

// Canonical name -> pattern. Own-firm name is deliberately absent. 'Arrow' is
// tightened from a bare word (too many false hits) to the pest-company form.
const RIVALS = [
  ['Turner', /turner/i],
  ['HomeTeam', /home ?team/i],
  ['Massey', /massey/i],
  ['Orkin', /\borkin/i],
  ['Terminix', /terminix/i],
  ['TruGreen', /tru ?green|true green/i],
  ['Hughes', /hughes/i],
  ['Green Edge', /green ?edge/i],
  ['Arrow', /\barrow (pest|exterminat|termite)/i],
  ['Keller', /keller/i],
  ['Good News', /good news pest/i],
  ['Hobsons', /hobson/i],
  ['Southern Pride', /southern pride/i],
  ['PHS', /\bphs\b/i],
  ['Pest Bear', /pest ?bear/i],
  ['Apex', /apex pest/i],
  ['Venice Pest', /venice pest control/i],
  ['Hawx', /\bhawx/i],
  ['Aptive', /aptive/i],
  ['Truly Nolen', /nolen/i],
  ['Bug Off', /bug off/i],
  ['Rentokil', /rentokil/i],
];

const RIVAL_USE = RIVALS.map(([name, re]) => [name, new RegExp(RIVAL_USE_LEAD + '(?:' + re.source + ')\\w*\\b' + RIVAL_SHOPPING_TAIL, 'i')]);

const SWITCH_REASONS = SWITCH_RULES.map(([reason]) => reason);
const NOT_BOOKED_REASONS = [...NOT_BOOKED_RULES.map(([reason]) => reason), 'no_response'];
const PREVIOUS_COMPANIES = RIVALS.map(([name]) => name);

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const topicsText = (c) => (Array.isArray(c.topics) ? c.topics.join(' ') : '');
// Quote + topics only: `context` can hold the agent's surrounding sentences.
const chunkText = (c) => [c.quote, topicsText(c)].filter(Boolean).join(' ').toLowerCase();
const joinText = (chunks) => chunks.map(chunkText).join(' ');
const firstRule = (rules, text) => (text ? (rules.find(([, re]) => re.test(text)) || [])[0] || null : null);

// A chunk is about a prior provider when it is a competitor_mention /
// churn_signal / complaint AND the words show the caller used that provider.
function aboutPriorProvider(c) {
  if (!SWITCH_TAGS.has(c.tag)) return false;
  const text = chunkText(c);
  if (NO_PRIOR_PROVIDER_RE.test(text)) return false;
  return PRIOR_PROVIDER_RE.test(text) || RIVAL_USE.some(([, re]) => re.test(text));
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

  const switchChunks = callerChunks.filter(aboutPriorProvider);
  if (switchChunks.length) {
    const text = joinText(switchChunks);
    next.switch_reason = firstRule(SWITCH_RULES, text);
    // Exactly one rival named anywhere in the switch talk, and named in a use
    // phrase. "We had Turner and Orkin" names two: left unset.
    const mentioned = RIVALS.filter(([, re]) => re.test(text)).map(([name]) => name);
    const used = RIVAL_USE.filter(([, re]) => re.test(text)).map(([name]) => name);
    if (mentioned.length === 1 && used.length === 1) next.previous_company = used[0];
  }

  // Only a lead whose status says it did not book (lost / unresponsive), that
  // never converted and has no visit booked since, gets a not-booked reason.
  if (!lead.converted_at && !facts.booked && LOST_STATUSES.has(lead.status)) {
    next.not_booked_reason = firstRule(NOT_BOOKED_RULES, joinText(callerChunks.filter((c) => NOT_BOOKED_TAGS.has(c.tag))))
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
  const customerIds = asUuidList(leads, 'customer_id');
  const rows = await conn('call_log').where((w) => {
    w.whereIn(conn.raw("metadata->>'lead_id'"), ids);
    if (sids.length) w.orWhereIn('twilio_call_sid', sids).orWhereIn('call_sid', sids);
    if (customerIds.length) w.orWhereIn('customer_id', customerIds);
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
  for (const c of calls) {
    const stamp = stampState(c);
    if (stamp === 'settled') { owner.set(c.id, c.stamp_lead_id); continue; }
    if (stamp === 'provisional') continue;
    const sid = bySid.get(c.id);
    if (sid) { if (sid.size === 1) owner.set(c.id, [...sid][0]); continue; }
    if (!c.customer_id) continue;
    const fits = custLeads.filter((l) => l.customer_id === c.customer_id && inWindow(c, l));
    if (fits.length === 1) owner.set(c.id, fits[0].id);
  }
  return owner;
}

async function loadChunksByLead(conn, leads, now) {
  const byLead = new Map(leads.map((l) => [l.id, new Set()]));
  const calls = new Map(); // call_log id -> row
  const candidates = await candidateCalls(conn, leads);
  const owner = await assignCalls(conn, leads, candidates);
  for (const c of candidates) {
    const leadId = owner.get(c.id);
    if (byLead.has(leadId)) { calls.set(c.id, c); byLead.get(leadId).add(c.id); }
  }

  const chunksByCall = new Map();
  if (calls.size) {
    const chunks = await conn('call_research_chunks')
      .whereIn('call_log_id', [...calls.keys()])
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

// A visit booked by phone on the call: call-recording-processor.js records it as
// an appointment_booked activity with metadata.scheduledServiceId and leaves the
// lead's status and converted_at as they were. Same customer ownership check as
// the admin card's links (a populated lead customer vetoes a dissenting visit).
function phoneBookedVisit(conn, lead) {
  return conn('scheduled_services as ss')
    .whereNotIn('ss.status', DEFAULT_EXCLUDE_STATUSES)
    .where(notUnclaimedHold)
    .whereExists(conn('lead_activities as la').select(conn.raw('1'))
      .where('la.lead_id', lead.id)
      .where('la.activity_type', 'appointment_booked')
      .whereRaw("la.metadata->>'scheduledServiceId' = ss.id::text"))
    .modify((q) => { if (lead.customer_id) q.where((o) => o.whereNull('ss.customer_id').orWhere('ss.customer_id', lead.customer_id)); })
    .first('ss.id');
}

async function bookedLeadIds(conn, leads) {
  const out = new Set();
  for (const l of leads) {
    if (!LOST_STATUSES.has(l.status) || l.converted_at) continue; // only these can get a reason
    const active = await leadLinkedVisits(conn, l).whereNotIn('ss.status', DEFAULT_EXCLUDE_STATUSES).where(notUnclaimedHold).first('ss.id')
      || await phoneBookedVisit(conn, l);
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
  return new Set(leads.filter((l) => done.some((v) => v.customer_id === l.customer_id && before(v, l))).map((l) => l.id));
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
      const ev = evidence.get(lead.id) || { chunks: [], miningPending: false };
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
  _test: { SWITCH_RULES, NOT_BOOKED_RULES, RIVALS, aboutPriorProvider },
};
