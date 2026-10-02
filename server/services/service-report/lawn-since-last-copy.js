/**
 * Lawn report "Since your last visit" copy (GATE_LAWN_SINCE_LAST).
 *
 * The customer render of the treatment memory (P12) and the progress engine
 * (P13): what the last visit applied, how the lawn has moved since, and which
 * of the topics that visit said it would watch are still on the list today.
 *
 * Selection, not writing (owner ruling 2026-10-01): every sentence here is a
 * fixed string picked by a closed key (a product kind, a metric and an engine
 * state, an overall direction, a watch topic). No model, no number, no date
 * and no timing word is ever composed; the visit date rides beside the lines
 * as data and the client prints it in the label. checkLawnModelCopy is the
 * second layer over the applied and progress lines: a line it rejects is left
 * out, so an edit to this table that breaks a guard removes the line instead
 * of publishing it.
 *
 * What it never says:
 *   - a state for an expectation row the owner has not approved,
 *   - anything for an 'unclear' item (photos that cannot support a comparison
 *     say nothing rather than a hedge),
 *   - a better / same / worse verdict on a watched topic: that comes only from
 *     a same-spot recheck record (owner ruling 2026-09-29), which nothing
 *     writes yet. "Still on our watch list" restates today's own finding.
 *
 * Pure: no I/O, no clock, no gate.
 */
const { checkLawnModelCopy } = require('./lawn-copy-guards');

const MAX_APPLIED_NOUNS = 3;
const MAX_METRIC_LINES = 2;

// What a product kind is called in the applied line. Keys are the closed set
// the memory freezes (lawn-visit-memory TAG_BY_KIND).
const APPLIED_NOUN = {
  herbicide: 'weed control',
  pre_emergent: 'weed prevention',
  fungicide: 'fungus protection',
  insecticide: 'insect control',
  fertilizer: 'fertilizer',
  supplement: 'color support',
  other: 'a lawn treatment',
};

const OVERALL_SENTENCE = {
  up: 'Your overall lawn score is up since then.',
  down: 'Your overall lawn score is down since then.',
  flat: 'Your overall lawn score is holding steady.',
};

// One sentence per metric and engine state (lawn-progress STATES, minus
// 'unclear', which says nothing).
const METRIC_SENTENCE = {
  weed_suppression: {
    improving: 'Weed control is ahead of schedule.',
    on_track: 'Weed control is on track.',
    holding_steady: 'Weed pressure is holding steady.',
    too_early: 'It is too early to judge the weed control.',
    behind: 'Weed control is behind where we expected.',
  },
  color_health: {
    improving: 'Color is ahead of schedule.',
    on_track: 'Color is on track.',
    holding_steady: 'Color is holding steady.',
    too_early: 'It is too early to judge the color response.',
    behind: 'Color is behind where we expected.',
    seasonal: 'The color change since then is mostly seasonal.',
  },
  turf_density: {
    improving: 'Thickness is ahead of schedule.',
    on_track: 'Thickness is on track.',
    holding_steady: 'Thickness is holding steady.',
    too_early: 'It is too early to judge thickness.',
    behind: 'Thickness is behind where we expected.',
  },
  stress_damage: {
    improving: 'Turf repair is ahead of schedule.',
    on_track: 'Turf repair is on track.',
    holding_steady: 'The stressed areas are holding steady.',
    too_early: 'It is too early to judge the turf repair.',
    behind: 'Turf repair is behind where we expected.',
  },
};

// Several applied rows can judge one metric on different windows. The metric
// gets ONE sentence, the least committal first: while any treatment's window
// is still open the metric is too early to call, and a positive word needs
// every row to agree.
const STATE_PRECEDENCE = ['too_early', 'seasonal', 'behind', 'holding_steady', 'on_track', 'improving'];
// Which metric sentences lead when more than MAX_METRIC_LINES qualify: what is
// unresolved first, then what worked.
const LINE_PRIORITY = ['behind', 'improving', 'on_track', 'too_early', 'holding_steady', 'seasonal'];
// The engine's state -> the copy guard's progress vocabulary (ITEM_PHRASES).
const GUARD_STATE = { improving: 'ahead', on_track: 'on_track', holding_steady: 'flat', too_early: 'too_early', behind: 'behind' };

// A prior check's key (lawn-visit-memory CHECK_CATEGORIES) as a watch topic.
const WATCH_TOPIC = {
  weeds: 'weeds',
  damage: 'stressed areas',
  mowing: 'mowing height',
  water: 'watering',
  coverage: 'sprinkler coverage',
};
// The watering banner owns these two topics whenever it is on the page (the
// lead's WATERING_WORDS rule, lawn-report-lead.js).
const BANNER_OWNED_TOPICS = new Set(['water', 'coverage']);
const WATCH_STATUSES = new Set(['watch', 'needs_attention']);

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function appliedLine(sinceLast) {
  const nouns = [];
  for (const product of Array.isArray(sinceLast?.applied) ? sinceLast.applied : []) {
    const noun = Object.prototype.hasOwnProperty.call(APPLIED_NOUN, product?.kind) ? APPLIED_NOUN[product.kind] : null;
    if (noun && !nouns.includes(noun)) nouns.push(noun);
  }
  // "a lawn treatment" beside a named treatment adds nothing.
  const named = nouns.filter((noun) => noun !== APPLIED_NOUN.other);
  const list = (named.length ? named : nouns).slice(0, MAX_APPLIED_NOUNS);
  return list.length ? `Last visit we applied ${joinList(list)}.` : null;
}

function overallLine(progress) {
  const direction = progress?.overall?.direction;
  return Object.prototype.hasOwnProperty.call(OVERALL_SENTENCE, direction)
    ? { text: OVERALL_SENTENCE[direction], direction, states: direction === 'flat' ? ['flat'] : [] }
    : null;
}

function metricLines(progress) {
  const byMetric = new Map();
  for (const item of Array.isArray(progress?.items) ? progress.items : []) {
    if (!item || item.kind !== 'applied' || item.approved !== true) continue;
    if (!Object.prototype.hasOwnProperty.call(METRIC_SENTENCE, item.metric)) continue;
    if (!STATE_PRECEDENCE.includes(item.state)) continue;
    const held = byMetric.get(item.metric);
    if (held == null || STATE_PRECEDENCE.indexOf(item.state) < STATE_PRECEDENCE.indexOf(held)) byMetric.set(item.metric, item.state);
  }
  return [...byMetric.entries()]
    .map(([metric, state]) => ({ text: METRIC_SENTENCE[metric][state] || null, state }))
    .filter((line) => line.text)
    .sort((a, b) => LINE_PRIORITY.indexOf(a.state) - LINE_PRIORITY.indexOf(b.state))
    .slice(0, MAX_METRIC_LINES);
}

function watchLine(sinceLast, insights, bannerPresent) {
  const today = new Set((Array.isArray(insights) ? insights : [])
    .filter((card) => card && WATCH_STATUSES.has(card.status))
    .map((card) => card.category));
  const topics = [];
  for (const check of Array.isArray(sinceLast?.checks) ? sinceLast.checks : []) {
    const key = check?.key;
    if (!Object.prototype.hasOwnProperty.call(WATCH_TOPIC, key) || !today.has(key)) continue;
    if (bannerPresent && BANNER_OWNED_TOPICS.has(key)) continue;
    if (!topics.includes(WATCH_TOPIC[key])) topics.push(WATCH_TOPIC[key]);
  }
  return topics.length ? `Still on our watch list: ${joinList(topics)}.` : null;
}

/**
 * @param {object} input
 * @param {object|null} input.sinceLast reportV2.sinceLast (P12): { priorDate, applied[], checks[] }
 * @param {object|null} [input.progress] buildLawnProgress's block (P13), or null
 * @param {object[]} [input.insights] this visit's insight cards (category, status)
 * @param {boolean} [input.bannerPresent] the watering banner carries lines
 * @returns {{ priorDate: string, lines: string[] }|null} null when there is nothing to say
 */
function buildSinceLastCopy({ sinceLast, progress = null, insights = [], bannerPresent = false } = {}) {
  if (!sinceLast || typeof sinceLast !== 'object') return null;
  const priorDate = /^\d{4}-\d{2}-\d{2}$/.test(String(sinceLast.priorDate || '')) ? sinceLast.priorDate : null;
  if (!priorDate) return null;

  // Progress is spoken only for the visit the memory came from and only when
  // the engine compared the two visits at all.
  const judged = progress && progress.eligible === true ? progress : null;
  const overall = overallLine(judged);
  const metrics = metricLines(judged);
  const facts = {
    progress: overall ? overall.direction : 'unknown',
    progressStates: [...(overall ? overall.states : []), ...metrics.map((line) => GUARD_STATE[line.state]).filter(Boolean)],
  };
  const guarded = [appliedLine(sinceLast), overall && overall.text, ...metrics.map((line) => line.text)]
    .filter(Boolean)
    .filter((text) => checkLawnModelCopy(text, facts).ok);

  const watch = watchLine(sinceLast, insights, bannerPresent);
  const lines = watch ? [...guarded, watch] : guarded;
  return lines.length ? { priorDate, lines } : null;
}

module.exports = {
  buildSinceLastCopy,
  APPLIED_NOUN,
  OVERALL_SENTENCE,
  METRIC_SENTENCE,
  WATCH_TOPIC,
  GUARD_STATE,
};
