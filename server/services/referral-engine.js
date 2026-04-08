/**
 * Referral Engine — unified referral program logic
 * Bridges the 007 referrals table with 054 referral_promoters table.
 */
const db = require('../models/db');
const logger = require('./logger');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${digits}`;
}

function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function templateReplace(template, vars) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
}

async function sendSMS(to, body) {
  try {
    const TwilioService = require('./twilio');
    await TwilioService.sendSMS(to, body, { messageType: 'referral' });
    return true;
  } catch (err) {
    logger.error(`[ReferralEngine] SMS failed to ${to}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. enrollPromoter
// ---------------------------------------------------------------------------
async function enrollPromoter(customerId) {
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) throw new Error('Customer not found');

  // Check if already enrolled
  const existing = await db('referral_promoters').where({ customer_id: customerId }).first();
  if (existing) {
    return { promoter: existing, alreadyEnrolled: true };
  }

  const settings = await getSettings();
  const code = customer.referral_code || `WAVES-${generateCode(4)}`;
  const link = `${settings.base_url}${code}`;

  // Ensure customer has a referral_code
  if (!customer.referral_code) {
    await db('customers').where({ id: customerId }).update({ referral_code: code });
  }

  const [promoter] = await db('referral_promoters').insert({
    customer_phone: customer.phone || '',
    customer_email: customer.email || '',
    first_name: customer.first_name || '',
    last_name: customer.last_name || '',
    customer_id: customerId,
    referral_code: code,
    referral_link: link,
    campaign: 'customer',
    status: 'active',
  }).returning('*');

  logger.info(`[ReferralEngine] Enrolled promoter ${promoter.id} for customer ${customerId}`);
  return { promoter, alreadyEnrolled: false };
}

// ---------------------------------------------------------------------------
// 2. submitReferral
// ---------------------------------------------------------------------------
async function submitReferral(promoterId, { name, phone, email, address, notes, source = 'portal' }) {
  if (!name || !phone) throw new Error('Name and phone are required');

  const normalizedPhone = normalizePhone(phone);
  const promoter = await db('referral_promoters').where({ id: promoterId }).first();
  if (!promoter) throw new Error('Promoter not found');

  const settings = await getSettings();

  // --- Fraud checks ---

  // Monthly cap
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthCount = await db('referrals')
    .where({ promoter_id: promoterId })
    .where('created_at', '>=', monthStart)
    .count('* as c')
    .first();
  if (parseInt(monthCount.c) >= settings.max_referrals_per_month) {
    throw new Error(`Monthly referral limit reached (${settings.max_referrals_per_month})`);
  }

  // Duplicate phone (same promoter)
  const dupCheck = await db('referrals')
    .where({ promoter_id: promoterId })
    .where(function () {
      this.where('referee_phone', normalizedPhone)
        .orWhere('referee_phone', phone.trim());
    })
    .first();
  if (dupCheck) throw new Error('You have already referred this phone number');

  // Self-referral
  if (normalizePhone(promoter.customer_phone) === normalizedPhone) {
    throw new Error('Cannot refer yourself');
  }

  // Already a customer
  const existingCustomer = await db('customers')
    .where('phone', normalizedPhone)
    .orWhere('phone', phone.trim())
    .first();
  if (existingCustomer) throw new Error('This person is already a Waves customer');

  // --- Create referral in the 007 referrals table ---
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ');

  const [referral] = await db('referrals').insert({
    referrer_customer_id: promoter.customer_id,
    referee_name: name.trim(),
    referee_phone: normalizedPhone || phone.trim(),
    referee_email: email?.trim() || null,
    referral_code: promoter.referral_code,
    status: 'pending',
    source: source,
    promoter_id: promoterId,
    referrer_reward_amount: settings.referrer_reward_cents / 100,
    referrer_reward_status: 'pending',
  }).returning('*');

  // --- Create lead via lead-attribution ---
  let leadId = null;
  try {
    const [lead] = await db('leads').insert({
      first_name: firstName,
      last_name: lastName || null,
      phone: normalizedPhone || phone.trim(),
      email: email?.trim() || null,
      address: address?.trim() || null,
      lead_type: 'referral',
      service_interest: null,
      first_contact_at: new Date(),
      first_contact_channel: 'referral',
      status: 'new',
    }).returning('*');
    leadId = lead.id;

    await db('referrals').where({ id: referral.id }).update({ lead_id: leadId });

    // Log lead activity
    await db('lead_activities').insert({
      lead_id: leadId,
      activity_type: 'created',
      description: `Referral lead from promoter ${promoter.first_name} ${promoter.last_name}`,
      performed_by: 'system',
    });
  } catch (err) {
    logger.warn(`[ReferralEngine] Lead creation failed: ${err.message}`);
  }

  // --- Update promoter stats ---
  await db('referral_promoters').where({ id: promoterId }).increment({
    total_referrals_sent: 1,
  }).update({
    last_referral_at: new Date(),
    updated_at: new Date(),
  });

  // --- Send invite SMS ---
  const smsBody = templateReplace(
    settings.invite_sms_template || 'Hi {referee_name}! Your neighbor {referrer_name} thinks you\'d love Waves Pest Control. Get a free quote: {referral_link} or call (941) 318-7612',
    {
      referee_name: firstName,
      referrer_name: promoter.first_name,
      referral_link: promoter.referral_link || `${settings.base_url}${promoter.referral_code}`,
    }
  );
  const smsSent = await sendSMS(normalizedPhone || phone.trim(), smsBody);

  if (smsSent) {
    await db('referrals').where({ id: referral.id }).update({ status: 'contacted' });
  }

  logger.info(`[ReferralEngine] Referral ${referral.id} submitted by promoter ${promoterId}`);
  return { ...referral, lead_id: leadId, sms_sent: smsSent };
}

// ---------------------------------------------------------------------------
// 3. convertReferral
// ---------------------------------------------------------------------------
async function convertReferral(referralId, { customerId, tier, monthlyValue }) {
  const referral = await db('referrals').where({ id: referralId }).first();
  if (!referral) throw new Error('Referral not found');

  const settings = await getSettings();

  // Calculate reward (base + tier bonus)
  let rewardCents = settings.referrer_reward_cents;
  if (tier) {
    const tierKey = `bonus_${tier.toLowerCase()}_cents`;
    if (settings[tierKey]) rewardCents += settings[tierKey];
  }
  const rewardDollars = rewardCents / 100;

  const updates = {
    status: 'signed_up',
    converted_at: new Date(),
    referrer_reward_amount: rewardDollars,
    converted_tier: tier || null,
    converted_monthly_value: monthlyValue || null,
    updated_at: new Date(),
  };

  if (settings.require_service_completion) {
    updates.referrer_reward_status = 'pending_service';
  } else {
    updates.referrer_reward_status = 'earned';
  }

  await db('referrals').where({ id: referralId }).update(updates);

  // Update promoter
  if (referral.promoter_id) {
    const promoterUpdates = { total_referrals_converted: 1 };

    if (settings.require_service_completion) {
      // Goes to pending earnings until first service
      await db('referral_promoters').where({ id: referral.promoter_id })
        .increment({ ...promoterUpdates, pending_earnings_cents: rewardCents, total_earned_cents: rewardCents });
    } else {
      // Credit immediately
      await db('referral_promoters').where({ id: referral.promoter_id })
        .increment({ ...promoterUpdates, available_balance_cents: rewardCents, total_earned_cents: rewardCents, referral_balance_cents: rewardCents });
    }

    // Send reward SMS
    const promoter = await db('referral_promoters').where({ id: referral.promoter_id }).first();
    if (promoter) {
      const rewardSms = templateReplace(
        settings.reward_sms_template || 'Great news, {referrer_name}! Your referral {referee_name} signed up. You earned {reward_amount}!',
        {
          referrer_name: promoter.first_name,
          referee_name: referral.referee_name || referral.referral_first_name || 'your friend',
          reward_amount: `$${rewardDollars.toFixed(2)}`,
        }
      );
      await sendSMS(promoter.customer_phone, rewardSms);

      // Check milestones
      await checkMilestones(referral.promoter_id);
    }
  }

  // Mark lead as converted if lead_id exists
  if (referral.lead_id) {
    try {
      const leadAttribution = require('./lead-attribution');
      await leadAttribution.markConverted(referral.lead_id, {
        customerId,
        monthlyValue,
        waveguardTier: tier,
      });
    } catch (err) {
      logger.warn(`[ReferralEngine] Lead conversion update failed: ${err.message}`);
    }
  }

  logger.info(`[ReferralEngine] Referral ${referralId} converted. Reward: $${rewardDollars}`);
  return { referralId, rewardCents, rewardDollars, tier, requiresServiceCompletion: settings.require_service_completion };
}

// ---------------------------------------------------------------------------
// 4. confirmFirstService
// ---------------------------------------------------------------------------
async function confirmFirstService(customerId) {
  // Find referral where the converted customer matches
  const referral = await db('referrals')
    .where(function () {
      this.where('referee_phone', '!=', '').whereIn('status', ['signed_up']);
    })
    .where('first_service_completed', false)
    .first();

  // Try by customer lookup
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) return null;

  const normalizedPhone = normalizePhone(customer.phone);
  const matchedReferral = await db('referrals')
    .whereIn('status', ['signed_up'])
    .where('first_service_completed', false)
    .where(function () {
      this.where('referee_phone', customer.phone)
        .orWhere('referee_phone', normalizedPhone);
    })
    .first();

  if (!matchedReferral) return null;

  const settings = await getSettings();
  const rewardCents = Math.round((matchedReferral.referrer_reward_amount || 50) * 100);

  // Update referral
  await db('referrals').where({ id: matchedReferral.id }).update({
    first_service_completed: true,
    referrer_reward_status: 'earned',
    status: 'credited',
    updated_at: new Date(),
  });

  // Move pending to available for promoter
  if (matchedReferral.promoter_id) {
    await db('referral_promoters').where({ id: matchedReferral.promoter_id }).update({
      available_balance_cents: db.raw('available_balance_cents + ?', [rewardCents]),
      pending_earnings_cents: db.raw('GREATEST(pending_earnings_cents - ?, 0)', [rewardCents]),
      referral_balance_cents: db.raw('referral_balance_cents + ?', [rewardCents]),
      updated_at: new Date(),
    });

    // Auto-credit if enabled
    if (settings.auto_credit_enabled) {
      logger.info(`[ReferralEngine] Auto-credited $${(rewardCents / 100).toFixed(2)} to promoter ${matchedReferral.promoter_id}`);
    }
  }

  logger.info(`[ReferralEngine] First service confirmed for referral ${matchedReferral.id}`);
  return { referralId: matchedReferral.id, promoterId: matchedReferral.promoter_id, rewardCents };
}

// ---------------------------------------------------------------------------
// 5. checkMilestones
// ---------------------------------------------------------------------------
async function checkMilestones(promoterId) {
  const promoter = await db('referral_promoters').where({ id: promoterId }).first();
  if (!promoter) return null;

  const settings = await getSettings();
  const converted = promoter.total_referrals_converted;
  const currentLevel = promoter.milestone_level || 'none';

  let newLevel = currentLevel;
  let bonusCents = 0;

  if (converted >= 10 && currentLevel !== 'champion') {
    newLevel = 'champion';
    bonusCents = settings.milestone_10_bonus_cents;
  } else if (converted >= 5 && !['champion', 'ambassador'].includes(currentLevel)) {
    newLevel = 'ambassador';
    bonusCents = settings.milestone_5_bonus_cents;
  } else if (converted >= 3 && !['champion', 'ambassador', 'advocate'].includes(currentLevel)) {
    newLevel = 'advocate';
    bonusCents = settings.milestone_3_bonus_cents;
  }

  if (newLevel === currentLevel) return null;

  // Award milestone
  await db('referral_promoters').where({ id: promoterId }).update({
    milestone_level: newLevel,
    milestone_earned_at: new Date(),
    available_balance_cents: db.raw('available_balance_cents + ?', [bonusCents]),
    total_earned_cents: db.raw('total_earned_cents + ?', [bonusCents]),
    referral_balance_cents: db.raw('referral_balance_cents + ?', [bonusCents]),
    updated_at: new Date(),
  });

  // Send milestone SMS
  const milestoneSms = templateReplace(
    settings.milestone_sms_template || 'Congrats {referrer_name}! You hit the {milestone_level} milestone with {count} referrals. Bonus: {bonus_amount}!',
    {
      referrer_name: promoter.first_name,
      milestone_level: newLevel,
      count: String(converted),
      bonus_amount: `$${(bonusCents / 100).toFixed(2)}`,
    }
  );
  await sendSMS(promoter.customer_phone, milestoneSms);

  logger.info(`[ReferralEngine] Promoter ${promoterId} reached ${newLevel} milestone. Bonus: $${(bonusCents / 100).toFixed(2)}`);
  return { promoterId, newLevel, bonusCents };
}

// ---------------------------------------------------------------------------
// 6. getSettings
// ---------------------------------------------------------------------------
async function getSettings() {
  try {
    const row = await db('referral_program_settings').where({ id: 1 }).first();
    if (row) return row;
  } catch { /* table may not exist yet */ }

  // Defaults
  return {
    program_active: true,
    base_url: 'https://wavespestcontrol.com/r/',
    referrer_reward_cents: 5000,
    referee_discount_cents: 2500,
    bonus_silver_cents: 5000,
    bonus_gold_cents: 7500,
    bonus_platinum_cents: 10000,
    milestone_3_bonus_cents: 2500,
    milestone_5_bonus_cents: 5000,
    milestone_10_bonus_cents: 10000,
    min_payout_cents: 1000,
    auto_credit_enabled: true,
    require_service_completion: true,
    max_referrals_per_month: 20,
    cooldown_days: 30,
    invite_sms_template: null,
    reward_sms_template: null,
    milestone_sms_template: null,
  };
}

// ---------------------------------------------------------------------------
// 7. updateSettings
// ---------------------------------------------------------------------------
async function updateSettings(updates) {
  const allowed = [
    'program_active', 'base_url', 'referrer_reward_cents', 'referee_discount_cents',
    'bonus_silver_cents', 'bonus_gold_cents', 'bonus_platinum_cents',
    'milestone_3_bonus_cents', 'milestone_5_bonus_cents', 'milestone_10_bonus_cents',
    'min_payout_cents', 'auto_credit_enabled', 'require_service_completion',
    'max_referrals_per_month', 'cooldown_days',
    'invite_sms_template', 'reward_sms_template', 'milestone_sms_template',
  ];

  const filtered = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) filtered[key] = updates[key];
  }
  filtered.updated_at = new Date();

  await db('referral_program_settings').where({ id: 1 }).update(filtered);
  logger.info(`[ReferralEngine] Settings updated: ${Object.keys(filtered).join(', ')}`);
  return getSettings();
}

// ---------------------------------------------------------------------------
// 8. getPromoterStats
// ---------------------------------------------------------------------------
async function getPromoterStats(promoterId) {
  const promoter = await db('referral_promoters').where({ id: promoterId }).first();
  if (!promoter) throw new Error('Promoter not found');

  const referrals = await db('referrals')
    .where({ promoter_id: promoterId })
    .orderBy('created_at', 'desc');

  const clicks = await db('referral_clicks')
    .where({ promoter_id: promoterId })
    .count('* as total')
    .first();

  const thisMonth = new Date();
  thisMonth.setDate(1);
  thisMonth.setHours(0, 0, 0, 0);

  const monthlyReferrals = referrals.filter(r => new Date(r.created_at) >= thisMonth).length;
  const conversionRate = promoter.total_referrals_sent > 0
    ? Math.round((promoter.total_referrals_converted / promoter.total_referrals_sent) * 100)
    : 0;

  return {
    promoter,
    referrals: referrals.map(r => ({
      id: r.id,
      name: r.referee_name || `${r.referral_first_name || ''} ${r.referral_last_name || ''}`.trim(),
      status: r.status,
      rewardAmount: parseFloat(r.referrer_reward_amount || r.credit_amount || 0),
      rewardStatus: r.referrer_reward_status || (r.referrer_credited ? 'earned' : 'pending'),
      createdAt: r.created_at,
      convertedAt: r.converted_at,
    })),
    stats: {
      totalClicks: parseInt(clicks?.total || 0),
      totalReferrals: promoter.total_referrals_sent,
      totalConverted: promoter.total_referrals_converted,
      conversionRate,
      monthlyReferrals,
      totalEarned: promoter.total_earned_cents,
      availableBalance: promoter.available_balance_cents || 0,
      pendingEarnings: promoter.pending_earnings_cents || 0,
      totalPaidOut: promoter.total_paid_out_cents,
      milestoneLevel: promoter.milestone_level || 'none',
    },
  };
}

// ---------------------------------------------------------------------------
// 9. getProgramAnalytics
// ---------------------------------------------------------------------------
async function getProgramAnalytics(startDate, endDate) {
  const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate || new Date();

  const [promoterStats, referralStats, clickStats, payoutStats, topPromoters] = await Promise.all([
    db('referral_promoters')
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'active') as active"),
      ).first(),
    db('referrals')
      .where('created_at', '>=', start)
      .where('created_at', '<=', end)
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'pending' OR status = 'contacted') as pending"),
        db.raw("COUNT(*) FILTER (WHERE status = 'signed_up' OR status = 'credited') as converted"),
        db.raw("COUNT(*) FILTER (WHERE status = 'rejected' OR lost_reason IS NOT NULL) as lost"),
        db.raw("COALESCE(SUM(CASE WHEN status IN ('signed_up','credited') THEN referrer_reward_amount ELSE 0 END), 0) as total_rewards_dollars"),
        db.raw("COALESCE(SUM(CASE WHEN status IN ('signed_up','credited') THEN converted_monthly_value ELSE 0 END), 0) as total_monthly_value"),
      ).first(),
    db('referral_clicks')
      .where('created_at', '>=', start)
      .where('created_at', '<=', end)
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE is_unique = true) as unique_clicks"),
        db.raw("COUNT(*) FILTER (WHERE converted_to_lead = true) as converted_to_lead"),
      ).first(),
    db('referral_payouts')
      .select(
        db.raw("COUNT(*) FILTER (WHERE status = 'pending') as pending"),
        db.raw("COALESCE(SUM(CASE WHEN status = 'applied' THEN amount_cents ELSE 0 END), 0) as total_paid_cents"),
      ).first(),
    db('referral_promoters')
      .where('total_referrals_converted', '>', 0)
      .orderBy('total_referrals_converted', 'desc')
      .limit(10)
      .select('id', 'first_name', 'last_name', 'total_referrals_sent', 'total_referrals_converted', 'total_earned_cents', 'milestone_level'),
  ]);

  const totalReferrals = parseInt(referralStats.total) || 0;
  const converted = parseInt(referralStats.converted) || 0;
  const totalClicks = parseInt(clickStats.total) || 0;
  const uniqueClicks = parseInt(clickStats.unique_clicks) || 0;
  const conversionRate = totalReferrals > 0 ? Math.round((converted / totalReferrals) * 100) : 0;
  const clickToReferral = uniqueClicks > 0 ? Math.round((totalReferrals / uniqueClicks) * 100) : 0;

  const totalRewardsDollars = parseFloat(referralStats.total_rewards_dollars) || 0;
  const totalMonthlyValue = parseFloat(referralStats.total_monthly_value) || 0;
  const estimatedAnnualRevenue = totalMonthlyValue * 12;
  const roi = totalRewardsDollars > 0
    ? Math.round(((estimatedAnnualRevenue - totalRewardsDollars) / totalRewardsDollars) * 100)
    : 0;

  return {
    period: { start, end },
    promoters: {
      total: parseInt(promoterStats.total),
      active: parseInt(promoterStats.active),
    },
    funnel: {
      clicks: totalClicks,
      uniqueClicks,
      referrals: totalReferrals,
      pending: parseInt(referralStats.pending) || 0,
      converted,
      lost: parseInt(referralStats.lost) || 0,
      conversionRate,
      clickToReferralRate: clickToReferral,
    },
    financial: {
      totalRewardsDollars,
      totalPaidOutCents: parseInt(payoutStats.total_paid_cents) || 0,
      pendingPayouts: parseInt(payoutStats.pending) || 0,
      totalMonthlyValue,
      estimatedAnnualRevenue,
      roi,
    },
    topPromoters: topPromoters.map(p => ({
      id: p.id,
      name: `${p.first_name} ${p.last_name}`,
      referrals: p.total_referrals_sent,
      conversions: p.total_referrals_converted,
      earned: p.total_earned_cents,
      milestone: p.milestone_level,
    })),
  };
}

module.exports = {
  enrollPromoter,
  submitReferral,
  convertReferral,
  confirmFirstService,
  checkMilestones,
  getSettings,
  updateSettings,
  getPromoterStats,
  getProgramAnalytics,
};
