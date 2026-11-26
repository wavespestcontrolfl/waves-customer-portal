'use strict';
// Facts staff know and the texting agent may state (owner 2026-11-25, texting AI fix step 2: "feed the facts staff know"): a customer's
// prepaid visits left, and the prep guide of the visit they have booked. This module only READS the numbers and the guide text; the AI
// never sees the numbers raw:
//   - the prepaid visit counts become one finished sentence each in payment-status-contract.js (the same copy-verbatim contract as the
//     plan price and the balance, PR #5331), so a count the AI writes in its own words is held;
//   - guide text reaches the facts block as the PREP GUIDE section (sms-shadow-drafter.js prepGuideSection), screened there.
// Never a technician note or a visit note: counts and published template text only. Every read fails soft to "no fact": an unreadable
// plan, visit or template renders nothing, never a guess.

const logger = require('./logger');

/**
 * The customer's prepaid recurring plans (prepaid-series.listCustomerPrepaidPlans, the same rollup the appointment screens show), as
 * { label, remaining, paid }. null when the read failed; [] when there is none.
 */
async function loadPrepaidPlanFacts(customerId, { db } = {}) {
  if (!customerId || !db) return null;
  try {
    const plans = await require('./prepaid-series').listCustomerPrepaidPlans(db, customerId);
    return plans
      .map((plan) => ({ label: String(plan.serviceType || ''), remaining: Number(plan.remainingVisits), paid: Number(plan.paidVisits) }))
      .filter((plan) => plan.label && Number.isInteger(plan.remaining) && Number.isInteger(plan.paid) && plan.paid > 0 && plan.remaining >= 0 && plan.remaining <= plan.paid);
  } catch (err) {
    logger.warn(`[sms-staff-facts] prepaid plans unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// ---- Prep guides ---------------------------------------------------------------------------------------------------------------------

// A published guide as its own sections, in order: { heading, parts } for each heading and the paragraphs, callouts and list items under it
// (never the service details rows, the button or the signature). The heading rides with its sentences, so a guide that covers two
// treatments ("Prep for a German roach cleanout", "Prep for palmetto bugs") keeps each one's steps under its own name, and no sentence moves
// away from the heading, list or sentence that gives it its subject.
function sectionsOfBlocks(blocks) {
  const sections = [{ heading: null, parts: [] }];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'heading') sections.push({ heading: String(block.content || '').replace(/\s+/g, ' ').trim() || null, parts: [] });
    else if (['paragraph', 'callout'].includes(block.type) && typeof block.content === 'string') sections[sections.length - 1].parts.push(block.content);
    else if (block.type === 'list' && Array.isArray(block.items)) sections[sections.length - 1].parts.push(...block.items.filter((item) => typeof item === 'string'));
  }
  return sections;
}

// What reads as a usable sentence of a guide: no merge tags, links, addresses, em dashes, nor wording that points at the email or page itself.
const usableSentence = (sentence) => sentence.length >= 4 && sentence.length <= 260 // (a list item can be one word: "Houseplants.")
  && !/\{\{|\]\(|https?:|www\.|@|\u2014/.test(sentence)
  && !/\b(?:e-?mail|inbox|button|below|above|this (?:guide|page))\b/i.test(sentence);

/**
 * The prep guide of the customer's booked visit: the soonest upcoming visit a guide covers, chosen by the prep senders' own eligibility
 * (prep-guide-sender.nextGuideVisit: one helper for the senders and for this lookup, so a visit the senders would not prep is never
 * read here). Only that visit's guide: its published email template as { key, label, sections: [{ heading, sentences }] }, in the guide's
 * own order. Merge tags and links are dropped here; the drafter screens what is left (banned claims, prompt-control text) and caps the
 * section. null when no booked visit has a guide or the template cannot be read. Never reads notes.
 */
async function loadPrepGuideFacts(customerId, { db } = {}) {
  if (!customerId || !db) return null;
  let key = null;
  try {
    const sender = require('./prep-guide-sender');
    const booked = await sender.nextGuideVisit(customerId);
    key = booked?.key || null;
    const config = key ? sender.PREP_CONFIG[key] : null;
    if (!config) return null;
    // the published version the guide page and the senders serve (the template's active_version_id), not any version marked active
    const loaded = await require('./email-template-library').loadTemplateByKey(config.emailTemplateKey, db);
    if (!loaded?.activeVersion) return null;
    const blocks = typeof loaded.activeVersion.blocks === 'string' ? JSON.parse(loaded.activeVersion.blocks) : loaded.activeVersion.blocks;
    const sections = sectionsOfBlocks(blocks)
      .map(({ heading, parts }) => ({ heading, sentences: parts.flatMap((part) => String(part).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)).map((raw) => raw.trim()).filter(usableSentence) }))
      .filter((section) => section.sentences.length);
    return sections.length ? { key, label: config.label, sections } : null;
  } catch (err) {
    logger.warn(`[sms-staff-facts] prep guide unavailable for customer ${customerId}${key ? ` (guide ${key})` : ''}: ${err.message}`);
    return null;
  }
}

module.exports = { loadPrepaidPlanFacts, loadPrepGuideFacts, sectionsOfBlocks };
