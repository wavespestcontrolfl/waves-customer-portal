'use strict';

/**
 * Live Call Co-Pilot 2.0 (free `/live`-only path, $0 extra API spend).
 *
 * Enriches GET /api/admin/call-recordings/live with four zero-LLM helpers:
 *   1. Caller Brief at Ring (0s, DB-only, 60s cache per customer):
 *      account stage/tier, property address/size, next & last visit, open
 *      estimates, 48h call/SMS touch counts, and redacted property notes.
 *   2. Full-Catalog Live Pricing Panel (5m cached catalog + deterministic
 *      keyword matching): surfaces matching one-time & specialty services
 *      alongside recurring plans as pests/services are spoken.
 *   3. 2 Best Route Slots (0 paid geocode calls): reuses cached assist times
 *      or computes 2 tightest open slots purely from a customer's stored
 *      lat/lng pin when self-booking is enabled (2m cache per customer).
 *   4. Missing-Info Checklist (7 items): Name, Address, Email, Pest/Scope,
 *      Price Quoted, Time Confirmed, and Gate/Pet Notes.
 *
 * Admin-only, read-only, fail-soft per section (never throws, never calls
 * external paid APIs, never logs customer PII or transcript text).
 */

const db = require('../models/db');
const logger = require('./logger');
const { scrubPans } = require('../utils/pan-scrub');
const { redactAccessCodes } = require('./context-aggregator');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { loadBookableCallServices } = require('./call-booking-catalog');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const CATALOG_TTL_MS = 5 * 60 * 1000;
const BRIEF_TTL_MS = 60 * 1000;
const SLOTS_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const MAX_CATALOG_MATCHES = 3;
const MAX_ROUTE_SLOTS = 2;
const LIVE_VISIT_STATUSES = Object.freeze(['pending', 'confirmed', 'en_route', 'on_site']);
const OPEN_ESTIMATE_STATUSES = Object.freeze(['draft', 'sent', 'viewed', 'pending']);

let catalogCache = { at: 0, rows: null };
const briefCache = new Map();
const slotsCache = new Map();

function resetCaches() {
  catalogCache = { at: 0, rows: null };
  briefCache.clear();
  slotsCache.clear();
}

function setBounded(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

function cleanSnippet(value, max = 160) {
  if (value == null) return null;
  const text = redactAccessCodes(scrubPans(String(value)))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return text || null;
}

function parseMeta(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '')) || {}; } catch { return {}; }
}

const placeNorm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const zip5 = (v) => String(v || '').replace(/\D/g, '').slice(0, 5);

function statesDifferentProperty(account, facts) {
  if (!account || !facts) return false;
  if (facts.city && account.city && placeNorm(facts.city) !== placeNorm(account.city)) return true;
  if (facts.zip && account.zip && zip5(facts.zip) !== zip5(account.zip)) return true;
  if (facts.address_line1) {
    if (!account.address_line1) return true;
    const aNum = String(account.address_line1).trim().match(/^\d+/)?.[0];
    const fNum = String(facts.address_line1).trim().match(/^\d+/)?.[0];
    if (aNum && fNum && aNum !== fNum) return true;
  }
  return false;
}

// ── 1. Caller Brief at Ring (DB-only, fail-soft, 60s cache) ──────────────────

async function safeRead(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[live-call-copilot] ${label} unreadable: ${err?.code || err?.name || 'error'}`);
    return fallback;
  }
}

function formatVisitBrief(row) {
  if (!row) return null;
  const date = row.scheduled_date instanceof Date
    ? row.scheduled_date.toISOString().slice(0, 10)
    : String(row.scheduled_date || '').slice(0, 10) || null;
  return {
    date,
    service: cleanSnippet(row.service_type, 80),
    window: cleanSnippet(row.window_display || row.window_start, 30),
  };
}

function formatEstimateBrief(row) {
  const rawTotal = row.onetime_total ?? row.monthly_total ?? row.annual_total;
  const num = rawTotal != null && rawTotal !== '' ? Number(rawTotal) : null;
  return {
    service: cleanSnippet(row.service_interest, 80) || 'Estimate',
    status: String(row.status || 'open').trim().toLowerCase(),
    amount: Number.isFinite(num) && num > 0 ? Math.round(num * 100) / 100 : null,
  };
}

function formatPropertyNotes(prefs) {
  if (!prefs) return [];
  const notes = [];
  if (prefs.pets_secured_plan) {
    const line = cleanSnippet(prefs.pets_secured_plan, 120);
    if (line) notes.push(`Pets: ${line}`);
  }
  if (prefs.chemical_sensitivities) {
    const detail = cleanSnippet(prefs.chemical_sensitivity_details, 100);
    notes.push(detail ? `Sensitivity: ${detail}` : 'Chemical sensitivity on file');
  }
  if (prefs.special_instructions) {
    const line = cleanSnippet(prefs.special_instructions, 120);
    if (line) notes.push(`Access: ${line}`);
  }
  return notes.slice(0, 3);
}

function formatAddressLine(account) {
  if (!account) return null;
  const parts = [account.address_line1, account.city, account.zip].map((s) => String(s || '').trim()).filter(Boolean);
  return parts.length ? cleanSnippet(parts.join(', '), 140) : null;
}

async function loadCustomerBundle(customerId, callId, conn, now) {
  const key = `${customerId}|${callId || ''}`;
  const hit = briefCache.get(key);
  if (hit && now.getTime() - hit.at < BRIEF_TTL_MS && now.getTime() >= hit.at) {
    return hit.bundle;
  }
  const today = etDateString(now);
  const since48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const [account, nextVisit, lastVisit, openEstimates, recentCalls, recentTexts, prefs] = await Promise.all([
    safeRead('customer', () => conn('customers')
      .where({ id: customerId }).whereNull('deleted_at')
      .first(
        'id', 'first_name', 'last_name', 'email', 'phone', 'pipeline_stage', 'waveguard_tier',
        'address_line1', 'address_line2', 'city', 'state', 'zip',
        'latitude', 'longitude', 'property_sqft', 'lot_sqft',
      ), null),
    safeRead('next_visit', () => conn('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', LIVE_VISIT_STATUSES)
      .where('scheduled_date', '>=', today)
      .orderBy('scheduled_date', 'asc')
      .orderBy('window_start', 'asc')
      .first('scheduled_date', 'window_start', 'window_display', 'service_type', 'status'), null),
    safeRead('last_visit', () => conn('scheduled_services')
      .where({ customer_id: customerId, status: 'completed' })
      .orderBy('scheduled_date', 'desc')
      .first('scheduled_date', 'service_type'), null),
    safeRead('estimates', () => conn('estimates')
      .where({ customer_id: customerId })
      .whereNull('archived_at')
      .whereIn('status', OPEN_ESTIMATE_STATUSES)
      .orderBy('created_at', 'desc')
      .limit(2)
      .select('status', 'service_interest', 'monthly_total', 'annual_total', 'onetime_total'), []),
    safeRead('recent_calls', async () => {
      const q = whereNotSandboxCall(conn('call_log'))
        .where({ customer_id: customerId })
        .where('created_at', '>=', since48h);
      if (callId) q.whereNot('id', callId);
      const row = await q.count({ n: '*' }).first();
      return Number(row?.n) || 0;
    }, 0),
    safeRead('recent_texts', async () => {
      const row = await conn('sms_log')
        .where({ customer_id: customerId })
        .where('created_at', '>=', since48h)
        .count({ n: '*' })
        .first();
      return Number(row?.n) || 0;
    }, 0),
    safeRead('prefs', () => conn('property_preferences')
      .where({ customer_id: customerId })
      .first('pets_secured_plan', 'chemical_sensitivities', 'chemical_sensitivity_details', 'special_instructions'), null),
  ]);

  const bundle = {
    account: account || null,
    prefs: prefs || null,
    brief: account ? {
      stage: account.pipeline_stage || null,
      tier: account.waveguard_tier || null,
      address: formatAddressLine(account),
      home_sqft: Number(account.property_sqft) > 0 ? Math.round(Number(account.property_sqft)) : null,
      lot_sqft: Number(account.lot_sqft) > 0 ? Math.round(Number(account.lot_sqft)) : null,
      next_visit: formatVisitBrief(nextVisit),
      last_visit: formatVisitBrief(lastVisit),
      open_estimates: (Array.isArray(openEstimates) ? openEstimates : []).map(formatEstimateBrief),
      recent_48h: { calls: recentCalls, texts: recentTexts },
      property_notes: formatPropertyNotes(prefs),
    } : null,
  };
  if (account) setBounded(briefCache, key, { at: now.getTime(), bundle });
  return bundle;
}

// ── 2. Full-Catalog Live Pricing Matcher ($0 deterministic) ──────────────────

const PALMETTO_RE = /\bpalmetto\s+(?:bugs?|(?:cock)?roach(?:es)?)\b/gi;
const CATALOG_CUES = Object.freeze([
  { re: /\b(?:wdo|wood[\s-]+destroying|real[\s-]+estate\s+inspection|closing\s+inspection|termite\s+letter)\b/i, keys: ['wdo_inspection', 'lawn_inspection'], nameRe: /\b(?:wdo|assessment)\b/i },
  { re: /\b(?:german\s+(?:cock)?roach|cockroach(?:es)?|roach(?:es)?)\b/i, stripPalmetto: true, keys: ['cockroach_control', 'one_time_pest'], nameRe: /\b(?:cockroach|one[- ]time\s+pest)\b/i },
  { re: /\b(?:wasp|hornet|yellow\s*jacket|bee\s*nest|beehive|wasp\s*nest|stinging)\b/i, keys: ['bee_wasp_nest_removal', 'stinging_insect'], nameRe: /\b(?:wasp|bee|hornet|nest)\b/i },
  { re: /\b(?:bed\s*bugs?)\b/i, keys: ['bed_bug_treatment', 'bed_bug'], nameRe: /\bbed\s*bug/i },
  { re: /\b(?:fleas?|ticks?)\b/i, keys: ['flea_treatment', 'flea_tick'], nameRe: /\bflea/i },
  { re: /\b(?:rats?|mice|mouse|rodents?|trapping|attic\s+(?:droppings?|noise|rats?|mice))\b/i, keys: ['rodent_trapping', 'rodent_control', 'rodent_exclusion'], nameRe: /\brodent/i },
  { re: /\b(?:termites?|sentricon|swarmers?|mud\s*tubes?|frass)\b/i, keys: ['termite_bait', 'sentricon', 'lawn_inspection'], nameRe: /\b(?:termite|sentricon|assessment)\b/i },
  { re: /\b(?:mosquito(?:es)?|no[- ]?see[- ]?ums?|misting)\b/i, keys: ['mosquito_control', 'mosquito'], nameRe: /\bmosquito/i },
  { re: /\b(?:fire\s*ants?|ant\s*mounds?)\b/i, keys: ['fire_ant_treatment', 'fire_ant'], nameRe: /\bfire\s*ant/i },
  { re: /\b(?:lawn|turf|weeds?|fertiliz|chinch\s*bugs?|mole\s*crickets?|st\.?\s*augustine|zoysia|sod|fungus)\b/i, keys: ['lawn_care', 'lawn_fertilization', 'lawn_pest_knockdown'], nameRe: /\blawn\b/i },
  { re: /\b(?:tree|shrub|palm|ornamental|whitefly|scale|spiraling)\b/i, keys: ['tree_shrub', 'palm_injection'], nameRe: /\b(?:tree|shrub|palm)\b/i },
  { re: /\b(?:one[- ]?time|single\s+treatment|just\s+once|ghost\s*ants?|sugar\s*ants?|ants?|spiders?|palmetto\s+bugs?|silverfish|earwigs?|general\s+pest|pest\s+control)\b/i, keys: ['one_time_pest', 'pest_control', 'quarterly_pest'], nameRe: /\b(?:one[- ]time\s+pest|pest\s+control)\b/i },
]);

async function loadCachedCatalog(conn, now) {
  if (catalogCache.rows && now.getTime() - catalogCache.at < CATALOG_TTL_MS && now.getTime() >= catalogCache.at) {
    return catalogCache.rows;
  }
  const rows = await safeRead('catalog', () => loadBookableCallServices(conn), []);
  if (rows.length) catalogCache = { at: now.getTime(), rows };
  return rows;
}

function formatCatalogPriceRow(row) {
  const num = row.base_price != null && row.base_price !== '' ? Number(row.base_price) : null;
  return {
    name: cleanSnippet(row.short_name || row.name, 70),
    price: Number.isFinite(num) && num >= 0 ? Math.round(num * 100) / 100 : null,
    billing_type: row.billing_type || null,
    duration_minutes: Number(row.default_duration_minutes) > 0 ? Number(row.default_duration_minutes) : null,
  };
}

function matchingRowsForCue(catalogRows, cue) {
  const byKey = new Map();
  for (const row of catalogRows) {
    const key = String(row?.service_key || '').toLowerCase();
    if (key && !byKey.has(key)) byKey.set(key, row);
  }
  const ordered = [];
  for (const key of cue.keys) {
    if (byKey.has(key)) ordered.push(byKey.get(key));
  }
  for (const row of catalogRows) {
    if (row && cue.nameRe && cue.nameRe.test(String(row.name || ''))) ordered.push(row);
  }
  return ordered;
}

function matchCatalogPrices(text, catalogRows) {
  const raw = String(text || '').trim();
  if (!raw || !Array.isArray(catalogRows) || !catalogRows.length) return [];
  const noPalmetto = raw.replace(PALMETTO_RE, ' ');
  const out = [];
  const seen = new Set();
  for (const cue of CATALOG_CUES) {
    const sample = cue.stripPalmetto ? noPalmetto : raw;
    if (!cue.re.test(sample)) continue;
    for (const row of matchingRowsForCue(catalogRows, cue)) {
      if (out.length >= MAX_CATALOG_MATCHES) return out;
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(formatCatalogPriceRow(row));
    }
  }
  return out;
}

// ── 3. Two Best Route Slots ($0, ZERO geocoding) ─────────────────────────────

function slotsFromAssist(assist) {
  if (!assist?.times || typeof assist.times !== 'string') return [];
  return assist.times.split(';').map((s) => s.trim()).filter(Boolean).slice(0, MAX_ROUTE_SLOTS);
}

async function resolveRouteSlots({ account, assist, assistFacts, now, deps }) {
  const fromAssist = slotsFromAssist(assist);
  if (fromAssist.length) return fromAssist;

  const isEnabled = deps.isEnabled || require('../config/feature-gates').isEnabled;
  if (!isEnabled('selfBooking')) return [];
  if (!account || assistFacts?.place_withdrawn || statesDifferentProperty(account, assistFacts)) return [];

  const lat = Number(account.latitude);
  const lng = Number(account.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return [];

  const today = etDateString(now);
  const cacheKey = `${account.id}|${today}`;
  const hit = slotsCache.get(cacheKey);
  if (hit && now.getTime() - hit.at < SLOTS_TTL_MS && now.getTime() >= hit.at) {
    return hit.slots;
  }

  const slots = await safeRead('route_slots', async () => {
    const booking = deps.booking || require('../routes/booking')._internals;
    const formatSlots = deps.formatSlots || require('./voice-agent/relay-tools').formatSlots;
    const config = await booking.loadBookingConfig();
    const minDays = config.advance_days_min ?? 1;
    const maxDays = Math.min(config.advance_days_max ?? 14, 14);
    const availability = await booking.buildBookingAvailability({
      lat,
      lng,
      duration: config.default_duration_minutes || 60,
      rangeFrom: etDateString(addETDays(now, minDays)),
      rangeTo: etDateString(addETDays(now, maxDays)),
      config,
      today,
      expandOpenDays: true,
      surface: 'voice',
    });
    const formatted = formatSlots(availability?.slots, MAX_ROUTE_SLOTS);
    return formatted ? formatted.split(';').map((s) => s.trim()).filter(Boolean).slice(0, MAX_ROUTE_SLOTS) : [];
  }, null);

  if (slots !== null) setBounded(slotsCache, cacheKey, { at: now.getTime(), slots });
  return slots || [];
}

// ── 4. Live Missing-Info Checklist ($0 pure deterministic) ───────────────────

const SPOKEN_NAME_RE = /\b(?:my name is|this is|i'?m|name'?s)\s+([a-z]{2,20})\b/i;
const SPOKEN_STREET_RE = /\b\d{2,5}\s+[a-z][a-z0-9'.-]*(?:\s+[a-z0-9'.-]+){0,3}\s+(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|blvd|boulevard|way|cir|circle|pl|place|ter|terrace|pkwy|trl|trail|loop|run|cv|cove)\b/i;
const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i;
const SPOKEN_EMAIL_RE = /\b(?:at|@)\s*(?:gmail|yahoo|icloud|outlook|hotmail|aol|comcast|verizon|me|live|msn|proton)\b/i;
const PRICE_SPOKEN_RE = /\$\s*\d{2,4}\b|\b\d{2,4}\s*(?:dollars?|bucks?)\b|\b(?:it'?s|would be|is|quoted?|total|price|cost|runs?|starts?\s+at)\s+\d{2,4}\b/i;
const DAY_CUE_RE = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next\s+week)\b/i;
const TIME_CUE_RE = /\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|morning|afternoon|noon|between\s+\d{1,2})\b/i;
const ACCESS_CUE_RE = /\b(?:gate|code|lockbox|dogs?|pets?|cats?|fence|backyard|hoa|guard|knock|ring|call\s+(?:before|when|ahead))\b/i;

function hasSpokenOrStoredAddress(ctx) {
  const { account, assistFacts, allText } = ctx;
  if (account?.address_line1 && account?.zip && !assistFacts?.place_withdrawn) return true;
  if (assistFacts?.address_line1 && (assistFacts?.city || assistFacts?.zip)) return true;
  return SPOKEN_STREET_RE.test(allText);
}

const CHECKLIST_RULES = Object.freeze([
  { key: 'name', label: 'Name', test: (c) => Boolean(c.customer?.name || c.account?.first_name || SPOKEN_NAME_RE.test(c.callerText)) },
  { key: 'address', label: 'Address', test: hasSpokenOrStoredAddress },
  { key: 'email', label: 'Email', test: (c) => EMAIL_RE.test(String(c.account?.email || '')) || EMAIL_RE.test(c.allText) || SPOKEN_EMAIL_RE.test(c.allText) },
  { key: 'scope', label: 'Pest / Scope', test: (c) => Boolean(c.assist?.intent || c.assistFacts?.service || c.catalogPrices.length) },
  { key: 'price_quoted', label: 'Price Quoted', test: (c) => PRICE_SPOKEN_RE.test(c.staffText) },
  { key: 'time_confirmed', label: 'Time Confirmed', test: (c) => Boolean(c.assistFacts?.when) || (DAY_CUE_RE.test(c.allText) && TIME_CUE_RE.test(c.allText)) },
  { key: 'access_notes', label: 'Gate / Pet Notes', test: (c) => Boolean(c.prefs?.pets_secured_plan || c.prefs?.special_instructions || c.prefs?.chemical_sensitivities || ACCESS_CUE_RE.test(c.allText)) },
]);

function joinSpeakerLines(lines, predicate) {
  return lines.filter(predicate).map((l) => String(l?.text || '')).join('\n');
}

function buildCallChecklist({ customer, account, prefs, assist, assistFacts, lines = [], catalogPrices = [] }) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const ctx = {
    customer,
    account,
    prefs,
    assist,
    assistFacts,
    catalogPrices: Array.isArray(catalogPrices) ? catalogPrices : [],
    allText: joinSpeakerLines(safeLines, () => true),
    staffText: joinSpeakerLines(safeLines, (l) => l?.speaker === 'staff'),
    callerText: joinSpeakerLines(safeLines, (l) => l?.speaker !== 'staff'),
  };
  return CHECKLIST_RULES.map(({ key, label, test }) => ({ key, label, ok: Boolean(test(ctx)) }));
}

/**
 * Build the Co-Pilot 2.0 payload for one active call on GET /live.
 * Never throws; returns null only if nothing could be assembled.
 */
async function buildLiveCallCopilot(input, deps) {
  try {
    const opts = Object(input);
    const cfg = Object(deps);
    const conn = cfg.db || db;
    const now = cfg.now ? new Date(cfg.now) : new Date();
    const assistFacts = Object(Object(parseMeta(opts.meta).live_transcription).assist).facts || null;
    const callObj = Object(opts.call);
    const customerId = Object(opts.customer).id || callObj.customer_id || null;
    const [bundle, catalogRows] = await Promise.all([
      customerId ? loadCustomerBundle(customerId, callObj.id || null, conn, now) : Promise.resolve({ account: null, prefs: null, brief: null }),
      loadCachedCatalog(conn, now),
    ]);
    const safeLines = Array.isArray(opts.lines) ? opts.lines : [];
    const intent = String(Object(opts.assist).intent || '');
    const catalogPrices = matchCatalogPrices(`${intent}\n${joinSpeakerLines(safeLines, () => true)}`, catalogRows);
    const routeSlots = await resolveRouteSlots({ account: bundle.account, assist: opts.assist, assistFacts, now, deps: cfg });
    const checklist = buildCallChecklist({
      customer: opts.customer, account: bundle.account, prefs: bundle.prefs, assist: opts.assist, assistFacts, lines: safeLines, catalogPrices,
    });
    return { brief: bundle.brief, catalog_prices: catalogPrices, route_slots: routeSlots, checklist };
  } catch (err) {
    logger.warn(`[live-call-copilot] build failed: ${Object(err).code || Object(err).name || 'error'}`);
    return null;
  }
}

module.exports = {
  buildLiveCallCopilot,
  matchCatalogPrices,
  buildCallChecklist,
  _test: {
    resetCaches,
    cleanSnippet,
    statesDifferentProperty,
    formatPropertyNotes,
    slotsFromAssist,
    CATALOG_CUES,
  },
};
