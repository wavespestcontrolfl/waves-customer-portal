/**
 * The "Weed spots" entry of the lawn Fast Complete sheet (GATE_LAWN_SPOT_RULES, owner 2026-10-08).
 * The protocol rows already say how the weed products belong together, so the group is read from
 * that data and never from product names:
 *
 *   lead         the add-on the other add-ons name in gates.tankMixWith (Celsius WG)
 *   members      the add-ons that name it (Certainty, the nonionic surfactant)
 *   replacement  the add-on whose gates.trigger is celsius_annual_cap_reached (Blindside)
 *
 * One tap adds the lead and its members. Once the lead is at its yearly cap the tap adds the
 * replacement in their place, and once the replacement is capped too there is nothing to add. A
 * product is "at its cap" when the plan's own limit reader (v13VisitLimits, the call the plan makes
 * for a selected product) returns a hard block for it; nothing is counted again here, and a limit
 * read that failed reads as capped, as it does in the plan.
 *
 * The Celsius WG label allows no adjuvant above SURFACTANT_MAX_TEMP_F, so the surfactant member is
 * left out at that air temperature or hotter. The temperature is read once, only when a surfactant
 * would be added, and any failure (no coordinates, no station, a slow answer, an old reading) is
 * "unknown": the surfactant is then added with a reminder, never silently dropped.
 *
 * Reads only. The result rides the tech context (plannedProducts.weedMix); no customer payload.
 */
const logger = require('./logger');

// Celsius WG label: no adjuvant at 90 F air temperature or above (lawn-program-scope label checks,
// 2026-10-01).
const SURFACTANT_MAX_TEMP_F = 90;
// The sheet must never wait on a weather station: past this the temperature is unknown.
const TEMP_TIMEOUT_MS = 2500;
// A cached station reading older than this is not "current".
const TEMP_MAX_AGE_MS = 90 * 60 * 1000;

const REPLACEMENT_TRIGGER = 'celsius_annual_cap_reached';

const SURFACTANT_LEFT_OUT = `Surfactant left out: it is ${SURFACTANT_MAX_TEMP_F}°F or hotter.`;
const SURFACTANT_CHECK_NOTE = `Leave the surfactant out if it is ${SURFACTANT_MAX_TEMP_F}°F or hotter.`;
const WEED_LIMIT_REACHED = 'The yearly weed-spray limit is reached for this lawn.';

const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const shortName = (name) => String(name || '').trim().split(/\s+/)[0] || String(name || '');
const idOf = (item) => String(item.product.id);

/**
 * The weed group in a list of plan add-on items (each with `product` and the staged row's
 * `gates`): `{ lead, members, replacement }`, or null when no add-on is named as a tank-mix lead.
 * Pure.
 */
function weedMixGroup(items) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item?.product?.id);
  const byName = new Map();
  for (const item of list) {
    byName.set(norm(item.product.name), item);
    if (item.substitution?.originalProductName) byName.set(norm(item.substitution.originalProductName), item);
  }
  const tied = list.map((item) => ({ item, lead: byName.get(norm(item.gates?.tankMixWith)) }))
    .filter(({ item, lead }) => lead && lead !== item);
  if (!tied.length) return null;
  const lead = tied[0].lead;
  const members = tied.filter((entry) => entry.lead === lead).map((entry) => entry.item);
  const replacement = list.find((item) => item !== lead && !members.includes(item) && item.gates?.trigger === REPLACEMENT_TRIGGER) || null;
  return { lead, members, replacement };
}

const LIMITS_UNREAD = 'The weed-spray limits could not be checked. Use Other product for what you sprayed.';
// application-limits' type for the yearly application count (checkLimits).
const YEARLY_CAP = 'annual_max_apps';

// The air temperature (F) at the property right now, or null for anything but a fresh number.
async function currentTempF(svc) {
  let timer;
  try {
    const { resolvePropertyCoordinates } = require('./property-coordinates');
    const coordinates = await resolvePropertyCoordinates(svc.customer_id, svc.property_id ?? null);
    if (!coordinates) return null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), TEMP_TIMEOUT_MS); });
    const current = await Promise.race([require('./fawn-weather').getCurrent(coordinates), timeout]);
    if (!current || current.station === 'unavailable' || current.temp_f == null) return null;
    const temp = Number(current.temp_f);
    // The reading's own time: `timestamp` is when the response was normalized, so a stale station
    // reading would pass on it. No observation time reads as unknown.
    const at = Date.parse(current.observation_time);
    if (!Number.isFinite(temp) || !Number.isFinite(at) || Date.now() - at > TEMP_MAX_AGE_MS) return null;
    return temp;
  } catch (err) {
    logger.warn(`[lawn-weed-mix] air temperature unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The surfactant is the member that states a concentration (a percent of the tank), not a rate.
const isSurfactant = (item) => !!item.gates?.concentration;

// Lead mode: the lead and its open members, with the surfactant judged by the air temperature.
async function leadMix({ base, lead, members, isCapped, svc, readTemp = () => currentTempF(svc) }) {
  // A member at its own yearly cap stays off the tap, as the lead does.
  const open = members.filter((item) => !isCapped(item));
  const surfactant = open.find(isSurfactant) || null;
  let tempF = null;
  let surfactantNote = null;
  let included = !!surfactant;
  if (surfactant) {
    tempF = await readTemp();
    if (tempF == null) surfactantNote = SURFACTANT_CHECK_NOTE;
    else if (tempF >= SURFACTANT_MAX_TEMP_F) { included = false; surfactantNote = SURFACTANT_LEFT_OUT; }
  }
  const leftOut = members.filter(isCapped).map((item) => `${shortName(item.product.name)} yearly limit reached; left out.`);
  return {
    ...base,
    mode: 'lead',
    productIds: [lead, ...open.filter((item) => item !== surfactant || included)].map(idOf),
    note: [surfactantNote, ...leftOut].filter(Boolean).join(' ') || null,
    surfactant: surfactant ? { productId: idOf(surfactant), included, note: surfactantNote } : null,
    tempF,
  };
}

/**
 * The context's `plannedProducts.weedMix`, or null when the add-ons hold no weed group.
 *   mode            'lead' (the tap adds productIds: the lead and its members), 'replacement' (the
 *                   replacement alone), 'none' (the yearly limit is reached, nothing to add) or
 *                   'unavailable' (the limits could not be read: nothing is offered)
 *   productIds      what the tap adds, in order
 *   groupProductIds every product the entry stands for; the sheet lists none of them on its own
 *   replacementProductId  the replacement's id, or null
 *   note            the one line under the entry, or null
 *   surfactant      { productId, included, note } in lead mode, else null
 *   noAreaProductIds members whose rate is not per area (a concentration): they figure no amount
 *                   and need no area
 *   tempF           the air temperature used, or null when unknown / not read
 *   byPlace         (`places: true`, GATE_LAWN_TROUBLE_AREAS) the same decision for each place of the lawn,
 *                   `{ [placeId]: { mode, productIds, note, surfactant, tempF } }`: the yearly limits are
 *                   judged per place for a spot application, so one place can be at the cap while another
 *                   still takes the lead. The top-level fields then follow the first place that can take the
 *                   lead, else the first that can take the replacement, else the lawn-wide decision.
 * `addOns` are the plan's raw add-on items; `svc` the visit row (customer_id, property_id, id,
 * scheduled_date); `structured` the plan's structured protocol.
 */
async function buildWeedMix({ addOns, svc, structured, knex, places = null }) {
  const group = weedMixGroup(addOns);
  if (!group) return null;
  const { lead, members, replacement } = group;
  const all = [lead, ...members, ...(replacement ? [replacement] : [])];
  const groupProductIds = all.map(idOf);
  const base = {
    mode: 'none', productIds: [], groupProductIds, replacementProductId: replacement ? idOf(replacement) : null,
    note: null, surfactant: null, noAreaProductIds: members.filter(isSurfactant).map(idOf), tempF: null,
  };
  const readLimits = async (place) => {
    const engine = require('./waveguard-plan-engine');
    const rows = engine.v13ProtocolRows(structured);
    const selected = all.map((item) => ({ selected: true, product: item.product }));
    return (await engine.v13VisitLimits(knex, svc, selected, rows, {}, ...(place ? [{ place }] : []))).capped;
  };
  let capped;
  try {
    capped = await readLimits(null);
  } catch (err) {
    logger.warn(`[lawn-weed-mix] limits unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return { ...base, mode: 'unavailable', note: LIMITS_UNREAD, blockedIds: [] };
  }
  // The air temperature is read once, however many places are judged.
  let tempRead = null;
  const readTemp = () => (tempRead = tempRead || currentTempF(svc));
  const wide = await decideMix({ base, lead, members, replacement, all, capped, svc, readTemp });
  if (!places || !places.length) return wide;
  // A place judged on its own can only be more open than the lawn: with nothing capped lawn-wide, every place
  // takes the lawn-wide decision as it is.
  const byPlace = {};
  for (const place of places) {
    byPlace[place] = capped.size
      ? await decideAtPlace({ place, base, lead, members, replacement, all, svc, readTemp, readLimits })
      : wide;
  }
  const best = places.find((place) => byPlace[place].mode === 'lead') || places.find((place) => byPlace[place].mode === 'replacement');
  // A member whose limit could not be read at ANY place stays reachable by the search and is never dropped by reconciliation
  // (`unreadableIds`, additive, places only): at a place whose read failed, the members not read as forbidding there.
  const unreadableIds = [...new Set(places.filter((place) => byPlace[place].mode === 'unavailable')
    .flatMap((place) => groupProductIds.filter((id) => !(byPlace[place].blockedIds || []).includes(id))))];
  return { ...(best ? byPlace[best] : wide), ...(unreadableIds.length ? { unreadableIds } : {}), byPlace };
}

// One place's decision: its own limit read, failing closed (unavailable) when the read throws.
async function decideAtPlace({ place, base, lead, members, replacement, all, svc, readTemp, readLimits }) {
  let here;
  try {
    here = await readLimits(place);
  } catch (err) {
    logger.warn(`[lawn-weed-mix] limits unavailable at ${place} for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return { ...base, mode: 'unavailable', note: LIMITS_UNREAD, blockedIds: [] };
  }
  return decideMix({ base, lead, members, replacement, all, capped: here, svc, readTemp });
}

// One decision from one limit read (see buildWeedMix): the mode, what the tap adds and the line under the entry.
async function decideMix({ base, lead, members, replacement, all, capped, svc, readTemp }) {
  // v13VisitLimits fails closed per product: a read that failed comes back as a block with no limit type (a real limit
  // always names one). That is not a reached cap, so nothing is offered.
  const blocksOf = (item) => capped.get(idOf(item)) || [];
  // `blockedIds` (additive, read by the treatment guide only): the members whose limit WAS read as a named
  // limit, so a sibling's failed read never releases them. The mix is withheld as a whole either way.
  if (all.some((item) => blocksOf(item).some((block) => !block.type))) {
    return { ...base, mode: 'unavailable', note: LIMITS_UNREAD, blockedIds: all.filter((item) => blocksOf(item).some((block) => block.type)).map(idOf) };
  }
  const isCapped = (item) => blocksOf(item).length > 0;
  // Only the yearly count hands the visit to the replacement; any other limit on the lead (a
  // minimum interval, a blackout) just holds the weed mix, with the limit's own words.
  const yearlyCapped = (item) => blocksOf(item).some((block) => block.type === YEARLY_CAP);
  if (isCapped(lead) && !yearlyCapped(lead)) return { ...base, note: blocksOf(lead)[0].message || WEED_LIMIT_REACHED };
  if (isCapped(lead)) {
    if (replacement && !isCapped(replacement)) {
      return {
        ...base,
        mode: 'replacement',
        productIds: [idOf(replacement)],
        note: `${shortName(lead.product.name)} yearly limit reached; ${shortName(replacement.product.name)} is used in its place.`,
      };
    }
    return { ...base, note: WEED_LIMIT_REACHED };
  }
  return leadMix({ base, lead, members, isCapped, svc, readTemp });
}

module.exports = { SURFACTANT_MAX_TEMP_F, weedMixGroup, buildWeedMix, currentTempF };
