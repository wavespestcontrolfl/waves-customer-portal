// Weekly owner digest for the agronomic brain's exception queue (phase F).
// Exception-based review model: green pages flow automatically, RED pages are
// blocked until reviewed, and YELLOW pages get surfaced here — a weekly email
// to the owner listing what changed and what's waiting, linking to /admin/kb.
// Nothing in this module mutates review state; it is a read-and-report leg.
//
// Runs as leg 3 of the daily 6:10 scheduler handler (after refresh + KB sync),
// never as its own cron: a fixed-offset cron could fire mid-refresh, report
// pre-refresh state, and stamp its weekly marker — suppressing a corrected
// digest for six days. Chaining after a successful refresh/sync means the
// digest always describes the week's final state.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { runExclusive } = require('../utils/cron-lock');

// Dark-ship gate: inert until the owner flips it. When off we still compute
// and shadow-log what WOULD have been sent, so the flip is a known quantity.
const digestEnabled = () => process.env.GATE_WIKI_YELLOW_DIGEST === 'true';
// Recipient is deliberately independent of SENDGRID_FROM_EMAIL: the sender
// identity is commonly a newsletter/automations mailbox, and falling back to
// it would land the review queue in the wrong inbox. Owner address or an
// explicit WIKI_DIGEST_EMAIL only.
const digestEmail = () => process.env.WIKI_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

const GUARD_TRIGGER = 'yellow_digest';
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function parseFlags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function pageLine(page) {
  const flags = parseFlags(page.risk_flags);
  const meta = [page.category, page.confidence, ...flags].filter(Boolean).map(esc).join(' · ');
  return `<li style="margin:0 0 8px 0;"><strong>${esc(page.title || page.slug)}</strong>${meta ? `<br><span style="color:#5A6B7B;font-size:12px;">${meta}</span>` : ''}</li>`;
}

function pageTextLine(page) {
  const flags = parseFlags(page.risk_flags);
  const meta = [page.category, page.confidence, ...flags].filter(Boolean).join(' · ');
  return `- ${page.title || page.slug}${meta ? ` (${meta})` : ''}`;
}

// Compose the digest from a getReviewQueue() payload. Returns null when there
// is nothing worth an email: no fresh yellow pages and no red pages awaiting
// review. Blocked pages are already human-decided — counted, never a trigger.
function composeYellowDigest(queue) {
  const yellow = queue.recentYellow || [];
  const pending = queue.pending || [];
  const blockedCount = (queue.blocked || []).length;
  if (!yellow.length && !pending.length) return null;

  const reviewUrl = `${adminPortalUrl()}/admin/kb`;
  const parts = [`Agronomic brain — weekly review digest`];
  const sections = [];
  if (pending.length) {
    sections.push(`<h3 style="margin:16px 0 8px 0;font-size:14px;color:#B3261E;">Blocked until review (${pending.length})</h3><ul style="margin:0;padding-left:18px;">${pending.map(pageLine).join('')}</ul>`);
  }
  if (yellow.length) {
    sections.push(`<h3 style="margin:16px 0 8px 0;font-size:14px;color:#8A6D00;">Yellow — updated this week, review optional (${yellow.length})</h3><ul style="margin:0;padding-left:18px;">${yellow.map(pageLine).join('')}</ul>`);
  }
  if (blockedCount) {
    sections.push(`<p style="margin:16px 0 0 0;color:#5A6B7B;font-size:12px;">${blockedCount} previously blocked page${blockedCount === 1 ? '' : 's'} remain${blockedCount === 1 ? 's' : ''} inactive.</p>`);
  }

  const html = [
    `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1B2C5B;max-width:640px;">`,
    `<h2 style="margin:0 0 4px 0;font-size:16px;">${esc(parts[0])}</h2>`,
    `<p style="margin:0 0 12px 0;color:#5A6B7B;">Green pages flowed automatically. The exceptions below are waiting at <a href="${reviewUrl}">${reviewUrl}</a>.</p>`,
    sections.join(''),
    `</div>`,
  ].join('');

  const text = [
    parts[0],
    `Review at ${reviewUrl}`,
    '',
    pending.length ? `BLOCKED UNTIL REVIEW (${pending.length}):\n${pending.map(pageTextLine).join('\n')}` : null,
    yellow.length ? `YELLOW — REVIEW OPTIONAL (${yellow.length}):\n${yellow.map(pageTextLine).join('\n')}` : null,
    blockedCount ? `${blockedCount} previously blocked page(s) remain inactive.` : null,
  ].filter(Boolean).join('\n\n');

  const subject = `[Brain digest] ${pending.length} blocked, ${yellow.length} yellow this week`;
  return { subject, html, text, yellowCount: yellow.length, pendingCount: pending.length };
}

// Daily cron entry point with a weekly guard (same self-healing pattern as
// weeklyRefreshIfDue / syncToClaudeopediaIfDue: invoked daily, at most one
// send per 6 days, a missed morning self-heals the next). An EMPTY week does
// NOT stamp the marker — the first exception after a quiet stretch goes out
// the next 6:10 rather than waiting for an arbitrary weekly slot.
// `opts.sendgrid` and `opts.wiki` are injectable for tests.
//
// The whole body runs under the cron advisory lock: during a Railway deploy
// the old and new instances overlap on the same 6:10 tick, and the
// guard-check → send → marker sequence is not atomic — both could pass the
// guard before either stamps the marker and the owner would get the digest
// twice. The lock serializes across instances; the marker then makes the
// second (later) run skip.
async function sendYellowDigestIfDue(opts = {}) {
  return runExclusive('wiki-yellow-digest', () => sendYellowDigestLocked(opts));
}

async function sendYellowDigestLocked(opts = {}) {
  try {
    const recentRun = await db('knowledge_update_log')
      .where({ trigger_type: GUARD_TRIGGER })
      .where('created_at', '>', new Date(Date.now() - SIX_DAYS_MS))
      .first('id');
    if (recentRun) return { skipped: true };
  } catch (err) {
    logger.error(`[yellow-digest] guard query failed: ${err.message}`);
  }

  const wiki = opts.wiki || require('./agronomic-wiki');
  const queue = await wiki.getReviewQueue();
  const composed = composeYellowDigest(queue);
  if (!composed) return { skipped: 'empty' };

  if (!digestEnabled()) {
    logger.info(`[yellow-digest] gated OFF — would send: ${composed.pendingCount} blocked, ${composed.yellowCount} yellow`);
    return { skipped: 'gated', ...composed };
  }

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[yellow-digest] mailer not configured — skipping send');
    return { skipped: 'unconfigured' };
  }

  // FAIL CLOSED: this digest may only ever reach an internal/owner address. A
  // mis-set WIKI_DIGEST_EMAIL must skip, never leak internal review state out.
  const to = digestEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[yellow-digest] recipient is not an internal address — skipping send; set a valid WIKI_DIGEST_EMAIL');
    return { skipped: 'recipient' };
  }

  try {
    await mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
      categories: ['wiki-brain', 'yellow-digest'],
      // A SendGrid validation body echoes the address — PII in Railway logs.
      suppressErrorLog: true,
    });
  } catch (err) {
    // Never interpolate err.message here (may echo the recipient address).
    logger.error(`[yellow-digest] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    try {
      await db('knowledge_update_log').insert({
        action: 'error',
        entry_slug: null,
        description: `Yellow digest send failed: ${composed.pendingCount} blocked, ${composed.yellowCount} yellow pending`,
        trigger_type: `${GUARD_TRIGGER}_error`,
      });
    } catch (logErr) {
      logger.error(`[yellow-digest] failed to log error run: ${logErr.message}`);
    }
    return { sent: false, error: true };
  }

  try {
    await db('knowledge_update_log').insert({
      action: 'digest',
      entry_slug: null,
      description: `Yellow digest sent: ${composed.pendingCount} blocked, ${composed.yellowCount} yellow`,
      trigger_type: GUARD_TRIGGER,
    });
  } catch (err) {
    logger.error(`[yellow-digest] failed to log digest run: ${err.message}`);
  }

  logger.info(`[yellow-digest] sent: ${composed.pendingCount} blocked, ${composed.yellowCount} yellow`);
  return { sent: true, yellowCount: composed.yellowCount, pendingCount: composed.pendingCount };
}

module.exports = { sendYellowDigestIfDue, composeYellowDigest };
