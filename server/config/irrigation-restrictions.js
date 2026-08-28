'use strict';

/**
 * CURRENT lawn-watering restriction policy — the legal ceiling the weekly
 * watering plan sits under (owner ruling 2026-08-28: restrictions are a hard
 * constraint ABOVE the irrigation model, never a clamp applied after it).
 *
 * Source of truth: IRRIGATION_RESTRICTION_POLICY (JSON) in the environment;
 * the checked-in DEFAULT is the SWFWMD Modified Phase III water-shortage
 * order as extended 2026-08-27 — one day per week through 2026-10-01 across
 * Manatee, Sarasota and covered portions of Charlotte.
 *
 * FAIL CLOSED: past `expiresOn` with no newer policy configured there is NO
 * policy — never a silent fallback to "2 days/week". Callers get null and
 * the plan reports itself unavailable (the email keeps its pre-plan copy).
 *
 * Shape: { maxDaysPerWeek, effectiveFrom (YYYY-MM-DD), expiresOn (YYYY-MM-DD,
 * inclusive), label, source, hoursNote }.
 */
const logger = require('../services/logger');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');

const DEFAULT_POLICY = Object.freeze({
  maxDaysPerWeek: 1,
  effectiveFrom: '2026-08-27',
  expiresOn: '2026-10-01',
  label: 'SWFWMD Modified Phase III water shortage order',
  source: 'https://www.swfwmd.state.fl.us/the-newsroom/2026/district-extends-modified-phase-iii-water-shortage',
  hoursNote: 'on your assigned day, during your area\'s allowed hours',
  // Jurisdiction. A policy applies only where its coverage can be
  // ESTABLISHED for the customer: counties listed here in full; a county in
  // `partial` (the order covers only portions of Charlotte) can't be
  // resolved from county alone and yields no policy (fail closed) until an
  // address-level lane exists.
  coverage: Object.freeze({ counties: ['Manatee', 'Sarasota'], partial: ['Charlotte'] }),
});

// Service-area cities → county, for customers whose turf profile carries no
// county. Only cities that sit wholly in one county; a city that straddles
// counties (e.g. Longboat Key, Englewood) is deliberately absent → unknown.
const CITY_COUNTY = Object.freeze({
  bradenton: 'Manatee', parrish: 'Manatee', palmetto: 'Manatee', ellenton: 'Manatee',
  'lakewood ranch': 'Manatee', 'anna maria': 'Manatee', 'holmes beach': 'Manatee',
  'bradenton beach': 'Manatee', myakka: 'Manatee', 'myakka city': 'Manatee',
  sarasota: 'Sarasota', venice: 'Sarasota', 'north port': 'Sarasota', nokomis: 'Sarasota',
  osprey: 'Sarasota', 'siesta key': 'Sarasota', 'laurel': 'Sarasota',
  'port charlotte': 'Charlotte', 'punta gorda': 'Charlotte', 'rotonda west': 'Charlotte',
});

/**
 * The county a customer's watering restriction is judged in: the turf
 * profile's county (same source the WaveGuard plan engine uses for
 * fertilizer ordinances), else a whole-county service city, else null
 * (coverage cannot be established).
 */
function resolveRestrictionCounty({ county = null, profileCity = null, city = null } = {}) {
  // Same stale-profile guard as waveguard-plan-engine getApplicableOrdinances:
  // the 1:1 turf profile describes the home it was written for, so when its
  // own city context DIVERGES from the customer's current city (moved
  // customer, stale profile) its county is dropped and the current city
  // decides — never the old property's order.
  const pCity = String(profileCity || '').trim().toLowerCase();
  const cCity = String(city || '').trim().toLowerCase();
  const cityCounty = CITY_COUNTY[cCity] || null;
  const norm = (v) => { const t = String(v || '').trim().replace(/\s+county$/i, ''); return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : ''; };
  const profileCounty = norm(county);
  const profileDiverges = !!pCity && !!cCity && pCity !== cCity;
  // A profile with NO city context can still be stale: when the customer's
  // current city maps to a different county, the current city wins.
  const countyConflicts = !!profileCounty && !!cityCounty && profileCounty !== cityCounty;
  if (profileCounty && !profileDiverges && !countyConflicts) return profileCounty;
  return cityCounty;
}

function coversCounty(policy, county) {
  const coverage = policy.coverage;
  if (!coverage) return true; // an env policy without coverage applies everywhere it is configured
  if (!county) return false;
  const norm = (v) => String(v || '').trim().toLowerCase();
  const inList = (list) => (Array.isArray(list) ? list : []).some((x) => norm(x) === norm(county));
  if (inList(coverage.partial)) return false;
  return inList(coverage.counties);
}

// { configured: false } when the variable is unset (default applies);
// { configured: true, policy: null } when it is set but unusable (FAIL
// CLOSED — an operator meant to override, so the default must not apply).
function parseEnvPolicy(raw) {
  if (!raw || !String(raw).trim()) return { configured: false, policy: null };
  try {
    const parsed = JSON.parse(raw);
    return { configured: true, policy: parsed && typeof parsed === 'object' ? parsed : null };
  } catch (err) {
    logger.error(`[irrigation-restrictions] IRRIGATION_RESTRICTION_POLICY is not valid JSON: ${err.message}`);
    return { configured: true, policy: null };
  }
}

function validPolicy(p) {
  if (!p) return false;
  const days = Number(p.maxDaysPerWeek);
  if (!Number.isInteger(days) || days < 0 || days > 7) return false;
  // Real calendar dates, not just the shape — a mistyped 2026-02-31 must not
  // keep legal guidance alive past its real expiry.
  if (!validCalendarDate(p.expiresOn)) return false;
  if (p.effectiveFrom != null && p.effectiveFrom !== '') {
    if (!validCalendarDate(p.effectiveFrom)) return false;
    if (String(p.effectiveFrom) > String(p.expiresOn)) return false;
  }
  return true;
}

/**
 * The policy in force on `now` (ET calendar date) FOR `county`, or null when
 * none is configured for that date or its coverage of the county cannot be
 * established.
 */
function currentRestrictionPolicy(now = new Date(), { env = process.env, county = null } = {}) {
  const today = etDateString(now);
  const envPolicy = parseEnvPolicy(env.IRRIGATION_RESTRICTION_POLICY);
  const candidate = envPolicy.configured ? envPolicy.policy : DEFAULT_POLICY;
  if (!validPolicy(candidate)) {
    logger.error('[irrigation-restrictions] restriction policy is malformed — weekly watering plan unavailable');
    return null;
  }
  if (!coversCounty(candidate, county)) return null;
  if (candidate.effectiveFrom && today < candidate.effectiveFrom) return null;
  if (today > candidate.expiresOn) {
    logger.error(`[irrigation-restrictions] restriction policy "${candidate.label}" expired ${candidate.expiresOn} — set IRRIGATION_RESTRICTION_POLICY; weekly watering plan unavailable until then`);
    return null;
  }
  return {
    maxDaysPerWeek: Number(candidate.maxDaysPerWeek),
    effectiveFrom: candidate.effectiveFrom || null,
    expiresOn: candidate.expiresOn,
    label: String(candidate.label || 'local watering restrictions'),
    source: candidate.source || null,
    hoursNote: candidate.hoursNote || null,
    county,
  };
}

module.exports = { currentRestrictionPolicy, resolveRestrictionCounty, DEFAULT_POLICY, _private: { validPolicy, parseEnvPolicy, coversCounty, CITY_COUNTY } };
