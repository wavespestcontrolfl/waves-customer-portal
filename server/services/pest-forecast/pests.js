/**
 * Florida household-pest seasonality model.
 *
 * Each pest carries a 12-month baseline pressure curve (Jan..Dec, 0–10)
 * calibrated to Central / Southwest Florida phenology, plus a deterministic
 * weather-adjustment function that nudges the baseline up or down based on
 * the live weekly weather signals resolved in weather.js.
 *
 * This is an INFORMATIONAL model — a transparent blend of documented FL pest
 * seasonality and local conditions, not a measurement or a guarantee. The
 * public forecast endpoint and the embeddable widget both consume it. Keep it
 * deterministic (no randomness, no DB) so the output is cacheable and the unit
 * tests stay stable.
 *
 * Baseline sources / rationale (Gulf-Coast FL):
 *   - Mosquitoes: peak in the warm wet season (Jun–Oct), rain-driven.
 *   - Ants (fire/ghost/white-footed): spring–fall, spike indoors after rain.
 *   - German roaches: indoor, elevated year-round, mild weather sensitivity.
 *   - Palmetto / American roaches: outdoor, driven indoors by heat + heavy rain.
 *   - Subterranean termites: spring swarm window (Mar–May), warm humid evenings.
 *   - Rodents: cool-season peak (Nov–Feb) as they seek shelter.
 *   - Fleas & ticks: warm humid months (Apr–Oct).
 *   - Wasps & stinging insects: colonies peak late summer (Aug–Oct).
 */

const clamp = (n, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => Math.round(n * 10) / 10;

// Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec
const PESTS = [
  {
    key: 'mosquitoes',
    label: 'Mosquitoes',
    emoji: '🦟',
    shortName: 'mosquitoes',
    category: 'biting',
    baseline: [2, 2, 3, 4, 5, 7, 8, 9, 8, 6, 4, 3],
    adjust(score, s) {
      if (s.wet) score += 2.0;
      else if (s.dry) score -= 1.5;
      if (s.hot) score += 1.0;
      else if (s.warm) score += 0.5;
      return score;
    },
    note(s, level) {
      if (s.wet) return 'Standing water from recent rain is fueling a new generation.';
      if (s.dry && (level === 'moderate' || level === 'low')) return 'Drier air is holding mosquito numbers down for now.';
      if (level === 'high' || level === 'elevated') return 'Warm, humid Florida weather keeps biting pressure up.';
      return 'Cooler conditions are keeping mosquito activity in check.';
    },
  },
  {
    key: 'ants',
    label: 'Ants',
    emoji: '🐜',
    shortName: 'ants',
    category: 'nuisance',
    baseline: [3, 3, 5, 6, 7, 7, 7, 7, 6, 5, 4, 3],
    adjust(score, s) {
      if (s.wet) score += 1.5;
      if (s.warm) score += 0.5;
      return score;
    },
    note(s, level) {
      if (s.wet) return 'Wet ground pushes ant colonies to forage indoors for dry shelter.';
      if (level === 'high' || level === 'elevated') return 'Warm weather has colonies foraging hard for food and water.';
      return 'Cooler weather slows ant foraging.';
    },
  },
  {
    key: 'german_roach',
    label: 'German Cockroaches',
    emoji: '🪳',
    shortName: 'German roaches',
    category: 'indoor',
    baseline: [5, 5, 5, 6, 6, 7, 7, 7, 6, 6, 5, 5],
    adjust(score, s) {
      if (s.warm) score += 0.5;
      if (s.wet) score += 0.3;
      return score;
    },
    note(s, _level) {
      if (s.warm) return 'Heat and humidity speed up indoor breeding cycles.';
      return 'German roaches stay active indoors year-round in Florida.';
    },
  },
  {
    key: 'palmetto_roach',
    label: 'Palmetto Bugs',
    emoji: '🪲',
    shortName: 'palmetto bugs',
    category: 'outdoor',
    baseline: [3, 3, 4, 5, 6, 7, 8, 8, 7, 5, 4, 3],
    adjust(score, s) {
      if (s.hot) score += 1.5;
      else if (s.warm) score += 0.7;
      if (s.wet) score += 1.0;
      return score;
    },
    note(s, level) {
      if (s.hot && s.wet) return 'Heat plus rain drives American roaches out of mulch and into homes.';
      if (s.hot) return 'High heat sends palmetto bugs looking for cool, damp indoor spots.';
      if (level === 'high' || level === 'elevated') return 'Warm Florida nights keep outdoor roaches on the move.';
      return 'Milder weather keeps palmetto bugs mostly outdoors.';
    },
  },
  {
    key: 'subterranean_termites',
    label: 'Subterranean Termites',
    emoji: '🪵',
    shortName: 'termite swarmers',
    category: 'wood-destroying',
    baseline: [1, 3, 6, 8, 7, 5, 3, 2, 2, 2, 1, 1],
    adjust(score, s) {
      // Swarm pressure only meaningfully moves during the spring window; scale
      // the weather nudge by how "in season" the baseline already is so a warm
      // rainy week in October doesn't fake a termite swarm.
      const seasonScale = score / 8;
      let nudge = 0;
      if (s.warm) nudge += 0.8;
      if (s.wet) nudge += 1.2;
      if (s.dry) nudge -= 0.5;
      return score + nudge * seasonScale;
    },
    note(s, level) {
      if ((level === 'high' || level === 'elevated') && s.wet) return 'Warm rains trigger evening swarms — peak time to spot winged termites.';
      if (level === 'high' || level === 'elevated') return 'Spring swarm season is underway across the Gulf Coast.';
      return 'Outside the spring swarm window, termite activity stays low and hidden.';
    },
  },
  {
    key: 'rodents',
    label: 'Rats & Mice',
    emoji: '🐀',
    shortName: 'rodents',
    category: 'rodent',
    baseline: [6, 5, 4, 3, 2, 2, 2, 2, 3, 4, 5, 6],
    adjust(score, s) {
      if (s.coolSnap) score += 2.0;
      if (s.dry) score += 0.5;
      if (s.hot) score -= 0.5;
      return score;
    },
    note(s, level) {
      if (s.coolSnap) return 'A cool snap sends rats and mice indoors hunting for warmth.';
      if (level === 'high' || level === 'elevated') return 'Cooler-season rodents are seeking shelter and food inside.';
      return 'Warm weather keeps rodents content outdoors for now.';
    },
  },
  {
    key: 'fleas_ticks',
    label: 'Fleas & Ticks',
    emoji: '🪰',
    shortName: 'fleas & ticks',
    category: 'biting',
    baseline: [3, 3, 4, 5, 6, 7, 7, 7, 6, 5, 4, 3],
    adjust(score, s) {
      if (s.warm) score += 1.0;
      if (s.wet) score += 0.5;
      if (s.coolSnap) score -= 1.0;
      return score;
    },
    note(s, level) {
      if (s.warm) return 'Warm, humid weather is prime breeding time for fleas and ticks.';
      if (level === 'low' || level === 'minimal') return 'Cooler air slows the flea and tick life cycle.';
      return 'Pets and yards stay at moderate flea and tick risk.';
    },
  },
  {
    key: 'wasps',
    label: 'Wasps & Stinging Insects',
    emoji: '🐝',
    shortName: 'wasps',
    category: 'stinging',
    baseline: [1, 1, 2, 3, 4, 5, 6, 7, 7, 6, 3, 2],
    adjust(score, s) {
      if (s.warm) score += 0.5;
      if (s.coolSnap) score -= 1.0;
      return score;
    },
    note(s, level) {
      if (level === 'high' || level === 'elevated') return 'Mature late-summer colonies make nests larger and more defensive.';
      if (s.coolSnap) return 'Cooling weather is shrinking wasp activity.';
      return 'Watch eaves and soffits as colonies build through the warm months.';
    },
  },
];

function levelFor(score) {
  if (score >= 8) return 'high';
  if (score >= 6) return 'elevated';
  if (score >= 4) return 'moderate';
  if (score >= 2) return 'low';
  return 'minimal';
}

function trendFor(adjusted, baseline) {
  const delta = adjusted - baseline;
  if (delta >= 0.75) return 'up';
  if (delta <= -0.75) return 'down';
  return 'flat';
}

/**
 * Score every pest for the given month (1–12) + resolved weather signals.
 * Returns an array sorted by score descending. Pure + deterministic.
 */
function scorePests(month, signals) {
  const idx = Math.max(0, Math.min(11, (month || 1) - 1));
  const rows = PESTS.map((pest) => {
    const baseline = pest.baseline[idx];
    const adjusted = clamp(pest.adjust(baseline, signals));
    // Derive the level from the same rounded integer the widget renders, so the
    // pill word and the "/10" number never disagree at a rounding boundary
    // (e.g. a precise 7.5 must not show as "Elevated 8/10").
    const score10 = Math.round(adjusted);
    const level = levelFor(score10);
    return {
      key: pest.key,
      label: pest.label,
      emoji: pest.emoji,
      shortName: pest.shortName,
      category: pest.category,
      score: round1(adjusted),
      score10,
      baseline,
      level,
      trend: trendFor(adjusted, baseline),
      note: pest.note(signals, level),
    };
  });
  rows.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return rows;
}

module.exports = { PESTS, scorePests, levelFor, trendFor, clamp, round1 };
