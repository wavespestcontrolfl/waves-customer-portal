'use strict';

/**
 * WaveGuard perk: the pet-named line in the completion text (perks round 4, owner 2026-10-31;
 * "continue working on" 2026-11-01). GATE_PET_NAME_TEXT, dark until the owner approves the words.
 *
 * One sentence that names the customer's dogs and cats and says when they can go back out. It is
 * never composed: it is one row of the closed table below, picked by the re-entry decision the
 * service report already prints for this visit (service-report/reentry.js buildReentryContext), so
 * the text never says more than the report does. No time or minute figure, no "safe" (AGENTS.md
 * compliance language), and every finished line still goes through customerCopyViolations.
 *
 *   what the report prints for the visit                         the pet line
 *   lawn condition 'dry' (frozen lawnReportFacts)                <names> can go back on the lawn once the application has dried.
 *   lawn condition 'watered_in_and_dry'                          <names> can go back on the lawn once you have watered it in and the grass is dry again.
 *   a pest or mosquito "until dry" advisory, outside only        <names> can go back out once the spray has dried.
 *     the same advisory, inside only                             <names> can go back into the treated rooms once the spray has dried.
 *     the same advisory, inside and outside                      <names> can go back inside and out once the spray has dried.
 *   the lawn turf advisory                                       <names> can go back on the lawn once it is dry.
 *   the tree and shrub advisory                                  <names> can go back near the treated beds once they are dry.
 *   the palm advisory                                            <names> can go back near the palms once the beds around them are dry.
 *   anything else: bait or station work, no re-entry on the report, an advisory not in the table -> no line
 *
 * Names come from property_preferences.pets_structured (the customer app's Pets editor; older rows
 * say `species` where the app says `type`). Only dogs and cats, or a pet with no type: a pet marked
 * Other may be a fish or a bird. An indoor pet is left out of an outside-only line and an outdoor pet
 * out of an inside-only line. One to three names; none, or four and more, means no line, so a long
 * list never crowds the text. WaveGuard members only (isMembershipCustomerRow), and only on a visit at
 * the member's home: a visit stamped at another address gets no line.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isMembershipCustomerRow } = require('./waveguard-existing-services');
const { VISIT_HOME_COLUMNS, visitAtCustomerHome } = require('./stamped-address');

// Pet names arrive as free text from the customer; anything else in an entry is ignored.
const MAX_NAMES = 3;
const MAX_NAME_LENGTH = 20;
const NAME_SHAPE = /^\p{L}[\p{L}\p{M}' .-]*$/u;
// Entries that are a description, not a name.
const NOT_A_NAME = new Set([
  'dog', 'dogs', 'cat', 'cats', 'pet', 'pets', 'puppy', 'kitten', 'none', 'no', 'yes', 'na', 'n/a',
  'unknown', 'tbd', 'other', 'name', 'the dog', 'the cat',
]);
const YARD_TYPES = new Set(['', 'dog', 'cat', 'dogs', 'cats', 'puppy', 'kitten']);

// The advisory sentences the report stores per visit (service-line-configs.js advisoryDefaults, and
// the older pest default some records still carry), by the place the line talks about.
const SPRAY_ADVISORIES = new Set([
  'Keep people and pets off treated areas until sprays have dried.',
  'Keep pets off treated zones until dry.',
]);
const ADVISORY_PLACE = Object.freeze({
  'Keep pets off treated turf until dry.': 'turf',
  'Keep pets off treated beds and foliage until dry.': 'beds',
  'Keep pets away from treated palms and surrounding beds until dry.': 'palms',
});

const LINE_ENDINGS = Object.freeze({
  lawn_dry: 'can go back on the lawn once the application has dried.',
  lawn_watered_in_and_dry: 'can go back on the lawn once you have watered it in and the grass is dry again.',
  spray_outside: 'can go back out once the spray has dried.',
  spray_inside: 'can go back into the treated rooms once the spray has dried.',
  spray_inside_and_out: 'can go back inside and out once the spray has dried.',
  turf: 'can go back on the lawn once it is dry.',
  beds: 'can go back near the treated beds once they are dry.',
  palms: 'can go back near the palms once the beds around them are dry.',
});

// Which pets the line may name: an outside line skips indoor pets, an inside line outdoor pets.
const SCOPE_SKIPS = Object.freeze({ outside: 'indoor', inside: 'outdoor', both: null });

function parsePets(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// A name as the customer would write it: "biscuit" and "BISCUIT" read "Biscuit"; "McFly" stays.
function cleanName(value) {
  const text = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_NAME_LENGTH || !NAME_SHAPE.test(text)) return null;
  if (NOT_A_NAME.has(text.toLowerCase())) return null;
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/(^|[ '-])(\p{L})/gu, (m, sep, letter) => `${sep}${letter.toUpperCase()}`);
}

/**
 * The pets a line may name: [{ name, where }] with where 'indoor' | 'outdoor' | '' (both or not
 * said), in the customer's order, one entry per name.
 */
function yardPets(petsStructured) {
  const seen = new Set();
  const pets = [];
  for (const pet of parsePets(petsStructured)) {
    if (!pet || typeof pet !== 'object') continue;
    const type = String(pet.type || pet.species || '').trim().toLowerCase();
    const name = cleanName(pet.name);
    if (!YARD_TYPES.has(type) || !name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const where = String(pet.indoor || '').trim().toLowerCase();
    pets.push({ name, where: where === 'indoor' || where === 'outdoor' ? where : '' });
  }
  return pets;
}

function joinNames(names) {
  if (names.length < 2) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// The table row and the pet scope for this visit's re-entry, or null for no line.
function lineKind(reentry) {
  if (!reentry) return null;
  if (reentry.condition) {
    const kind = `lawn_${reentry.condition.rule}`;
    return LINE_ENDINGS[kind] ? { kind, scope: 'outside' } : null;
  }
  const advisory = String(reentry.petAdvisory || '').trim();
  const keys = new Set((Array.isArray(reentry.targets) ? reentry.targets : []).map((t) => t && t.key));
  if (!keys.size) return null;
  if (SPRAY_ADVISORIES.has(advisory)) {
    if (keys.has('interior') && keys.has('exterior')) return { kind: 'spray_inside_and_out', scope: 'both' };
    return keys.has('interior') ? { kind: 'spray_inside', scope: 'inside' } : { kind: 'spray_outside', scope: 'outside' };
  }
  const place = ADVISORY_PLACE[advisory];
  return place && keys.has('exterior') ? { kind: place, scope: 'outside' } : null;
}

/** The finished sentence for these pets and this re-entry context, or '' when there is none. */
function petLine(petsStructured, reentry) {
  const kind = lineKind(reentry);
  if (!kind) return '';
  const skip = SCOPE_SKIPS[kind.scope];
  const names = yardPets(petsStructured).filter((p) => p.where !== skip).map((p) => p.name);
  if (!names.length || names.length > MAX_NAMES) return '';
  const line = `${joinNames(names)} ${LINE_ENDINGS[kind.kind]}`;
  // Names are customer free text: the finished line takes the complete report-copy screen.
  const { customerCopyViolations } = require('./service-report/technician-report-copy');
  return customerCopyViolations(line).length ? '' : line;
}

/**
 * The pet line for a just-completed visit's text, or ''. Reads the customer's pets and the visit's
 * record fresh (the re-entry facts are frozen during the closeout), and never throws: a failed read
 * costs the customer only this one sentence, never the text.
 */
async function petLineForCompletion({ customerId, recordId, knex = db } = {}) {
  if (!customerId || !recordId) return '';
  try {
    const gates = require('../config/feature-gates');
    if (typeof gates.petNameTextLive !== 'function' || !gates.petNameTextLive()) return '';
    const prefs = await knex('property_preferences').where({ customer_id: customerId }).first('pets_structured');
    if (!yardPets(prefs?.pets_structured).length) return '';
    const record = await knex('service_records').where({ id: recordId }).first();
    if (!record) return '';
    // A WaveGuard member perk about the member's home, in one read of the visit and its customer: a non-member, or a
    // visit stamped at another address or another unit (the home's pets do not live there), gets no line.
    const visit = record.scheduled_service_id
      ? await knex('scheduled_services as ss')
        .join('customers as c', 'c.id', 'ss.customer_id')
        .where('ss.id', record.scheduled_service_id)
        .first('c.waveguard_tier', 'c.monthly_rate', ...VISIT_HOME_COLUMNS)
      : null;
    if (!visit || !isMembershipCustomerRow(visit) || !visitAtCustomerHome(visit)) return '';
    const { buildReentryContext } = require('./service-report/reentry');
    return petLine(prefs.pets_structured, await buildReentryContext({ record, knex }));
  } catch (err) {
    logger.warn(`[pet-name-line] pet line skipped for record ${recordId}: ${err.message}`);
    return '';
  }
}

module.exports = {
  petLine,
  petLineForCompletion,
  yardPets,
  LINE_ENDINGS,
};
