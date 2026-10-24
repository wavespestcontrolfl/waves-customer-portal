/**
 * Technician note for a lawn visit that froze no watering instruction because
 * the products' watering clashes (owner 2026-10-24: "I dont want an office
 * alert for this"; the plan: "the tech gets a note at completion to water the
 * Dylox in on site").
 *
 * Two reasons only: `water_in_conflict` (one product needs a water-in while
 * another needs time with no water) and `same_day_too_late` (a water-in is due
 * today but the visit ended too late for the customer to run a full watering).
 * Both are fixed by the technician watering the product in before leaving, so
 * the visit's technician gets a Today-screen card (tech_notifications, type
 * `lawn_watering_tech_note`) instead of an office alert. Every other reason
 * keeps the office alert (lawn-watering-sms.js).
 *
 * The caller falls back to the office alert when this returns null (no
 * technician on the visit, or the card could not be written), so someone always
 * hears. Best-effort: never throws.
 */
const logger = require('../logger');

const TECH_NOTE_TYPE = 'lawn_watering_tech_note';
const TECH_NOTE_REASONS = Object.freeze(['water_in_conflict', 'same_day_too_late']);
const TECH_NOTE_HEADLINE = 'Water this in before you leave';
const OTHER_PRODUCT = 'another product on this visit';

const names = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n.trim() !== '') : []);

// W = the product(s) to water in; H = the product(s) that need time with no water.
function techNoteMessage(noClaim) {
  const waterIn = names(noClaim.waterInProducts);
  const w = (waterIn.length ? waterIn : names(noClaim.products).slice(0, 1)).join(' and ') || 'A product';
  if (noClaim.reason === 'same_day_too_late') {
    return `${w} must be watered in today, and this visit ended too late for the customer to run a full watering. Water it in on site before you leave.`;
  }
  const h = names(noClaim.holdProducts).join(' and ') || OTHER_PRODUCT;
  return `${w} needs watering in, and ${h} needs time with no water. No text to the customer can do both. Water ${w} in on site before you leave. Next time, water it in before you apply ${h}.`;
}

// Only the fields the visit row actually carries: first_name / last_name come
// from the customer join; the visit's own address stamp is service_address_*.
function techNotePayload({ svc, noClaim }) {
  const customerName = [svc.first_name, svc.last_name].filter(Boolean).join(' ').trim();
  const street = [svc.service_address_line1, svc.service_address_city].filter(Boolean).join(', ');
  return {
    headline: TECH_NOTE_HEADLINE,
    ...(customerName ? { customer_name: customerName } : {}),
    ...(svc.service_address_line1 ? { address: street } : {}),
    service_id: svc.id,
    reason: noClaim.reason,
  };
}

async function writeTechNoteCard({ svc, noClaim }, deps) {
  const send = deps.sendTechNotification || require('../tech-notify').sendTechNotification;
  try {
    return (await send(svc.technician_id, {
      type: TECH_NOTE_TYPE,
      message: techNoteMessage(noClaim),
      payload: techNotePayload({ svc, noClaim }),
    })) === true;
  } catch (err) {
    logger.warn(`[lawn-watering-sms] tech note failed for service ${svc.id}: ${err.message}`);
    return false;
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
  if (!(await writeTechNoteCard({ svc, noClaim }, deps))) return null;
  try {
    const marker = {
      lawnWateringSmsStatus: 'skipped_no_instruction',
      lawnWateringNoClaimReason: noClaim.reason,
      lawnWateringTechNoteAt: new Date().toISOString(),
    };
    await deps.mergeNotes(record.id, marker);
    Object.assign(notes, marker);
  } catch (err) {
    logger.warn(`[lawn-watering-sms] tech-note marker write failed for service_record ${record.id}: ${err.message}`);
  }
  return 'tech_noted_no_instruction';
}

module.exports = { sendWateringTechNote, techNoteMessage, TECH_NOTE_TYPE, TECH_NOTE_REASONS, TECH_NOTE_HEADLINE };
