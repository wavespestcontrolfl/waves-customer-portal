/**
 * Technician note for a lawn visit that froze no watering instruction because
 * the products' watering clashes (owner 2026-10-24: "I dont want an office
 * alert for this"; the plan: "the tech gets a note at completion to water the
 * Dylox in on site").
 *
 * Two reasons only: `water_in_conflict` (one product needs a water-in while
 * another needs time with no water) and `same_day_too_late` (a water-in is due
 * today but the visit ended too late for the customer to run a full watering).
 * The visit's technician gets a Today-screen card (tech_notifications, type
 * `lawn_watering_tech_note`) instead of an office alert: too late with no hold,
 * water the product in on site; a clash, never water during the hold (it is a
 * label direction, or the label ladder would have shortened it), and ask the
 * customer to water in as soon as the no-water time is over. Every other reason keeps the
 * office alert (lawn-watering-sms.js).
 *
 * The caller falls back to the office alert when this returns null (no
 * technician on the visit, or the card could not be written), so someone always
 * hears. Best-effort: never throws.
 */
const logger = require('../logger');

const TECH_NOTE_TYPE = 'lawn_watering_tech_note';
const TECH_NOTE_REASONS = Object.freeze(['water_in_conflict', 'same_day_too_late']);
const TECH_NOTE_HEADLINE = 'Water this in before you leave';
// A clash leaves a hold no label lets end early: nobody waters during it.
const CLASH_HEADLINE = 'Do not water this lawn now';
const OTHER_PRODUCT = 'another product on this visit';

const names = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n.trim() !== '') : []);

// W = the product(s) to water in; H = the product(s) that need time with no water.
function techNoteMessage(noClaim) {
  const waterInNames = names(noClaim.waterInProducts);
  const waterIns = waterInNames.length ? waterInNames : names(noClaim.products).slice(0, 1);
  const w = waterIns.join(' and ') || 'A product';
  if (noClaim.reason === 'same_day_too_late') {
    return `${w} must be watered in today, and this visit ended too late for the customer to run a full watering. Water ${waterIns.length > 1 ? 'them' : 'it'} in on site before you leave.`;
  }
  const holds = names(noClaim.holdProducts);
  const h = holds.join(' and ') || OTHER_PRODUCT;
  const needs = (list) => (list.length > 1 ? 'need' : 'needs');
  return `Do not water now: ${h} ${needs(holds)} time with no water. ${w} ${needs(waterIns)} watering in, and no time is left today for both, so the customer got no watering text. Ask the customer to water ${w} in as soon as the no-water time for ${h} is over. Next time, water ${w} in before you apply ${h}.`;
}

// Only the fields the visit row actually carries: first_name / last_name come
// from the customer join; the visit's own address stamp is service_address_*.
function techNotePayload({ svc, noClaim }) {
  const customerName = [svc.first_name, svc.last_name].filter(Boolean).join(' ').trim();
  const street = [svc.service_address_line1, svc.service_address_city].filter(Boolean).join(', ');
  return {
    headline: noClaim.reason === 'water_in_conflict' ? CLASH_HEADLINE : TECH_NOTE_HEADLINE,
    ...(customerName ? { customer_name: customerName } : {}),
    ...(svc.service_address_line1 ? { address: street } : {}),
    service_id: svc.id,
    reason: noClaim.reason,
  };
}

// One card per visit, atomically: the visit's marker is claimed only while it
// is absent, and the card row is written in the same transaction, so two
// callers never both write a card and a failed card leaves no claim.
async function claimAndWriteCard({ record, svc, noClaim, marker }, deps) {
  const database = deps.db || require('../../models/db');
  const send = deps.sendTechNotification || require('../tech-notify').sendTechNotification;
  try {
    return await database.transaction(async (trx) => {
      const claimed = await trx('service_records')
        .where({ id: record.id })
        .whereRaw("NOT jsonb_exists(COALESCE(structured_notes::jsonb, '{}'::jsonb), 'lawnWateringTechNoteAt')")
        .update({ structured_notes: trx.raw("COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb", [JSON.stringify(marker)]) });
      if (!claimed) return 'claimed_before';
      const written = await send(svc.technician_id, {
        type: TECH_NOTE_TYPE,
        message: techNoteMessage(noClaim),
        payload: techNotePayload({ svc, noClaim }),
      }, { knex: trx });
      if (written !== true) throw new Error('card not written');
      return 'written';
    });
  } catch (err) {
    logger.warn(`[lawn-watering-sms] tech note failed for service ${svc.id}: ${err.message}`);
    return null;
  }
}

/**
 * @returns {Promise<string|null>} 'tech_noted_no_instruction' when the visit is
 *   handled (card written now, or already written earlier), or null when the
 *   caller must raise the office alert.
 */
async function sendWateringTechNote({ record, svc, notes, noClaim }, deps) {
  if (!noClaim || !TECH_NOTE_REASONS.includes(noClaim.reason)) return null;
  // One card per visit: a resumed completion never writes a second one.
  if (notes && notes.lawnWateringTechNoteAt) return 'tech_noted_no_instruction';
  if (!svc.technician_id) return null;
  const marker = {
    lawnWateringSmsStatus: 'skipped_no_instruction',
    lawnWateringNoClaimReason: noClaim.reason,
    lawnWateringTechNoteAt: new Date().toISOString(),
  };
  const outcome = await claimAndWriteCard({ record, svc, noClaim, marker }, deps);
  if (!outcome) return null;
  if (outcome === 'written' && notes) Object.assign(notes, marker);
  return 'tech_noted_no_instruction';
}

module.exports = { sendWateringTechNote, techNoteMessage, TECH_NOTE_TYPE, TECH_NOTE_REASONS, TECH_NOTE_HEADLINE, CLASH_HEADLINE };
