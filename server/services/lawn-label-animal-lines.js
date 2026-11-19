'use strict';

/**
 * Label warning lines for the technician's lawn visit brief (owner 2026-11-15, decision 6 A "label flags"). No gate: it sends nothing.
 *
 * The customer's Pets form has four kinds besides Dog, Cat and Other. A technician working a lawn treatment visit sees one fixed
 * warning for each of those kinds on file, with the product names. Code picks the lines from the closed table below, never AI. A
 * grouped stop is judged per member: only a member whose own service type is a lawn treatment carries the warnings.
 *
 *   stored type     shown label                       lines
 *   Grass eater     Animals that eat grass            GRAZING
 *   Birds           Chickens or other birds           GRAZING, BIRDS   (chickens graze)
 *   Fish pond       Fish pond                         FISH
 *   Beehives        Beehives                          BEES
 *
 * Dog, Cat, Other and a blank kind get no warning (the Access section already lists them).
 *
 * Source of every claim below: the lawn product label research of 2026-11-14 (27 products, quotes with PDF pages), on the owner's
 * Mac: ~/lawn-pet-labels-20261114/labels-pets.md (the "Patterns" section) and summary-table.md. Nothing here comes from outside
 * those two files, except the LESCO Crosscheck Plus lines, which come from its label (SiteOne D00001542, read 2026-11-18; the house
 * bifenthrin since owner ruling 2026-11-18): extremely toxic to fish, highly toxic to bees, avoid fish and reptile pets in ornamental
 * ponds, and (page 7) no ground application within 25 feet of the waters the line names, never sprayed into fish pools or ponds.
 * Wording choices that follow the files and not the owner's decision-page text:
 *   - no "no waiting time" phrase: the files give no waiting time either way, only flat no-graze and no-feed lines;
 *   - Tetrino has its own bee line: its label says no contact with plants in bloom, not "while bees forage" (Arena and Merit 2F say that);
 *   - Topchoice's far distance reads "estuarine water", the label's word for the 60 ft rule.
 * The lists are the labels' own; a product the files do not name for a topic is not listed. Re-check the files before editing a line.
 *
 * The pet names are the customer's free text from property_preferences.pets_structured (the Pets form writes `type`; older rows say
 * `species`); a blank name reads "no name". Any read or parse failure returns no warnings, never an error: the brief must still load.
 */

const logger = require('./logger');

const GRAZING = 'Labels say no grazing on the treated lawn and no clippings as feed: Stonewall, Prodiamine 65 WG, Merit 2F, Advion, Heritage G, Heritage WDG, Headway, Headway G, T-Storm Flowable, T-Storm 2G. T-Storm names poultry.';
const BIRDS = 'Toxic to birds: Topchoice (spread evenly to reduce the risk to birds) and Dylox.';
const FISH = 'Toxic to fish: Dimension, Talstar P, Talak, LESCO Crosscheck Plus, Advion, Topchoice, Dylox, Artavia, Heritage G, Heritage WDG, Headway, Headway G, Velista. Lawn distance from water: Topchoice 15 ft (fresh water) or 60 ft (estuarine water), Tetrino 25 ft, LESCO Crosscheck Plus 25 ft (lakes, reservoirs, rivers, permanent streams, marshes, natural ponds, estuaries and commercial fish farm ponds; never spray it into fish pools, ponds, streams or lakes). Talstar P and LESCO Crosscheck Plus: avoid fish and reptile pets in ornamental ponds.';
const BEES = 'Toxic to bees: Talstar P, Talak, LESCO Crosscheck Plus, Arena, Merit 2F, Alpine, Tetrino. No contact with blooming plants while bees forage: Arena, Merit 2F. Tetrino: no contact with blooming plants; manage flowering weeds for 10 days; keep a 10 ft downwind buffer when blooming plants are within 10 ft of the downwind edge.';

// Stored `type` values, lower case (matched case-insensitively), in the order the warnings are shown.
const KINDS = Object.freeze([
  { type: 'grass eater', kind: 'grass_eater', label: 'Animals that eat grass', lines: [GRAZING] },
  { type: 'birds', kind: 'birds', label: 'Chickens or other birds', lines: [GRAZING, BIRDS] },
  { type: 'fish pond', kind: 'fish_pond', label: 'Fish pond', lines: [FISH] },
  { type: 'beehives', kind: 'beehives', label: 'Beehives', lines: [BEES] },
]);
const BY_TYPE = new Map(KINDS.map((entry) => [entry.type, entry]));

const NO_NAME = 'no name';
const MAX_NAME_LENGTH = 30;

function parsePets(value) {
  let pets = value;
  if (typeof pets === 'string') {
    try { pets = JSON.parse(pets); } catch { return []; }
  }
  return Array.isArray(pets) ? pets : [];
}

function petName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return text || NO_NAME;
}

/**
 * [{ kind, label, names, lines }] for the new animal kinds in a pets_structured value (array or JSON string), in the table's order.
 * Pure: no lawn check here (labelAnimalWarningsForVisit adds it). A line already shown by an earlier warning is not repeated.
 */
function labelAnimalWarnings(petsStructured) {
  const namesByKind = new Map();
  for (const pet of parsePets(petsStructured)) {
    if (!pet || typeof pet !== 'object') continue;
    const entry = BY_TYPE.get(String(pet.type || pet.species || '').trim().toLowerCase());
    if (!entry) continue;
    const names = namesByKind.get(entry) || [];
    const name = petName(pet.name);
    if (!names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name);
    namesByKind.set(entry, names);
  }
  const shown = new Set();
  const warnings = [];
  for (const entry of KINDS) {
    const names = namesByKind.get(entry);
    if (!names) continue;
    const lines = entry.lines.filter((line) => !shown.has(line));
    lines.forEach((line) => shown.add(line));
    warnings.push({ kind: entry.kind, label: entry.label, names, lines });
  }
  return warnings;
}

/**
 * The warnings for one scheduled_services row (`svc`) and the customer's property_preferences row: [] unless the row's own service
 * type is a lawn treatment at the customer's home. Never throws.
 */
async function labelAnimalWarningsForVisit(svc, prefs, dbh) {
  try {
    if (!svc || !prefs) return [];
    const { isLawnTreatmentServiceType } = require('./lawn-treatment-visit');
    if (!isLawnTreatmentServiceType(svc.service_type)) return [];
    const warnings = labelAnimalWarnings(prefs.pets_structured);
    if (!warnings.length) return [];
    // Pets are the customer's own home's: a visit stamped at another address says nothing about them.
    if (svc.service_address_line1) {
      const { visitAtCustomerHome } = require('./stamped-address');
      const home = await dbh('customers').where({ id: svc.customer_id }).first('address_line1', 'address_line2', 'city', 'zip');
      if (!home || !visitAtCustomerHome({ ...svc, ...home })) return [];
    }
    return warnings;
  } catch (err) {
    logger.warn(`[lawn-label-animal-lines] warnings skipped for visit ${svc?.id}: ${err.message}`);
    return [];
  }
}

module.exports = { labelAnimalWarnings, labelAnimalWarningsForVisit, KINDS };
