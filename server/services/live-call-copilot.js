'use strict';

/**
 * Live Call Co-Pilot 2.0 (free `/live`-only path, $0 extra API spend).
 *
 * Enriches GET /api/admin/call-recordings/live with four zero-LLM helpers:
 *   1. Caller Brief at Ring (0s, DB-only, 60s cache per customer+call):
 *      account stage/tier, property address, treated lawn & lot area, next &
 *      last visit, open estimates, 48h call/SMS touch counts, redacted notes.
 *   2. Full-Catalog Live Pricing Panel (5m cached catalog + affirmative-only
 *      deterministic keyword matching): shows exact prices ONLY for fixed-price
 *      or free rows and labels variable-priced services as variable so staff
 *      never see a stale base anchor contradicting the pricing engine.
 *   3. 2 Best Route Slots (ZERO paid lookups — `paidLookups: false`, no
 *      geocoding): reuses cached assist times or computes 2 tightest open
 *      slots from a resolved single-property stored lat/lng pin (2m cache).
 *   4. Missing-Info Checklist (7 items across full call utterances, up to 120
 *      turns): Name, Address, Email, Pest/Scope, Price Quoted, Time
 *      Preference, and Gate/Pet Notes.
 *
 * Admin-only, read-only, fail-soft per section (never throws, never calls
 * external paid APIs, never logs customer PII or transcript text).
 */

const db = require('../models/db');
const logger = require('./logger');
const { scrubPans } = require('../utils/pan-scrub');
const { redactAccessCodes } = require('./context-aggregator');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { loadBookableCallServices } = require('./call-booking-catalog');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { excludeHeld } = require('./visit-hold');
const { lineForCatalogRow } = require('./auto-dispatch/service-category');

const CATALOG_TTL_MS = 5 * 60 * 1000;
const BRIEF_TTL_MS = 60 * 1000;
const SLOTS_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const MAX_CATALOG_MATCHES = 3;
const MAX_ROUTE_SLOTS = 2;
const MAX_CALL_UTTERANCES = 120;
const PALMETTO_RE = /\bpalmetto\s+(?:bugs?|(?:cock)?roach(?:es)?)\b/gi;
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

const SPOKEN_STREET_RE = /\b\d{2,5}\s+[a-z][a-z0-9'.-]*(?:\s+[a-z0-9'.-]+){0,3}\s+(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|blvd|boulevard|way|cir|circle|pl|place|ter|terrace|pkwy|trl|trail|loop|run|cv|cove)\b/i;
const SWFL_CITIES = Object.freeze([
  'bradenton', 'sarasota', 'venice', 'parrish', 'palmetto', 'ellenton', 'englewood',
  'north port', 'port charlotte', 'lakewood ranch', 'osprey', 'nokomis', 'myakka',
  'rotonda west', 'punta gorda', 'longboat key', 'siesta key', 'anna maria',
  'holmes beach', 'bradenton beach', 'sun city center', 'ruskin', 'riverview',
  'apollo beach', 'wimauma', 'arcadia', 'cape coral', 'fort myers', 'naples', 'tampa',
]);
const SWFL_CITY_RE = new RegExp(
  `\\b(${[...SWFL_CITIES].sort((a, b) => b.length - a.length).map((c) => c.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'gi',
);
const OTHER_PROPERTY_CUE_RE = /\b(?:different\s+(?:address|house|property|home|place)|another\s+(?:address|property|home|house)|rental\s+property|investment\s+property|other\s+(?:house|property|home)|my\s+(?:mom'?s|mother'?s|dad'?s|father'?s|son'?s|daughter'?s|sister'?s|brother'?s)\s+(?:house|home|place|property))\b/i;
const SPOKEN_ZIP_RE = /\b((?:33|34)\d{3})\b/g;

// Compares full street + unit via booking._internals.addressMatchesCustomer
// (same helper live-call-assist.js uses). Fails closed (true) on error.
function statesDifferentProperty(target, facts, addressMatcher) {
  if (!target || !facts) return false;
  if (facts.city && target.city && placeNorm(facts.city) !== placeNorm(target.city)) return true;
  if (facts.zip && target.zip && zip5(facts.zip) !== zip5(target.zip)) return true;
  if (!facts.address_line1) return false;
  if (!target.address_line1) return true;
  try {
    const matcher = addressMatcher || require('../routes/booking')._internals.addressMatchesCustomer;
    return !matcher(target, facts.address_line1, facts.zip || undefined);
  } catch {
    return true;
  }
}

// Works even when GATE_CALL_LIVE_ASSIST is off (assistFacts null): detects when
// the caller speaks a different street, ZIP, SWFL city, or another property.
function spokenLocationDiffers(target, callerSpeech, addressMatcher) {
  const speech = String(callerSpeech || '').trim();
  if (!target || !speech) return false;
  if (OTHER_PROPERTY_CUE_RE.test(speech)) return true;
  const targetZip = zip5(target.zip);
  const zips = [...speech.matchAll(SPOKEN_ZIP_RE)].map((m) => m[1]);
  if (targetZip && zips.some((z) => z !== targetZip)) return true;
  const targetCity = placeNorm(target.city);
  const citySpeech = speech.replace(PALMETTO_RE, ' ');
  const cities = [...citySpeech.matchAll(SWFL_CITY_RE)].map((m) => placeNorm(m[1]));
  if (targetCity && cities.some((c) => c !== targetCity)) return true;
  const streets = [...speech.matchAll(new RegExp(SPOKEN_STREET_RE.source, 'gi'))].map((m) => m[0]);
  if (!streets.length) return false;
  return streets.some((street) => statesDifferentProperty(target, { address_line1: street, zip: zips[0] || null }, addressMatcher));
}

// ── 1. Caller Brief at Ring (DB-only, fail-soft, 60s cache) ──────────────────

async function safeRead(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[live-call-copilot] ${label} unreadable: ${Object(err).code || Object(err).name || 'error'}`);
    return fallback;
  }
}

function formatVisitBrief(row) {
  if (!row) return null;
  return {
    date: dateOnlyString(row.scheduled_date) || null,
    service: cleanSnippet(row.service_type, 80),
    window: cleanSnippet(row.window_display || row.window_start, 30),
  };
}

function positiveAmount(raw) {
  if (raw == null || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.round(num * 100) / 100 : null;
}

function formatEstimateBrief(row) {
  const onetime = positiveAmount(row.onetime_total);
  const monthly = positiveAmount(row.monthly_total);
  const annual = positiveAmount(row.annual_total);
  const parts = [];
  if (onetime != null) parts.push(`$${onetime} one-time`);
  // monthly_total and annual_total represent equivalent recurring bases (never additive).
  if (monthly != null && annual != null) parts.push(`$${monthly}/mo ($${annual}/yr)`);
  else if (monthly != null) parts.push(`$${monthly}/mo`);
  else if (annual != null) parts.push(`$${annual}/yr`);
  return {
    service: cleanSnippet(row.service_interest, 80) || 'Estimate',
    status: String(row.status || 'open').trim().toLowerCase(),
    totals: { onetime, monthly, annual },
    price_summary: parts.length ? parts.join(' + ') : null,
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

function buildBriefSummary(account, { nextVisit, lastVisit, openEstimates, recentCalls, recentTexts, prefs }) {
  if (!account) return null;
  return {
    stage: account.pipeline_stage || null,
    tier: account.waveguard_tier || null,
    address: formatAddressLine(account),
    // customers.property_sqft is treated lawn area (never home size); lot_sqft is total lot area.
    lawn_sqft: Number(account.property_sqft) > 0 ? Math.round(Number(account.property_sqft)) : null,
    lot_sqft: Number(account.lot_sqft) > 0 ? Math.round(Number(account.lot_sqft)) : null,
    next_visit: formatVisitBrief(nextVisit),
    last_visit: formatVisitBrief(lastVisit),
    open_estimates: (Array.isArray(openEstimates) ? openEstimates : []).map(formatEstimateBrief),
    recent_48h: { calls: recentCalls, texts: recentTexts },
    property_notes: formatPropertyNotes(prefs),
  };
}

async function loadCustomerBundle(customerId, callId, conn, now) {
  const key = `${customerId}|${callId || ''}`;
  const hit = briefCache.get(key);
  if (hit && now.getTime() - hit.at < BRIEF_TTL_MS && now.getTime() >= hit.at) {
    return hit.bundle;
  }
  const today = etDateString(now);
  const since48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const [account, properties, nextVisit, lastVisit, openEstimates, recentCalls, recentTexts, prefs] = await Promise.all([
    safeRead('customer', () => conn('customers')
      .where({ id: customerId }).whereNull('deleted_at')
      .first(
        'id', 'first_name', 'last_name', 'email', 'phone', 'pipeline_stage', 'waveguard_tier',
        'address_line1', 'address_line2', 'city', 'state', 'zip',
        'latitude', 'longitude', 'property_sqft', 'lot_sqft',
      ), null),
    // Null on failure so route-slot lookup fails closed instead of assuming single-property.
    safeRead('properties', () => conn('customer_properties')
      .where({ customer_id: customerId, active: true })
      .limit(2)
      .select('id', 'address_line1', 'address_line2', 'city', 'zip', 'latitude', 'longitude'), null),
    safeRead('next_visit', () => excludeHeld(conn('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', LIVE_VISIT_STATUSES)
      .where('scheduled_date', '>=', today)
      .orderBy('scheduled_date', 'asc')
      .orderBy('window_start', 'asc'))
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
        .modify(excludeUnresolvedSendReservations)
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
    properties,
    prefs: prefs || null,
    brief: buildBriefSummary(account, { nextVisit, lastVisit, openEstimates, recentCalls, recentTexts, prefs }),
  };
  if (account) setBounded(briefCache, key, { at: now.getTime(), bundle });
  return bundle;
}

// ── 2. Full-Catalog Live Pricing Matcher ($0 affirmative-only deterministic) ─

const NEGATION_LEAD = '(?:no|not|never|none|zero|without|free\\s+of|isn[\'’]?t|is\\s+not|aren[\'’]?t|are\\s+not|wasn[\'’]?t|was\\s+not|weren[\'’]?t|were\\s+not|don[\'’]?t|do\\s+not|doesn[\'’]?t|does\\s+not|didn[\'’]?t|did\\s+not|haven[\'’]?t|have\\s+not|hasn[\'’]?t|has\\s+not|hadn[\'’]?t|had\\s+not|ain[\'’]?t)';
const HISTORICAL_LEAD = '(?:used\\s+to\\s+(?:have|get|see)|years?\\s+ago|months?\\s+ago|last\\s+(?:year|time|visit)|previously(?:\\s+had)?|before\\s+we\\s+moved|in\\s+the\\s+past|back\\s+in\\s+\\d{4})';
const HISTORICAL_TAIL = '(?:years?\\s+ago|months?\\s+ago|last\\s+(?:year|time|visit)|in\\s+the\\s+past|before\\s+we\\s+moved|a\\s+long\\s+time\\s+ago)';
const NON_ADVERSATIVE_WORDS = '(?:\\s+(?!(?:but|however|though|except|just|only|instead|now)\\b)[\\w\'’]+){0,5}';

function stripNegatedAndHistorical(text, termPattern) {
  const negRe = new RegExp(`\\b${NEGATION_LEAD}${NON_ADVERSATIVE_WORDS}\\s+(?:${termPattern})\\b`, 'gi');
  const histLeadRe = new RegExp(`\\b${HISTORICAL_LEAD}${NON_ADVERSATIVE_WORDS}\\s+(?:${termPattern})\\b`, 'gi');
  const histTailRe = new RegExp(`\\b(?:${termPattern})${NON_ADVERSATIVE_WORDS}\\s+${HISTORICAL_TAIL}\\b`, 'gi');
  return text.replace(negRe, ' ').replace(histLeadRe, ' ').replace(histTailRe, ' ');
}

const CATALOG_CUES = Object.freeze([
  { term: 'wdo|wood[\\s-]+destroying|real[\\s-]+estate\\s+inspection|closing\\s+inspection|termite\\s+letter', keys: ['wdo_inspection', 'lawn_inspection'], nameRe: /\b(?:wdo|assessment)\b/i, funnelKey: 'termite', serviceLine: 'termite' },
  { term: 'german\\s+(?:cock)?roach(?:es)?|cockroach(?:es)?|roach(?:es)?', stripPalmetto: true, keys: ['cockroach_control', 'one_time_pest'], nameRe: /\b(?:cockroach|one[- ]time\s+pest)\b/i, funnelKey: 'pest_control', serviceLine: 'general' },
  { term: 'wasp(?:s|\\s*nest)?|hornets?|yellow\\s*jackets?|bee\\s*nest|beehives?|stinging\\s+insects?', keys: ['bee_wasp_nest_removal', 'stinging_insect'], nameRe: /\b(?:wasp|bee|hornet|nest)\b/i, funnelKey: 'pest_control', serviceLine: 'general' },
  { term: 'bed\\s*bugs?', keys: ['bed_bug_treatment', 'bed_bug'], nameRe: /\bbed\s*bug/i, funnelKey: 'pest_control', serviceLine: 'general' },
  { term: 'fleas?|ticks?', keys: ['flea_treatment', 'flea_tick'], nameRe: /\bflea/i, funnelKey: 'pest_control', serviceLine: 'general' },
  { term: 'rats?|mice|mouse|rodents?|trapping|attic\\s+(?:droppings?|noise|rats?|mice)', keys: ['rodent_trapping', 'rodent_control', 'rodent_exclusion'], nameRe: /\brodent/i, funnelKey: 'rodent', serviceLine: 'exclusion' },
  { term: 'bora[\\s-]?care', keys: ['bora_care'], nameRe: /\bbora[\s-]?care\b/i, funnelKey: 'bora_care', serviceLine: 'termite' },
  { term: 'termites?|sentricon|swarmers?|mud\\s*tubes?|frass', keys: ['termite_bait', 'sentricon', 'lawn_inspection'], nameRe: /\b(?:termite|sentricon|assessment)\b/i, funnelKey: 'termite', serviceLine: 'termite' },
  { term: 'mosquito(?:es)?|no[- ]?see[- ]?ums?|misting', keys: ['mosquito_control', 'mosquito'], nameRe: /\bmosquito/i, funnelKey: 'mosquito', serviceLine: 'mosquito' },
  { term: 'fire\\s*ants?|ant\\s*mounds?', keys: ['fire_ant_treatment', 'fire_ant'], nameRe: /\bfire\s*ant/i, funnelKey: 'pest_control', serviceLine: 'general' },
  { term: 'lawn|turf|weeds?|fertiliz\\w*|chinch\\s*bugs?|mole\\s*crickets?|st\\.?\\s*augustine|zoysia|sod|fungus', keys: ['lawn_care', 'lawn_fertilization', 'lawn_pest_knockdown'], nameRe: /\blawn\b/i, funnelKey: 'lawn_care', serviceLine: 'lawn' },
  { term: 'trees?|shrubs?|palms?|ornamentals?|whitefl(?:y|ies)|spiraling', keys: ['tree_shrub', 'palm_injection'], nameRe: /\b(?:tree|shrub|palm)\b/i, funnelKey: 'tree_shrub', serviceLine: 'lawn' },
  { term: 'one[- ]?time|single\\s+treatment|just\\s+once|ghost\\s*ants?|sugar\\s*ants?|ants?|spiders?|palmetto\\s+bugs?|silverfish|earwigs?|general\\s+pest|pest\\s+control', keys: ['one_time_pest', 'pest_control', 'quarterly_pest'], nameRe: /\b(?:one[- ]time\s+pest|pest\s+control)\b/i, funnelKey: 'pest_control', serviceLine: 'general' },
]);

async function loadCachedCatalog(conn, now) {
  if (catalogCache.rows && now.getTime() - catalogCache.at < CATALOG_TTL_MS && now.getTime() >= catalogCache.at) {
    return catalogCache.rows;
  }
  const rows = await safeRead('catalog', () => loadBookableCallServices(conn), []);
  if (rows.length) catalogCache = { at: now.getTime(), rows };
  return rows;
}

const EXPLICITLY_FREE_SERVICE_KEYS = new Set(['lawn_inspection']);

function formatCatalogPriceRow(row) {
  const num = row.base_price != null && row.base_price !== '' ? Number(row.base_price) : null;
  const validNum = Number.isFinite(num) && num >= 0 ? Math.round(num * 100) / 100 : null;
  const key = String(row.service_key || '').toLowerCase();
  // Variable rows can store base_price=0 as a library placeholder — never label those "Free".
  const isFree = (row.pricing_type === 'free') || (row.pricing_type === 'fixed' && validNum === 0 && EXPLICITLY_FREE_SERVICE_KEYS.has(key));
  const isFixed = row.pricing_type === 'fixed' && validNum !== null && validNum > 0;
  return {
    name: cleanSnippet(row.short_name || row.name, 70),
    price: isFree ? 0 : (isFixed ? validNum : null),
    pricing_type: isFree ? 'free' : (isFixed ? 'fixed' : 'variable'),
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

function matchCatalogCues(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const noPalmetto = raw.replace(PALMETTO_RE, ' ');
  return CATALOG_CUES.filter((cue) => {
    const cleaned = stripNegatedAndHistorical(cue.stripPalmetto ? noPalmetto : raw, cue.term);
    return new RegExp(`\\b(?:${cue.term})\\b`, 'i').test(cleaned);
  });
}

function matchCatalogMatches(text, catalogRows) {
  const cues = matchCatalogCues(text);
  if (!cues.length) return { cues: [], rows: [], cueLines: [] };
  const safeCatalog = Array.isArray(catalogRows) ? catalogRows : [];
  const rows = [];
  const seen = new Set();
  const cueLines = [];
  for (const cue of cues) {
    const matched = safeCatalog.length ? matchingRowsForCue(safeCatalog, cue) : [];
    const line = (matched[0] && lineForCatalogRow(matched[0])) || cue.serviceLine || null;
    if (line && !cueLines.includes(line)) cueLines.push(line);
    for (const row of matched) {
      if (rows.length >= MAX_CATALOG_MATCHES) break;
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push({ row, cue });
    }
  }
  return { cues, rows, cueLines };
}

function matchCatalogPrices(text, catalogRows) {
  return matchCatalogMatches(text, catalogRows).rows.map(({ row }) => formatCatalogPriceRow(row));
}

const FALLBACK_FUNNEL_DURATIONS = Object.freeze({
  pest_control: 60, lawn_care: 60, mosquito: 60, tree_shrub: 60, termite: 90, rodent: 60, bora_care: 90,
});

function resolveSlotServiceContext(matches) {
  const cues = Array.isArray(matches?.cues) ? matches.cues : [];
  const rows = Array.isArray(matches?.rows) ? matches.rows.map((m) => m.row).filter(Boolean) : [];
  const funnelKeys = [...new Set(cues.map((c) => c.funnelKey).filter(Boolean))].sort();
  const serviceLines = Array.isArray(matches?.cueLines) && matches.cueLines.length
    ? matches.cueLines
    : [...new Set(cues.map((c) => c.serviceLine).filter(Boolean))];
  const primaryRow = rows[0] || null;
  const rowDuration = Number(primaryRow?.default_duration_minutes) || 0;
  const isSingleSpecificRow = Boolean(primaryRow) && funnelKeys.length <= 1 && primaryRow.service_key !== 'lawn_inspection';
  const serviceIdentity = isSingleSpecificRow
    ? { catalogServiceKey: primaryRow.service_key || null, serviceType: primaryRow.name || null }
    : null;
  const rawServiceKey = funnelKeys.join('+');
  return {
    rawServiceKey,
    funnelKeys,
    serviceIdentity,
    serviceLines: serviceLines.length ? serviceLines : undefined,
    rowDuration,
    cacheKey: `${rawServiceKey || 'default'}:${serviceLines.join('+') || 'any'}:${rowDuration || 'cfg'}`,
  };
}

function resolveRequestedSlotArgs(svc, config, booking, isEnabled) {
  const keys = svc.funnelKeys || [];
  if (keys.length > 1 && !isEnabled('multiServiceBooking')) return null;
  const normalizedKey = typeof booking.normalizeBookingServiceKey === 'function'
    ? booking.normalizeBookingServiceKey(svc.rawServiceKey)
    : svc.rawServiceKey;
  if (keys.length > 1 && !normalizedKey) return null;
  const sumDuration = keys.reduce((acc, k) => acc + (FALLBACK_FUNNEL_DURATIONS[k] || 60), 0);
  const duration = typeof booking.resolveBookingDuration === 'function'
    ? booking.resolveBookingDuration(svc.rowDuration || null, config, normalizedKey)
    : (sumDuration || svc.rowDuration || config.slot_duration_minutes || config.default_duration_minutes || 60);
  return {
    duration,
    serviceKey: normalizedKey || undefined,
    serviceIdentity: svc.serviceIdentity || undefined,
    serviceLines: svc.serviceLines,
  };
}

// ── 3. Two Best Route Slots ($0, ZERO paid lookups, single-property resolved) ─

function slotsFromAssist(assist) {
  if (!assist?.times || typeof assist.times !== 'string') return [];
  return assist.times.split(';').map((s) => s.trim()).filter(Boolean).slice(0, MAX_ROUTE_SLOTS);
}

function isValidCoord(value) {
  if (value == null || String(value).trim() === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0;
}

function resolveSinglePropertyPin(account, properties, assistFacts, callerSpeech, addressMatcher) {
  // Null properties = lookup failed → fail closed. >1 active property = ambiguous → withhold.
  if (!account || !Array.isArray(properties) || properties.length > 1) return null;
  if (assistFacts?.place_withdrawn) return null;
  const target = properties.length === 1 ? properties[0] : account;
  if (statesDifferentProperty(target, assistFacts, addressMatcher)) return null;
  if (spokenLocationDiffers(target, callerSpeech, addressMatcher)) return null;
  if (!isValidCoord(target.latitude) || !isValidCoord(target.longitude)) return null;
  return { lat: Number(target.latitude), lng: Number(target.longitude), cacheTarget: properties.length === 1 ? `prop:${target.id}` : `cust:${account.id}` };
}

async function resolveRouteSlots({ account, properties, assist, assistFacts, callerSpeech, slotService, now, deps }) {
  const fromAssist = slotsFromAssist(assist);
  if (fromAssist.length) return fromAssist;

  const isEnabled = deps.isEnabled || require('../config/feature-gates').isEnabled;
  if (!isEnabled('selfBooking')) return [];

  const pin = resolveSinglePropertyPin(account, properties, assistFacts, callerSpeech, deps.addressMatchesCustomer);
  if (!pin) return [];

  const todayDay = etDateString(now);
  const svc = slotService || { rawServiceKey: '', funnelKeys: [], serviceIdentity: null, serviceLines: undefined, rowDuration: 0, cacheKey: 'default' };
  const multiFlag = isEnabled('multiServiceBooking') ? 'm1' : 'm0';
  const cacheKey = `${pin.cacheTarget}|${todayDay}|${svc.cacheKey}|${multiFlag}`;
  const hit = slotsCache.get(cacheKey);
  if (hit && now.getTime() - hit.at < SLOTS_TTL_MS && now.getTime() >= hit.at) {
    return hit.slots;
  }

  const slots = await safeRead('route_slots', async () => {
    const booking = deps.booking || require('../routes/booking')._internals;
    const formatSlots = deps.formatSlots || require('./voice-agent/relay-tools').formatSlots;
    const config = await booking.loadBookingConfig();
    const slotArgs = resolveRequestedSlotArgs(svc, config, booking, isEnabled);
    if (!slotArgs) return [];
    const minDays = config.advance_days_min ?? 1;
    const maxDays = Math.min(config.advance_days_max ?? 14, 14);
    const availability = await booking.buildBookingAvailability({
      lat: pin.lat,
      lng: pin.lng,
      duration: slotArgs.duration,
      ...(slotArgs.serviceKey ? { serviceKey: slotArgs.serviceKey } : {}),
      ...(slotArgs.serviceIdentity ? { serviceIdentity: slotArgs.serviceIdentity } : {}),
      ...(slotArgs.serviceLines ? { serviceLines: slotArgs.serviceLines } : {}),
      rangeFrom: etDateString(addETDays(now, minDays)),
      rangeTo: etDateString(addETDays(now, maxDays)),
      config,
      // buildBookingAvailability expects a Date instance for `today` (passes it to etDateString).
      today: now,
      expandOpenDays: true,
      surface: 'voice',
      // Hard zero-spend guard: skips paid road-distance and weather provider calls.
      paidLookups: false,
    });
    const formatted = formatSlots(availability?.slots, MAX_ROUTE_SLOTS);
    return formatted ? formatted.split(';').map((s) => s.trim()).filter(Boolean).slice(0, MAX_ROUTE_SLOTS) : [];
  }, null);

  if (slots !== null) setBounded(slotsCache, cacheKey, { at: now.getTime(), slots });
  return slots || [];
}

// ── 4. Live Missing-Info Checklist ($0 pure deterministic across whole call) ─

const INTRO_NAME_EXPLICIT_RE = /\b(?:my\s+name\s+is|name['’]?s)\s+([a-z][a-z'-]{1,20})\b/gi;
const INTRO_NAME_SELF_RE = /(?:^|[\n.!?]\s*|(?:hi|hello|hey|yes|yeah)[,\s]+)(?:this\s+is|i['’]?m|i\s+am)\s+([a-z][a-z'-]{1,20})\b/gi;
const NON_NAME_WORDS = new Set([
  'about', 'actually', 'already', 'also', 'an', 'at', 'available', 'back', 'busy',
  'closed', 'currently', 'fine', 'for', 'from', 'good', 'great', 'her', 'here', 'his',
  'in', 'interested', 'it', 'just', 'located', 'my', 'new', 'not', 'ok', 'okay', 'on',
  'only', 'open', 'our', 'ready', 'really', 'so', 'sorry', 'still', 'sure', 'that',
  'the', 'their', 'there', 'this', 'too', 'unavailable', 'very', 'with', 'your',
]);

function isPlausibleFirstName(word) {
  const low = String(word || '').toLowerCase();
  return low.length >= 2 && !NON_NAME_WORDS.has(low) && !low.endsWith('ing');
}

function hasSpokenCallerName(callerText) {
  const text = String(callerText || '');
  for (const re of [INTRO_NAME_EXPLICIT_RE, INTRO_NAME_SELF_RE]) {
    for (const match of text.matchAll(re)) {
      if (isPlausibleFirstName(match[1])) return true;
    }
  }
  return false;
}

const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i;
const SPOKEN_EMAIL_RE = /\b(?:at|@)\s*(?:gmail|yahoo|icloud|outlook|hotmail|aol|comcast|verizon|me|live|msn|proton)\b/i;
const PRICE_SPOKEN_RE = /\$\s*\d{2,4}(?:\.\d{2})?\b|\b\d{2,4}(?:\.\d{2})?\s*(?:dollars?|bucks?|a\s+month|per\s+month|\/\s*mo(?:nth)?|a\s+quarter|per\s+quarter|a\s+year|per\s+year|one[- ]?time)\b|\b(?:quoted?|quote|total|price|pricing|cost|costs|charge|fee|rate|runs?|starts?\s+at|comes?\s+to)\s+(?:is\s+|would\s+be\s+|of\s+|at\s+|around\s+)?\$?\s*\d{2,4}(?:\.\d{2})?\b/i;
const DAY_CUE_RE = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next\s+week)\b/i;
const TIME_CUE_RE = /\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|morning|afternoon|noon|between\s+\d{1,2})\b/i;
const ACCESS_CUE_RE = /\b(?:gate|code|lockbox|dogs?|pets?|cats?|fence|backyard|hoa|guard|knock|ring|call\s+(?:before|when|ahead))\b/i;

function hasSpokenOrStoredAddress(ctx) {
  const { account, assistFacts, callerText } = ctx;
  if (assistFacts?.place_withdrawn) return false;
  if (account?.address_line1 && account?.zip) return true;
  if (assistFacts?.address_line1 && (assistFacts?.city || assistFacts?.zip)) return true;
  return SPOKEN_STREET_RE.test(callerText);
}

// Every caller-fact item requires stored account/assist facts or CALLER speech (never an unanswered staff question).
const CHECKLIST_RULES = Object.freeze([
  { key: 'name', label: 'Name', test: (c) => Boolean(c.customer?.name || c.account?.first_name || hasSpokenCallerName(c.callerText)) },
  { key: 'address', label: 'Address', test: hasSpokenOrStoredAddress },
  { key: 'email', label: 'Email', test: (c) => EMAIL_RE.test(String(c.account?.email || '')) || EMAIL_RE.test(c.callerText) || SPOKEN_EMAIL_RE.test(c.callerText) },
  { key: 'scope', label: 'Pest / Scope', test: (c) => Boolean(c.assist?.intent || c.assistFacts?.service || c.catalogPrices.length) },
  { key: 'price_quoted', label: 'Price Quoted', test: (c) => PRICE_SPOKEN_RE.test(c.staffText) },
  { key: 'time_preference', label: 'Time Preference', test: (c) => Boolean(c.assistFacts?.when) || (DAY_CUE_RE.test(c.callerText) && TIME_CUE_RE.test(c.callerText)) },
  { key: 'access_notes', label: 'Gate / Pet Notes', test: (c) => Boolean(c.prefs?.pets_secured_plan || c.prefs?.special_instructions || c.prefs?.chemical_sensitivities || ACCESS_CUE_RE.test(c.callerText)) },
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
    staffText: joinSpeakerLines(safeLines, (l) => l?.speaker === 'staff'),
    callerText: joinSpeakerLines(safeLines, (l) => l?.speaker !== 'staff'),
  };
  return CHECKLIST_RULES.map(({ key, label, test }) => ({ key, label, ok: Boolean(test(ctx)) }));
}

// Loads up to MAX_CALL_UTTERANCES chronological utterances when the preview
// slice may be truncated, so checklist/catalog evidence from earlier in a
// longer call does not disappear once it scrolls past the 15-line display cap.
async function loadEvidenceLines(callSid, previewLines, conn) {
  const fallback = Array.isArray(previewLines) ? previewLines : [];
  if (!callSid || fallback.length < 15) return fallback;
  const rows = await safeRead('call_utterances', () => conn('call_live_utterances')
    .where('call_sid', callSid)
    .orderBy([{ column: 'spoken_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(MAX_CALL_UTTERANCES)
    .select('speaker', 'text', 'spoken_at'), null);
  return Array.isArray(rows) && rows.length ? rows.reverse() : fallback;
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
    const emptyBundle = { account: null, properties: null, prefs: null, brief: null };
    const [bundle, catalogRows, evidenceLines] = await Promise.all([
      customerId ? loadCustomerBundle(customerId, callObj.id || null, conn, now) : Promise.resolve(emptyBundle),
      loadCachedCatalog(conn, now),
      loadEvidenceLines(callObj.twilio_call_sid || null, opts.lines, conn),
    ]);
    const intent = String(Object(opts.assist).intent || '');
    // Match catalog prices from CALLER speech and confirmed assist intent only (never staff screening questions).
    const callerSpeech = joinSpeakerLines(evidenceLines, (l) => l?.speaker !== 'staff');
    const serviceMatches = matchCatalogMatches(`${intent}\n${callerSpeech}`, catalogRows);
    const catalogPrices = serviceMatches.rows.map(({ row }) => formatCatalogPriceRow(row));
    const slotService = resolveSlotServiceContext(serviceMatches);
    const routeSlots = await resolveRouteSlots({
      account: bundle.account, properties: bundle.properties, assist: opts.assist, assistFacts, callerSpeech, slotService, now, deps: cfg,
    });
    const checklist = buildCallChecklist({
      customer: opts.customer, account: bundle.account, prefs: bundle.prefs, assist: opts.assist, assistFacts, lines: evidenceLines, catalogPrices,
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
    spokenLocationDiffers,
    hasSpokenCallerName,
    resolveSinglePropertyPin,
    formatPropertyNotes,
    slotsFromAssist,
    stripNegatedAndHistorical,
    CATALOG_CUES,
  },
};
