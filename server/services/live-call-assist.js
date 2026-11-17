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
 * Price and times are looked up again ONLY when (service, location, when, sizes) changed since the last run:
 * resolveAvailability can geocode (a paid Google call) and pricing reads the DB. Facts the caller said earlier stay
 * in `facts`, so they survive after they scroll out of the 3-minute window.
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
const SERVICES = new Set(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait']);

const SYSTEM_PROMPT = `You read the last few minutes of a live phone call to a pest control and lawn care company. "Caller:" is the customer or prospect. "Agent:" is the Waves staff member.
Reply with ONLY this JSON: {"intent": "<one plain line, 90 characters or fewer: what the caller wants>", "service": "pest_control" | "lawn_care" | "mosquito" | "tree_shrub" | "termite_bait" | null, "when": "<the caller's own words about timing, or null>", "address_line1": "<street address the caller said, or null>", "city": "<or null>", "zip": "<5 digits or null>", "home_sqft": <number the caller said for the home's square feet, or null>, "lot_sqft": <number the caller said for the lot, or null>}
Use a service only when the caller is asking about that recurring plan. Fill address, timing and sizes only when the caller said them; never guess. No phone numbers and no card or account digits anywhere.`;

const gateOn = () => require('../config/feature-gates').isEnabled('callLiveAssist');

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

// Every field the model returns is checked here; null for anything out of shape.
function validate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = text(raw.intent, 90);
  if (!intent) return null;
  const zip = typeof raw.zip === 'string' || typeof raw.zip === 'number' ? String(raw.zip).trim() : '';
  return {
    intent,
    facts: {
      service: SERVICES.has(raw.service) ? raw.service : null,
      when: text(raw.when, 60),
      address_line1: text(raw.address_line1, 80),
      city: text(raw.city, 40),
      zip: /^\d{5}(-\d{4})?$/.test(zip) ? zip.slice(0, 5) : null,
      home_sqft: size(raw.home_sqft),
      lot_sqft: size(raw.lot_sqft),
    },
  };
}

// A newer non-null fact replaces the older one; an unspoken fact keeps what the caller said earlier.
function mergeFacts(previous, next) {
  const merged = {};
  for (const k of Object.keys(next)) merged[k] = next[k] ?? previous?.[k] ?? null;
  return merged;
}

// Decides whether a run is due, then stamps it with a compare-and-swap on assist.runs: of two polls that read the
// same count, one UPDATE matches and wins. Cheap checks first, so most polls cost no query beyond the row.
async function claimRun(callSid, live, now) {
  const assist = live.assist || {};
  const runs = Number(assist.runs) || 0;
  if (live.stopped_at || runs >= MAX_RUNS) return false;
  const last = Date.parse(assist.at);
  if (Number.isFinite(last) && now.getTime() - last < MIN_GAP_MS) return false;
  const [{ n }] = await db('call_live_utterances').where({ call_sid: callSid, speaker: 'caller' }).count({ n: '*' });
  const callerCount = Number(n) || 0;
  if (runs === 0 ? callerCount < FIRST_RUN_CALLERS : callerCount - (Number(assist.caller_count) || 0) < 1) return false;
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
  return won > 0;
}

// Merges a finished run's fields into assist without touching runs, at or caller_count.
async function saveResult(callSid, patch) {
  await db('call_log').where('twilio_call_sid', callSid).update({
    metadata: db.raw(
      "jsonb_set(metadata, '{live_transcription,assist}', COALESCE(metadata -> 'live_transcription' -> 'assist', '{}'::jsonb) || ?::jsonb, true)",
      [JSON.stringify(patch)],
    ),
  });
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

// The engine's price text for the service, or null when none is asked. Throws on a lookup error.
async function lookupPrice(facts, customer) {
  if (!facts.service) return null;
  // property_sqft is the account's TREATED LAWN area (never the home size); lot_sqft is the whole lot.
  const input = {
    service: facts.service,
    home_sqft: facts.home_sqft || undefined,
    lot_sqft: facts.lot_sqft || customer?.lot_sqft || undefined,
    ...(facts.service === 'lawn_care' && customer?.property_sqft ? { lawn_sqft: customer.property_sqft } : {}),
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
    if (!(await claimRun(callSid, live, new Date()))) return { ran: false, reason: 'not_due' };
    const transcript = await transcriptWindow(callSid);
    if (!transcript) return { ran: true, saved: false };
    const read = await readCall(transcript);
    // A bad read keeps the last good assist; the run still counted.
    if (!read) return { ran: true, saved: false };

    const previous = live.assist || {};
    const facts = mergeFacts(previous.facts, read.facts);
    const customer = await accountFor(customerId);
    const useAccount = !!customer && !statesOtherProperty(customer, facts);
    const key = JSON.stringify([
      facts.service, facts.when, facts.address_line1?.toLowerCase(), facts.city?.toLowerCase(), facts.zip,
      facts.home_sqft, facts.lot_sqft, useAccount ? customer.id : null,
    ]);
    const patch = { intent: read.intent, service: facts.service, facts };
    if (key === previous.key) {
      patch.price = previous.price ?? null;
      patch.times = previous.times ?? null;
      patch.key = key;
    } else {
      // Each lookup stands alone: one failing leaves the other and the intent in place. A failure drops the key so the
      // next run tries again instead of reusing a gap.
      let failed = false;
      const attempt = async (fn) => {
        try { return await fn(); } catch (err) {
          failed = true;
          logger.warn(`[live-call-assist] lookup failed: ${err?.code || err?.name || 'error'}`);
          return null;
        }
      };
      patch.price = await attempt(() => lookupPrice(facts, useAccount ? customer : null));
      patch.times = facts.service || facts.when ? await attempt(() => lookupTimes(facts, customer, useAccount)) : null;
      patch.key = failed ? null : key;
    }
    await saveResult(callSid, patch);
    return { ran: true, saved: true };
  } catch (err) {
    logger.warn(`[live-call-assist] refresh failed: ${err?.code || err?.name || 'error'}`);
    return { ran: false, reason: 'error' };
  }
}

// The shape GET /live sends: text only, or null while there is nothing to show.
function assistForPanel(callMeta) {
  const a = meta(callMeta).live_transcription?.assist;
  if (!a || (!a.intent && !a.price && !a.times)) return null;
  return { intent: a.intent || null, price: a.price || null, times: a.times || null, at: a.at || null };
}

module.exports = { refreshAssistIfDue, assistForPanel, _test: { validate, staffPrice, mergeFacts } };
