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

// The customer's two flags. The turf profile is one row per customer. No
// customer, no profile, or a read error: no flags (the fixed paragraph still
// prints, because it is true of every lawn estimate).
async function loadLawnLimitFlags(customerId, knex = db) {
  if (!customerId) return { otherGrasses: [], virusStreaksSuspected: false };
  try {
    const row = await knex('customer_turf_profiles')
      .where({ customer_id: customerId })
      .first('other_grasses', 'virus_streaks_suspected');
    return {
      otherGrasses: normalizeOtherGrasses(row?.other_grasses),
      virusStreaksSuspected: row?.virus_streaks_suspected === true,
    };
  } catch (err) {
    logger.warn?.(`[estimate-lawn-limits] flag read failed for customer ${customerId}: ${err.message}`);
    return { otherGrasses: [], virusStreaksSuspected: false };
  }
}

// The block for one estimate row, or null: gate off, or not a recurring lawn
// estimate. Every surface (the /data payload and both PDF paths) calls this.
async function lawnLimitsForEstimate(estimate, { knex = db } = {}) {
  if (featureGates.estimateLawnLimitsLive?.() !== true) return null;
  if (!estimate || !estimateHasRecurringLawn(estimate)) return null;
  return buildLawnLimits(await loadLawnLimitFlags(estimate.customer_id, knex));
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
  lawnLimitsForEstimate,
  lawnLimitsBlock,
};
