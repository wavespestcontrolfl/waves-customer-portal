'use strict';

/**
 * The lawn pre-visit lines of the 24-hour reminder text (owner 2026-11-14). GATE_LAWN_PREVISIT_LINE, dark until the owner flips it.
 *
 * A lawn treatment visit at the customer's home gets one fixed sentence in its 24-hour reminder. It is never composed: it is one of
 * two rows of the closed table below, and code picks the row.
 *
 *   the visit day is not the home's one lawful watering day   Please keep sprinklers off tonight and tomorrow morning, unlock the gate, and keep <who> inside while we treat.
 *   the visit day is the home's one lawful watering day       Please unlock the gate and keep <who> inside while we treat.
 *
 * <who> is the customer's dog and cat names from property_preferences.pets_structured ("Biscuit", "Biscuit and Mochi", "Biscuit, Mochi
 * and Rex"); no name, or four and more, reads "pets". A customer with no pet on file also gets a second paragraph that links to the
 * Property tab where pets are added. No short link and no write.
 *
 * The home's watering day comes from the last digit of the house number (config/irrigation-restrictions.js
 * wateringWeekdayForAddress) and counts only under a policy that covers the customer's county with one day a week. No policy, no
 * coverage or no house number = the normal sentence.
 *
 * No time or minute figure and no "safe" (AGENTS.md compliance language). Pet names are customer free text, so the finished text takes
 * the complete report-copy screen; a violation retries with the word "pets", and a second violation sends no lawn text.
 * lawnPrevisitLineForVisit never throws: any failure sends today's reminder.
 */

const db = require('../models/db');
const logger = require('./logger');
const { yardPets } = require('./pet-name-line');
const { VISIT_HOME_COLUMNS, visitAtCustomerHome } = require('./stamped-address');
const { isLawnTreatmentVisit } = require('./lawn-treatment-visit');
const { currentRestrictionPolicy, resolveRestrictionCounty, wateringWeekdayForAddress } = require('../config/irrigation-restrictions');
const { countyConfirmedAfterMove } = require('./irrigation-schedule-confirmation');
const { publicPortalUrl } = require('../utils/portal-url');
const { stripSmsUrlScheme } = require('./messaging/sms-link-policy');
const { etParts } = require('../utils/datetime-et');

const MAX_NAMES = 3;
const NORMAL_SENTENCE = (who) => `Please keep sprinklers off tonight and tomorrow morning, unlock the gate, and keep ${who} inside while we treat.`;
const WATERING_DAY_SENTENCE = (who) => `Please unlock the gate and keep ${who} inside while we treat.`;
const SENDABLE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

function joinNames(names) {
  if (names.length < 2) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// "Biscuit and Mochi", or "pets" for no name and for four and more.
function whoFor(petsStructured) {
  const names = yardPets(petsStructured).map((pet) => pet.name);
  return names.length >= 1 && names.length <= MAX_NAMES ? joinNames(names) : 'pets';
}

// Any entry at all, of any species. A JSON string is read the way yardPets reads it.
function hasPetOnFile(petsStructured) {
  let pets = petsStructured;
  if (typeof pets === 'string') {
    try { pets = JSON.parse(pets); } catch { return false; }
  }
  return Array.isArray(pets) && pets.some((pet) => pet && typeof pet === 'object');
}

function petLinkLine() {
  return `Have pets? Add them here: ${stripSmsUrlScheme(`${publicPortalUrl()}/?tab=property#pets`)}`;
}

/**
 * The lawn text for these plain inputs, or '' when it fails the copy screen. wateringDayClash: the visit day is the home's one lawful
 * watering day. The pet link paragraph is added only when the customer has no pet on file.
 */
function buildLawnPrevisitLine({ petsStructured, wateringDayClash = false } = {}) {
  const { customerCopyViolations } = require('./service-report/technician-report-copy');
  const sentenceFor = wateringDayClash ? WATERING_DAY_SENTENCE : NORMAL_SENTENCE;
  const finish = (who) => {
    const sentence = sentenceFor(who);
    return hasPetOnFile(petsStructured) ? sentence : `${sentence}\n\n${petLinkLine()}`;
  };
  const named = finish(whoFor(petsStructured));
  if (!customerCopyViolations(named).length) return named;
  const plain = finish('pets');
  return customerCopyViolations(plain).length ? '' : plain;
}

async function visitServiceTypes(knex, visit) {
  if (!visit.visit_id) return [visit.service_type];
  const rows = await knex('scheduled_services').where({ visit_id: visit.visit_id }).whereIn('status', SENDABLE_STATUSES).select('service_type');
  return rows.length ? rows.map((row) => row.service_type) : [visit.service_type];
}

// True when the visit day is the home's one lawful watering day: a policy in force on that day covers the county, allows one day a week
// and names this weekday for the house number.
async function wateringDayClashFor(knex, { customerId, home, apptTime }) {
  const weekday = wateringWeekdayForAddress(home.address_line1);
  if (!weekday) return false;
  const prefs = (await knex('property_preferences').where({ customer_id: customerId }).first('irrigation_home_changed_at', 'irrigation_confirmed_fields')) || {};
  const turf = (await knex('customer_turf_profiles').where({ customer_id: customerId, active: true }).first('county', 'city')) || {};
  const movedAt = prefs.irrigation_home_changed_at || null;
  const county = resolveRestrictionCounty({
    county: turf.county || null, profileCity: turf.city || null, city: home.city, zip: home.zip,
    homeMoved: !!movedAt, movedAt, countyConfirmed: countyConfirmedAfterMove(prefs),
  });
  const policy = currentRestrictionPolicy(apptTime, { county });
  return Boolean(policy) && policy.maxDaysPerWeek === 1 && etParts(apptTime).dayOfWeek === weekday;
}

/**
 * The lawn text for a visit's 24-hour reminder, or '' (gate off, not a lawn treatment visit, not at the customer's home, or any
 * failure). Reads only after the gate is on.
 */
async function lawnPrevisitLineForVisit({ scheduledServiceId, customerId, apptTime, knex = db } = {}) {
  if (!scheduledServiceId || !customerId || !(apptTime instanceof Date)) return '';
  try {
    const gates = require('../config/feature-gates');
    if (typeof gates.lawnPrevisitLineLive !== 'function' || !gates.lawnPrevisitLineLive()) return '';
    const visit = await knex('scheduled_services as ss')
      .join('customers as c', 'c.id', 'ss.customer_id')
      .where('ss.id', scheduledServiceId)
      .first('ss.service_type', 'ss.visit_id', ...VISIT_HOME_COLUMNS);
    if (!visit || !visitAtCustomerHome(visit)) return '';
    if (!isLawnTreatmentVisit(await visitServiceTypes(knex, visit))) return '';
    const prefs = await knex('property_preferences').where({ customer_id: customerId }).first('pets_structured');
    const wateringDayClash = await wateringDayClashFor(knex, { customerId, home: visit, apptTime });
    return buildLawnPrevisitLine({ petsStructured: prefs?.pets_structured, wateringDayClash });
  } catch (err) {
    logger.warn(`[lawn-previsit-line] lawn line skipped for visit ${scheduledServiceId}: ${err.message}`);
    return '';
  }
}

module.exports = { buildLawnPrevisitLine, lawnPrevisitLineForVisit };
