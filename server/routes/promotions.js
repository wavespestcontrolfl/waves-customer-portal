const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

router.use(authenticate);

const WAVES_OFFICE_PHONE = '+19413187612';

// =========================================================================
// SERVICE DEFINITIONS & PRICING
// =========================================================================
const SERVICES = {
  pest_control: {
    name: 'Quarterly Pest Control',
    monthlyPrice: 45,
    keywords: ['pest control', 'quarterly pest'],
  },
  lawn_care: {
    name: 'Lawn Care Premium (12-visit)',
    monthlyPrice: 85,
    keywords: ['lawn care'],
  },
  mosquito: {
    name: 'Mosquito Barrier Monthly',
    monthlyPrice: 65,
    keywords: ['mosquito'],
  },
  tree_shrub: {
    name: 'Tree & Shrub Program (6x)',
    monthlyPrice: 55,
    keywords: ['tree', 'shrub'],
  },
  termite: {
    name: 'Termite Bait Monitoring',
    monthlyPrice: 35,
    keywords: ['termite'],
  },
};

const TIERS = {
  none: { discount: 0, label: 'No Bundle', minServices: 0 },
  Bronze: { discount: 0, label: 'Bronze', minServices: 1 },
  Silver: { discount: 0.10, label: 'Silver', minServices: 2 },
  Gold: { discount: 0.15, label: 'Gold', minServices: 3 },
  Platinum: { discount: 0.20, label: 'Platinum', minServices: 4 },
};

const TIER_ORDER = ['none', 'Bronze', 'Silver', 'Gold', 'Platinum'];

function getTierForServiceCount(count) {
  if (count >= 4) return 'Platinum';
  if (count >= 3) return 'Gold';
  if (count >= 2) return 'Silver';
  if (count >= 1) return 'Bronze';
  return 'none';
}

// =========================================================================
// SWFL SEASONAL PROMOTION LOGIC
// =========================================================================
function getSeasonalPromotions(month) {
  // month is 0-indexed: 0=Jan, 11=Dec
  const promos = {
    0: [ // January
      { service: 'termite', urgency: 'moderate', title: 'Get Ahead of Swarm Season', reason: 'Termite swarm season starts next month — Formosan and drywood swarmers are active Feb through May in SWFL', social: 'preventive inspections booked this month' },
      { service: 'lawn_care', urgency: 'moderate', title: 'New Year, New Lawn', reason: 'Start your premium lawn program before spring growth kicks in', social: 'neighbors started lawn programs this January' },
    ],
    1: [ // February
      { service: 'termite', urgency: 'high', title: 'Termite Swarm Season Is Starting', reason: 'Formosan and drywood swarmers are active Feb through May in SWFL — are your bait stations in place?', social: 'termite inspections scheduled in your area' },
      { service: 'lawn_care', urgency: 'moderate', title: 'Spring Green-Up Starts Now', reason: 'St. Augustine begins active growth — spring is the ideal time to start a lawn program', social: 'lawn programs started this month in Lakewood Ranch' },
    ],
    2: [ // March
      { service: 'termite', urgency: 'peak', title: 'Peak Termite Swarm Month', reason: 'March is the peak swarm month in Manatee & Sarasota counties — don\'t wait until you see wings', social: 'termite treatments this month in your zip code' },
      { service: 'lawn_care', urgency: 'high', title: 'Your Neighbors Are Starting Lawn Programs', reason: 'Spring is the #1 time to begin a lawn care program in SWFL', social: 'neighbors started lawn care this spring' },
      { service: 'mosquito', urgency: 'moderate', title: 'Mosquito Season Starts This Month', reason: 'Get ahead of mosquito season before populations build through the rainy months', social: 'mosquito barriers installed this month' },
    ],
    3: [ // April
      { service: 'mosquito', urgency: 'high', title: 'Mosquito Season Is Here', reason: 'April through October is active mosquito season in SWFL — populations are building fast', social: 'neighbors in Lakewood Ranch added mosquito this month' },
      { service: 'termite', urgency: 'peak', title: 'Formosan Swarmers Are Active', reason: 'Formosan swarmers appear late April — these cause the most damage of any termite species in Florida', social: 'bait station installations this spring' },
      { service: 'lawn_care', urgency: 'high', title: 'Spring Growth Is in Full Swing', reason: 'Your lawn is growing fast — now is the time for weed control and feeding', social: 'lawns under professional care in your neighborhood' },
    ],
    4: [ // May
      { service: 'mosquito', urgency: 'peak', title: 'Rainy Season Is About to Start', reason: 'Mosquito pressure is about to explode — rainy season begins in May and runs through October', social: 'mosquito customers in your area' },
      { service: 'tree_shrub', urgency: 'moderate', title: 'Protect Your Trees Before Summer', reason: 'Summer stress, whitefly, and palm health issues spike — protect your palms and ornamentals now', social: 'tree & shrub programs started this spring' },
      { service: 'termite', urgency: 'high', title: 'Termite Season Still Active', reason: 'Swarm season continues through May — have your property inspected before summer', social: 'inspections completed this month' },
    ],
    5: [ // June
      { service: 'mosquito', urgency: 'peak', title: 'Peak Mosquito Season', reason: 'June through September is the worst for mosquitoes in SWFL due to daily afternoon storms', social: 'mosquito barriers active in Lakewood Ranch' },
      { service: 'tree_shrub', urgency: 'high', title: 'Summer Tree & Shrub Protection', reason: 'Whitefly, scale, and summer stress are hitting hard — your palms and ornamentals need defense', social: 'trees under professional care nearby' },
      { service: 'pest_control', urgency: 'high', title: 'Summer = Peak Pest Activity', reason: 'Florida summer brings roaches, ants, and spiders indoors seeking moisture and cool air', social: 'homes protected by Waves in your area' },
    ],
    6: [ // July — same as June
      { service: 'mosquito', urgency: 'peak', title: 'Mosquito Pressure at Maximum', reason: 'Mid-summer in SWFL — standing water everywhere, mosquito populations are at their worst', social: 'mosquito treatments this month in your neighborhood' },
      { service: 'tree_shrub', urgency: 'high', title: 'Protect Your Palms & Ornamentals', reason: 'Summer heat and whitefly are stressing your landscaping — professional care makes the difference', social: 'tree programs active in Lakewood Ranch' },
      { service: 'pest_control', urgency: 'high', title: 'Keep Summer Pests Out', reason: 'Peak pest activity in Florida — quarterly treatments keep your home sealed', social: 'quarterly customers in your zip code' },
    ],
    7: [ // August — same pattern
      { service: 'mosquito', urgency: 'peak', title: 'Two More Months of Peak Mosquito', reason: 'August and September are the final push of peak season — don\'t let up now', social: 'continuous mosquito barriers in your area' },
      { service: 'tree_shrub', urgency: 'moderate', title: 'Late Summer Tree Health', reason: 'Your trees have been under stress all summer — a treatment now sets them up for fall recovery', social: 'tree customers preparing for fall' },
    ],
    8: [ // September
      { service: 'mosquito', urgency: 'high', title: 'Last Month of Peak Mosquito', reason: 'September wraps up peak season — maintain protection through the final push', social: 'mosquito programs running in your neighborhood' },
      { service: 'tree_shrub', urgency: 'moderate', title: 'Fall Recovery Starts for Trees', reason: 'Prepare your palms and shrubs for cooler weather with a fall feeding and treatment', social: 'fall tree programs starting' },
    ],
    9: [ // October
      { service: 'lawn_care', urgency: 'high', title: 'Fall Recovery Season — Best Time to Start', reason: 'After summer stress, October is the ideal month to begin a lawn program in SWFL', social: 'fall lawn programs started this October' },
      { service: 'tree_shrub', urgency: 'moderate', title: 'Fall Feeding & Scale Treatment', reason: 'Fall is the prime window for scale and whitefly treatment on your ornamentals', social: 'tree treatments scheduled this month' },
    ],
    10: [ // November
      { service: 'lawn_care', urgency: 'high', title: 'Set Your Lawn Up for Spring', reason: 'Pre-winter prep now means a stronger, greener lawn come spring', social: 'neighbors prepping lawns for winter' },
      { service: 'termite', urgency: 'moderate', title: 'Holiday Listing Season — Get Your WDO', reason: 'Home sales spike over the holidays — get your WDO inspection and bait stations before listing', social: 'WDO inspections this month' },
    ],
    11: [ // December
      { service: 'lawn_care', urgency: 'moderate', title: 'Winter Weed Prevention Starts Now', reason: 'Pre-emergent applied now prevents spring weeds — don\'t wait until you see them', social: 'lawns under winter care in your area' },
      { service: 'pest_control', urgency: 'moderate', title: 'Holiday-Ready Home', reason: 'Guests coming for the holidays? Make sure your home is pest-free and cobweb-free', social: 'holiday pest treatments booked' },
    ],
  };

  return promos[month] || promos[0];
}

// =========================================================================
// GET /api/promotions/relevant
// =========================================================================
router.get('/relevant', async (req, res, next) => {
  try {
    const customer = req.customer;
    const currentTier = customer.waveguard_tier || 'Bronze';
    const currentDiscount = TIERS[currentTier]?.discount || 0;

    // Determine which services the customer already has
    const serviceRecords = await db('service_records')
      .where({ customer_id: req.customerId })
      .select('service_type');

    const scheduledServices = await db('scheduled_services')
      .where({ customer_id: req.customerId })
      .select('service_type');

    const allServiceTypes = [
      ...serviceRecords.map(s => s.service_type.toLowerCase()),
      ...scheduledServices.map(s => s.service_type.toLowerCase()),
    ];

    // Map to our service keys
    const hasService = {};
    for (const [key, svc] of Object.entries(SERVICES)) {
      hasService[key] = svc.keywords.some(kw => allServiceTypes.some(st => st.includes(kw)));
    }

    const currentServiceCount = Object.values(hasService).filter(Boolean).length;

    // Check if fully covered
    if (currentServiceCount >= 5) {
      return res.json({
        fullyProtected: true,
        tier: currentTier,
        discount: `${currentDiscount * 100}%`,
        promotions: [],
      });
    }

    // Get dismissed promos (within last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dismissals = await db('promotion_dismissals')
      .where({ customer_id: req.customerId })
      .where('dismissed_at', '>=', thirtyDaysAgo.toISOString())
      .select('promotion_id');

    const dismissedIds = new Set(dismissals.map(d => d.promotion_id));

    // Get seasonal promotions
    const month = new Date().getMonth();
    const seasonalPromos = getSeasonalPromotions(month);

    // ── Property-Aware Intelligence ──
    // Use customer's property data to score relevance of each service
    const property = {
      sqft: customer.property_sqft || 0,
      lotSqft: customer.lot_sqft || 0,
      constructionMaterial: customer.construction_material || null,
      yearBuilt: customer.year_built || null,
      palmCount: customer.palm_count || 0,
      poolCage: customer.pool_cage || false,
      nearWater: customer.near_water || false,
      treeDensity: customer.tree_density || 'MODERATE',
    };

    // Property-based relevance scoring
    const propertyRelevance = {};
    // Wood frame or older home → termite protection critical
    if (property.constructionMaterial === 'WOOD_FRAME' || (property.yearBuilt && property.yearBuilt < 1990)) {
      propertyRelevance.termite = { boost: 3, reason: `Your ${property.constructionMaterial === 'WOOD_FRAME' ? 'wood frame' : 'pre-1990'} home has elevated termite risk` };
    }
    // Large lot or treatable area → lawn care
    if (property.lotSqft > 8000) {
      propertyRelevance.lawn_care = { boost: 2, reason: `Your ${Math.round(property.lotSqft / 1000)}K sq ft lot is ideal for our lawn program` };
    }
    // Many palms or heavy tree density → tree & shrub
    if (property.palmCount >= 4 || property.treeDensity === 'HEAVY') {
      propertyRelevance.tree_shrub = { boost: 2, reason: `With ${property.palmCount || 'multiple'} palms and ${property.treeDensity?.toLowerCase()} vegetation, professional tree & shrub care protects your investment` };
    }
    // Pool cage or near water → mosquito
    if (property.poolCage || property.nearWater) {
      propertyRelevance.mosquito = { boost: 2, reason: `${property.nearWater ? 'Your proximity to water' : 'Your pool/lanai area'} creates prime mosquito breeding conditions` };
    }
    // Larger home → pest control priority
    if (property.sqft > 2500) {
      propertyRelevance.pest_control = { boost: 1, reason: `Larger homes have more entry points — quarterly treatments keep your ${Math.round(property.sqft / 1000)}K sq ft home sealed` };
    }

    // Filter: only services they DON'T have, not dismissed
    const relevant = [];
    for (const promo of seasonalPromos) {
      if (hasService[promo.service]) continue; // already has it

      const promoId = `promo_${promo.service}_${month}`;
      if (dismissedIds.has(promoId)) continue; // dismissed

      const svc = SERVICES[promo.service];
      const newServiceCount = currentServiceCount + 1;
      const newTier = getTierForServiceCount(newServiceCount);
      const newDiscount = TIERS[newTier]?.discount || 0;
      const tierUpgrade = newTier !== currentTier && TIER_ORDER.indexOf(newTier) > TIER_ORDER.indexOf(currentTier);

      const originalPrice = svc.monthlyPrice;
      const discountedPrice = +(originalPrice * (1 - (tierUpgrade ? newDiscount : currentDiscount))).toFixed(2);
      const savings = +(originalPrice - discountedPrice).toFixed(2);

      // Calculate total monthly savings across ALL services at new tier if upgrading
      let totalMonthlySavingsAtNewTier = null;
      if (tierUpgrade) {
        let totalAtCurrent = 0;
        let totalAtNew = 0;
        for (const [key, s] of Object.entries(SERVICES)) {
          if (hasService[key] || key === promo.service) {
            totalAtCurrent += s.monthlyPrice * (1 - currentDiscount);
            totalAtNew += s.monthlyPrice * (1 - newDiscount);
          }
        }
        totalMonthlySavingsAtNewTier = +(totalAtCurrent - totalAtNew + (originalPrice * currentDiscount)).toFixed(2);
      }

      // Social proof — randomize a realistic number
      const socialBase = { peak: 15, high: 10, moderate: 6 };
      const socialNum = (socialBase[promo.urgency] || 5) + Math.floor(Math.random() * 8);

      // Property-specific enhancement
      const propBoost = propertyRelevance[promo.service];
      const description = propBoost
        ? `${propBoost.reason}. ${promo.reason}`
        : promo.reason;

      relevant.push({
        id: promoId,
        title: promo.title,
        description,
        serviceType: promo.service,
        serviceName: svc.name,
        originalMonthlyPrice: originalPrice,
        discountedMonthlyPrice: discountedPrice,
        currentTier,
        currentDiscount: `${currentDiscount * 100}%`,
        tierUpgradeAvailable: tierUpgrade,
        potentialNewTier: tierUpgrade ? newTier : null,
        potentialNewDiscount: tierUpgrade ? `${newDiscount * 100}%` : null,
        totalMonthlySavingsAtNewTier,
        savingsText: tierUpgrade
          ? `Unlock ${newTier} — ${newDiscount * 100}% off everything`
          : savings > 0
            ? `Save $${savings}/mo with your ${currentTier} discount`
            : null,
        seasonalUrgency: promo.urgency,
        urgencyReason: promo.reason,
        propertyRelevance: propBoost ? propBoost.reason : null,
        relevanceScore: (propBoost?.boost || 0) + ({ peak: 3, high: 2, moderate: 1 }[promo.urgency] || 0) + (tierUpgrade ? 2 : 0),
        socialProof: `${socialNum} ${promo.social}`,
        ctaText: `Add ${svc.name.split(' (')[0]}`,
      });
    }

    // Sort by relevance score (property match + seasonal urgency + tier upgrade potential)
    relevant.sort((a, b) => b.relevanceScore - a.relevanceScore);

    res.json({
      fullyProtected: false,
      tier: currentTier,
      discount: `${currentDiscount * 100}%`,
      serviceCount: currentServiceCount,
      promotions: relevant.slice(0, 2), // Top 2 most relevant
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/promotions/:id/interest
// =========================================================================
router.post('/:id/interest', async (req, res, next) => {
  try {
    const promoId = req.params.id;
    const { serviceType, serviceName } = req.body;
    const customer = req.customer;

    // Create service request
    await db('service_requests').insert({
      customer_id: req.customerId,
      category: 'add_service',
      subject: `Interested in adding ${serviceName || serviceType}`,
      description: `Customer expressed interest via promotion card: ${promoId}`,
      status: 'new',
    });

    // Count current services for tier info
    const serviceRecords = await db('service_records')
      .where({ customer_id: req.customerId })
      .select('service_type');
    const serviceTypes = [...new Set(serviceRecords.map(s => s.service_type))];
    const currentCount = Object.entries(SERVICES).filter(([_, svc]) =>
      svc.keywords.some(kw => serviceTypes.some(st => st.toLowerCase().includes(kw)))
    ).length;
    const newTier = getTierForServiceCount(currentCount + 1);
    const newDiscount = TIERS[newTier]?.discount || 0;
    const svc = SERVICES[serviceType] || {};
    const discountedPrice = svc.monthlyPrice ? (svc.monthlyPrice * (1 - newDiscount)).toFixed(2) : '?';

    // SMS to office
    try {
      await TwilioService.sendSMS(
        WAVES_OFFICE_PHONE,
        `🎯 Upsell Interest!\n\n` +
        `${customer.first_name} ${customer.last_name} at ${customer.address_line1}, ${customer.city}\n` +
        `is interested in adding ${serviceName || serviceType}.\n\n` +
        `Currently: ${customer.waveguard_tier} WaveGuard (${currentCount} services)\n` +
        `Adding this → ${newTier} (${newDiscount * 100}% off)\n` +
        `Their price: $${discountedPrice}/mo\n\n` +
        `Follow up!`
      );
    } catch (smsErr) {
      logger.error(`Failed to send upsell SMS: ${smsErr.message}`);
    }

    // SMS to customer
    try {
      await TwilioService.sendSMS(
        customer.phone,
        `🌊 Thanks for your interest in ${serviceName || serviceType}, ${customer.first_name}!\n\n` +
        `Waves will follow up within 24 hours to get you set up. ` +
        `Your ${newTier} WaveGuard discount will apply automatically.\n\n` +
        `Questions? Call us: (941) 318-7612`
      );
    } catch (smsErr) {
      logger.error(`Failed to send customer confirmation: ${smsErr.message}`);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/promotions/:id/dismiss
// =========================================================================
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    const promoId = req.params.id;

    await db('promotion_dismissals')
      .insert({
        customer_id: req.customerId,
        promotion_id: promoId,
        dismissed_at: db.fn.now(),
      })
      .onConflict(['customer_id', 'promotion_id'])
      .merge({ dismissed_at: db.fn.now() });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
