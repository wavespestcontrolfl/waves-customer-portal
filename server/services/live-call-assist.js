'use strict';

/**
 * Live call assist (GATE_CALL_LIVE_ASSIST, dark; owner 2026-11-16 "ok build all, use haiku", live-call suite parts 13 + 14).
 *
 * While a staff member watches the Live call panel, GET /live kicks refreshAssistIfDue for each listed call. A Claude
 * Haiku 5.5 read of the last ~3 minutes says what the caller wants, which recurring service they mean, and any
 * address, timing or sizes they spoke. From that the module shows, as text for the screen only:
 *   - the price: the pricing engine's own words (pricingText, the voice agent's get_pricing path), never computed here;
 *   - the open times: resolveAvailability (the voice agent's availability path) at the matched customer's account pin,
 *     else at the spoken address.
 * Nothing reaches a customer. It writes only metadata.live_transcription.assist on the call row; never call_summary,
 * ai_extraction, transcription or call_commitments.
 *
 * Cadence (the claim is a compare-and-swap UPDATE on assist.runs, so several admins polling at once admit ONE run):
 * the first run once 2 Caller utterances exist, then at least 1 new Caller utterance and 45 s since the last run, at
 * most 12 runs per call, none after the call stops. Fire and forget: nothing here throws.
 *
 * Price and times are looked up again ONLY when (service, plan details, property type, location, when, sizes) changed:
 * resolveAvailability can geocode (a paid Google call) and pricing reads the DB. Facts the caller said earlier stay
 * in `facts`, so they survive after they scroll out of the 3-minute window. A fact the caller took back is cleared
 * (the model lists it in `withdrawn`), and the changed key looks price and times up again, so a stale price never sits
 * beside a new intent.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { ledgerCall } = require('./llm-dispatch-metrics');
const { anthropicText } = require('./llm/call');
const { anthropicMaxTokens, anthropicEffortConfig } = require('./llm/anthropic-wire');
const { scrubPans } = require('../utils/pan-scrub');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const FIRST_RUN_CALLERS = 2;
const MIN_GAP_MS = 45 * 1000;
const MAX_RUNS = 12;
const WINDOW_MS = 3 * 60 * 1000;
const MAX_INPUT_CHARS = 2000;
const SHOWN_TIMES = 3;
// The allowed values of get_pricing's inputs (CONTEXT_TOOLS in voice-agent/relay-tools.js; a test pins them to it). An
// unknown value is dropped, never guessed. The engine's own defaults (quarterly, enhanced, monthly12, single_family)
// stay in pricingText: nothing here invents one.
const ENUMS = {
  service: new Set(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait']),
  property_type: new Set(['single_family', 'townhome_end', 'townhome_interior', 'duplex', 'condo_ground', 'condo_upper', 'commercial']),
  frequency: new Set(['quarterly', 'bimonthly', 'monthly']),
  lawn_track: new Set(['st_augustine', 'bermuda', 'zoysia', 'bahia']),
  lawn_tier: new Set(['enhanced', 'premium']),
  mosquito_tier: new Set(['seasonal9', 'monthly12']),
};
// What the plan says about the service: a different service makes these stale.
const PLAN_KEYS = ['frequency', 'lawn_track', 'lawn_tier', 'mosquito_tier'];
// What belongs to one place: a different street makes the others stale unless the same read says them again.
const PLACE_KEYS = ['address_line1', 'city', 'zip', 'home_sqft', 'lot_sqft', 'property_type'];
const FACT_KEYS = [
  'service', 'when', 'address_line1', 'city', 'zip', 'home_sqft', 'lot_sqft', 'property_type', ...PLAN_KEYS,
];
// "address" in the withdrawn list means the whole spoken place.
const WITHDRAWN_GROUPS = { address: ['address_line1', 'city', 'zip'] };

const SYSTEM_PROMPT = `You read the last few minutes of a live phone call to a pest control and lawn care company. "Caller:" is the customer or prospect. "Agent:" is the Waves staff member.
Reply with ONLY this JSON: {"intent": "<one plain line, 90 characters or fewer: what the caller wants>", "service": "pest_control" | "lawn_care" | "mosquito" | "tree_shrub" | "termite_bait" | null, "when": "<the caller's own words about timing, or null>", "address_line1": "<street address the caller said, or null>", "city": "<or null>", "zip": "<5 digits or null>", "home_sqft": <number the caller said for the home's square feet, or null>, "lot_sqft": <number the caller said for the lot, or null>, "property_type": "single_family" | "townhome_end" | "townhome_interior" | "duplex" | "condo_ground" | "condo_upper" | "commercial" | null, "frequency": "quarterly" | "bimonthly" | "monthly" | null, "lawn_track": "st_augustine" | "bermuda" | "zoysia" | "bahia" | null, "lawn_tier": "enhanced" | "premium" | null, "mosquito_tier": "seasonal9" | "monthly12" | null, "withdrawn": [<fact names the caller took back>]}
Use a service only when the caller is asking about that recurring plan. Fill address, timing, sizes and plan details only when the caller said them; never guess. Use "commercial" for any business, office, restaurant, HOA or multifamily property. A null fact means the caller did not mention it: the earlier value stays. When the caller gives a new value, put the new value. When the caller takes a fact back (for example turns down recurring service and wants a one-time treatment, or says the address was wrong), set that fact to null and list its name in "withdrawn": one of service, when, address (the street, city and zip together), home_sqft, lot_sqft, property_type, frequency, lawn_track, lawn_tier, mosquito_tier. Otherwise "withdrawn" is []. No phone numbers and no card or account digits anywhere.`;

const gateOn = () => require('../config/feature-gates').isEnabled('callLiveAssist');
// The same gate resolveAvailability reads: with scheduling off no open times are looked up, reused or shown.
const schedulingOn = () => require('../config/feature-gates').isEnabled('selfBooking');

function meta(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')) || {}; } catch { return {}; }
}

// Plain one-line text: card numbers masked (the live scrub can miss a number split across utterances, and the model
// can then write it whole), control characters out, spaces collapsed, cut to max.
function text(value, max) {
  if (typeof value !== 'string') return null;
  const plain = scrubPans(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return plain || null;
}

function size(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[,\s]/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 5000000 ? Math.round(n) : null;
}

function oneOf(set, value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return set.has(v) ? v : null;
}

// The facts the caller took back: only known names, "address" opened into its three parts.
function withdrawnFacts(raw) {
  if (!Array.isArray(raw)) return [];
  const names = raw.flatMap((n) => (typeof n === 'string' ? WITHDRAWN_GROUPS[n.trim()] || [n.trim()] : []));
  return [...new Set(names.filter((n) => FACT_KEYS.includes(n)))];
}

// Every field the model returns is checked here; null for anything out of shape.
function validate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = text(raw.intent, 90);
  if (!intent) return null;
  const zip = typeof raw.zip === 'string' || typeof raw.zip === 'number' ? String(raw.zip).trim() : '';
  const facts = {
    when: text(raw.when, 60),
    address_line1: text(raw.address_line1, 80),
    city: text(raw.city, 40),
    zip: /^\d{5}(-\d{4})?$/.test(zip) ? zip.slice(0, 5) : null,
    home_sqft: size(raw.home_sqft),
    lot_sqft: size(raw.lot_sqft),
  };
  for (const k of Object.keys(ENUMS)) facts[k] = oneOf(ENUMS[k], raw[k]);
  return { intent, facts, withdrawn: withdrawnFacts(raw.withdrawn) };
}

// Casing, spacing and punctuation do not make a different place.
const placeText = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// True when this read names a street, city or zip that differs from the one said before: the caller moved to another
// property, so the sizes and type said for the old one must not price the new one.
function switchedProperty(previous, next) {
  return ['address_line1', 'city', 'zip'].some((k) => next[k] && previous?.[k] && placeText(next[k]) !== placeText(previous[k]));
}

// A newer non-null fact replaces the older one; an unmentioned fact keeps what the caller said earlier; a withdrawn
// fact is cleared. A different (or withdrawn) service also clears the plan details said for the old one.
function mergeFacts(previous, next, withdrawn = []) {
  const carried = (k) => (withdrawn.includes(k) ? null : previous?.[k] ?? null);
  const service = next.service ?? carried('service');
  const serviceChanged = !!previous?.service && service !== previous.service;
  const moved = switchedProperty(previous, next);
  const stale = (k) => (serviceChanged && PLAN_KEYS.includes(k)) || (moved && PLACE_KEYS.includes(k));
  const merged = {};
  for (const k of FACT_KEYS) {
    merged[k] = k === 'service' ? service : next[k] ?? (stale(k) ? null : carried(k));
  }
  return merged;
}

// Decides whether a run is due, then stamps it with a compare-and-swap on assist.runs: of two polls that read the
// same count, one UPDATE matches and wins. Cheap checks first, so most polls cost no query beyond the row.
// Returns the run's generation (its runs number, 1 or more) or 0 when no run is due or the claim was lost.
async function claimRun(callSid, live, now) {
  const assist = live.assist || {};
  const runs = Number(assist.runs) || 0;
  if (live.stopped_at || runs >= MAX_RUNS) return 0;
  const last = Date.parse(assist.at);
  if (Number.isFinite(last) && now.getTime() - last < MIN_GAP_MS) return 0;
  const [{ n }] = await db('call_live_utterances').where({ call_sid: callSid, speaker: 'caller' }).count({ n: '*' });
  const callerCount = Number(n) || 0;
  if (runs === 0 ? callerCount < FIRST_RUN_CALLERS : callerCount - (Number(assist.caller_count) || 0) < 1) return 0;
  const won = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("COALESCE((metadata -> 'live_transcription' -> 'assist' ->> 'runs')::int, 0) = ?", [runs])
    .whereRaw("(metadata -> 'live_transcription') ->> 'stopped_at' IS NULL")
    .update({
      metadata: db.raw(
        "jsonb_set(metadata, '{live_transcription,assist}', COALESCE(metadata -> 'live_transcription' -> 'assist', '{}'::jsonb) || ?::jsonb, true)",
        [JSON.stringify({ runs: runs + 1, at: now.toISOString(), caller_count: callerCount })],
      ),
    });
  return won > 0 ? runs + 1 : 0;
}

// Merges a finished run's fields into assist without touching runs, at or caller_count. Fenced by the run's
// generation: a run that took longer than the claim gap finds assist.runs already moved on by a newer claim, and its
// stale facts, price and times are not written. True when the result was saved. The only write a run makes after its
// claim, so the lookup-error stamp (key null) is fenced the same way.
async function saveResult(callSid, patch, generation) {
  const saved = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("COALESCE((metadata -> 'live_transcription' -> 'assist' ->> 'runs')::int, 0) = ?", [generation])
    .update({
      metadata: db.raw(
        "jsonb_set(metadata, '{live_transcription,assist}', COALESCE(metadata -> 'live_transcription' -> 'assist', '{}'::jsonb) || ?::jsonb, true)",
        [JSON.stringify(patch)],
      ),
    });
  return saved > 0;
}

// The last ~3 minutes, oldest first, "Caller:" / "Agent:", cut to the newest 2,000 characters.
async function transcriptWindow(callSid) {
  const rows = await db('call_live_utterances')
    .where('call_sid', callSid)
    .orderBy([{ column: 'spoken_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(60)
    .select('speaker', 'text', 'spoken_at');
  if (!rows.length) return '';
  const newest = new Date(rows[0].spoken_at).getTime();
  return rows
    .filter((r) => newest - new Date(r.spoken_at).getTime() <= WINDOW_MS && r.text)
    .reverse()
    .map((r) => `${r.speaker === 'caller' ? 'Caller' : 'Agent'}: ${r.text}`)
    .join('\n')
    .slice(-MAX_INPUT_CHARS);
}

// { intent, facts } or null (no key, refusal, bad JSON, bad fields, API error). Never throws.
async function readCall(transcript) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20 * 1000, maxRetries: 0 });
    const response = await ledgerCall('anthropic', MODELS.LIVE_CALL, () => client.messages.create({
      model: MODELS.LIVE_CALL,
      ...anthropicEffortConfig(MODELS.LIVE_CALL),
      // Haiku 5.5 thinks by default and the thinking spends from this cap, so it is not sized to the reply alone.
      max_tokens: anthropicMaxTokens(MODELS.LIVE_CALL, 2048),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
    }), { laneId: 'live_call_assist' });
    if (response?.stop_reason === 'refusal') return null;
    const out = anthropicText(response);
    return validate(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)));
  } catch (err) {
    logger.warn(`[live-call-assist] read failed: ${err?.status || err?.name || 'error'}`);
    return null;
  }
}

// pricingText speaks to the voice agent. Staff see its price sentence only: the instructions to the agent are cut.
const AGENT_TAIL = /\s*(?:—\s*do not|[.;]?\s+(?:Quote ONLY|Ask the caller|Do NOT|Capture the lead|Tell the caller|Call get_pricing|I can price))/i;
function staffPrice(out) {
  const plain = text(String(out || '').split(AGENT_TAIL)[0].replace(/\s*\([a-z_]+\)/g, ''), 300);
  return plain ? plain.replace(/[\s.;]+$/, '') : null;
}

// The matched customer's row, for the account pin and the property facts. Never throws.
async function accountFor(customerId) {
  if (!customerId) return null;
  try {
    return await db('customers').where({ id: customerId }).whereNull('deleted_at')
      .first('id', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude', 'lot_sqft', 'property_sqft') || null;
  } catch { return null; }
}

// True when the caller named a street that is not the account's own: then the spoken location wins.
function statesOtherProperty(customer, facts) {
  if (!customer || !facts.address_line1) return false;
  try {
    return !require('../routes/booking')._internals.addressMatchesCustomer(customer, facts.address_line1, facts.zip || undefined);
  } catch { return true; }
}

// The engine's price text for the service, or null when none is asked (the engine prices recurring plans only, so a
// caller who dropped recurring service has no service and no price here). Throws on a lookup error.
async function lookupPrice(facts, customer) {
  if (!facts.service) return null;
  // property_sqft is the account's TREATED LAWN area (never the home size); lot_sqft is the whole lot.
  const input = {
    service: facts.service,
    home_sqft: facts.home_sqft || undefined,
    lot_sqft: facts.lot_sqft || customer?.lot_sqft || undefined,
    ...(facts.service === 'lawn_care' && customer?.property_sqft ? { lawn_sqft: customer.property_sqft } : {}),
    // What the caller said about the property and the plan goes to the engine's own guards and plan selection; an
    // unsaid one is left out, so the engine's default applies.
    ...Object.fromEntries(['property_type', ...PLAN_KEYS].filter((k) => facts[k]).map((k) => [k, facts[k]])),
  };
  return staffPrice(await require('./voice-agent/relay-context').pricingText(input));
}

// The soonest few windows as text, or null (no location, scheduling off, nothing open). Throws on a lookup error.
async function lookupTimes(facts, customer, useAccount) {
  const tools = require('./voice-agent/relay-tools');
  let account = null;
  if (useAccount && customer) {
    const located = await require('./voice-agent/relay-booking').resolveAccountBookingLocation(db, customer);
    if (located.status === 'ok') account = { kind: 'account', customerId: customer.id, coords: located.coords };
  }
  if (!account && !facts.address_line1 && !facts.city && !facts.zip) return null;
  const res = await tools.resolveAvailability({
    address_line1: facts.address_line1, city: facts.city, zip: facts.zip, when: facts.when, account,
  });
  if (res.status !== 'ok') return null;
  return tools.formatSlots(res.availability && res.availability.slots, SHOWN_TIMES) || null;
}

// Everything a price or a time depends on, and whether scheduling is on: when any of it changes, both are looked up
// again (so times come back on their own once GATE_SELF_BOOKING is turned on).
function lookupKey(facts, accountId, scheduling) {
  return JSON.stringify([
    facts.service, facts.when, placeText(facts.address_line1), placeText(facts.city), facts.zip,
    facts.home_sqft, facts.lot_sqft, facts.property_type, facts.frequency, facts.lawn_track, facts.lawn_tier,
    facts.mosquito_tier, accountId, scheduling,
  ]);
}

// The price, times and key to store. An unchanged key reuses the last ones; a changed key looks both up again, and
// whatever a lookup does not return is null, so nothing stale stays beside new facts. Each lookup stands alone: one
// failing leaves the other and the intent in place, and drops the key so the next run tries again.
async function priceAndTimes(facts, customer, useAccount, key, previous, scheduling) {
  if (key === previous.key) return { price: previous.price ?? null, times: previous.times ?? null, key };
  let failed = false;
  const attempt = async (fn) => {
    try { return await fn(); } catch (err) {
      failed = true;
      logger.warn(`[live-call-assist] lookup failed: ${err?.code || err?.name || 'error'}`);
      return null;
    }
  };
  const price = await attempt(() => lookupPrice(facts, useAccount ? customer : null));
  const times = scheduling && (facts.service || facts.when) ? await attempt(() => lookupTimes(facts, customer, useAccount)) : null;
  return { price, times, key: failed ? null : key };
}

/**
 * One refresh of a live call's assist; the caller does not await it. Resolves a small result for tests; never throws.
 * callRow: { twilio_call_sid, metadata }; customerId: the customer the panel matched to the call, if any.
 */
async function refreshAssistIfDue(callRow, { customerId = null } = {}) {
  try {
    if (!gateOn()) return { ran: false, reason: 'gate_off' };
    const callSid = callRow?.twilio_call_sid;
    const live = meta(callRow?.metadata).live_transcription;
    if (!callSid || !live) return { ran: false, reason: 'not_live' };
    const generation = await claimRun(callSid, live, new Date());
    if (!generation) return { ran: false, reason: 'not_due' };
    const transcript = await transcriptWindow(callSid);
    if (!transcript) return { ran: true, saved: false };
    const read = await readCall(transcript);
    // A bad read keeps the last good assist; the run still counted.
    if (!read) return { ran: true, saved: false };

    const previous = live.assist || {};
    const facts = mergeFacts(previous.facts, read.facts, read.withdrawn);
    const customer = await accountFor(customerId);
    const useAccount = !!customer && !statesOtherProperty(customer, facts);
    const scheduling = schedulingOn();
    const key = lookupKey(facts, useAccount ? customer.id : null, scheduling);
    const patch = { intent: read.intent, service: facts.service, facts, ...(await priceAndTimes(facts, customer, useAccount, key, previous, scheduling)) };
    return { ran: true, saved: await saveResult(callSid, patch, generation) };
  } catch (err) {
    logger.warn(`[live-call-assist] refresh failed: ${err?.code || err?.name || 'error'}`);
    return { ran: false, reason: 'error' };
  }
}

// The shape GET /live sends: text only, or null while there is nothing to show.
function assistForPanel(callMeta) {
  const a = meta(callMeta).live_transcription?.assist;
  // Cached times are not shown while scheduling is off, whatever an earlier run saved.
  const times = (schedulingOn() && a?.times) || null;
  if (!a || (!a.intent && !a.price && !times)) return null;
  return { intent: a.intent || null, price: a.price || null, times, at: a.at || null };
}

module.exports = { refreshAssistIfDue, assistForPanel, _test: { validate, staffPrice, mergeFacts } };
