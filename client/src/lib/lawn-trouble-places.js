// client/src/lib/lawn-trouble-places.js
//
// The place of a spot treatment on the lawn Fast Complete sheet (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09).
// The server sends the closed list of places, the lawn's known trouble areas and what each yearly limit closes
// where (the context's `troubleAreas`, and `byPlace` on the Weed spots and chinch decisions). This file only
// reads those answers: no limit, no place name and no rule lives here, and /complete asks the same limit reader
// again, so the sheet can only be less strict than the server, never more.
//
// With no `troubleAreas` in the context (the gate is off, or an older server) every function here answers "no
// place rule" and the sheet renders exactly as before.

const sameId = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

/** The context's troubleAreas block, normalized, or null (no place rule). */
export function troubleAreasOf(data) {
  const block = data?.spotRules === true ? data?.troubleAreas : null;
  if (!block || block.v !== 1 || !Array.isArray(block.places)) return null;
  const places = block.places.filter((place) => text(place?.id) && text(place?.label)).map((place) => ({ id: place.id, label: place.label }));
  if (!places.length) return null;
  const known = (Array.isArray(block.known) ? block.known : [])
    .filter((area) => text(area?.id) && places.some((place) => place.id === area.place) && text(area?.type))
    .map((area) => ({
      id: area.id, place: area.place, placeLabel: area.placeLabel || area.place, type: area.type, typeLabel: area.typeLabel || area.type, lastTreatedOn: area.lastTreatedOn || null,
    }));
  const blocked = block.blocked && typeof block.blocked === 'object' && !Array.isArray(block.blocked) ? block.blocked : {};
  return { places, known, knownUnavailable: block.knownUnavailable === true, blocked };
}

// The trouble-area type a row is for. The guide card or entry that opened the row says it; a plain row follows the
// catalog category (the server uses the same two rules when it writes the store, and it wins on any difference).
const GUIDED_TYPE = { weeds: 'weeds', fungus: 'fungus', chinch: 'chinch', caterpillars: 'other_insect', dry_spots: 'dry_spot' };
const CATEGORY_TYPE = { herbicide: 'weeds', fungicide: 'fungus', insecticide: 'other_insect' };
export function troubleTypeOfRow(row) {
  // A take-all fungicide is added through Search (no guide tag) and is cataloged as a fungicide: the guide's take-all set says it.
  if (row?.takeAllRow) return 'take_all';
  return GUIDED_TYPE[row?.guided] || CATEGORY_TYPE[String(row?.product?.category || '').trim().toLowerCase()] || null;
}

const reasonText = (value, fallback) => text(value) || fallback;

/**
 * Which places a row may go on: `{ [placeId]: null | reason }`. null = open. A row is judged by the decision that
 * governs its product: a Weed spots row by the weed decision at that place (the row must be one of what the place
 * takes), a chinch row by the chinch decision at that place (the place must offer this very product), any other row
 * by the products a limit closes at a place. A decision whose limits could not be read ('unavailable') closes nothing:
 * the unknown is not "forbidden" (completion records it and flags the office). `weedRows` are the rows of the weed entry.
 */
export function placeProblems(row, { areas, weedMix = null, chinch = null, weedRows = [] }) {
  const out = {};
  for (const place of areas.places) {
    out[place.id] = problemAt(place.id, row, { areas, weedMix, chinch, weedRows });
  }
  return out;
}

const lowerIds = (list) => (Array.isArray(list) ? list : []).map((id) => String(id).toLowerCase());
// A product belongs to the weed group or the chinch ladder by what the server says it stands for, never by how its row was added:
// a planned row or a Search-added row of Arena or Celsius is judged by the same per-place decision as the entry's row.
const inWeedGroup = (row, weedMix) => !!row.weedGroup || lowerIds(weedMix?.groupProductIds).includes(String(row.productId).toLowerCase());
const inChinchLadder = (row, chinch) => row.guided === 'chinch' || lowerIds(chinch?.rungIds).includes(String(row.productId).toLowerCase());
// A tank-mix member with no capped rate (the surfactant) closes no place.
const uncapped = (row, weedMix) => lowerIds(weedMix?.noAreaProductIds).includes(String(row.productId).toLowerCase());

function problemAt(placeId, row, { areas, weedMix, chinch, weedRows }) {
  if (weedMix?.byPlace && inWeedGroup(row, weedMix)) {
    if (uncapped(row, weedMix)) return null;
    // The rows of the entry share one set; a group product that is on the sheet on its own is judged on its own.
    return weedProblem(weedMix.byPlace[placeId], row.weedGroup ? weedRows.filter((other) => !uncapped(other, weedMix)) : [row]);
  }
  if (chinch?.byPlace && inChinchLadder(row, chinch)) return chinchProblem(chinch.byPlace[placeId], row);
  const closed = areas.blocked?.[String(row.productId).toLowerCase()] || areas.blocked?.[row.productId];
  return closed?.[placeId] ? reasonText(closed[placeId], 'A yearly limit is reached at this place.') : null;
}

const KNOWN_WEED_BLOCK = 'A yearly limit is reached for a weed product on the sheet at this place.';
const blockedHere = (decision, row) => lowerIds(decision.blockedIds).includes(String(row.productId).toLowerCase());

// The weed decision at a place takes the rows on the sheet, or says why not. Unavailable closes nothing.
function weedProblem(decision, weedRows) {
  if (!decision) return null;
  // A place where some member's limit read FAILED is the unknown for that member only: a member whose read succeeded and said
  // capped (decision.blockedIds) stays closed there, whatever its siblings' reads did.
  if (decision.mode === 'unavailable') return weedRows.some((other) => blockedHere(decision, other)) ? KNOWN_WEED_BLOCK : null;
  const taken = Array.isArray(decision.productIds) ? decision.productIds : [];
  const fits = ['lead', 'replacement'].includes(decision.mode) && weedRows.every((other) => taken.some((id) => sameId(id, other.productId)));
  return fits ? null : reasonText(decision.note, 'The weed products on the sheet do not fit this place.');
}

// The chinch decision at a place offers this very product, or says why not. A limit that could not be read is the unknown.
function chinchProblem(decision, row) {
  if (!decision) return null;
  if (decision.item && sameId(decision.item.productId, row.productId)) return null;
  if ((decision.unreadableIds || []).some((id) => sameId(id, row.productId))) return null;
  // With the rungs a place's limits closed (blockedIds), only those are closed there: a rung the place does not offer but does
  // not close is open, as /complete reads it. Without them (an older answer) the place offers its one product.
  if (Array.isArray(decision.blockedIds)) return decision.blockedIds.some((id) => sameId(id, row.productId)) ? reasonText(decision.note, 'This chinch product is not available at this place.') : null;
  return reasonText(decision.note, 'This chinch product is not available at this place.');
}

// Whether the limits could not be read at a place for this row (the unknown: the row is allowed, recorded and flagged by the
// closeout). Only the decisions that say so are asked: the weed mix at a place that is 'unavailable', the chinch ladder at a place
// that lists the product as unreadable.
function unreadableAt(placeId, row, { weedMix, chinch }) {
  if (weedMix?.byPlace && inWeedGroup(row, weedMix)) {
    const decision = weedMix.byPlace[placeId];
    return decision?.mode === 'unavailable' && !blockedHere(decision, row);
  }
  if (chinch?.byPlace && inChinchLadder(row, chinch)) return (chinch.byPlace[placeId]?.unreadableIds || []).some((id) => sameId(id, row.productId));
  return false;
}

/**
 * The place a row starts on when the tech has not tapped one: the lawn's single known trouble area of the row's type
 * whose place is open for the row. Two or more known places of that type, or none, leave the choice to the tech.
 */
export function defaultPlaceFor(row, { areas, problems }) {
  const type = troubleTypeOfRow(row);
  if (!type) return '';
  const here = areas.known.filter((area) => area.type === type && !problems[area.place]);
  const places = [...new Set(here.map((area) => area.place))];
  return places.length === 1 ? places[0] : '';
}

/** The known areas of a type, for ordering a row's choices (a known place first). */
export const knownPlacesOfType = (areas, type) => new Set(areas.known.filter((area) => area.type === type).map((area) => area.place));

/**
 * What a row's place is, given the tech's own tap (`chosen`, '' when none): the tap, else the default. The row's
 * `placeRule` says the server asks for one; `place` is '' while it is missing.
 */
export function withPlace(row, { areas, chosen, weedMix, chinch, weedRows, takeAll = null }) {
  // `takeAll`: the guide's take-all product ids (a Set of lower-case ids); the row stands for a take-all area, not plain fungus.
  const tagged = takeAll?.has(String(row.productId).toLowerCase()) ? { ...row, takeAllRow: true } : row;
  return placed(tagged, { areas, chosen, weedMix, chinch, weedRows });
}

function placed(row, { areas, chosen, weedMix, chinch, weedRows }) {
  const problems = placeProblems(row, { areas, weedMix, chinch, weedRows });
  const picked = chosen && areas.places.some((place) => place.id === chosen) ? chosen : '';
  const place = picked || defaultPlaceFor(row, { areas, problems });
  return {
    ...row,
    placeRule: true,
    placeLabels: Object.fromEntries(areas.places.map((choice) => [choice.id, choice.label])),
    place,
    placeProblems: problems,
    placeDefaulted: !picked && !!place,
    // The reason a row may not go where it is (or anywhere), for the hold under the Complete button.
    placeBlock: place && problems[place] ? problems[place] : null,
    placeUnreadable: !!place && !problems[place] && unreadableAt(place, row, { weedMix, chinch }),
    placeNowhere: Object.values(problems).every(Boolean) ? Object.values(problems)[0] : null,
  };
}

/** What a place chip says when it is closed, for the row. */
export const placeLabel = (areas, id) => areas.places.find((place) => place.id === id)?.label || id;
