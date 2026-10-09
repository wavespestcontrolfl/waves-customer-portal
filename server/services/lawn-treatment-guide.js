/**
 * The "Suggested from this lawn" cards of the lawn Fast Complete sheet (GATE_LAWN_TREATMENT_GUIDE,
 * owner 2026-10-08). After the technician confirms the lawn assessment, one card per photo
 * finding: the finding line, the check to do first (when one applies), the product and one tap.
 * The rules are the fixed table below: no model call, no new AI read. The technician taps every
 * product; nothing is added by itself.
 *
 *   weeds         weed coverage 10% or more AND the Weed spots entry (lawn-weed-mix.js) is offerable
 *   fungus        worst fungal activity minor or worse AND the month's add-ons hold a fungicide row;
 *                 for take-all (mapped areas) the card is the check only, until a trouble area is on file
 *   chinch        insect damage moderate or severe, April through September; one look at the
 *                 sunny edge of the damage, not a count (owner 2026-10-08); Arena 50 WDG, the
 *                 bifenthrin product when Arena is at its yearly cap (also a standing sheet entry
 *                 every month, so a find in any month is treated)
 *   caterpillars  insect damage moderate or severe AND the month's add-ons hold the caterpillar row
 *   dry spots     drought stress minor or worse AND the month's add-ons hold the wetting agent row
 *
 * Products are found by what the v13 program's staged rows say about them (their role and their
 * gates.trigger), never by a name typed here. A product at its yearly cap or otherwise blocked is
 * never suggested; the chinch order is the program's own: Arena, then bifenthrin.
 *
 * Reads only. The cards ride the tech sheet's treatment-guide route; the completion freezes which
 * cards showed and what the technician did (treatmentGuideFreeze). No customer or public payload.
 */
const logger = require('./logger');
const { worstSeverity } = require('./lawn-photo-merge');

const KINDS = Object.freeze(['weeds', 'fungus', 'chinch', 'caterpillars', 'dry_spots']);
const SEVERITY_RANK = Object.freeze({ none: 0, minor: 1, moderate: 2, severe: 3 });

const WEED_MIN_PERCENT = 10;
const CHINCH_FIRST_MONTH = 4;
const CHINCH_LAST_MONTH = 9;

// What the v13 staged rows call each add-on (migration 20261005120000): the fungicides carry the
// role, the others the gates.trigger. The chinch order is the program's own text: Arena, then
// bifenthrin.
const FUNGICIDE_ROLE = 'fungicide_spot';
const CATERPILLAR_TRIGGER = 'caterpillars';
const DRY_SPOT_TRIGGER = 'dry_spots';
// One entry per rung, in order. The second rung's staged row was renamed by 20261007180000 (it also
// covers mole cricket nymphs now); a protocol version staged before that still holds the old value.
const CHINCH_RUNGS = Object.freeze([
  Object.freeze(['chinch_20_to_25_per_sqft']),
  Object.freeze(['chinch_second_product_caterpillars_or_mole_cricket_nymphs', 'chinch_second_product_or_caterpillars']),
]);
const CHINCH_TRIGGERS = Object.freeze(CHINCH_RUNGS.flat());
// application-limits' type for the yearly application count (checkLimits).
const YEARLY_CAP = 'annual_max_apps';

const CHECKS = Object.freeze({
  fungus: 'Check first: look at the blades and the edge of the patch.',
  chinch: 'Check first: part the grass at the sunny edge of the damaged patch. Do a float test only if you are unsure.',
  caterpillars: 'Check first: soap flush to bring them to the surface.',
});
// Take-all is treated on known trouble areas only (owner 2026-10-08). The month's take-all fungicide
// row (gates.trigger mapped_take_all_*, or a protocol line about mapped take-all) shows the check
// and no product until a trouble area is on file for the lawn.
const TAKE_ALL_TRIGGER = /^mapped_take_all/;
const TAKE_ALL_LINE = /mapped take-all/i;
const TAKE_ALL_KIND = 'take_all';
const TAKE_ALL_NOTE = 'Take-all is treated on known trouble areas only. None is on file for this lawn.';
// "Blocked" means the read found a limit or hold that forbids the product. When the limit read itself
// failed the product is only UNREADABLE: its entry or card offers nothing (we cannot vouch for it),
// but it is released to the search (and, for a pick, the generic list), because the sheet has no Full
// form control: hiding it would leave no way to record a real application. Completion records the
// visit and flags it to the office ("product limits could not be checked"). One wording, everywhere.
const UNREADABLE_NOTE = 'The limits could not be checked. Use Search products for what you applied; the office will review it.';
const CHINCH_LIMIT_REACHED = 'The yearly limit is reached for the chinch bug products on this lawn.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortName = (name) => String(name || '').trim().split(/\s+/)[0] || String(name || '');
const idOf = (value) => String(value);

// ── what the assessment stored ──────────────────────────────────────────────

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}
const levelOf = (value) => (typeof value === 'string' && Object.hasOwn(SEVERITY_RANK, value) ? value : null);
const numberOrNull = (value) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
const atLeast = (level, minimum) => level !== null && SEVERITY_RANK[level] >= SEVERITY_RANK[minimum];

/**
 * The finding signals of a confirmed assessment: `{ weedCoverage, fungus, insect, drought }`
 * (a percent, then none | minor | moderate | severe, each null when unknown). Two stores hold them:
 *   - a run-backed assessment (GATE_LAWN_VISIT_ASSESSMENT): the run's `severities` (one read over
 *     every photo) and its raw weed score;
 *   - a legacy assessment: the per-photo model reads kept in claude_raw / gemini_raw, of which the
 *     WORST level across photos counts, the same worst-stressor rule the photo merge uses for
 *     worst_fungal_activity (a trouble-spot photo must survive).
 * Weed coverage is the confirmed score column (the technician may have edited it): 100 minus the
 * stored weed suppression, else the run's raw coverage. Drought stress is the composite's own
 * field, else the same severities. A level the model could not determine ('unknown') is no signal.
 * `assessment` is the lawn_assessments row, `run` its lawn_assessment_runs row or null. Pure.
 */
function signalsFromAssessment(assessment, run = null) {
  const composite = parseJson(assessment?.composite_scores);
  const severities = parseJson(run?.severities);
  const worstRead = worstReader(assessment);
  return {
    weedCoverage: weedCoverageOf(assessment, composite, parseJson(run?.scores_raw)),
    fungus: levelOf(severities?.fungal_activity?.level) ?? worstRead('fungal_activity'),
    insect: levelOf(severities?.insect_damage?.level) ?? worstRead('insect_damage'),
    drought: levelOf(composite?.drought_stress) ?? levelOf(severities?.drought_stress?.level) ?? worstRead('drought_stress'),
  };
}

// The weed score the technician confirmed: 100 minus the stored suppression, else the run's raw coverage.
function weedCoverageOf(assessment, composite, rawScores) {
  const suppression = numberOrNull(assessment?.weed_suppression) ?? numberOrNull(composite?.weed_suppression);
  return suppression !== null ? Math.max(0, Math.min(100, 100 - suppression)) : numberOrNull(rawScores?.weed_coverage);
}

// A legacy assessment's worst level of one field across every per-photo model read.
function worstReader(assessment) {
  const perPhoto = ['claude_raw', 'gemini_raw'].flatMap((column) => {
    const reads = parseJson(assessment?.[column]);
    return Array.isArray(reads) ? reads.filter((read) => read && typeof read === 'object') : [];
  });
  return (field) => levelOf(worstSeverity(perPhoto.map((read) => read[field]), null));
}

// ── the month's add-ons ─────────────────────────────────────────────────────

// The staged row an add-on stands on: the protocol's own product (a visit's substitute keeps its
// original's row, as the completion defaults read it).
const stagedRowOf = (rows, raw) => rows.get(idOf(raw?.substitution?.originalProductId || raw?.product?.id)) || null;
const heldByCity = (raw) => raw?.unavailable?.kind === 'city_hold';

/**
 * The add-ons the guide may suggest, from the month's candidates (`{ raw, item }`: the plan's add-on
 * and the sheet-shaped copy of it) and the staged program rows (a Map by product id, in the
 * protocol's own order): `{ fungus, caterpillars, dry_spots }`, each `{ item }` or null. The FIRST
 * fungicide in program order is the suggestion; a product that is at a limit, whose limit could not
 * be read, or that the city holds is never suggested (no card, not a fall-through to the next).
 */
async function addOnOffers({ candidates, rows, svc, knex, places = null }) {
  const picks = Object.entries(pickAddOns(candidates, rows)).filter(([, candidate]) => candidate);
  // A take-all row the pick passed over (October's Headway row follows the large patch row) is governed
  // all the same: its limit is read so a forbidden one stays out of the search, and it has no offer.
  const picked = new Set(picks.map(([, candidate]) => idOf(candidate.raw.product.id)));
  const chosen = [...picks, ...takeAllAddOns(candidates, rows).filter((c) => !picked.has(idOf(c.raw.product.id))).map((c) => [TAKE_ALL_KIND, c])];
  // `blocked`: the picks a limit or a city hold that was READ forbids. `unreadable`: the picks whose
  // limit read failed (nothing is offered for them, and they are not forbidden). A pick that merely
  // has no finding is neither.
  const offers = { fungus: null, caterpillars: null, dry_spots: null, blocked: [], unreadable: [] };
  if (!chosen.length) return offers;
  const wide = await readCaps({ products: chosen.map(([, c]) => c.raw.product), rows, svc, knex });
  if (!wide) return { ...offers, unreadable: chosen.map(([, c]) => idOf(c.raw.product.id)) };
  // GATE_LAWN_TROUBLE_AREAS: what this read found closed at each place, `{ [productId]: { [place]: message } }` for every product it
  // read (an empty entry = open at every place), in the shape of the context's troubleAreas.blocked: the sheet prefers it once the
  // answer settles, so a limit that changed since the sheet opened is never judged by the older map.
  const placeBlocked = places?.length ? Object.fromEntries(chosen.map(([, c]) => [idOf(c.raw.product.id), {}])) : null;
  const capped = places?.length ? await openSomewhere({ chosen, wide, rows, svc, knex, places, placeBlocked }) : wide;
  for (const [kind, candidate] of chosen) {
    const id = idOf(candidate.raw.product.id);
    if (kind !== TAKE_ALL_KIND) offers[kind] = offerFor(kind, candidate, { capped, rows });
    if (isBlocked(candidate, capped)) offers.blocked.push(id);
    else if (isUnreadable(candidate, capped)) offers.unreadable.push(id);
  }
  if (placeBlocked) offers.placeBlocked = placeBlocked;
  return offers;
}

// GATE_LAWN_TROUBLE_AREAS: the limit answer with the picks that SOME place still permits taken out of it. The yearly limits are
// judged per place for a spot treatment, so a pick closed lawn-wide (or at one place) but open at another is still offered (the
// row's place chips then close only the forbidden places, with the limit's words). A pick stays blocked or unreadable only when
// NO place permits it, with the lawn-wide answer's own entry; a place whose read fails permits nothing (fail closed). A place can
// only be more open than the lawn, so only the picks capped lawn-wide are read again, once per place. A city hold is no limit
// and is judged by isBlocked as before.
async function openSomewhere({ chosen, wide, rows, svc, knex, places, placeBlocked }) {
  const closed = chosen.filter(([, c]) => limitBlocks(c, wide).length > 0 && !heldByCity(c.raw));
  if (!closed.length) return wide;
  const open = new Set();
  const unread = new Set();
  for (const place of places) {
    const here = await readCaps({ products: closed.map(([, c]) => c.raw.product), rows, svc, knex, place });
    for (const [, c] of closed) {
      const id = idOf(c.raw.product.id);
      const blocks = here ? here.get(id) || [] : null;
      const typed = blocks?.find((block) => block.type);
      if (typed) placeBlocked[id][place] = typed.message || 'A yearly limit is reached for this place.';
      if (blocks && !blocks.length) open.add(id);
      // A place whose read failed (the whole call, or this product's own typeless block) is UNKNOWN there, not closed: a product
      // unreadable at ANY place stays reachable by the search with the unreadable note, and a place that read as capped stays closed.
      else if (!blocks || blocks.every((block) => !block.type)) unread.add(id);
    }
  }
  const UNREAD = [{ message: 'application limits could not be read.' }];
  return new Map([...wide].filter(([id]) => !open.has(id)).map(([id, blocks]) => [id, unread.has(id) ? UNREAD : blocks]));
}

// The one add-on each kind may suggest: the FIRST fungicide in program order, the others by trigger.
function pickAddOns(candidates, rows) {
  const order = [...rows.keys()];
  const rank = (candidate) => order.indexOf(idOf(candidate.raw?.substitution?.originalProductId || candidate.raw?.product?.id));
  const withRole = (test) => (candidates || []).filter((candidate) => {
    const row = stagedRowOf(rows, candidate.raw);
    return row && test(row);
  });
  return {
    fungus: withRole((row) => row.role === FUNGICIDE_ROLE).sort((a, b) => rank(a) - rank(b))[0] || null,
    caterpillars: withRole((row) => row.gates?.trigger === CATERPILLAR_TRIGGER)[0] || null,
    dry_spots: withRole((row) => row.gates?.trigger === DRY_SPOT_TRIGGER)[0] || null,
  };
}

// Every take-all fungicide row of the month, wherever it stands in the program order (owner 2026-10-08:
// take-all is preventive on mapped areas only, never curative on a lawn with none on file). The staged
// role says fungicide; the trigger or the protocol line says take-all. The sheet keeps these out of the
// plain add-on list always, and releases them to the search only (see guideGovernance).
function takeAllAddOns(candidates, rows) {
  return (candidates || []).filter((candidate) => {
    const row = stagedRowOf(rows, candidate.raw);
    return row && row.role === FUNGICIDE_ROLE && isTakeAll(candidate, rows);
  });
}

// The plan's own limit reader over some products as selected lines: the hard blocks by product id,
// or null when the read failed (nothing is then suggested).
async function readCaps({ products, rows, svc, knex, place = null }) {
  try {
    const engine = require('./waveguard-plan-engine');
    return (await engine.v13VisitLimits(knex, svc, products.map((product) => ({ selected: true, product })), rows, {}, ...(place ? [{ place }] : []))).capped;
  } catch (err) {
    logger.warn(`[lawn-guide] limits unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

// Take-all fungus is told by the staged trigger or by the add-on's own protocol line.
const isTakeAll = (candidate, rows) => TAKE_ALL_TRIGGER.test(stagedRowOf(rows, candidate.raw)?.gates?.trigger || '') || TAKE_ALL_LINE.test(candidate.item?.line || '');

// One kind's offer, or null. Any block (a reached cap, another limit, a read that failed and came
// back as a block with no type, a city hold) keeps the product off the card. A take-all card names
// no product, so it stands, with `blocked` so a later trouble-area card still holds back.
// v13VisitLimits fails closed per product: a read that failed comes back as a block with no limit type
// (a real limit always names one). A named limit or a city hold forbids the product; a typeless block
// is an unreadable limit.
const limitBlocks = (candidate, capped) => capped.get(idOf(candidate.raw.product.id)) || [];
const isBlocked = (candidate, capped) => heldByCity(candidate.raw) || limitBlocks(candidate, capped).some((block) => block.type);
const isUnreadable = (candidate, capped) => !isBlocked(candidate, capped) && limitBlocks(candidate, capped).length > 0;

function offerFor(kind, candidate, { capped, rows }) {
  const blocked = isBlocked(candidate, capped) || isUnreadable(candidate, capped);
  if (kind === 'fungus' && isTakeAll(candidate, rows)) return { item: candidate.item, takeAll: true, blocked };
  return blocked ? null : { item: candidate.item };
}

/**
 * The Weed spots entry as an offer, or null: only while the spot rules' own decision says there is
 * something to add (the lead and its members, or the replacement at the lead's cap). `items` are the
 * sheet-shaped add-ons; the card carries them (and the names), and the tap adds exactly those rows.
 */
/**
 * The ids of the guide-governed products the fresh read did NOT offer because a limit or a city hold it
 * READ forbids them, across every governed kind: the fungicide, caterpillar and dry-spot picks, the
 * chinch rungs, and the weed group when the tap offers nothing (mode none) or hands the visit to the
 * replacement. The sheet keeps these out of every list; a governed pick that is NOT here and has no card
 * (no finding) returns to the generic list. Pure.
 */
function blockedProductIds({ offers, chinch, weedMix }) {
  // Unavailable (a member's own read failed): only the members whose limit WAS read as forbidding stay blocked.
  const weedOut = (weedMix?.mode === 'unavailable' ? weedMix.blockedIds || []
    : weedMix && weedMix.mode !== 'lead' ? (weedMix.groupProductIds || []).filter((id) => !(weedMix.productIds || []).includes(id)) : [])
    // Unreadable at some place (GATE_LAWN_TROUBLE_AREAS): not forbidden.
    .filter((id) => !(weedMix?.unreadableIds || []).includes(id));
  return [...new Set([...(offers?.blocked || []), ...(chinch?.blockedIds || []), ...weedOut].map(idOf))];
}

/**
 * The ids of the guide-governed products whose limit read FAILED (so nothing could be offered or read as
 * forbidden): the picks, the chinch rungs, and the weed group in mode 'unavailable'. They are not
 * blocked: the sheet releases them to the search (and a pick to the generic list), see UNREADABLE_NOTE.
 * Pure.
 */
function unreadableProductIds({ offers, chinch, weedMix }) {
  // The mix is withheld as a whole, so the members NOT read as forbidden are released to the search.
  const weedUnread = weedMix?.mode === 'unavailable' ? (weedMix.groupProductIds || []).filter((id) => !(weedMix.blockedIds || []).includes(id)) : [];
  return [...new Set([...(offers?.unreadable || []), ...(chinch?.unreadableIds || []), ...weedUnread, ...(weedMix?.unreadableIds || [])].map(idOf))];
}

function weedOffer(weedMix, items) {
  if (!weedMix || !['lead', 'replacement'].includes(weedMix.mode) || !Array.isArray(weedMix.productIds) || !weedMix.productIds.length) return null;
  const found = weedMix.productIds.map((id) => (items || []).find((item) => idOf(item.productId).toLowerCase() === idOf(id).toLowerCase()));
  if (!found.every(Boolean)) return null;
  const offer = { productIds: weedMix.productIds.map(idOf), names: found.map((item) => item.name), items: found, note: weedMix.note || null };
  if (!weedMix.byPlace) return offer;
  // GATE_LAWN_TROUBLE_AREAS: what each place takes (the card then adds a place's own mix with one tap on the place).
  const byPlace = {};
  for (const [place, decision] of Object.entries(weedMix.byPlace)) {
    if (!['lead', 'replacement'].includes(decision?.mode) || !Array.isArray(decision.productIds) || !decision.productIds.length) continue;
    const here = decision.productIds.map((id) => (items || []).find((item) => idOf(item.productId).toLowerCase() === idOf(id).toLowerCase()));
    if (here.every(Boolean)) byPlace[place] = { productIds: decision.productIds.map(idOf), names: here.map((item) => item.name), items: here, note: decision.note || null };
  }
  return { ...offer, byPlace };
}

// ── chinch bugs ─────────────────────────────────────────────────────────────

/**
 * The chinch bug product for this lawn, in the program's own order (Arena, then bifenthrin), read
 * from the v13 program's staged rows of the visit's protocol (any window: Arena is staged in April
 * to June, bifenthrin in July, and a find in any month is treated). The same cap reader the weed
 * mix uses decides: a product at its yearly count cap hands the tap to the next one; any other limit
 * on a product holds the offer with the limit's own words; a limit read that failed offers nothing.
 *
 *   null                                          the lookup succeeded and no chinch row is staged (no v13 protocol)
 * A thrown staged-row lookup is not an answer: it rejects.
 *   { productId, name, stagedRow, note, rungIds, blockedIds }   the product to add; `note` says why it is not Arena
 *   { productId: null, note, rungIds, blockedIds }               nothing to offer, and why
 * `rungIds` are all the rungs' products (governed by the guide whether offered or not); `blockedIds` the ones
 * a limit that was read kept out; `unreadableIds` all of them when the limit read failed.
 */
async function resolveChinch({ svc, structured, knex, places = null }) {
  const engine = require('./waveguard-plan-engine');
  const rows = engine.v13ProtocolRows(structured);
  if (!rows || !rows.size || !structured?.id) return null;
  // Three cases, kept apart: (1) the lookup succeeded and no chinch row is staged: a real "nothing to
  // offer" (null); (2) the lookup THREW: the error propagates (the guide request fails, and the
  // context drops the guide for the visit), because an empty answer here would claim a clean "no
  // rungs" the sheet cannot tell from case 1; (3) rows found but the LIMIT read failed: unreadable.
  const products = chinchProducts(await stagedChinchRows({ structured, knex }));
  if (!products.length) return null;
  const lines = products.map((p) => ({ id: p.productId, name: p.name }));
  const capped = await readCaps({ products: lines, rows, svc, knex });
  const wide = withRungs(capped ? chooseChinch(products, capped) : unreadableChinch(), products);
  if (!places || !places.length) return wide;
  // GATE_LAWN_TROUBLE_AREAS: which rungs are chinch-only (the sheet types a row of one as chinch without being told). See chinchOnlyIds.
  const chinchOnlyIds = await chinchOnlyIdsOf({ products, structured, knex });
  // GATE_LAWN_TROUBLE_AREAS: the same ladder walked at each place of the lawn (the yearly count, the interval and the
  // yearly amount are judged per place for a spot treatment), `byPlace[place]` shaped like the lawn-wide answer. A place
  // can only be more open than the lawn, so with nothing capped lawn-wide every place takes the lawn-wide answer; a limit
  // read that failed lawn-wide is read again per place, each failing closed on its own. The top-level answer is the first
  // place that has a product to add, else the lawn-wide one.
  const byPlace = {};
  for (const place of places) {
    if (capped && !capped.size) { byPlace[place] = wide; continue; }
    const here = await readCaps({ products: lines, rows, svc, knex, place });
    byPlace[place] = withRungs(here ? chooseChinch(products, here) : unreadableChinch(), products);
  }
  const best = places.find((place) => byPlace[place].productId);
  const top = best ? byPlace[best] : wide;
  // The sheet's search and reconciliation read the TOP-LEVEL unreadable ids, which follow one place only. A rung unreadable at ANY
  // place stays unreadable here (released to the search with the note, never dropped by reconciliation) and is not also blocked.
  const unreadableIds = [...new Set(places.flatMap((place) => byPlace[place].unreadableIds || []))];
  return { ...top, unreadableIds, blockedIds: (top.blockedIds || []).filter((id) => !unreadableIds.includes(id)), byPlace, chinchOnlyIds };
}

/**
 * The chinch rungs that are chinch-only in this program, by the staged rows' triggers (never the name): the ladder's first rung, when
 * every row the protocol stages for that product carries a first-rung trigger. A later rung (Talak) is also the caterpillar and mole
 * cricket product, so a row of it is chinch only when the technician says so (the chinch entry or card, or the place's own decision).
 */
async function chinchOnlyIdsOf({ products, structured, knex }) {
  const first = products.filter((product) => product.rung === 0);
  if (!first.length) return [];
  const { activeProtocolProducts } = require('./lawn-protocol-retired');
  const staged = await activeProtocolProducts(knex('lawn_protocol_products as lpp'), 'lpp')
    .join('lawn_protocol_windows as w', 'lpp.lawn_protocol_window_id', 'w.id')
    .where('w.lawn_protocol_id', structured.id)
    .whereRaw('lpp.product_id::text = ANY(?)', [first.map((product) => product.productId)])
    .select('lpp.product_id', 'lpp.gates');
  const only = (id) => staged.filter((row) => idOf(row.product_id) === id).every((row) => CHINCH_RUNGS[0].includes((parseJson(row.gates) || {}).trigger));
  return first.map((product) => product.productId).filter(only);
}

/** Every chinch rung's product id for a protocol (the staged-row rule resolveChinch uses), with no limit read: what the completion confirms a `chinch` hint against. */
async function chinchLadderIds({ structured, knex }) {
  if (!structured?.id) return [];
  return chinchProducts(await stagedChinchRows({ structured, knex })).map((product) => product.productId);
}

// Every rung's product id (all of them are governed by the guide, offered or not). The rungs a READ limit
// blocked and the rungs whose own read failed come per rung from chooseChinch; only a read that failed
// as a whole (the limits call itself threw) makes every rung unreadable.
function withRungs(result, products) {
  const rungIds = products.map((product) => product.productId);
  if (result.unreadable) return { ...result, rungIds, blockedIds: [], unreadableIds: rungIds };
  return { ...result, rungIds };
}

// Nothing is offered when the limit read failed: the line says so, and the rungs are released to the search.
const unreadableChinch = () => ({ productId: null, name: null, stagedRow: null, note: UNREADABLE_NOTE, unreadable: true });

// The staged chinch rows of the visit's protocol (any window) with their catalog row. A failed read
// THROWS: an empty list means the protocol really stages no chinch rung.
async function stagedChinchRows({ structured, knex }) {
  const { activeProtocolProducts } = require('./lawn-protocol-retired');
  return activeProtocolProducts(knex('lawn_protocol_products as lpp'), 'lpp')
    .join('lawn_protocol_windows as w', 'lpp.lawn_protocol_window_id', 'w.id')
    .leftJoin('products_catalog as pc', 'lpp.product_id', 'pc.id')
    .where('w.lawn_protocol_id', structured.id)
    .whereNotNull('lpp.product_id')
    .whereRaw(`lpp.gates->>'trigger' IN (${CHINCH_TRIGGERS.map(() => '?').join(', ')})`, CHINCH_TRIGGERS)
    .select('lpp.product_id', 'lpp.product_name', 'lpp.gates', 'lpp.rate_per_1000', 'lpp.rate_unit', 'lpp.sort_order', 'w.month', 'pc.id as catalog_id', 'pc.name as catalog_name', 'pc.active as catalog_active');
}

// One product per rung, in the program's order, the earliest window's row first; a product the
// catalog no longer has or has retired cannot be recorded, so it is not offered.
function chinchProducts(staged) {
  const usable = (Array.isArray(staged) ? staged : []).filter((row) => row.catalog_id && row.catalog_active !== false);
  const products = [];
  for (const [rungIndex, rung] of CHINCH_RUNGS.entries()) {
    const row = usable
      .filter((candidate) => rung.includes((parseJson(candidate.gates) || {}).trigger))
      .sort((a, b) => (Number(a.month) - Number(b.month)) || (Number(a.sort_order) - Number(b.sort_order)))[0];
    if (row && !products.some((product) => product.productId === idOf(row.product_id))) {
      products.push({ productId: idOf(row.product_id), name: row.catalog_name || row.product_name, stagedRow: row, rung: rungIndex });
    }
  }
  return products;
}

// Which product the tap adds, from the limit reader's blocks, PER RUNG. v13VisitLimits fails closed per
// product: a read that failed comes back as a block with no limit type (a real limit always names one).
// A rung is therefore blocked (a typed limit that was read), unreadable (only a typeless block) or clean.
// The ladder is walked in the program's order:
//   clean rung        offered (with the "used in its place" note when an earlier rung is yearly-capped)
//   yearly-capped     skipped, the next rung is judged
//   another limit     (a minimum interval, a blackout) holds the whole offer with the limit's words
//   unreadable rung   nothing is offered (we cannot say it is exhausted, so the next rung is not offered
//                     either) and it is released to the search; later rungs keep their OWN state (a
//                     later blocked rung stays blocked, a later unreadable one is released too, a later
//                     clean one is simply not offered)
// Rungs after an offered rung are not reached: neither blocked nor unreadable, only not offered.
function chooseChinch(products, capped) {
  const none = (note, blockedIds, unreadableIds = []) => ({ productId: null, name: null, stagedRow: null, note, blockedIds, unreadableIds });
  const typedOf = (product) => (capped.get(product.productId) || []).filter((block) => block.type);
  const stateOf = (product) => {
    if (typedOf(product).length) return 'blocked';
    return (capped.get(product.productId) || []).length ? 'unreadable' : 'clean';
  };
  const idsOf = (list, state) => list.filter((product) => stateOf(product) === state).map((product) => product.productId);
  let skipped = null;
  for (const [index, product] of products.entries()) {
    const state = stateOf(product);
    const earlier = products.slice(0, index).map((p) => p.productId);
    if (state === 'clean') {
      const note = skipped ? `${shortName(skipped.name)} yearly limit reached; ${shortName(product.name)} is used in its place.` : null;
      return { ...product, note, blockedIds: earlier, unreadableIds: [] };
    }
    if (state === 'unreadable') return none(UNREADABLE_NOTE, [...earlier, ...idsOf(products.slice(index + 1), 'blocked')], [product.productId, ...idsOf(products.slice(index + 1), 'unreadable')]);
    // Another limit (an interval, a blackout) holds the whole offer with its own words. A rung whose OWN read failed is still the unknown,
    // not blocked: a sibling's known limit never turns an unreadable rung into a forbidden one.
    if (!typedOf(product).every((block) => block.type === YEARLY_CAP)) {
      return none(typedOf(product)[0].message || CHINCH_LIMIT_REACHED, products.filter((p) => stateOf(p) !== 'unreadable').map((p) => p.productId), idsOf(products, 'unreadable'));
    }
    skipped = skipped || product;
  }
  return none(CHINCH_LIMIT_REACHED, products.map((p) => p.productId));
}

// ── the cards ───────────────────────────────────────────────────────────────

const cardFor = (kind, fields) => ({
  kind, title: '', finding: '', check: null, detail: null, note: null, productIds: [], heldProductIds: [], items: [],
  actionLabel: 'Add it', dismissLabel: null, ...fields,
});
const protocolLine = (item) => item.line || item.name;

/**
 * The cards for a confirmed assessment, in screen order. `offers` is `{ fungus, caterpillars,
 * dry_spots, chinch }` (each `{ item }` / `{ item, note }` or null: what the month can offer and
 * what is not blocked), `weeds` the weedOffer. Pure: the rule table is this function and nothing
 * else. `month` is the visit month, 1 to 12.
 */
function buildCards({ signals, month, offers = {}, weeds = null, troubleAreas = [] }) {
  const input = { s: signals || {}, month, offers, weeds, troubleAreas };
  return [weedsCard, fungusCard, chinchCard, caterpillarsCard, dryCard].map((rule) => rule(input)).filter(Boolean);
}

// One rule per card kind: the input is { s: signals, month, offers, weeds, troubleAreas }; the answer
// is the card or null.
function weedsCard({ s, weeds }) {
  if (!weeds || s.weedCoverage === null || s.weedCoverage === undefined || s.weedCoverage < WEED_MIN_PERCENT) return null;
  return cardFor('weeds', {
    title: 'Weed spots',
    finding: `Photos show weeds on about ${Math.round(s.weedCoverage)}% of the lawn.`,
    detail: weeds.names.join(', '),
    note: weeds.note,
    productIds: weeds.productIds,
    // The fresh offer's own add-ons: the tap adds exactly these, not the context's older weed mix.
    items: weeds.items,
    actionLabel: 'Add weed spots',
    ...(weeds.byPlace ? { byPlace: weeds.byPlace } : {}),
  });
}

function fungusCard({ s, offers, troubleAreas }) {
  if (!atLeast(s.fungus, 'minor') || !offers.fungus?.item) return null;
  const { item, takeAll, blocked } = offers.fungus;
  const finding = `Photos show ${s.fungus} fungus activity.`;
  // The check only: take-all is treated on known trouble areas, and none is on file.
  // The product is held, not offered: it names no add button and must not be addable from anywhere else.
  if (takeAll && (!troubleAreas.length || blocked)) {
    return cardFor('fungus', { title: 'Fungus', finding, check: CHECKS.fungus, note: TAKE_ALL_NOTE, heldProductIds: [item.productId], actionLabel: null });
  }
  return cardFor('fungus', {
    title: 'Fungus', finding, check: CHECKS.fungus, detail: protocolLine(item), productIds: [item.productId], items: [item],
    // A take-all card offered because the lawn has take-all areas on file names them (GATE_LAWN_TROUBLE_AREAS).
    ...(takeAll ? { note: `Take-all area on file: ${[...new Set(troubleAreas.map((area) => area.placeLabel || area.place))].join(', ')}.` } : {}),
    actionLabel: 'I checked. Add it', dismissLabel: 'Nothing found',
  });
}

function chinchCard({ s, month, offers }) {
  if (!atLeast(s.insect, 'moderate') || month < CHINCH_FIRST_MONTH || month > CHINCH_LAST_MONTH || !offers.chinch?.item) return null;
  const { item, note } = offers.chinch;
  return cardFor('chinch', {
    title: 'Insects: check for chinch bugs',
    finding: `Photos show ${s.insect} insect damage.`,
    check: CHECKS.chinch,
    detail: `Chinch bugs at the edge of the damage: ${item.name}, spot treatment.`,
    note: note || null,
    productIds: [item.productId],
    items: [item],
    actionLabel: 'Found at the edge. Add it',
    dismissLabel: 'Nothing found',
    // GATE_LAWN_TROUBLE_AREAS: the product each place takes (Arena where it is open, the bifenthrin product where it is capped).
    ...(offers.chinch.byPlace ? { byPlace: chinchCardPlaces(offers.chinch.byPlace) } : {}),
  });
}

function chinchCardPlaces(byPlace) {
  return Object.fromEntries(Object.entries(byPlace).filter(([, d]) => d?.item).map(([place, d]) => [place, { productIds: [d.item.productId], names: [d.item.name], items: [d.item], note: d.note || null }]));
}

function caterpillarsCard({ s, offers }) {
  if (!atLeast(s.insect, 'moderate') || !offers.caterpillars?.item) return null;
  const { item } = offers.caterpillars;
  return cardFor('caterpillars', {
    title: 'Insects: check for caterpillars',
    finding: `Photos show ${s.insect} insect damage.`,
    check: CHECKS.caterpillars,
    detail: protocolLine(item),
    productIds: [item.productId],
    items: [item],
    actionLabel: 'Found them. Add it',
    dismissLabel: 'Nothing found',
  });
}

function dryCard({ s, offers }) {
  if (!atLeast(s.drought, 'minor') || !offers.dry_spots?.item) return null;
  const { item } = offers.dry_spots;
  return cardFor('dry_spots', {
    title: 'Dry spots',
    finding: `Photos show ${s.drought} drought stress.`,
    detail: protocolLine(item),
    productIds: [item.productId],
    items: [item],
    actionLabel: `Add ${item.name}`,
  });
}

// ── the record ──────────────────────────────────────────────────────────────

const MAX_RECORD_PRODUCTS = 4;

// One card of the record. With GATE_LAWN_TROUBLE_AREAS live, a card taken at a place also names that place (a closed-list place) and its
// product ids are the ones actually added: the ids stay a flat list, narrowed to the applied products when the completion's list is
// known, and a card with a place and nothing applied is not taken. Without a valid place the card is exactly what it always was.
function frozenCard(card, productIds, appliedIds) {
  const base = { kind: card.kind, shown: true, checked: card.checked === 'found' || card.checked === 'none' ? card.checked : null, taken: card.taken === true, productIds };
  const live = require('../config/feature-gates').lawnTroubleAreasLive();
  if (!live || !base.taken || !require('./lawn-trouble-areas').isPlace(card.place)) return base;
  const added = appliedIds ? productIds.filter((id) => appliedIds.has(id)) : productIds;
  return { ...base, taken: added.length > 0, productIds: added, ...(added.length ? { place: card.place } : {}) };
}

/**
 * The completion's record of the guide (owner choice D4): `{ lawnTreatmentGuide: { v: 1, cards } }`
 * to spread into structured_notes, or `{}`. Built from the `treatmentGuide` block of the submit's
 * `lawnFast` echo, checked here: only while the gate is live, only version 1, unknown kinds and
 * repeats dropped, product ids uuids (at most four each), `checked` found | none | null,
 * `taken` a boolean (every product the card offers is on the sheet; the client decides). Every card kept was shown. Frozen on the record for tuning the rules and read
 * by no customer or public path. With GATE_LAWN_TROUBLE_AREAS live a card taken at a place also carries `place` (see frozenCard).
 */
// The lower-case ids of the products a completion applied, or null when its list is not known.
const appliedIdsOf = (products) => (Array.isArray(products) ? new Set(products.map((row) => String(row?.productId || '').toLowerCase())) : null);

function treatmentGuideFreeze(lawnFast, { products = null, appliedIds = appliedIdsOf(products) } = {}) {
  if (!require('../config/feature-gates').lawnTreatmentGuideLive()) return {};
  const block = lawnFast && typeof lawnFast === 'object' ? lawnFast.treatmentGuide : null;
  if (!block || typeof block !== 'object' || Array.isArray(block) || block.v !== 1) return {};
  const seen = new Set();
  const cards = [];
  for (const card of Array.isArray(block.cards) ? block.cards.slice(0, KINDS.length * 2) : []) {
    if (!card || typeof card !== 'object' || !KINDS.includes(card.kind) || seen.has(card.kind)) continue;
    seen.add(card.kind);
    const productIds = [...new Set((Array.isArray(card.productIds) ? card.productIds : [])
      .filter((id) => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase()))].slice(0, MAX_RECORD_PRODUCTS);
    cards.push(frozenCard(card, productIds, appliedIds));
  }
  return { lawnTreatmentGuide: { v: 1, cards } };
}

module.exports = {
  KINDS,
  WEED_MIN_PERCENT,
  CHECKS,
  CHINCH_TRIGGERS,
  signalsFromAssessment,
  addOnOffers,
  pickAddOns,
  takeAllAddOns,
  weedOffer,
  blockedProductIds,
  unreadableProductIds,
  UNREADABLE_NOTE,
  resolveChinch,
  chinchLadderIds,
  chinchOnlyIdsOf,
  buildCards,
  treatmentGuideFreeze,
};
