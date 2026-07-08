/**
 * Customer Referral Routes v2 — unified referral program
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const engine = require('../services/referral-engine');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');

router.use(authenticate);

// Per-customer write throttles. Both endpoints fan out SMS, so we want them
// stricter than the global /api limiter.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.customerId || req.ip,
  message: { error: 'Too many referrals submitted recently. Please try again later.' },
});

const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.customerId || req.ip,
  message: { error: 'Too many invites sent recently. Please try again later.' },
});

const submitSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  phone: Joi.string().trim().min(7).max(32).required(),
  email: Joi.string().trim().email().max(254).optional().allow(''),
  address: Joi.string().trim().max(300).optional().allow(''),
  notes: Joi.string().trim().max(500).optional().allow(''),
});

const inviteSchema = Joi.object({
  phone: Joi.string().trim().min(7).max(32).required(),
  friendName: Joi.string().trim().max(100).optional().allow(''),
});

const inviteEmailSchema = Joi.object({
  email: Joi.string().trim().email().max(254).required(),
  friendName: Joi.string().trim().max(100).optional().allow(''),
});

// =========================================================================
// GET / — full referral data (auto-enrolls if needed)
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    // Auto-enroll as promoter if not already
    const { promoter } = await engine.enrollPromoter(req.customerId);

    const referrals = await db('referrals')
      .where(function () {
        this.where({ promoter_id: promoter.id })
          .orWhere({ referrer_customer_id: req.customerId });
      })
      .orderBy('created_at', 'desc');

    const settings = await engine.getSettings();
    const referralLink = engine.getPromoterReferralLink(promoter, settings);
    if (promoter.referral_link !== referralLink) {
      void db('referral_promoters')
        .where({ id: promoter.id })
        .update({ referral_link: referralLink, updated_at: new Date() })
        .catch(err => logger.warn(`[referrals-v2] referral link repair failed for promoter ${promoter.id}: ${err.message}`));
    }

    const total = referrals.length;
    const converted = referrals.filter(r => ['signed_up', 'credited'].includes(r.status)).length;
    const pending = referrals.filter(r => ['pending', 'contacted', 'estimated', 'sms_failed'].includes(r.status)).length;

    // Milestone progress
    const milestones = [
      { level: 'advocate', threshold: 3, bonus: settings.milestone_3_bonus_cents },
      { level: 'ambassador', threshold: 5, bonus: settings.milestone_5_bonus_cents },
      { level: 'champion', threshold: 10, bonus: settings.milestone_10_bonus_cents },
    ];
    const currentLevel = promoter.milestone_level || 'none';
    const levelOrder = ['none', 'advocate', 'ambassador', 'champion'];
    const currentIdx = levelOrder.indexOf(currentLevel);
    const nextMilestone = milestones.find(m => levelOrder.indexOf(m.level) > currentIdx) || null;

    res.json({
      referralCode: promoter.referral_code,
      referralLink,
      milestoneLevel: currentLevel,
      nextMilestone: nextMilestone ? {
        level: nextMilestone.level,
        threshold: nextMilestone.threshold,
        bonus: nextMilestone.bonus,
        progress: converted,
        remaining: Math.max(0, nextMilestone.threshold - converted),
      } : null,
      availableBalance: promoter.available_balance_cents || 0,
      pendingEarnings: promoter.pending_earnings_cents || 0,
      totalEarned: promoter.total_earned_cents || 0,
      totalPaidOut: promoter.total_paid_out_cents || 0,
      stats: {
        totalReferrals: total,
        converted,
        pending,
        totalClicks: promoter.total_clicks || 0,
      },
      referrals: referrals.map(r => ({
        id: r.id,
        name: r.referee_name || `${r.referral_first_name || ''} ${r.referral_last_name || ''}`.trim(),
        phone: maskPhone(r.referee_phone || r.referral_phone),
        status: r.status,
        rewardAmount: parseFloat(r.referrer_reward_amount || r.credit_amount || 0),
        rewardStatus: r.referrer_reward_status || (r.referrer_credited ? 'earned' : 'pending'),
        createdAt: r.created_at,
        convertedAt: r.converted_at,
      })),
      rewardPerReferral: settings.referrer_reward_cents / 100,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /stats — lightweight stats for dashboard card
// =========================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const promoter = await db('referral_promoters').where({ customer_id: req.customerId }).first();

    if (!promoter) {
      return res.json({
        totalReferrals: 0,
        totalEarned: 0,
        referralCode: null,
        enrolled: false,
      });
    }

    const settings = await engine.getSettings();
    const referralLink = engine.getPromoterReferralLink(promoter, settings);

    res.json({
      totalReferrals: promoter.total_referrals_sent || 0,
      totalConverted: promoter.total_referrals_converted || 0,
      totalEarned: promoter.total_earned_cents || 0,
      availableBalance: promoter.available_balance_cents || 0,
      referralCode: promoter.referral_code,
      referralLink,
      milestoneLevel: promoter.milestone_level || 'none',
      enrolled: true,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// POST / — submit a referral
// =========================================================================
router.post('/', submitLimiter, async (req, res, next) => {
  try {
    const { value, error } = submitSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { name, phone, email, address, notes } = value;

    // Ensure enrolled
    const { promoter } = await engine.enrollPromoter(req.customerId);

    const referral = await engine.submitReferral(promoter.id, {
      name, phone, email, address, notes, source: 'portal',
    });

    res.status(201).json({
      success: true,
      referral: {
        id: referral.id,
        name: referral.referee_name,
        status: referral.status || (referral.sms_sent ? 'contacted' : 'sms_failed'),
        smsSent: referral.sms_sent,
        phone: maskPhone(referral.referee_phone || referral.referral_phone),
        createdAt: referral.created_at,
      },
    });
  } catch (err) {
    if (err.message.includes('limit') || err.message.includes('already') || err.message.includes('Cannot') || err.message.includes('Waves customer')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// =========================================================================
// POST /invite — send invite SMS to a phone number
// =========================================================================
router.post('/invite', inviteLimiter, async (req, res, next) => {
  try {
    const { value, error } = inviteSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { phone, friendName } = value;

    const { promoter } = await engine.enrollPromoter(req.customerId);
    const settings = await engine.getSettings();
    const referralLink = engine.getPromoterReferralLink(promoter, settings);

    // Cooldown: same promoter+phone within 24 hours = no-op (idempotent double-tap protection)
    const cleanPhone = phone.replace(/\s+/g, '');
    const cooldownStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await db('referral_invites')
      .where({ promoter_id: promoter.id, phone: cleanPhone })
      .where('sent_at', '>=', cooldownStart)
      .first()
      .catch(() => null);

    if (recent) {
      return res.json({ success: true, deduped: true });
    }

    const friendly = friendName ? friendName.replace(/[<>]/g, '') : 'there';
    const body = await renderRequiredSmsTemplate('referral_invite', {
      referee_name: friendly,
      referrer_name: promoter.first_name || 'your neighbor',
      referral_link: referralLink,
    }, {
      workflow: 'referral_invite',
      entity_type: 'referral_promoter',
      entity_id: promoter.id,
    });

    const smsResult = await sendCustomerMessage({
      to: cleanPhone,
      body,
      channel: 'sms',
      audience: 'lead',
      purpose: 'referral',
      identityTrustLevel: 'phone_provided_unverified',
      consentBasis: {
        status: 'transactional_allowed',
        source: 'referral_invite_form',
        capturedAt: new Date().toISOString(),
      },
      entryPoint: 'referrals_v2_invite',
      metadata: {
        original_message_type: 'referral_invite',
        promoter_id: promoter.id,
      },
    });
    if (!smsResult.sent) {
      logger.warn(`[referrals-v2] Invite SMS blocked/failed for promoter ${promoter.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
    }

    // Best-effort log of the invite for cooldown tracking
    await db('referral_invites').insert({
      promoter_id: promoter.id,
      phone: cleanPhone,
      sent_at: new Date(),
    }).catch(() => { /* table may not exist yet */ });

    // Update share timestamp
    await db('referral_promoters').where({ id: promoter.id }).update({
      last_share_at: new Date(),
      updated_at: new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(`[Referrals] Invite SMS failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// =========================================================================
// POST /invite-email — send a branded-glass referral invite email to a friend
// =========================================================================
// The email twin of /invite: mirrors the portal's "Text a friend" flow but
// sends the referral.friend_invite branded template from Waves instead of a
// plain mailto draft. Best-effort tracking only (no referral/lead row) — it
// replaces a client-side mailto that tracked nothing.
router.post('/invite-email', inviteLimiter, async (req, res, next) => {
  try {
    const { value, error } = inviteEmailSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { email, friendName } = value;
    const cleanEmail = email.trim().toLowerCase();

    const { promoter } = await engine.enrollPromoter(req.customerId);
    const settings = await engine.getSettings();
    const referralLink = engine.getPromoterReferralLink(promoter, settings);

    // Can't invite your own address. promoter.customer_email is a snapshot
    // taken at enrollment — also compare the CURRENT account email (mirrors
    // submitReferral's fallback) so a promoter whose row predates an email
    // change, or has a blank snapshot, can't self-invite.
    const selfCustomer = await db('customers').where({ id: req.customerId }).first().catch(() => null);
    const selfEmails = [promoter.customer_email, selfCustomer?.email]
      .map((e) => String(e || '').trim().toLowerCase())
      .filter(Boolean);
    if (selfEmails.includes(cleanEmail)) {
      return res.status(400).json({ error: 'That’s your own email — invite a friend instead.' });
    }

    // Rolling 24h cooldown, reserved ATOMICALLY before the send: the advisory
    // xact lock serializes concurrent same-promoter+email submits, so the
    // read-then-insert can't race — including double-taps that straddle UTC
    // midnight, the hole a date-bucketed idempotency key alone leaves. The
    // reservation is released on a failed send so a retry isn't locked out.
    const cooldownStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    let reserved = false;
    try {
      const cooldownHit = await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`referral-invite-email:${promoter.id}:${cleanEmail}`]);
        const recent = await trx('referral_invites')
          .where({ promoter_id: promoter.id })
          .whereRaw('LOWER(email) = ?', [cleanEmail])
          .where('sent_at', '>=', cooldownStart)
          .first();
        if (recent) return true;
        await trx('referral_invites').insert({
          promoter_id: promoter.id,
          email: cleanEmail,
          sent_at: new Date(),
        });
        return false;
      });
      if (cooldownHit) {
        return res.json({ success: true, deduped: true });
      }
      reserved = true;
    } catch (reserveErr) {
      // referral_invites is a best-effort tracking table — if the reservation
      // can't be taken (e.g. migration not applied yet), send without it; the
      // idempotency key below still collapses same-day duplicates.
      logger.warn(`[referrals-v2] invite-email cooldown reservation unavailable: ${reserveErr.message}`);
    }
    // Cooldown passed, so the only row inside the window is the one we just
    // wrote — safe to target by promoter+email+window.
    const releaseReservation = () => {
      if (!reserved) return Promise.resolve();
      return db('referral_invites')
        .where({ promoter_id: promoter.id })
        .whereRaw('LOWER(email) = ?', [cleanEmail])
        .where('sent_at', '>=', cooldownStart)
        .del()
        .catch(() => {});
    };

    const friendly = friendName ? friendName.replace(/[<>]/g, '').trim() : '';
    const EmailTemplateLibrary = require('../services/email-template-library');
    let result;
    try {
      result = await EmailTemplateLibrary.sendTemplate({
        templateKey: 'referral.friend_invite',
        to: cleanEmail,
        payload: {
          friend_name: friendly || 'there',
          referrer_name: promoter.first_name || 'A Waves customer',
          referral_url: referralLink,
          referral_offer_line: engine.buildRefereeOfferLine(settings),
        },
        recipientType: 'referral_promoter',
        recipientId: promoter.id,
        categories: ['referral_invite'],
        // Second guard behind the reservation, at the email_messages layer:
        // uniquely indexed, so duplicates that slip past a failed reservation
        // still collapse to one send. The address is digested because a raw
        // 254-char email would push the key past the column's varchar(260).
        // UTC-day bucket: blocks same-day dupes, never a >24h re-invite.
        idempotencyKey: `referral.friend_invite:${promoter.id}:${crypto.createHash('sha256').update(cleanEmail).digest('hex').slice(0, 16)}:${new Date().toISOString().slice(0, 10)}`,
        // SendGrid 4xx bodies can echo the recipient address — keep provider
        // errors out of the logs (the redacted reason is logged below).
        suppressProviderErrorLog: true,
      });
    } catch (sendErr) {
      // ONLY the explicit in-flight collision is a deduped success (another
      // request owns the send). Other 409s — e.g. EMAIL_TEMPLATE_DISABLED —
      // are real failures and must surface, not read as "sent". The
      // reservation is released either way: if the in-flight winner crashes,
      // a retry must re-resolve against its row (terminal → clean dedupe,
      // stale → the library reclaims it), not sit behind a 24h cooldown.
      await releaseReservation();
      if (sendErr.code === 'EMAIL_SEND_IN_PROGRESS') {
        return res.json({ success: true, deduped: true });
      }
      throw sendErr;
    }

    if (result && result.sent === false) {
      // Includes deduped-but-blocked (a prior same-day attempt hit
      // suppression/bounce): deduped never means delivered — don't tell the
      // customer a suppressed address got their invite.
      await releaseReservation();
      logger.warn(`[referrals-v2] Friend invite email not sent for promoter ${promoter.id}: ${result.reason || 'blocked'}`);
      return res.status(422).json({ error: 'We couldn’t email that address. Double-check it and try again.' });
    }

    // Skip the share-timestamp bump on a deduped result — this request didn't
    // actually send anything. (The cooldown row is the pre-send reservation.)
    if (!result?.deduped) {
      await db('referral_promoters').where({ id: promoter.id }).update({
        last_share_at: new Date(),
        updated_at: new Date(),
      });
    }

    res.json({ success: true });
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : require('../services/email-template-library').redactEmailAddresses(err.message);
    logger.error(`[Referrals] Invite email failed: ${reason}`);
    res.status(500).json({ error: 'Failed to send invite email' });
  }
});

function maskPhone(phone) {
  if (!phone) return phone;
  // Mask everything except the area code prefix style — never expose last 4 to the
  // promoter (prevents enumeration / cross-referencing).
  return '••• ••• ••••';
}

module.exports = router;
