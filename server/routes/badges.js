const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// =========================================================================
// BADGE DEFINITIONS — 32 badges across 8 categories
// =========================================================================
const BADGE_DEFS = [
  // ONBOARDING
  { type: 'welcome_aboard', category: 'onboarding', title: 'Welcome Aboard', icon: '🌊', description: "You're officially part of the Waves family", order: 1 },
  { type: 'property_pro', category: 'onboarding', title: 'Property Pro', icon: '🏡', description: 'Your tech knows exactly how to serve your home', order: 2 },
  { type: 'first_visit', category: 'onboarding', title: 'First Visit', icon: '🌱', description: 'Your first service is in the books', order: 3 },

  // LOYALTY
  { type: 'member_3mo', category: 'loyalty', title: '3-Month Member', icon: '⭐', description: 'A quarter year of protection', order: 1 },
  { type: 'member_6mo', category: 'loyalty', title: '6-Month Member', icon: '🌟', description: 'Half a year strong', order: 2 },
  { type: 'member_1yr', category: 'loyalty', title: '1-Year Veteran', icon: '🏆', description: 'A full year of Waves protection', order: 3 },
  { type: 'member_2yr', category: 'loyalty', title: '2-Year Legend', icon: '💎', description: "Two years — you're a Waves legend", order: 4 },
  { type: 'member_og', category: 'loyalty', title: 'OG Member', icon: '👑', description: 'Day one. Original Waves family.', order: 5 },

  // PAYMENT
  { type: 'perfect_payer', category: 'payment', title: 'Perfect Payer', icon: '💳', description: 'Never missed a beat', order: 1 },
  { type: 'annual_prepay', category: 'payment', title: 'Annual Prepay', icon: '💰', description: 'Smart move — you saved with prepay', order: 2 },

  // ENGAGEMENT
  { type: 'feedback_champion', category: 'engagement', title: 'Feedback Champion', icon: '📝', description: 'Your feedback makes us better', order: 1 },
  { type: 'review_rockstar', category: 'engagement', title: 'Review Rockstar', icon: '⭐', description: 'Thanks for spreading the word', order: 2 },
  { type: 'responsive', category: 'engagement', title: 'Responsive', icon: '✅', description: 'Always ready for service day', order: 3 },
  { type: 'portal_regular', category: 'engagement', title: 'Portal Regular', icon: '📱', description: 'You love staying in the loop', order: 4 },
  { type: 'doc_downloader', category: 'engagement', title: 'Document Downloader', icon: '📄', description: 'Organized and informed', order: 5 },

  // REFERRAL
  { type: 'referral_starter', category: 'referral', title: 'Referral Starter', icon: '🤝', description: 'Your first referral! $25 earned.', order: 1 },
  { type: 'referral_pro', category: 'referral', title: 'Referral Pro', icon: '🎯', description: '$75 in referral credits. Your neighbors thank you.', order: 2 },
  { type: 'referral_legend', category: 'referral', title: 'Referral Legend', icon: '🏅', description: "$125 earned. You're our best ambassador.", order: 3 },
  { type: 'referral_mvp', category: 'referral', title: 'Referral MVP', icon: '🦸', description: "MVP status. You've built a Waves neighborhood.", order: 4 },

  // TIER
  { type: 'tier_silver', category: 'tier', title: 'WaveGuard Silver', icon: '🥈', description: '10% bundle savings unlocked', order: 1 },
  { type: 'tier_gold', category: 'tier', title: 'WaveGuard Gold', icon: '🥇', description: '15% bundle savings unlocked', order: 2 },
  { type: 'tier_platinum', category: 'tier', title: 'WaveGuard Platinum', icon: '💎', description: '20% bundle savings — maximum protection', order: 3 },
  { type: 'tier_up', category: 'tier', title: 'Tier Up', icon: '⬆️', description: 'You leveled up your protection', order: 4 },

  // SERVICE
  { type: 'green_thumb', category: 'service', title: 'Green Thumb', icon: '🌿', description: 'Your lawn is in premium hands', order: 1 },
  { type: 'mosquito_slayer', category: 'service', title: 'Mosquito Slayer', icon: '🦟', description: 'You made it through peak season bite-free', order: 2 },
  { type: 'fully_protected', category: 'service', title: 'Fully Protected', icon: '🏰', description: 'Total home protection — nothing gets through', order: 3 },
  { type: 'visits_25', category: 'service', title: '25 Visits', icon: '📋', description: '25 visits and counting', order: 4 },
  { type: 'visits_50', category: 'service', title: '50 Visits', icon: '🎖️', description: 'Half a century of service visits', order: 5 },
  { type: 'lawn_transformation', category: 'service', title: 'Lawn Transformation', icon: '🔄', description: 'Your lawn glow-up is real', order: 6 },

  // SEASONAL
  { type: 'summer_survivor', category: 'seasonal', title: 'Summer Survivor', icon: '☀️', description: 'You survived SWFL summer with Waves', order: 1 },
  { type: 'hurricane_ready', category: 'seasonal', title: 'Hurricane Ready', icon: '🌀', description: 'Protected through storm season', order: 2 },
  { type: 'year_round_warrior', category: 'seasonal', title: 'Year-Round Warrior', icon: '🗓️', description: 'Every single month. That is commitment.', order: 3 },
];

const BADGE_MAP = Object.fromEntries(BADGE_DEFS.map(b => [b.type, b]));

const CATEGORY_LABELS = {
  onboarding: 'Getting Started',
  loyalty: 'Loyalty',
  payment: 'Payment',
  engagement: 'Engagement',
  referral: 'Referrals',
  tier: 'WaveGuard Tier',
  service: 'Service Milestones',
  seasonal: 'Seasonal',
};

// =========================================================================
// BADGE EVALUATION ENGINE
// =========================================================================
async function evaluateBadges(customerId) {
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) return [];

  // Gather all data needed for evaluation
  const [services, payments, referrals, satisfaction, propertyPrefs, lawnHealth, confirmedAppts] = await Promise.all([
    db('service_records').where({ customer_id: customerId, status: 'completed' }).orderBy('service_date'),
    db('payments').where({ customer_id: customerId }),
    db('referrals').where({ referrer_customer_id: customerId }),
    db('satisfaction_responses').where({ customer_id: customerId }),
    db('property_preferences').where({ customer_id: customerId }).first(),
    db('lawn_health_scores').where({ customer_id: customerId }).orderBy('assessment_date', 'asc'),
    db('scheduled_services').where({ customer_id: customerId, customer_confirmed: true }),
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

  // Evaluate each badge
  const earned = {};

  // ONBOARDING
  earned.welcome_aboard = true; // they're logged in
  earned.property_pro = !!propComplete;
  earned.first_visit = totalVisits >= 1;

  // LOYALTY
  earned.member_3mo = memberDays >= 90;
  earned.member_6mo = memberDays >= 180;
  earned.member_1yr = memberDays >= 365;
  earned.member_2yr = memberDays >= 730;
  earned.member_og = memberDays >= 1095;

  // PAYMENT
  earned.perfect_payer = paidPayments.length >= 6 && failedPayments.length === 0;
  earned.annual_prepay = false; // would need prepay tracking

  // ENGAGEMENT
  earned.feedback_champion = satisfaction.length >= 3;
  earned.review_rockstar = satisfaction.some(s => s.directed_to_review);
  earned.responsive = confirmedAppts.length >= 6;
  earned.portal_regular = true; // simplified — would need login tracking
  earned.doc_downloader = false; // would need download tracking

  // REFERRAL
  earned.referral_starter = totalReferrals >= 1;
  earned.referral_pro = totalReferrals >= 3;
  earned.referral_legend = totalReferrals >= 5;
  earned.referral_mvp = totalReferrals >= 10;

  // TIER
  earned.tier_silver = ['Silver', 'Gold', 'Platinum'].includes(tier);
  earned.tier_gold = ['Gold', 'Platinum'].includes(tier);
  earned.tier_platinum = tier === 'Platinum';
  earned.tier_up = false; // would need tier history tracking

  // SERVICE
  const lawnServices = services.filter(s => s.service_type.toLowerCase().includes('lawn care'));
  const lawnMonths = lawnServices.length > 0 ? Math.floor((now - new Date(lawnServices[0].service_date + 'T12:00:00')) / (1000 * 60 * 60 * 24 * 30)) : 0;
  earned.green_thumb = hasLawn && lawnMonths >= 6;

  // Mosquito slayer: had mosquito service spanning Apr-Oct
  const mosquitoServices = services.filter(s => s.service_type.toLowerCase().includes('mosquito'));
  const mosquitoMonths = new Set(mosquitoServices.map(s => new Date(s.service_date + 'T12:00:00').getMonth()));
  earned.mosquito_slayer = hasMosquito && [3, 4, 5, 6, 7, 8, 9].every(m => mosquitoMonths.has(m));

  earned.fully_protected = hasPest && hasLawn && hasMosquito && hasTermite;
  earned.visits_25 = totalVisits >= 25;
  earned.visits_50 = totalVisits >= 50;
  earned.lawn_transformation = lawnImprovement >= 30;

  // SEASONAL
  const serviceMonths = new Set(services.map(s => {
    const d = new Date(s.service_date + 'T12:00:00');
    return `${d.getFullYear()}-${d.getMonth()}`;
  }));
  const summerMonths = [5, 6, 7, 8]; // Jun-Sep
  const hurricaneMonths = [5, 6, 7, 8, 9, 10]; // Jun-Nov
  const currentYear = now.getFullYear();
  const lastYear = currentYear - 1;

  earned.summer_survivor = summerMonths.every(m =>
    serviceMonths.has(`${lastYear}-${m}`) || serviceMonths.has(`${currentYear}-${m}`)
  );
  earned.hurricane_ready = hurricaneMonths.some(m =>
    serviceMonths.has(`${lastYear}-${m}`) || serviceMonths.has(`${currentYear}-${m}`)
  );
  // Year-round: 12 consecutive months
  earned.year_round_warrior = (() => {
    for (let startMonth = 0; startMonth < 12; startMonth++) {
      let consecutive = true;
      for (let i = 0; i < 12; i++) {
        const checkDate = new Date(lastYear, startMonth + i, 1);
        const key = `${checkDate.getFullYear()}-${checkDate.getMonth()}`;
        if (!serviceMonths.has(key)) { consecutive = false; break; }
      }
      if (consecutive) return true;
    }
    return false;
  })();

  // Build progress info for locked badges
  const progress = {};
  if (!earned.member_3mo) progress.member_3mo = `${memberDays}/90 days`;
  if (!earned.member_6mo) progress.member_6mo = `${memberDays}/180 days`;
  if (!earned.member_1yr) progress.member_1yr = `${memberDays}/365 days`;
  if (!earned.member_2yr) progress.member_2yr = `${Math.floor(memberDays / 365)}/2 years`;
  if (!earned.feedback_champion) progress.feedback_champion = `${satisfaction.length}/3 reviews`;
  if (!earned.referral_starter) progress.referral_starter = `${totalReferrals}/1 referral`;
  if (!earned.referral_pro) progress.referral_pro = `${totalReferrals}/3 referrals`;
  if (!earned.referral_legend) progress.referral_legend = `${totalReferrals}/5 referrals`;
  if (!earned.referral_mvp) progress.referral_mvp = `${totalReferrals}/10 referrals`;
  if (!earned.visits_25) progress.visits_25 = `${totalVisits}/25 visits`;
  if (!earned.visits_50) progress.visits_50 = `${totalVisits}/50 visits`;
  if (!earned.perfect_payer) progress.perfect_payer = `${paidPayments.length}/6 payments`;
  if (!earned.responsive) progress.responsive = `${confirmedAppts.length}/6 confirmations`;
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

    // Insert newly earned badges
    const newBadges = [];
    for (const [type, isEarned] of Object.entries(earned)) {
      if (isEarned && !existingMap[type]) {
        newBadges.push({ customer_id: req.customerId, badge_type: type });
      }
    }
    if (newBadges.length) {
      await db('customer_badges').insert(newBadges).onConflict(['customer_id', 'badge_type']).ignore();
    }

    // Re-fetch to get earned_at timestamps
    const allBadgeRows = await db('customer_badges').where({ customer_id: req.customerId });
    const badgeRowMap = Object.fromEntries(allBadgeRows.map(b => [b.badge_type, b]));

    // Build response
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
        notified: row?.notified ?? true, // unearned = no toast needed
        progress: progress[def.type] || null,
        nextBadgeInCategory: nextBadge,
      };
    });

    const earnedCount = badges.filter(b => b.earned).length;

    res.json({
      badges,
      earnedCount,
      totalCount: BADGE_DEFS.length,
      categories: CATEGORY_LABELS,
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

module.exports = router;
