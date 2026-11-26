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
 *   - Only NULL fields are filled; the job never overwrites a set value. There
 *     is no office editor for these fields (option B, not picked); the
 *     migration comment that mentions office edits predates that ruling.
 *     Each UPDATE re-checks the field is NULL, the lead is live, and its
 *     status and customer link are the ones the reason was computed from.
 *   - switch_reason / previous_company read caller speech only, on calls that
 *     carry competitor_mention / churn_signal / complaint chunks about a prior
 *     provider. Two different rivals named on one lead = ambiguous = left NULL.
 *   - not_booked_reason only for lost / unresponsive leads (never an open
 *     lead, never a converted one); no_response only when the status is
 *     'unresponsive' and no other not-booked reason fits.
 *   - Each call feeds at most one lead: explicit owners (sid / metadata stamp)
 *     win, conflicting owners are skipped, and the same-customer window is a
 *     fallback only when exactly one live lead of that customer fits.
 *   - Leads of customers who already existed before the lead are skipped:
 *     they are not prospects switching providers.
 *   - why_filled_at is stamped only on a run that wrote at least one field.
 *   - Idempotent; bounded by LOOKBACK_DAYS and MAX_LEADS_PER_RUN. Each run
 *     scans least-recently-checked leads first (why_checked_at), so a capped
 *     run never starves older leads in the window.
 *   - A call explicitly owned by one lead (sid or metadata stamp) never feeds
 *     another lead through the same-customer window fallback.
 *
 * Rule lists are ported from the research scripts of 2026-11-23 (switch
 * themes, objection themes, rival name patterns); the order of each list is
 * the priority — the first rule that matches wins.
 *
 * Kill switch: LEAD_WHY_FILL=off (read per run in scheduler.js). Not a GATE_*.
 */

const db = require('../models/db');
const logger = require('./logger');

const LOOKBACK_DAYS = 120;
const PAGE_SIZE = 200;
const MAX_LEADS_PER_RUN = 2000;
// A call counts for a lead (same customer, no sid/stamp link) when it happened
// from 2 days before the lead was created to 14 days after.
const CALL_WINDOW_BEFORE_DAYS = 2;
const CALL_WINDOW_AFTER_DAYS = 14;
const EXISTING_CUSTOMER_MARGIN_DAYS = 1;
const DAY_MS = 86400000;

// Statuses that never get a not-booked reason (booked, junk, or not a lead).
const LOST_STATUSES = new Set(['lost', 'unresponsive']);

const SWITCH_TAGS = new Set(['competitor_mention', 'churn_signal', 'complaint']);
// Evidence the caller actually USED another provider. A rival named only as a
// quote ("Orkin quoted me $99") is not a prior relationship.
const PRIOR_PROVIDER_RE = /(current|previous|prior|existing|former|old|last) (pest |lawn )?(provider|company|exterminator|guy|service)|switch(ing|ed)? (from|over from|providers|companies)|provider switch|currently (with|using) (a|an|another|them)|cancel+(ed|ing)? (with|our|my) (provider|company|service)/i;
// A rival counts as the previous company only when a use phrase names it:
// "we had Turner", "switching from Orkin", "been with Hughes".
// At most one word between the phrase and the name ("had the Turner guy" is
// two, so "we had ants and Orkin quoted us" never links Orkin).
const RIVAL_USE_LEAD = String.raw`\b(?:had|have had|used|been using|been with|was with|were with|leaving|left|cancel+(?:ed|ing)?|switch(?:ing|ed)? from|currently (?:have|use|with))\s+(?:the\s+)?(?:\w+\s+)?`;
// A chunk about a quote or estimate is shopping, not a prior relationship.
const NO_PRIOR_PROVIDER_RE = /never (used|had|been with)|first time|no (current|previous|prior) (provider|company)|don'?t have (a|any) (provider|company|pest)|\bquot(e|es|ed|ing)\b|estimate|\bbids?\b/i;

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
  ['spouse', /talk to (my|her|his)|husband|wife|spouse|partner|landlord|\bhoa\b|property manager|think about it|run it by/],
  ['one_visit', /one[- ]time|just once|single (visit|treatment|service)|one visit|just the one/],
  ['no_plan', /commit|contract|recurring|quarterly|annual|prepay|pay (up ?front|in advance|for the (year|whole))|subscription|membership|(don'?t|do not|not) want (a |any )?plan|\bplan\b/],
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

const RIVAL_USE = RIVALS.map(([name, re]) => [name, new RegExp(RIVAL_USE_LEAD + '(?:' + re.source + ')', 'i')]);

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

/**
 * Decide what to fill for one lead. Pure: lead row + its linked chunks in,
 * a patch (only for currently-empty fields) out. Never returns a key whose
 * lead value is already set.
 */
function planLeadWhy(lead, chunks, now = new Date()) {
  const patch = {};
  const callerChunks = (chunks || []).filter((c) => c.speaker === 'caller');

  const switchChunks = callerChunks.filter(aboutPriorProvider);
  if (switchChunks.length) {
    const text = joinText(switchChunks);
    if (isBlank(lead.switch_reason)) {
      const reason = firstRule(SWITCH_RULES, text);
      if (reason) patch.switch_reason = reason;
    }
    if (isBlank(lead.previous_company)) {
      const named = RIVAL_USE.filter(([, re]) => re.test(text)).map(([name]) => name);
      if (named.length === 1) patch.previous_company = named[0];
    }
  }

  // Only a lead whose status says it did not book (lost / unresponsive) gets a
  // not-booked reason. An open lead may have booked an assessment or a visit
  // without a status change, so it is never guessed. converted_at survives a
  // reopen of a won lead, so a converted lead never gets one either.
  if (isBlank(lead.not_booked_reason) && !lead.converted_at && LOST_STATUSES.has(lead.status)) {
    const reason = firstRule(NOT_BOOKED_RULES, joinText(callerChunks.filter((c) => NOT_BOOKED_TAGS.has(c.tag))))
      || (lead.status === 'unresponsive' ? 'no_response' : null);
    if (reason) patch.not_booked_reason = reason;
  }
  return patch;
}

const asUuidList = (rows, key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))];

const CALL_COLS = (conn) => ['id', 'customer_id', 'created_at', 'twilio_call_sid', 'call_sid',
  conn.raw("metadata->>'lead_id' AS stamp_lead_id"), conn.raw("metadata->>'relay_lead_id' AS stamp_relay_lead_id")];

// Candidate calls for a page of leads: by the lead's sid, by the lead_id stamp
// on call_log.metadata, and by the same customer.
async function candidateCalls(conn, leads) {
  const sids = [...new Set(leads.map((l) => l.twilio_call_sid).filter(Boolean))];
  const ids = leads.map((l) => l.id);
  const customerIds = asUuidList(leads, 'customer_id');
  const rows = await conn('call_log').where((w) => {
    w.whereIn(conn.raw("metadata->>'lead_id'"), ids).orWhereIn(conn.raw("metadata->>'relay_lead_id'"), ids);
    if (sids.length) w.orWhereIn('twilio_call_sid', sids).orWhereIn('call_sid', sids);
    if (customerIds.length) w.orWhereIn('customer_id', customerIds);
  }).select(CALL_COLS(conn));
  return [...new Map(rows.map((r) => [r.id, r])).values()];
}

// call id -> Set of live lead ids that explicitly own it: a metadata stamp, or
// any live lead (across ALL leads, not just this page) whose sid is the call's.
async function explicitOwners(conn, calls) {
  const owners = new Map();
  const add = (callId, leadId) => { if (leadId) owners.set(callId, (owners.get(callId) || new Set()).add(leadId)); };
  for (const c of calls) { add(c.id, c.stamp_lead_id); add(c.id, c.stamp_relay_lead_id); }
  const sids = [...new Set(calls.flatMap((c) => [c.twilio_call_sid, c.call_sid]).filter(Boolean))];
  if (sids.length) {
    const sidLeads = await conn('leads').whereIn('twilio_call_sid', sids).whereNull('deleted_at').select('id', 'twilio_call_sid');
    for (const c of calls) {
      for (const l of sidLeads) if (l.twilio_call_sid === c.twilio_call_sid || l.twilio_call_sid === c.call_sid) add(c.id, l.id);
    }
  }
  return owners;
}

// Assign each call to at most ONE lead. Explicit owners win; two different
// explicit owners = conflict = skipped. A call with no explicit owner falls back
// to the customer window, only when exactly one live lead of that customer fits.
async function assignCalls(conn, leads, calls) {
  const owners = await explicitOwners(conn, calls);
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
    const explicit = owners.get(c.id);
    if (explicit) { if (explicit.size === 1) owner.set(c.id, [...explicit][0]); continue; }
    if (!c.customer_id) continue;
    const fits = custLeads.filter((l) => l.customer_id === c.customer_id && inWindow(c, l));
    if (fits.length === 1) owner.set(c.id, fits[0].id);
  }
  return owner;
}

async function loadChunksByLead(conn, leads) {
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
  const out = new Map();
  for (const [leadId, set] of byLead) out.set(leadId, [...set].flatMap((cid) => chunksByCall.get(cid) || []));
  return out;
}

// Customers that existed before the lead are not prospects: skip their leads.
async function existingCustomerLeadIds(conn, leads) {
  const customerIds = asUuidList(leads, 'customer_id');
  if (!customerIds.length) return new Set();
  const rows = await conn('customers').whereIn('id', customerIds).select('id', 'created_at');
  const createdAt = new Map(rows.map((r) => [r.id, new Date(r.created_at)]));
  return new Set(leads
    .filter((l) => createdAt.has(l.customer_id)
      && createdAt.get(l.customer_id) < new Date(l.created_at) - EXISTING_CUSTOMER_MARGIN_DAYS * DAY_MS)
    .map((l) => l.id));
}

async function fillLeadWhy({ conn = db, now = new Date(), maxLeads = MAX_LEADS_PER_RUN } = {}) {
  const cutoff = new Date(now - LOOKBACK_DAYS * DAY_MS);
  const stats = { scanned: 0, filled: 0, fields: 0 };

  while (stats.scanned < maxLeads) {
    const q = conn('leads')
      .whereNull('deleted_at')
      .where('created_at', '>=', cutoff)
      .where((w) => w.whereNull('status').orWhere('status', '<>', 'duplicate'))
      .where((w) => w.whereNull('previous_company').orWhereNull('switch_reason').orWhereNull('not_booked_reason'))
      .where((w) => w.whereNull('why_checked_at').orWhere('why_checked_at', '<', now))
      .orderByRaw('why_checked_at ASC NULLS FIRST, created_at DESC, id DESC')
      .limit(Math.min(PAGE_SIZE, maxLeads - stats.scanned))
      .select('id', 'status', 'converted_at', 'created_at', 'customer_id', 'twilio_call_sid', 'previous_company', 'switch_reason', 'not_booked_reason');
    const leads = await q;
    if (!leads.length) break;
    stats.scanned += leads.length;

    const existing = await existingCustomerLeadIds(conn, leads);
    const candidates = leads.filter((l) => !existing.has(l.id));
    const chunksByLead = candidates.length ? await loadChunksByLead(conn, candidates) : new Map();

    for (const lead of candidates) {
      const patch = planLeadWhy(lead, chunksByLead.get(lead.id) || [], now);
      const keys = Object.keys(patch);
      if (!keys.length) continue;
      // Guard each field against a concurrent office edit: write only if still NULL.
      let wrote = 0;
      for (const key of keys) {
        // Write only if the field is still empty, the lead is not deleted, and its
        // status is the one the reason was computed from (a booking in between wins).
        // why_filled_at rides in the same update, so it never lags its field.
        const q = conn('leads').where({ id: lead.id }).whereNull(key).whereNull('deleted_at');
        if (lead.status == null) q.whereNull('status'); else q.where('status', lead.status);
        if (key === 'not_booked_reason') q.whereNull('converted_at');
        // The evidence came through this customer link; a relinked lead is skipped.
        if (lead.customer_id == null) q.whereNull('customer_id'); else q.where('customer_id', lead.customer_id);
        wrote += await q.update({ [key]: patch[key], why_filled_at: now });
      }
      if (wrote) {
        stats.filled += 1;
        stats.fields += wrote;
      }
    }
    // Stamp the page as examined so this run moves on and the next run starts
    // with leads not looked at for the longest time.
    await conn('leads').whereIn('id', leads.map((l) => l.id)).update({ why_checked_at: now });
    if (leads.length < PAGE_SIZE) break;
  }
  logger.info(`[lead-why-fill] scanned=${stats.scanned} leads_filled=${stats.filled} fields=${stats.fields}`);
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
