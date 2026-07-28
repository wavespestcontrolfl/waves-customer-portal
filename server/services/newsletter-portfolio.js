/**
 * Flagship portfolio selector (owner spec 2026-07-28).
 *
 * The weekly lineup is not the top-N scores — it is the strongest
 * PORTFOLIO: the best-scoring combination that also covers the weekend,
 * the map, and both audiences. Deterministic and pure: greedy pick by
 * effective score under per-venue/source/zone caps, then bounded repair
 * passes that trade the weakest non-load-bearing pick for the best
 * candidate that satisfies an unmet minimum.
 *
 * The editorial floor is absolute: no candidate below the feature floor
 * (event-scoring.js) is ever added — not to reach the target count, not
 * to satisfy a constraint. A thin week ships fewer events with the
 * shortfall reported, never padded (owner rule: "an event cannot become
 * publishable because the issue needs another card").
 *
 * Score provenance: editorial_score comes from the curation rubric.
 * Rows without one are either operator-starred (admin_status='featured'
 * — deliberate editorial override, treated as hero-grade) or manually
 * approved (treated as exactly floor-grade: trusted into the pool, but
 * never beats a scored event and never counts as the hero).
 *
 * Targets (spec): MIN 5 / TARGET 8 / MAX 10. Coverage minimums:
 *   ≥4 Fri–Sun events, ≥2 distinct weekend days, ≥3 zones,
 *   ≥2 family picks, ≥2 parents'-night picks, ≥1 free-ish pick,
 *   ≥1 hero (≥ hero floor), ≥1 inaugural/opening/limited/one-time.
 * Caps: ≤3 per zone, ≤2 per venue, ≤2 per source, ≤1 generic class.
 */

const { etParts } = require('../utils/datetime-et');
const { featureScoreFloor, heroScoreFloor } = require('./event-scoring');

const TARGET_COUNT = 8;
const MIN_COUNT = 5;
const MAX_COUNT = 10;
const ALTERNATE_COUNT = 2;

const ZONE_CAP = 3;
const VENUE_CAP = 2;
const SOURCE_CAP = 2;
const CLASS_CAP = 1;

const MIN_WEEKEND = 4;
const MIN_WEEKEND_DAYS = 2;
const MIN_ZONES = 3;
const MIN_FAMILY = 2;
const MIN_PARENTS = 2;
const MIN_FREE = 1;
const MIN_HERO = 1;
const MIN_NOVELTY = 1;

const NOVELTY_SET = new Set([
  'one_time', 'inaugural', 'opening_weekend', 'limited_engagement',
  'special_edition', 'series_debut', 'touring', 'annual_signature',
]);

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function breakdown(event) {
  const b = event?.score_breakdown;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return {}; } }
  return typeof b === 'object' ? b : {};
}

function tags(event) {
  const t = event?.audience_tags;
  let arr = t;
  if (typeof t === 'string') { try { arr = JSON.parse(t); } catch { arr = []; } }
  return new Set((Array.isArray(arr) ? arr : []).map((x) => String(x).toLowerCase()));
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** ET day-of-week (0=Sun … 6=Sat) for the event's start; null when undated. */
function etWeekday(event) {
  if (!event?.start_at) return null;
  const d = new Date(event.start_at);
  if (Number.isNaN(d.getTime())) return null;
  return etParts(d).dayOfWeek;
}

// Weekend = Friday(5), Saturday(6), Sunday(0) in ET.
const isWeekend = (event) => [5, 6, 0].includes(etWeekday(event));
// family_friendly may be null at ingestion while curation confirmed the
// fit — the persisted family_status is an equally valid signal.
const isFamily = (event) => event?.family_friendly === true
  || tags(event).has('family')
  || breakdown(event).family_status === 'confirmed';
const isParents = (event) => tags(event).has('parents_night')
  || breakdown(event).family_status === 'adults_lean';
const isFreeish = (event) => event?.is_free === true || /\bfree\b/i.test(String(event?.price_text || ''));
const isNovel = (event) => NOVELTY_SET.has(String(event?.novelty_type || ''));
const isGenericClass = (event) => (breakdown(event).penalty_flags || []).includes('generic_class');

/**
 * Effective score for ordering. Starred rows are hero-grade by operator
 * fiat; manually approved unscored rows sit exactly at the floor.
 */
function effectiveScore(event) {
  // A star is a deliberate operator override — it outranks the numeric
  // score. Checking the score first silently stripped hero-grade (or the
  // whole slot, for sub-floor scores) from starred-after-scoring events.
  if (event?.admin_status === 'featured') {
    const scored = Number(event?.editorial_score);
    return Math.max(heroScoreFloor(), Number.isFinite(scored) ? scored : 0);
  }
  const raw = event?.editorial_score;
  // Number(null) === 0 — an unscored row must fall through to provenance,
  // not read as a zero score.
  if (raw !== null && raw !== undefined && Number.isFinite(Number(raw))) return Number(raw);
  return featureScoreFloor();
}

const isHero = (event) => effectiveScore(event) >= heroScoreFloor();

function capsAllow(picked, candidate) {
  const zone = norm(candidate.region_zone || candidate.city);
  const venue = norm(candidate.venue_name);
  const source = String(candidate.source_id || '');
  let zoneCount = 0; let venueCount = 0; let sourceCount = 0; let classCount = 0;
  for (const p of picked) {
    if (zone && norm(p.region_zone || p.city) === zone) zoneCount += 1;
    if (venue && norm(p.venue_name) === venue) venueCount += 1;
    if (source && String(p.source_id || '') === source) sourceCount += 1;
    if (isGenericClass(p)) classCount += 1;
  }
  if (zone && zoneCount >= ZONE_CAP) return false;
  if (venue && venueCount >= VENUE_CAP) return false;
  if (source && sourceCount >= SOURCE_CAP) return false;
  if (isGenericClass(candidate) && classCount >= CLASS_CAP) return false;
  return true;
}

const zoneOf = (event) => norm(event?.region_zone || event?.city);

// Each constraint may define:
//   test(c)               — does one event satisfy it (default counting)
//   count(picked)         — set-valued minimums (distinct days/zones)
//   poolTest(c, picked)   — is a CANDIDATE useful for repair (defaults to test)
//   swapEligible(p, picked) — may this PICK be traded away during repair
//                             (defaults to !test(p))
const CONSTRAINTS = [
  { key: 'weekend', min: MIN_WEEKEND, test: isWeekend, label: `≥${MIN_WEEKEND} Fri–Sun events` },
  {
    key: 'weekend_days',
    min: MIN_WEEKEND_DAYS,
    count: (picked) => new Set(picked.filter(isWeekend).map(etWeekday)).size,
    test: isWeekend,
    // Only a candidate on a NOT-yet-covered weekend day helps.
    poolTest: (c, picked) => isWeekend(c)
      && !new Set(picked.filter(isWeekend).map(etWeekday)).has(etWeekday(c)),
    // A weekend pick on an ALREADY-DOUBLED day may be traded (the
    // weekend-count minimum survives because the incoming candidate is
    // itself a weekend event) — the default !test(p) barred every
    // weekend pick and made day repair impossible on a weekend-heavy
    // full lineup.
    swapEligible: (p, picked) => !isWeekend(p)
      || picked.filter((x) => isWeekend(x) && etWeekday(x) === etWeekday(p)).length > 1,
    label: `≥${MIN_WEEKEND_DAYS} distinct weekend days`,
  },
  {
    key: 'zones',
    min: MIN_ZONES,
    count: (picked) => new Set(picked.map(zoneOf).filter(Boolean)).size,
    test: () => true,
    // A candidate helps only when it BRINGS a new zone; a pick may be
    // traded when losing it doesn't shrink zone coverage (its zone is
    // redundant or missing) — with test:()=>true the default
    // !test(p) predicate could never swap anything on a full lineup.
    poolTest: (c, picked) => {
      const zone = zoneOf(c);
      return Boolean(zone) && !new Set(picked.map(zoneOf)).has(zone);
    },
    swapEligible: (p, picked) => {
      const zone = zoneOf(p);
      if (!zone) return true;
      return picked.filter((x) => zoneOf(x) === zone).length > 1;
    },
    label: `≥${MIN_ZONES} zones`,
  },
  { key: 'family', min: MIN_FAMILY, test: isFamily, label: `≥${MIN_FAMILY} family picks` },
  { key: 'parents', min: MIN_PARENTS, test: isParents, label: `≥${MIN_PARENTS} parents'-night picks` },
  { key: 'free', min: MIN_FREE, test: isFreeish, label: `≥${MIN_FREE} free/inexpensive pick` },
  { key: 'hero', min: MIN_HERO, test: isHero, label: `≥${MIN_HERO} hero-grade event` },
  { key: 'novelty', min: MIN_NOVELTY, test: isNovel, label: `≥${MIN_NOVELTY} inaugural/opening/limited/one-time` },
];

function constraintCount(constraint, picked) {
  return constraint.count ? constraint.count(picked) : picked.filter(constraint.test).length;
}

function unmetConstraints(picked) {
  return CONSTRAINTS.filter((c) => constraintCount(c, picked) < c.min);
}

/**
 * True when removing `event` from `picked` would break a currently-met
 * minimum — such an event is load-bearing and not swappable.
 */
function isLoadBearing(event, picked) {
  const without = picked.filter((p) => p !== event);
  const beforeUnmet = new Set(unmetConstraints(picked).map((c) => c.key));
  return unmetConstraints(without).some((c) => !beforeUnmet.has(c.key));
}

/**
 * Select the issue portfolio from scored, eligibility-filtered
 * candidates. Returns { selected, alternates, unmet, stats }.
 */
function selectPortfolio(candidates, {
  targetCount = TARGET_COUNT,
  minCount = MIN_COUNT,
  maxCount = MAX_COUNT,
  seeded = [],
} = {}) {
  const floor = featureScoreFloor();
  // Seeded events are OPERATOR picks: locked into the selection verbatim
  // (never swapped out, exempt from caps among themselves — operator
  // override), but they COUNT toward every cap when the selector adds
  // more, so a partial operator slate can't be supplemented into a
  // four-cards-one-venue issue.
  const seededRows = (Array.isArray(seeded) ? seeded : []).filter(Boolean);
  const seededIds = new Set(seededRows.map((r) => String(r.id)));
  const qualified = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && !seededIds.has(String(c.id)) && (effectiveScore(c) >= floor))
    .sort((a, b) => effectiveScore(b) - effectiveScore(a));

  // Greedy pass under caps, on top of the seeded base.
  const picked = [...seededRows];
  for (const c of qualified) {
    if (picked.length >= Math.max(targetCount, seededRows.length)) break;
    if (capsAllow(picked, c)) picked.push(c);
  }

  // Repair passes: satisfy each unmet minimum with the best remaining
  // qualified candidate — first by adding (room below maxCount), then by
  // swapping out the weakest non-load-bearing pick. Bounded: one pass
  // per constraint, never below the floor, caps always respected.
  for (const constraint of unmetConstraints(picked)) {
    let need = constraint.min - constraintCount(constraint, picked);
    if (need <= 0) continue;
    const poolTest = constraint.poolTest || ((c) => constraint.test(c));
    const swapEligible = constraint.swapEligible || ((p) => !constraint.test(p));
    const pool = qualified.filter((c) => !picked.includes(c));
    for (const candidate of pool) {
      if (need <= 0) break;
      if (!poolTest(candidate, picked)) continue;
      if (picked.length < maxCount && capsAllow(picked, candidate)) {
        picked.push(candidate);
        need = constraint.min - constraintCount(constraint, picked);
        continue;
      }
      // Swap: try EVERY tradeable pick, weakest first — the weakest pick
      // alone may not free the candidate's saturated venue/source/zone
      // cap even though trading a different pick would.
      const tradeable = [...picked]
        .sort((a, b) => effectiveScore(a) - effectiveScore(b))
        .filter((p) => !seededIds.has(String(p.id)) && swapEligible(p, picked) && !isLoadBearing(p, picked));
      for (const swappable of tradeable) {
        const trial = picked.filter((p) => p !== swappable);
        if (!capsAllow(trial, candidate)) continue;
        picked.length = 0;
        picked.push(...trial, candidate);
        break;
      }
      need = constraint.min - constraintCount(constraint, picked);
    }
  }

  // Seeded operator picks lead in their original order; the selector's
  // own picks follow by score.
  const selectorPicks = picked
    .filter((p) => !seededIds.has(String(p.id)))
    .sort((a, b) => effectiveScore(b) - effectiveScore(a));
  const selected = [...seededRows, ...selectorPicks];
  const selectedSet = new Set(selected);
  const alternates = qualified.filter((c) => !selectedSet.has(c)).slice(0, ALTERNATE_COUNT);
  const unmet = selected.length < minCount
    ? [{ key: 'min_count', label: `≥${minCount} events at or above the editorial floor` }, ...unmetConstraints(selected)]
    : unmetConstraints(selected);

  return {
    selected,
    alternates,
    unmet: unmet.map((c) => c.label),
    stats: {
      qualified: qualified.length,
      selectedCount: selected.length,
      weekendCount: selected.filter(isWeekend).length,
      weekendDays: [...new Set(selected.filter(isWeekend).map(etWeekday))].map((d) => DAY_NAMES[d]),
      zones: [...new Set(selected.map((p) => norm(p.region_zone || p.city)).filter(Boolean))],
      familyCount: selected.filter(isFamily).length,
      parentsCount: selected.filter(isParents).length,
      freeCount: selected.filter(isFreeish).length,
      heroCount: selected.filter(isHero).length,
      lowestSelectedScore: selected.length ? Math.min(...selected.map(effectiveScore)) : null,
    },
  };
}

/**
 * Rank alternates AGAINST the final resolved lineup: best floor-passing
 * candidates not already locked that are VALID one-for-one replacements —
 * substituting the alternate for at least one locked event must respect
 * every cap (a score-only ranking could suggest a third same-venue card).
 * Built after operator-preferred merging, so a preferred event capped out
 * of the selection can never appear as both locked and replacement.
 */
function rankAlternates(candidates, finalLineup, count = ALTERNATE_COUNT) {
  const floor = featureScoreFloor();
  const lineup = (Array.isArray(finalLineup) ? finalLineup : []).filter(Boolean);
  const locked = new Set(lineup.map((ev) => String(ev.id)));
  const replacesSomeone = (candidate) => lineup.some((out) => capsAllow(
    lineup.filter((ev) => ev !== out),
    candidate,
  ));
  return (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && !locked.has(String(c.id)) && effectiveScore(c) >= floor && replacesSomeone(c))
    .sort((a, b) => effectiveScore(b) - effectiveScore(a))
    .slice(0, count);
}

module.exports = {
  selectPortfolio,
  rankAlternates,
  effectiveScore,
  isWeekend,
  isFamily,
  isParents,
  isFreeish,
  isNovel,
  unmetConstraints,
  TARGET_COUNT,
  MIN_COUNT,
  MAX_COUNT,
};
