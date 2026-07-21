/**
 * Visit context for AI-generated customer copy (owner directive 2026-07-21):
 * season, live weather, and what-to-expect guidance feed every recap/draft
 * prompt so the copy sets accurate expectations. Context ONLY — the prompt
 * rules still govern the output (no product names, no guarantees), and the
 * weather lookup is the BOUNDED variant so a draft never waits on NWS.
 */
const db = require('../models/db');
const { getDailyRainOutlookBounded } = require('./weather-forecast');

// Mirrors admin-inventory's serviceLineForType (keyword map, pest fallback).
function serviceLineForType(serviceType) {
  const value = String(serviceType || '').toLowerCase();
  if (value.includes('termite') || value.includes('bora-care') || value.includes('bora care') || value.includes('termidor')) return 'termite';
  if (value.includes('mosquito')) return 'mosquito';
  if (value.includes('rodent') || value.includes('rat') || value.includes('mouse') || value.includes('mice')) return 'rodent';
  if (value.includes('lawn')) return 'lawn';
  if (value.includes('tree') || value.includes('shrub') || value.includes('palm')) return 'tree_shrub';
  return 'pest';
}

// Southwest Florida seasonal framing — deterministic, ET month.
function seasonNote(month) {
  if (month >= 6 && month <= 9) {
    return 'Wet season in Southwest Florida: daily heat, humidity, and afternoon storms. Peak pressure months for lawn insects, fungus, weeds, ants, and mosquitoes; rain can wash in new activity between visits.';
  }
  if (month >= 10 && month <= 11) {
    return 'Transition into the Southwest Florida dry season: cooling temperatures and less rain. Turf and plant growth slows; pests increasingly move toward structures and moisture sources.';
  }
  if (month === 12 || month <= 2) {
    return 'Dry season in Southwest Florida: cooler and dry. Slower turf/plant growth is normal (some browning is dormancy, not damage); occasional cold snaps stress tropical plants; indoor and rodent pressure rises.';
  }
  return 'Spring warm-up in Southwest Florida: new growth flush, rising insect activity, and dry conditions before the summer rains — irrigation and drought stress matter this time of year.';
}

// What the customer should expect after this line's visit — guidance the AI
// turns into one plain-language expectation sentence.
const LINE_EXPECTATIONS = {
  pest: 'After a pest treatment it is normal to see SOME activity for up to two weeks as the treatment flushes pests out — this fades as the products keep working. Staying on schedule maintains the barrier.',
  lawn: 'Lawn results build gradually — visible improvement typically takes a few weeks and depends on mowing height, irrigation, and weather. Recently treated areas should be watered per the visit guidance.',
  mosquito: 'Mosquito reduction builds over the first 24-48 hours and knocks the population down rather than removing every mosquito; heavy rain and standing water bring new pressure between visits.',
  tree_shrub: 'Trees and shrubs respond gradually — expect visible improvement over weeks, with new growth as the main sign of recovery. Existing damaged foliage does not repair itself; new leaves come in healthy.',
  termite: 'Termite protection works in the background — monitoring and bait/treatment zones keep working between visits, and there is usually nothing visible day to day.',
  rodent: 'Rodent control is a process of exclusion, monitoring, and captures over multiple visits — activity typically declines over the first weeks as entry points and attractants are addressed.',
};

/**
 * Build the prompt context block. Weather is best-effort (bounded lookup on
 * the customer's geocode); season and expectations are always present.
 * Returns '' only on unexpected failure — callers append it verbatim.
 */
async function buildRecapVisitContext({ serviceType, customerId, knex = db } = {}) {
  try {
    const line = serviceLineForType(serviceType);
    const now = new Date();
    const month = Number(now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'America/New_York' }));
    const lines = [
      `Season: ${seasonNote(month)}`,
      `What to expect for this service line: ${LINE_EXPECTATIONS[line] || LINE_EXPECTATIONS.pest}`,
    ];
    if (customerId) {
      try {
        const customer = await knex('customers')
          .where({ id: customerId })
          .first('latitude', 'longitude');
        if (customer?.latitude != null && customer?.longitude != null) {
          const outlook = await getDailyRainOutlookBounded(customer.latitude, customer.longitude, { deadlineMs: 900 });
          const todayEt = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          const today = outlook?.[todayEt];
          if (today && (today.shortForecast || today.rainChance != null)) {
            const parts = [
              today.shortForecast,
              today.rainChance != null ? `${today.rainChance}% chance of rain` : '',
            ].filter(Boolean);
            lines.push(`Local weather today: ${parts.join(', ')}.`);
          }
        }
      } catch { /* weather is decorative — never block the draft */ }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

module.exports = { buildRecapVisitContext, seasonNote, serviceLineForType, LINE_EXPECTATIONS };
