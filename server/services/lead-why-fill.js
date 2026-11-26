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
 *   - Only NULL fields are filled. A value an office user set is never
 *     overwritten (the UPDATE is also guarded per field with whereNull).
 *   - switch_reason / previous_company read caller speech only, on calls that
 *     carry competitor_mention / churn_signal / complaint chunks about a prior
 *     provider. Two different rivals named on one lead = ambiguous = left NULL.
 *   - no_response only when the lead status is 'unresponsive' and no other
 *     not-booked reason fits.
 *   - Leads of customers who already existed before the lead are skipped:
 *     they are not prospects switching providers.
 *   - why_filled_at is stamped only on a run that wrote at least one field.
 *   - Idempotent; bounded by LOOKBACK_DAYS and MAX_LEADS_PER_RUN.
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
// A lead still open ('new', 'contacted', ...) is not "not booked" until it ages.
const NOT_BOOKED_MIN_AGE_DAYS = 3;
const EXISTING_CUSTOMER_MARGIN_DAYS = 1;
const DAY_MS = 86400000;

// Statuses that never get a not-booked reason (booked, junk, or not a lead).
const NO_NOT_BOOKED_STATUSES = new Set(['won', 'duplicate', 'disqualified', 'handled']);
const LOST_STATUSES = new Set(['lost', 'unresponsive']);

const SWITCH_TAGS = new Set(['competitor_mention', 'churn_signal', 'complaint']);
const PRIOR_PROVIDER_RE = /(current|previous|prior|existing|former|old|other|last) (provider|company|pest)|switching (providers|companies)|provider switch|(provider|company)\b/i;

// First match wins. Specific complaint themes sit before the broad price theme.
const SWITCH_RULES = [
  ['moved', /\bmoved\b|new (home|house)|just (bought|purchased)|bought (a|the|our) (new )?(home|house)|closing on|offer on the home/],
  ['pests_came_back', /still (seeing|have|got)|came back|coming back|not work|didn'?t work|ineffective|failed treatment|treatment effectiveness|recurring infestation|keep seeing|getting worse/],
  ['no_show', /no[- ]show|didn'?t show|never show|never came|miss(ed|ing) (an? |our |the )?(appointment|service|visit)|service gap|skipp|didn'?t come|haven'?t been out|haven'?t come/],
  ['no_callback', /call(ed)? back|callback|not getting back|can'?t reach|cannot reach|unresponsive|no one answer|nobody answer|never (answer|return)/],
  ['contract', /contract|commitment|locked in|cancel(lation)? fee|renewal/],
  ['bundle', /bundle|consolidat|both lawn and pest|lawn and pest|one company/],
  ['price_creep', /price|pricing|cost|expensive|cheaper|afford|paying|raised|increase|went up|\$|dollar/],
];

// First match wins. Run over caller speech in objection / complaint / need chunks.
const NOT_BOOKED_RULES = [
  ['spouse', /talk to (my|her|his)|husband|wife|spouse|partner|landlord|\bhoa\b|property manager|think about it|run it by/],
  ['one_visit', /one[- ]time|just once|single (visit|treatment|service)|one visit|just the one/],
  ['no_plan', /commit|contract|recurring|quarterly|annual|prepay|pay (up ?front|in advance|for the (year|whole))|subscription|membership|(don'?t|do not|not) want (a |any )?plan|\bplan\b/],
  ['wants_a_look', /in[- ]person|come out (and|to) (look|see|take)|look at (it|the)|take a look|see it first|inspect|walk ?through|before (i|we) (commit|decide|agree)/],
  ['price', /price|pricing|cost|expensive|afford|budget|cheaper|too much|\$|dollar/],
  ['timing', /not right now|next (month|week)|\blater\b|not ready|\bwait|after (the )?(holiday|summer|season)|timing|out of town|busy|schedul/],
];
const NOT_BOOKED_TAGS = new Set(['objection', 'complaint', 'need']);

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

const SWITCH_REASONS = SWITCH_RULES.map(([reason]) => reason);
const NOT_BOOKED_REASONS = [...NOT_BOOKED_RULES.map(([reason]) => reason), 'no_response'];
const PREVIOUS_COMPANIES = RIVALS.map(([name]) => name);

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const topicsText = (c) => (Array.isArray(c.topics) ? c.topics.join(' ') : '');
const chunkText = (c) => [c.quote, c.context, topicsText(c)].filter(Boolean).join(' ').toLowerCase();
const joinText = (chunks) => chunks.map(chunkText).join(' ');
const firstRule = (rules, text) => (text ? (rules.find(([, re]) => re.test(text)) || [])[0] || null : null);

// A chunk is about a prior provider when it is a competitor mention, or a
// churn_signal / complaint that talks about a provider / company.
function aboutPriorProvider(c) {
  if (!SWITCH_TAGS.has(c.tag)) return false;
  if (c.tag === 'competitor_mention') return true;
  return PRIOR_PROVIDER_RE.test(chunkText(c));
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
      const named = RIVALS.filter(([, re]) => re.test(text)).map(([name]) => name);
      if (named.length === 1) patch.previous_company = named[0];
    }
  }

  if (isBlank(lead.not_booked_reason) && !NO_NOT_BOOKED_STATUSES.has(lead.status)) {
    const ageDays = (now - new Date(lead.created_at)) / DAY_MS;
    if (LOST_STATUSES.has(lead.status) || ageDays >= NOT_BOOKED_MIN_AGE_DAYS) {
      const reason = firstRule(NOT_BOOKED_RULES, joinText(callerChunks.filter((c) => NOT_BOOKED_TAGS.has(c.tag))))
        || (lead.status === 'unresponsive' ? 'no_response' : null);
      if (reason) patch.not_booked_reason = reason;
    }
  }
  return patch;
}

const asUuidList = (rows, key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))];

// Link calls to a page of leads. Order of evidence: the sid on the lead, the
// lead_id stamp on call_log.metadata, then the same customer inside a window.
// Each linker adds call ids to byLead (lead id -> Set) and rows to calls.
async function linkBySid(conn, leads, byLead, calls) {
  const leadsBySid = new Map();
  for (const l of leads) if (l.twilio_call_sid) leadsBySid.set(l.twilio_call_sid, [...(leadsBySid.get(l.twilio_call_sid) || []), l.id]);
  if (!leadsBySid.size) return;
  const sids = [...leadsBySid.keys()];
  const rows = await conn('call_log')
    .where((w) => w.whereIn('twilio_call_sid', sids).orWhereIn('call_sid', sids))
    .select('id', 'twilio_call_sid', 'call_sid', 'customer_id', 'created_at');
  for (const r of rows) {
    calls.set(r.id, r);
    for (const sid of [r.twilio_call_sid, r.call_sid]) for (const lid of leadsBySid.get(sid) || []) byLead.get(lid).add(r.id);
  }
}

async function linkByStamp(conn, leads, byLead, calls) {
  const ids = leads.map((l) => l.id);
  const rows = await conn('call_log')
    .where((w) => w.whereIn(conn.raw("metadata->>'lead_id'"), ids).orWhereIn(conn.raw("metadata->>'relay_lead_id'"), ids))
    .select('id', 'customer_id', 'created_at', conn.raw("metadata->>'lead_id' AS stamp_lead_id"), conn.raw("metadata->>'relay_lead_id' AS stamp_relay_lead_id"));
  for (const r of rows) {
    calls.set(r.id, r);
    for (const lid of [r.stamp_lead_id, r.stamp_relay_lead_id]) if (byLead.has(lid)) byLead.get(lid).add(r.id);
  }
}

async function linkByCustomer(conn, leads, byLead, calls) {
  const customerIds = asUuidList(leads, 'customer_id');
  if (!customerIds.length) return;
  const rows = await conn('call_log').whereIn('customer_id', customerIds).select('id', 'customer_id', 'created_at');
  for (const r of rows) {
    for (const l of leads) {
      if (l.customer_id !== r.customer_id) continue;
      const delta = (new Date(r.created_at) - new Date(l.created_at)) / DAY_MS;
      if (delta >= -CALL_WINDOW_BEFORE_DAYS && delta <= CALL_WINDOW_AFTER_DAYS) {
        calls.set(r.id, r);
        byLead.get(l.id).add(r.id);
      }
    }
  }
}

async function loadChunksByLead(conn, leads) {
  const byLead = new Map(leads.map((l) => [l.id, new Set()]));
  const calls = new Map(); // call_log id -> row
  await linkBySid(conn, leads, byLead, calls);
  await linkByStamp(conn, leads, byLead, calls);
  await linkByCustomer(conn, leads, byLead, calls);

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
  let cursor = null;

  while (stats.scanned < maxLeads) {
    const q = conn('leads')
      .whereNull('deleted_at')
      .where('created_at', '>=', cutoff)
      .where((w) => w.whereNull('status').orWhere('status', '<>', 'duplicate'))
      .where((w) => w.whereNull('previous_company').orWhereNull('switch_reason').orWhereNull('not_booked_reason'))
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(Math.min(PAGE_SIZE, maxLeads - stats.scanned))
      .select('id', 'status', 'created_at', 'customer_id', 'twilio_call_sid', 'previous_company', 'switch_reason', 'not_booked_reason');
    if (cursor) {
      q.where((w) => w.where('created_at', '<', cursor.created_at)
        .orWhere((x) => x.where('created_at', cursor.created_at).andWhere('id', '<', cursor.id)));
    }
    const leads = await q;
    if (!leads.length) break;
    stats.scanned += leads.length;
    cursor = leads[leads.length - 1];

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
        wrote += await conn('leads').where({ id: lead.id }).whereNull(key).update({ [key]: patch[key] });
      }
      if (wrote) {
        await conn('leads').where({ id: lead.id }).update({ why_filled_at: now });
        stats.filled += 1;
        stats.fields += wrote;
      }
    }
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
