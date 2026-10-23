'use strict';

// ============================================================
// estimate-lawn-limits.js — the "What we can and can't fix" block on a
// recurring lawn estimate (GATE_ESTIMATE_LAWN_LIMITS, owner 2026-10-22).
//
// One fixed paragraph on every lawn estimate, plus one line for each flag the
// office set on the customer's turf profile (other_grasses,
// virus_streaks_suspected). The wording is the owner's, word for word. It is
// the ONE copy for every surface: the /data payload (`lawnLimits`) that the
// estimate page and the browser-rendered PDF read, and the pdfkit fallback PDF.
//
// No prices and no send logic here: the block is copy only.
// ============================================================

const featureGates = require('../config/feature-gates');
const db = require('../models/db');
const logger = require('./logger');

const OTHER_GRASSES = Object.freeze(['carpetgrass', 'bahiagrass', 'bermudagrass', 'torpedograss', 'dallisgrass']);

const HEADING = "What we can and can't fix";

const ALWAYS_TEXT = "Our program clears most broadleaf weeds, sedge and dollarweed out of St. Augustine. A few grassy weeds are different: torpedograss, dallisgrass and bermudagrass have no spray that takes them out without hurting St. Augustine too. If we see them, we'll tell you, and we can spot-kill and replug those areas or add our bermuda removal service.";

const spotKillAndReplug = (name) => `We saw ${name} in your lawn. It won't respond to our regular program, so spot-kill and replug is the fix for those areas.`;

const GRASS_TEXT = Object.freeze({
  carpetgrass: "Part of your lawn is carpetgrass. It looks a lot like St. Augustine, but our weed product kills it, so we'll keep it off those patches and talk with you about replugging them.",
  bahiagrass: "We saw bahiagrass mixed into your St. Augustine. There's no spray that removes it on its own, so spot-kill and replug is the fix.",
  bermudagrass: 'Bermudagrass is creeping into your St. Augustine. Our bermuda removal service holds it back over the season; nothing clears it in one visit.',
  torpedograss: spotKillAndReplug('torpedograss'),
  dallisgrass: spotKillAndReplug('dallisgrass'),
});

const VIRUS_TEXT = "Some of your Floratam has yellow streaks that look like a virus that affects this grass. No treatment cures it. If it spreads, replanting with Palmetto or CitraBlue St. Augustine is the lasting fix, and we'll help you plan it.";

// Tech sheet warning (Fast Complete): shown on a Celsius WG row when the turf
// profile lists carpetgrass.
const CARPETGRASS_CELSIUS_WARNING = 'Carpetgrass on this lawn: Celsius kills it. Spot only, off the carpetgrass.';

// The stored list as a clean, ordered, de-duplicated array of known names.
// Unknown names are dropped (the route validator refuses them on write; this
// guards a hand-edited row).
function normalizeOtherGrasses(value) {
  const list = Array.isArray(value) ? value : [];
  return OTHER_GRASSES.filter((name) => list.includes(name));
}

// The block for a set of flags, or the always-paragraph alone.
// `paragraphs` is [{ key, text }]: key 'always', a grass name, or 'virus_streaks'.
function buildLawnLimits({ otherGrasses = [], virusStreaksSuspected = false } = {}) {
  const paragraphs = [{ key: 'always', text: ALWAYS_TEXT }];
  for (const name of normalizeOtherGrasses(otherGrasses)) paragraphs.push({ key: name, text: GRASS_TEXT[name] });
  if (virusStreaksSuspected === true) paragraphs.push({ key: 'virus_streaks', text: VIRUS_TEXT });
  return { heading: HEADING, paragraphs };
}

// Whether an estimate row quotes recurring lawn service. Uses the same reader
// the lawn guide packet uses (estimate-public's recurringServicesWithSupplements
// and recurringServiceKey), so this block and the packet agree on "a lawn
// estimate". Lazy require: estimate-public is a large module that requires many
// services. Never throws: a malformed row is "not a lawn estimate".
function estimateHasRecurringLawn(estimate) {
  try {
    const pub = require('../routes/estimate-public');
    const estData = pub.parseEstimateDataSafe(estimate);
    const estResult = estData?.result || estData?.engineResult || estData || {};
    return pub.recurringServicesWithSupplements(estResult).some((svc) => pub.recurringServiceKey(svc) === 'lawn_care');
  } catch (err) {
    logger.warn?.(`[estimate-lawn-limits] lawn detection failed: ${err.message}`);
    return false;
  }
}

// Grasses the fixed paragraph is NOT true for: it talks about clearing weeds "out of St.
// Augustine", so a lawn recorded as one of these gets no block at all. An unknown, blank
// or unrecognised grass keeps the block (nearly every lawn is St. Augustine). 'mixed' is
// a recorded answer that is not St. Augustine, so it counts as not St. Augustine.
const NOT_ST_AUGUSTINE = Object.freeze(new Set(['bermuda', 'zoysia', 'bahia', 'mixed']));

const NO_FLAGS = Object.freeze({ otherGrasses: [], virusStreaksSuspected: false, grassKey: null });

// Does the customer-level turf profile speak for THIS property? customer_turf_profiles has no
// property column (one row per customer), and the repo already treats it as the customer's
// only active property, else the primary one (lawn-bermuda-removal profilePropertyScope: the
// same rule the bermuda removal switch uses). So the profile applies only when the estimate's
// or visit's property IS that property, or names none and the customer has one property. A
// customer with several properties and no named property, a different property, or a failed
// read: it does not apply (fail closed). A customer with no active property rows at all and no
// named property is a legacy single home, so it applies.
async function profileAppliesToProperty(knex, customerId, propertyId) {
  const scope = await require('./lawn-bermuda-removal').profilePropertyScope(knex, customerId, propertyId || null, false);
  return scope.ok === true || (scope.count === 0 && !propertyId);
}

// The grass the lawn is recorded as, as a lawn-grass-context key (st_augustine, bermuda,
// zoysia, bahia, mixed, unknown) or null: the profile's grass, then its track, then the
// customer's legacy lawn text.
async function recordedGrassKey(knex, customerId, profile) {
  const { normalizeGrassType } = require('./lawn-grass-context');
  const fromProfile = normalizeGrassType(profile?.grass_type) || normalizeGrassType(profile?.track_key);
  if (fromProfile) return fromProfile;
  try {
    const customer = await knex('customers').where({ id: customerId }).first('lawn_type');
    return normalizeGrassType(customer?.lawn_type);
  } catch (err) {
    logger.warn?.(`[estimate-lawn-limits] lawn type read failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// The flags and the recorded grass for one property of one customer. Only the ACTIVE turf
// profile counts (the canonical loader's scope: active, or the legacy NULL), and only when it
// speaks for `propertyId`. No customer, no profile, an inactive profile, another property's
// profile or a read error: no flags and an unknown grass, so the fixed paragraph still prints
// (it is true of every St. Augustine lawn estimate) and no flag line or warning does.
async function loadLawnLimitFlags(customerId, propertyId = null, knex = db) {
  if (!customerId) return NO_FLAGS;
  try {
    if (!(await profileAppliesToProperty(knex, customerId, propertyId))) return NO_FLAGS;
    const found = await require('./customer-pricing-ai').loadTurfProfile(knex, customerId);
    // The loader answers [] on a failed read; only a row is a profile.
    const profile = found && !Array.isArray(found) && typeof found === 'object' ? found : null;
    return {
      otherGrasses: normalizeOtherGrasses(profile?.other_grasses),
      virusStreaksSuspected: profile?.virus_streaks_suspected === true,
      grassKey: await recordedGrassKey(knex, customerId, profile),
    };
  } catch (err) {
    logger.warn?.(`[estimate-lawn-limits] flag read failed for customer ${customerId}: ${err.message}`);
    return NO_FLAGS;
  }
}

// The block for one estimate row, or null: gate off, not a recurring lawn estimate, or a lawn
// recorded as a grass other than St. Augustine. Every surface (the /data payload and every
// PDF path) calls this. The estimate's own property decides which property's profile counts.
async function lawnLimitsForEstimate(estimate, { knex = db } = {}) {
  if (featureGates.estimateLawnLimitsLive?.() !== true) return null;
  if (!estimate || !estimateHasRecurringLawn(estimate)) return null;
  const flags = await loadLawnLimitFlags(estimate.customer_id, estimate.property_id, knex);
  if (NOT_ST_AUGUSTINE.has(flags.grassKey)) return null;
  return buildLawnLimits(flags);
}

// The /data payload fragment: `{ lawnLimits }` or nothing, so a gate-off or
// non-lawn response is byte-identical to before.
async function lawnLimitsBlock(estimate, opts) {
  const lawnLimits = await lawnLimitsForEstimate(estimate, opts);
  return lawnLimits ? { lawnLimits } : {};
}

module.exports = {
  OTHER_GRASSES,
  HEADING,
  ALWAYS_TEXT,
  GRASS_TEXT,
  VIRUS_TEXT,
  CARPETGRASS_CELSIUS_WARNING,
  normalizeOtherGrasses,
  buildLawnLimits,
  estimateHasRecurringLawn,
  loadLawnLimitFlags,
  profileAppliesToProperty,
  NOT_ST_AUGUSTINE,
  lawnLimitsForEstimate,
  lawnLimitsBlock,
};
