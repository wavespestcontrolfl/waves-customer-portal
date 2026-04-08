const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// =========================================================================
// BADGE DEFINITIONS — 22 badges across 5 categories
// =========================================================================
const CATEGORY_ORDER = ['getting_started', 'loyalty', 'referral', 'service', 'tier'];

const CATEGORY_LABELS = {
  getting_started: 'Getting Started',
  loyalty: 'Loyalty',
  referral: 'Referrals',
  service: 'Service Milestones',
  tier: 'WaveGuard Tier',
};

const BADGE_DEFS = [
  // GETTING STARTED
  { type: 'welcome', category: 'getting_started', title: 'Welcome Aboard', icon: '🌊', description: "You're officially part of the Waves family", order: 1 },
  { type: 'property_pro', category: 'getting_started', title: 'Property Pro', icon: '🏡', description: 'Your tech knows exactly how to serve your home', order: 2 },
  { type: 'first_visit', category: 'getting_started', title: 'First Visit Complete', icon: '🌱', description: 'Your first service is in the books', order: 3 },

  // LOYALTY
  { type: 'loyalty_3mo', category: 'loyalty', title: '3-Month Member', icon: '⭐', description: 'A quarter year of protection', order: 1 },
  { type: 'loyalty_6mo', category: 'loyalty', title: '6-Month Member', icon: '🌟', description: 'Half a year strong', order: 2 },
  { type: 'loyalty_1yr', category: 'loyalty', title: '1-Year Veteran', icon: '🏆', description: 'A full year of Waves protection', order: 3,
    reward: { type: 'credit', description: '$25 account credit', amount: 25 } },
  { type: 'loyalty_2yr', category: 'loyalty', title: '2-Year Member', icon: '💎', description: "Two years — you're a Waves legend", order: 4,
    reward: { type: 'credit', description: '$50 account credit', amount: 50 } },
  { type: 'always_current', category: 'loyalty', title: 'Always Current', icon: '💳', description: '12 consecutive on-time payments', order: 5,
    reward: { type: 'priority', description: 'Priority scheduling' } },

  // REFERRAL
  { type: 'referral_starter', category: 'referral', title: 'Referral Starter', icon: '🤝', description: 'Your first successful referral', order: 1 },
  { type: 'referral_champion', category: 'referral', title: 'Referral Champion', icon: '🎯', description: '3 referrals — your neighbors thank you', order: 2,
    reward: { type: 'free_month', description: 'Free month of service' } },
  { type: 'referral_legend', category: 'referral', title: 'Referral Legend', icon: '🏅', description: "5 referrals — you're our best ambassador", order: 3 },
  { type: 'referral_mvp', category: 'referral', title: 'Referral MVP', icon: '🦸', description: "MVP status — you've built a Waves neighborhood", order: 4 },

  // SERVICE
  { type: 'review_rockstar', category: 'service', title: 'Review Rockstar', icon: '⭐', description: 'Thanks for spreading the word on Google', order: 1 },
  { type: 'green_thumb', category: 'service', title: 'Green Thumb', icon: '🌿', description: '4 lawn visits completed', order: 2 },
  { type: 'mosquito_slayer', category: 'service', title: 'Mosquito Slayer', icon: '🦟', description: 'Full mosquito season completed bite-free', order: 3 },
  { type: 'fully_protected', category: 'service', title: 'Fully Protected', icon: '🏰', description: '3+ service types active — total home protection', order: 4,
    reward: { type: 'service', description: 'Free assessment + priority hurricane scheduling' } },
  { type: 'lawn_transformation', category: 'service', title: 'Lawn Transformation', icon: '🔄', description: '30+ point lawn health improvement', order: 5 },
  { type: 'visit_25', category: 'service', title: '25 Visits', icon: '📋', description: '25 visits and counting', order: 6,
    reward: { type: 'service', description: 'Complimentary assessment' } },
  { type: 'visit_50', category: 'service', title: '50 Visits', icon: '🎖️', description: 'Half a century of service visits', order: 7 },

  // TIER
  { type: 'tier_silver', category: 'tier', title: 'WaveGuard Silver', icon: '🥈', description: '10% bundle savings unlocked', order: 1 },
  { type: 'tier_gold', category: 'tier', title: 'WaveGuard Gold', icon: '🥇', description: '15% bundle savings unlocked', order: 2 },
  { type: 'tier_platinum', category: 'tier', title: 'WaveGuard Platinum', icon: '💎', description: '20% bundle savings — maximum protection', order: 3 },
];

const BADGE_MAP = Object.fromEntries(BADGE_DEFS.map(b => [b.type, b]));

// =========================================================================
// BADGE EVALUATION ENGINE
// =========================================================================
async function evaluateBadges(customerId) {
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) return { earned: {}, progress: {} };

  // Gather all data needed for evaluation
  const [services, payments, referrals, satisfaction, propertyPrefs, lawnHealth] = await Promise.all([
    db('service_records').where({ customer_id: customerId, status: 'completed' }).orderBy('service_date'),
    db('payments').where({ customer_id: customerId }),
    db('referrals').where({ referrer_customer_id: customerId }),
    db('satisfaction_responses').where({ customer_id: customerId }),
    db('property_preferences').where({ customer_id: customerId }).first(),
    db('lawn_health_scores').where({ customer_id: customerId }).orderBy('assessment_date', 'asc'),
  ]);

  const now = new Date();
  const memberSinceStr = customer.member_since
    ? (typeof customer.member_since === 'string' ? customer.member_since.split('T')[0] : new Date(customer.member_since).toISOString().split('T')[0])
    : null;
  const memberSince = memberSinceStr ? new Date(memberSinceStr + 'T12:00:00') : null;
  const memberDays = memberSince && !isNaN(memberSince) ? Math.floor((now - memberSince) / (1000 * 60 * 60 * 24)) : 0;
  const tier = customer.waveguard_tier || 'Bronze';
  const totalVisits = services.length;
  const totalReferrals = referrals.length;
  const paidPayments = payments.filter(p => p.status === 'paid');
  const failedPayments = payments.filter(p => p.status === 'failed');

  // Service type detection
  const svcTypes = services.map(s => s.service_type.toLowerCase());
  const hasLawn = svcTypes.some(s => s.includes('lawn care'));
  const hasMosquito = svcTypes.some(s => s.includes('mosquito'));
  const hasPest = svcTypes.some(s => s.includes('pest control'));
  const hasTermite = svcTypes.some(s => s.includes('termite'));

  // Count distinct service types
  const distinctServiceTypes = new Set();
  for (const s of svcTypes) {
    if (s.includes('lawn care')) distinctServiceTypes.add('lawn');
    if (s.includes('mosquito')) distinctServiceTypes.add('mosquito');
    if (s.includes('pest control')) distinctServiceTypes.add('pest');
    if (s.includes('termite')) distinctServiceTypes.add('termite');
    if (s.includes('rodent')) distinctServiceTypes.add('rodent');
  }

  // Property preferences completeness
  const propComplete = propertyPrefs && (
    propertyPrefs.neighborhood_gate_code || propertyPrefs.property_gate_code ||
    propertyPrefs.pet_count > 0 || propertyPrefs.access_notes ||
    propertyPrefs.preferred_day !== 'no_preference'
  );

  // Lawn health improvement
  let lawnImprovement = 0;
  if (lawnHealth.length >= 2) {
    const initial = lawnHealth[0];
    const latest = lawnHealth[lawnHealth.length - 1];
    const avgInitial = (initial.turf_density + initial.weed_suppression + initial.fungus_control + initial.thatch_score) / 4;
    const avgLatest = (latest.turf_density + latest.weed_suppression + latest.fungus_control + latest.thatch_score) / 4;
    lawnImprovement = avgLatest - avgInitial;
  }

  // Lawn visits count
  const lawnVisits = services.filter(s => s.service_type.toLowerCase().includes('lawn care')).length;

  // Consecutive on-time payments (12 consecutive)
  const sortedPaid = paidPayments.sort((a, b) => new Date(a.payment_date || a.created_at) - new Date(b.payment_date || b.created_at));
  let consecutiveOnTime = 0;
  let maxConsecutive = 0;
  for (const p of sortedPaid) {
    if (p.status === 'paid') {
      consecutiveOnTime++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveOnTime);
    } else {
      consecutiveOnTime = 0;
    }
  }
  // Also check no failed payments break the streak
  const alwaysCurrent = maxConsecutive >= 12 && failedPayments.length === 0;

  // Mosquito slayer: had mosquito service spanning Apr-Oct
  const mosquitoServices = services.filter(s => s.service_type.toLowerCase().includes('mosquito'));
  const mosquitoMonths = new Set(mosquitoServices.map(s => new Date(s.service_date + 'T12:00:00').getMonth()));

  // Evaluate each badge
  const earned = {};

  // GETTING STARTED
  earned.welcome = true; // they're logged in
  earned.property_pro = !!propComplete;
  earned.first_visit = totalVisits >= 1;

  // LOYALTY
  earned.loyalty_3mo = memberDays >= 90;
  earned.loyalty_6mo = memberDays >= 180;
  earned.loyalty_1yr = memberDays >= 365;
  earned.loyalty_2yr = memberDays >= 730;
  earned.always_current = alwaysCurrent;

  // REFERRAL
  earned.referral_starter = totalReferrals >= 1;
  earned.referral_champion = totalReferrals >= 3;
  earned.referral_legend = totalReferrals >= 5;
  earned.referral_mvp = totalReferrals >= 10;

  // SERVICE
  earned.review_rockstar = satisfaction.some(s => s.directed_to_review);
  earned.green_thumb = lawnVisits >= 4;
  earned.mosquito_slayer = hasMosquito && [3, 4, 5, 6, 7, 8, 9].every(m => mosquitoMonths.has(m));
  earned.fully_protected = distinctServiceTypes.size >= 3;
  earned.lawn_transformation = lawnImprovement >= 30;
  earned.visit_25 = totalVisits >= 25;
  earned.visit_50 = totalVisits >= 50;

  // TIER
  earned.tier_silver = ['Silver', 'Gold', 'Platinum'].includes(tier);
  earned.tier_gold = ['Gold', 'Platinum'].includes(tier);
  earned.tier_platinum = tier === 'Platinum';

  // Build progress info for locked badges
  const progress = {};
  if (!earned.loyalty_3mo) progress.loyalty_3mo = `${memberDays}/90 days`;
  if (!earned.loyalty_6mo) progress.loyalty_6mo = `${memberDays}/180 days`;
  if (!earned.loyalty_1yr) progress.loyalty_1yr = `${memberDays}/365 days`;
  if (!earned.loyalty_2yr) progress.loyalty_2yr = `${Math.floor(memberDays / 365)}/2 years`;
  if (!earned.always_current) progress.always_current = `${maxConsecutive}/12 on-time payments`;
  if (!earned.referral_starter) progress.referral_starter = `${totalReferrals}/1 referral`;
  if (!earned.referral_champion) progress.referral_champion = `${totalReferrals}/3 referrals`;
  if (!earned.referral_legend) progress.referral_legend = `${totalReferrals}/5 referrals`;
  if (!earned.referral_mvp) progress.referral_mvp = `${totalReferrals}/10 referrals`;
  if (!earned.green_thumb) progress.green_thumb = `${lawnVisits}/4 lawn visits`;
  if (!earned.visit_25) progress.visit_25 = `${totalVisits}/25 visits`;
  if (!earned.visit_50) progress.visit_50 = `${totalVisits}/50 visits`;
  if (!earned.lawn_transformation) progress.lawn_transformation = `${Math.round(lawnImprovement)}/30 point improvement`;

  return { earned, progress };
}

// =========================================================================
// GET /api/badges
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { earned, progress } = await evaluateBadges(req.customerId);

    // Get existing badge records
    const existing = await db('customer_badges').where({ customer_id: req.customerId });
    const existingMap = Object.fromEntries(existing.map(b => [b.badge_type, b]));

    // Insert newly earned badges + queue rewards
    const newBadges = [];
    for (const [type, isEarned] of Object.entries(earned)) {
      if (isEarned && !existingMap[type]) {
        newBadges.push({ customer_id: req.customerId, badge_type: type });
      }
    }
    if (newBadges.length) {
      await db('customer_badges').insert(newBadges).onConflict(['customer_id', 'badge_type']).ignore();

      // Queue rewards for newly earned reward badges
      for (const nb of newBadges) {
        const badge = BADGE_MAP[nb.badge_type];
        if (badge && badge.reward) {
          await db('badge_reward_queue').insert({
            customer_id: req.customerId,
            badge_type: badge.type,
            reward_type: badge.reward.type,
            reward_description: badge.reward.description,
            reward_amount: badge.reward.amount || null,
          }).onConflict(['customer_id', 'badge_type']).ignore();
        }
      }
    }

    // Re-fetch to get earned_at timestamps
    const allBadgeRows = await db('customer_badges').where({ customer_id: req.customerId });
    const badgeRowMap = Object.fromEntries(allBadgeRows.map(b => [b.badge_type, b]));

    // Fetch pending rewards for this customer
    const rewards = await db('badge_reward_queue')
      .where({ customer_id: req.customerId })
      .orderBy('created_at', 'desc');

    // Build response — badges in defined category order
    const badges = BADGE_DEFS.map(def => {
      const row = badgeRowMap[def.type];
      const isEarned = !!earned[def.type];

      // Find next badge in same category
      const categoryBadges = BADGE_DEFS.filter(b => b.category === def.category).sort((a, b) => a.order - b.order);
      const myIdx = categoryBadges.findIndex(b => b.type === def.type);
      const nextInCategory = categoryBadges[myIdx + 1];
      let nextBadge = null;
      if (isEarned && nextInCategory && !earned[nextInCategory.type]) {
        nextBadge = {
          type: nextInCategory.type,
          title: nextInCategory.title,
          remaining: progress[nextInCategory.type] || 'Keep going!',
        };
      }

      return {
        badgeType: def.type,
        category: def.category,
        categoryLabel: CATEGORY_LABELS[def.category],
        title: def.title,
        description: def.description,
        icon: def.icon,
        order: def.order,
        earned: isEarned,
        earnedAt: row?.earned_at || null,
        notified: row?.notified ?? true,
        progress: progress[def.type] || null,
        nextBadgeInCategory: nextBadge,
        reward: def.reward || null,
      };
    });

    const earnedCount = badges.filter(b => b.earned).length;

    res.json({
      badges,
      earnedCount,
      totalCount: BADGE_DEFS.length,
      categories: CATEGORY_LABELS,
      categoryOrder: CATEGORY_ORDER,
      rewards: rewards.map(r => ({
        badgeType: r.badge_type,
        rewardType: r.reward_type,
        rewardDescription: r.reward_description,
        rewardAmount: r.reward_amount,
        status: r.status,
        fulfilledAt: r.fulfilled_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/badges/:badgeType/notify
// =========================================================================
router.post('/:badgeType/notify', async (req, res, next) => {
  try {
    await db('customer_badges')
      .where({ customer_id: req.customerId, badge_type: req.params.badgeType })
      .update({ notified: true });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// ADMIN ENDPOINTS (used by BadgesPage.jsx)
// =========================================================================

// GET /api/badges/admin/definitions — all badge definitions
router.get('/admin/definitions', async (req, res) => {
  res.json({ badges: BADGE_DEFS });
});

// GET /api/badges/admin/stats — aggregate badge stats
router.get('/admin/stats', async (req, res) => {
  try {
    const [earned, customers] = await Promise.all([
      db('customer_badges').count('* as c').first().catch(() => ({ c: 0 })),
      db('customer_badges').countDistinct('customer_id as c').first().catch(() => ({ c: 0 })),
    ]);
    res.json({
      totalDefinitions: BADGE_DEFS.length,
      totalEarned: parseInt(earned?.c || 0),
      customersWithBadges: parseInt(customers?.c || 0),
    });
  } catch (err) {
    res.json({ totalDefinitions: BADGE_DEFS.length, totalEarned: 0, customersWithBadges: 0 });
  }
});

// GET /api/badges/admin/customer/:customerId — badges for a specific customer
router.get('/admin/customer/:customerId', async (req, res) => {
  try {
    const { earned, progress } = await evaluateBadges(req.params.customerId);
    const earnedList = BADGE_DEFS.filter(b => earned[b.type]).map(b => {
      return { ...b, earned: true };
    });
    // Get earned dates from DB
    const records = await db('customer_badges').where({ customer_id: req.params.customerId }).catch(() => []);
    const dateMap = Object.fromEntries((records || []).map(r => [r.badge_type, r.earned_at || r.created_at]));
    earnedList.forEach(b => { b.earnedAt = dateMap[b.type] || null; });

    const progressList = BADGE_DEFS.filter(b => !earned[b.type] && progress[b.type]).map(b => ({
      ...b, progressLabel: progress[b.type],
    }));
    res.json({ earned: earnedList, progress: progressList });
  } catch (err) {
    res.json({ earned: [], progress: [] });
  }
});

module.exports = router;
