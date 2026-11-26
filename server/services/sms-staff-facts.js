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

// The text parts of a published guide's blocks that read as prose: paragraphs, callouts and list items (never a heading, the service
// details rows, the button or the signature).
function proseOfBlocks(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (['paragraph', 'callout'].includes(block.type) && typeof block.content === 'string') parts.push(block.content);
    if (block.type === 'list' && Array.isArray(block.items)) parts.push(...block.items.filter((item) => typeof item === 'string'));
  }
  return parts;
}

/**
 * The prep guide of the customer's booked visit: the soonest upcoming visit a guide covers, chosen by the prep senders' own eligibility
 * (prep-guide-sender.nextGuideVisit: one helper for the senders and for this lookup, so a visit the senders would not prep is never
 * read here). Only that visit's guide: the sentences of its ACTIVE email template, as { key, label, sentences }. Merge tags and links are
 * dropped here; the drafter screens what is left (banned claims, prompt-control text) and caps the section. null when no booked visit
 * has a guide or the template cannot be read. Never reads notes.
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
    const row = await db('email_templates as t')
      .join('email_template_versions as v', 'v.template_id', 't.id')
      .where({ 't.template_key': config.emailTemplateKey, 'v.status': 'active' })
      .orderBy('v.version_number', 'desc')
      .first('v.blocks');
    if (!row) return null;
    const blocks = typeof row.blocks === 'string' ? JSON.parse(row.blocks) : row.blocks;
    const sentences = [];
    for (const part of proseOfBlocks(blocks)) {
      for (const raw of String(part).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)) {
        const sentence = raw.trim();
        if (sentence.length < 12 || sentence.length > 260) continue;
        if (/\{\{|\]\(|https?:|www\.|@|—/.test(sentence)) continue; // merge tags, links, addresses, em dashes
        if (/\b(?:e-?mail|inbox|button|below|above|this (?:guide|page))\b/i.test(sentence)) continue; // points at the email or page itself, not at the service
        sentences.push(sentence);
      }
    }
    return sentences.length ? { key, label: config.label, sentences } : null;
  } catch (err) {
    logger.warn(`[sms-staff-facts] prep guide unavailable for customer ${customerId}${key ? ` (guide ${key})` : ''}: ${err.message}`);
    return null;
  }
}

module.exports = { loadPrepaidPlanFacts, loadPrepGuideFacts, proseOfBlocks };
