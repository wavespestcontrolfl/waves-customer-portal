/**
 * Pest Insider autopilot — monthly auto-draft of the pest deep-dive.
 *
 * Called by the Tuesday 7AM ET cron in scheduler.js; runs only on the
 * FIRST Tuesday of the month (owner decision 2026-06-11 — Thursdays
 * stay owned by the weekly events guide). Never auto-sends: creates a
 * draft in newsletter_sends for admin review + manual send, exactly
 * like the weekly autopilot.
 *
 * Format: the humor-sandwich from the shipped Beehiiv "Pest Watch"
 * issues — edutainment facts → one sincere featured-service section →
 * voice-y close. The featured service auto-rotates by month
 * (PEST_INSIDER_ROTATION in newsletter-draft.js); the operator can
 * override by editing the draft or re-drafting from Compose.
 *
 * Idempotent per ET month: skips when a pest-insider-monthly send
 * already exists for the current month (any status — a deleted draft
 * does NOT resurrect, matching the weekly's deleted-draft rule).
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts, etDateString } = require('../utils/datetime-et');

const PEST_INSIDER_TYPE = 'pest-insider-monthly';

/**
 * First-Tuesday gate. node-cron's day-of-month × day-of-week semantics
 * are not portable, so the cron fires every Tuesday and this guard
 * keeps only the first one (ET day-of-month 1-7).
 */
function isFirstTuesdayET(now = new Date()) {
  const parts = etParts(now);
  return parts.dayOfWeek === 2 && parts.day >= 1 && parts.day <= 7;
}

/**
 * ET month window [start, nextStart) as Date bounds for the
 * already-drafted-this-month idempotency check.
 */
function etMonthBounds(now = new Date()) {
  const { parseETDateTime } = require('../utils/datetime-et');
  const parts = etParts(now);
  const mm = String(parts.month).padStart(2, '0');
  const start = parseETDateTime(`${parts.year}-${mm}-01T00:00:00`);
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
  const nm = String(nextMonth).padStart(2, '0');
  const end = parseETDateTime(`${nextYear}-${nm}-01T00:00:00`);
  return { start, end };
}

async function runPestInsiderAutopilot({ now = new Date() } = {}) {
  if (!isFirstTuesdayET(now)) {
    return { skipped: true, reason: 'not the first Tuesday (ET)' };
  }

  const { start, end } = etMonthBounds(now);
  const existing = await db('newsletter_sends')
    .where('newsletter_type', PEST_INSIDER_TYPE)
    .where('created_at', '>=', start)
    .where('created_at', '<', end)
    .first();
  if (existing) {
    return { skipped: true, reason: `already drafted this month (send ${existing.id})` };
  }

  const month = new Date(now).toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
  const { createNewsletterDraft } = require('./newsletter-draft');
  const { send, draft } = await createNewsletterDraft({
    prompt: `Monthly Pest Insider for ${month} (${etDateString(now)}). Use this month's featured service from the rotation.`,
    newsletterType: PEST_INSIDER_TYPE,
  });

  logger.info(`[pest-insider-autopilot] drafted send ${send.id}: ${send.subject}`);

  try {
    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification('pest_insider_draft', {
      sendId: send.id,
      subject: send.subject,
      month,
    });
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] draft notification failed: ${e.message}`);
  }

  return { skipped: false, sendId: send.id, subject: send.subject, voiceWarnings: draft.voiceWarnings };
}

module.exports = {
  runPestInsiderAutopilot,
  isFirstTuesdayET,
  etMonthBounds,
  PEST_INSIDER_TYPE,
};
