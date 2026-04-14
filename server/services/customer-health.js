const db = require('../models/db');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Weights for composite score
// ---------------------------------------------------------------------------
const WEIGHTS = {
  payment: 0.25,
  service: 0.20,
  satisfaction: 0.20,
  engagement: 0.15,
  loyalty: 0.10,
  growth: 0.10,
};

// ---------------------------------------------------------------------------
// Grade helpers
// ---------------------------------------------------------------------------
function getGrade(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Table-existence cache (reset each batch run)
// ---------------------------------------------------------------------------
let _tableCache = {};
async function tableExists(name) {
  if (_tableCache[name] !== undefined) return _tableCache[name];
  try {
    const exists = await db.schema.hasTable(name);
    _tableCache[name] = exists;
    return exists;
  } catch {
    _tableCache[name] = false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. Payment Score (0-100)
// ---------------------------------------------------------------------------
async function computePaymentScore(customerId) {
  const details = { source: 'none', onTimeRate: null, lateCount: 0, failedCount: 0 };

  // Try invoices table first, then payments table
  for (const tbl of ['invoices', 'payments']) {
    if (!(await tableExists(tbl))) continue;
    try {
      const rows = await db(tbl).where('customer_id', customerId).orderBy('created_at', 'desc').limit(24);
      if (rows.length === 0) continue;

      details.source = tbl;
      const total = rows.length;
      const paid = rows.filter(r => ['paid', 'completed', 'succeeded'].includes(r.status));
      const late = rows.filter(r => ['late', 'overdue', 'past_due'].includes(r.status));
      const failed = rows.filter(r => ['failed', 'declined', 'void'].includes(r.status));

      details.onTimeRate = total > 0 ? paid.length / total : 0;
      details.lateCount = late.length;
      details.failedCount = failed.length;

      let score = 60; // base
      score += Math.round(details.onTimeRate * 30); // up to 30 for on-time
      score -= late.length * 5;
      score -= failed.length * 10;

      // Bonus for consistent recent payments
      const recent = rows.slice(0, 6);
      const recentPaid = recent.filter(r => ['paid', 'completed', 'succeeded'].includes(r.status));
      if (recent.length >= 3 && recentPaid.length === recent.length) score += 10;

      return { score: clamp(score), details };
    } catch (err) {
      logger.debug(`[health] ${tbl} query error for ${customerId}: ${err.message}`);
    }
  }

  // No payment data → default
  return { score: 60, details };
}

// ---------------------------------------------------------------------------
// 2. Service Score (0-100)
// ---------------------------------------------------------------------------
async function computeServiceScore(customerId) {
  const details = { completedCount: 0, cancelledCount: 0, skippedCount: 0, daysSinceLastService: null, adherenceRate: null };
  let score = 50;

  try {
    // Service records
    if (await tableExists('service_records')) {
      const records = await db('service_records').where('customer_id', customerId).orderBy('service_date', 'desc').limit(50);
      const completed = records.filter(r => r.status === 'completed');
      const cancelled = records.filter(r => r.status === 'cancelled');
      details.completedCount = completed.length;
      details.cancelledCount = cancelled.length;

      if (completed.length > 0) {
        const lastDate = new Date(completed[0].service_date);
        details.daysSinceLastService = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
      }

      if (records.length > 0) {
        details.adherenceRate = completed.length / records.length;
      }
    }

    // Scheduled services
    if (await tableExists('scheduled_services')) {
      const scheduled = await db('scheduled_services').where('customer_id', customerId)
        .where('scheduled_date', '<', new Date().toISOString())
        .limit(50);
      const skipped = scheduled.filter(s => s.status === 'skipped' || s.status === 'cancelled');
      details.skippedCount = skipped.length;
    }

    // Callback ratio tracking
    details.callbackCount = 0;
    details.callbackRatio = 0;
    try {
      if (await tableExists('service_records')) {
        const sixMonthsAgo = new Date(Date.now() - 180 * 86400000);
        const cbResult = await db('service_records')
          .where('customer_id', customerId)
          .where('service_date', '>', sixMonthsAgo)
          .where(function() {
            this.where('is_callback', true)
              .orWhere('service_type', 'ilike', '%callback%')
              .orWhere('service_type', 'ilike', '%re-service%');
          })
          .count('* as count').first();
        details.callbackCount = parseInt(cbResult?.count || 0);

        const totalRecent = await db('service_records')
          .where('customer_id', customerId)
          .where('service_date', '>', sixMonthsAgo)
          .count('* as count').first();
        const totalCount = parseInt(totalRecent?.count || 0);
        details.callbackRatio = totalCount > 0 ? details.callbackCount / totalCount : 0;
      }
    } catch { /* is_callback column may not exist */ }

    // Calculate score
    if (details.completedCount > 0) {
      score = 50;
      // Recency bonus
      if (details.daysSinceLastService !== null) {
        if (details.daysSinceLastService <= 30) score += 20;
        else if (details.daysSinceLastService <= 60) score += 10;
        else if (details.daysSinceLastService <= 90) score += 5;
        else score -= 10;
      }
      // Adherence bonus
      if (details.adherenceRate !== null) {
        score += Math.round(details.adherenceRate * 20);
      }
      // Volume bonus
      if (details.completedCount >= 12) score += 10;
      else if (details.completedCount >= 6) score += 5;
      // Penalties
      score -= details.cancelledCount * 3;
      score -= details.skippedCount * 2;

      // Callback penalty: -5 per callback, -10 additional if ratio > 20%
      score -= details.callbackCount * 5;
      if (details.callbackRatio > 0.2) score -= 10;
    }
  } catch (err) {
    logger.debug(`[health] service score error for ${customerId}: ${err.message}`);
  }

  return { score: clamp(score), details };
}

// ---------------------------------------------------------------------------
// 3. Engagement Score (0-100)
// ---------------------------------------------------------------------------
async function computeEngagementScore(customerId) {
  const details = { smsInbound: 0, smsOutbound: 0, interactions: 0, daysSinceLastContact: null };
  let score = 50;

  try {
    // SMS engagement
    if (await tableExists('sms_log')) {
      const smsRows = await db('sms_log').where('customer_id', customerId).orderBy('created_at', 'desc').limit(100);
      details.smsInbound = smsRows.filter(s => s.direction === 'inbound').length;
      details.smsOutbound = smsRows.filter(s => s.direction === 'outbound').length;

      if (smsRows.length > 0) {
        const lastSms = new Date(smsRows[0].created_at);
        details.daysSinceLastContact = Math.floor((Date.now() - lastSms.getTime()) / 86400000);
      }
    }

    // Customer interactions
    if (await tableExists('customer_interactions')) {
      const interactions = await db('customer_interactions').where('customer_id', customerId).count('* as cnt').first();
      details.interactions = parseInt(interactions?.cnt || 0);
    }

    // Scoring
    const totalEngagement = details.smsInbound + details.interactions;
    if (totalEngagement >= 10) score += 25;
    else if (totalEngagement >= 5) score += 15;
    else if (totalEngagement >= 2) score += 5;
    else if (totalEngagement === 0) score -= 15;

    // Response ratio (inbound vs outbound)
    if (details.smsOutbound > 0 && details.smsInbound > 0) {
      const ratio = details.smsInbound / details.smsOutbound;
      if (ratio >= 0.5) score += 10;
      else if (ratio >= 0.2) score += 5;
    }

    // Recency
    if (details.daysSinceLastContact !== null) {
      if (details.daysSinceLastContact <= 14) score += 10;
      else if (details.daysSinceLastContact <= 30) score += 5;
      else if (details.daysSinceLastContact > 90) score -= 10;
    }
  } catch (err) {
    logger.debug(`[health] engagement score error for ${customerId}: ${err.message}`);
  }

  return { score: clamp(score), details };
}

// ---------------------------------------------------------------------------
// 4. Satisfaction Score (0-100)
// ---------------------------------------------------------------------------
async function computeSatisfactionScore(customerId) {
  const details = { avgRating: null, reviewCount: 0, complaintCount: 0, complimentCount: 0 };
  let score = 50;

  try {
    // Check for ratings in service_records
    if (await tableExists('service_records') && await db.schema.hasColumn('service_records', 'rating')) {
      try {
        const ratings = await db('service_records')
          .where('customer_id', customerId)
          .whereNotNull('rating')
          .select('rating');
        if (ratings.length > 0) {
          const avg = ratings.reduce((sum, r) => sum + parseFloat(r.rating), 0) / ratings.length;
          details.avgRating = Math.round(avg * 10) / 10;
          details.reviewCount = ratings.length;
          score = Math.round((avg / 5) * 100);
        }
      } catch { /* rating column may not exist */ }
    }

    // Check for interactions tagged as complaint/compliment
    if (await tableExists('customer_interactions')) {
      try {
        const complaints = await db('customer_interactions')
          .where('customer_id', customerId)
          .where('interaction_type', 'complaint')
          .count('* as cnt').first();
        details.complaintCount = parseInt(complaints?.cnt || 0);

        const compliments = await db('customer_interactions')
          .where('customer_id', customerId)
          .where('interaction_type', 'compliment')
          .count('* as cnt').first();
        details.complimentCount = parseInt(compliments?.cnt || 0);

        score -= details.complaintCount * 10;
        score += details.complimentCount * 5;
      } catch { /* interaction_type may not exist */ }
    }
  } catch (err) {
    logger.debug(`[health] satisfaction score error for ${customerId}: ${err.message}`);
  }

  return { score: clamp(score), details };
}

// ---------------------------------------------------------------------------
// 5. Loyalty Score (0-100)
// ---------------------------------------------------------------------------
async function computeLoyaltyScore(customerId) {
  const details = { tenureMonths: 0, tier: null, referralCount: 0 };
  let score = 50;

  try {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return { score, details };

    // Tenure
    const memberSince = customer.member_since || customer.created_at;
    if (memberSince) {
      const months = Math.floor((Date.now() - new Date(memberSince).getTime()) / (30.44 * 86400000));
      details.tenureMonths = months;
      if (months >= 24) score += 25;
      else if (months >= 12) score += 15;
      else if (months >= 6) score += 8;
      else if (months >= 3) score += 3;
    }

    // Tier
    details.tier = customer.waveguard_tier || null;
    if (details.tier) {
      const tierBonus = { platinum: 15, gold: 10, silver: 5, bronze: 2 };
      score += tierBonus[details.tier.toLowerCase()] || 0;
    }

    // Referrals
    if (customer.referral_count) {
      details.referralCount = parseInt(customer.referral_count) || 0;
    } else if (await tableExists('customer_tags')) {
      try {
        const refTags = await db('customer_tags')
          .where('customer_id', customerId)
          .where('tag', 'like', '%referral%')
          .count('* as cnt').first();
        details.referralCount = parseInt(refTags?.cnt || 0);
      } catch { /* ok */ }
    }
    if (details.referralCount > 0) {
      score += Math.min(details.referralCount * 5, 15);
    }
  } catch (err) {
    logger.debug(`[health] loyalty score error for ${customerId}: ${err.message}`);
  }

  return { score: clamp(score), details };
}

// ---------------------------------------------------------------------------
// 6. Growth Score (0-100)
// ---------------------------------------------------------------------------
async function computeGrowthScore(customerId) {
  const details = { distinctServices: 0, monthlyRate: null, rateChange: null };
  let score = 50;

  try {
    // Distinct service types
    if (await tableExists('service_records')) {
      try {
        const types = await db('service_records')
          .where('customer_id', customerId)
          .distinct('service_type')
          .whereNotNull('service_type');
        details.distinctServices = types.length;
        if (types.length >= 4) score += 20;
        else if (types.length >= 3) score += 15;
        else if (types.length >= 2) score += 10;
        else if (types.length === 1) score += 3;
      } catch { /* service_type column may not exist */ }
    }

    // Monthly rate
    const customer = await db('customers').where('id', customerId).first();
    if (customer && customer.monthly_rate) {
      details.monthlyRate = parseFloat(customer.monthly_rate);
      if (details.monthlyRate >= 200) score += 15;
      else if (details.monthlyRate >= 100) score += 10;
      else if (details.monthlyRate >= 50) score += 5;
    }

    // Rate trend (check previous_monthly_rate if available)
    if (customer && customer.previous_monthly_rate && customer.monthly_rate) {
      const prev = parseFloat(customer.previous_monthly_rate);
      const curr = parseFloat(customer.monthly_rate);
      if (prev > 0) {
        details.rateChange = ((curr - prev) / prev * 100).toFixed(1);
        if (curr > prev) score += 10;
        else if (curr < prev) score -= 10;
      }
    }
  } catch (err) {
    logger.debug(`[health] growth score error for ${customerId}: ${err.message}`);
  }

  return { score: clamp(score), details };
}

// ---------------------------------------------------------------------------
// Churn signal detection
// ---------------------------------------------------------------------------
async function detectChurnSignals(customerId, scores) {
  const signals = [];

  try {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return signals;

    // 1. Score below 35
    if (scores.overall <= 35) {
      signals.push({ signal: 'critical_score', severity: 'critical', message: `Overall health score is critically low (${scores.overall})` });
    }

    // 2. Score dropped >15 pts in 30 days
    if (scores.scoreChange30d !== null && scores.scoreChange30d < -15) {
      signals.push({ signal: 'rapid_decline', severity: 'high', message: `Score dropped ${Math.abs(scores.scoreChange30d)} points in 30 days` });
    }

    // 3. No service in 90+ days
    const serviceDetails = scores.serviceDetails || {};
    if (serviceDetails.daysSinceLastService && serviceDetails.daysSinceLastService > 90) {
      signals.push({ signal: 'service_gap', severity: 'high', message: `No service in ${serviceDetails.daysSinceLastService} days` });
    }

    // 4. Payment failures
    const paymentDetails = scores.paymentDetails || {};
    if (paymentDetails.failedCount && paymentDetails.failedCount >= 2) {
      signals.push({ signal: 'payment_failures', severity: 'high', message: `${paymentDetails.failedCount} failed payments` });
    }

    // 5. Zero engagement in 60+ days
    const engDetails = scores.engagementDetails || {};
    if (engDetails.daysSinceLastContact && engDetails.daysSinceLastContact > 60) {
      signals.push({ signal: 'no_engagement', severity: 'moderate', message: `No contact in ${engDetails.daysSinceLastContact} days` });
    }

    // 6. Multiple cancelled/skipped services
    if (serviceDetails.cancelledCount >= 3 || serviceDetails.skippedCount >= 3) {
      const cnt = (serviceDetails.cancelledCount || 0) + (serviceDetails.skippedCount || 0);
      signals.push({ signal: 'service_avoidance', severity: 'moderate', message: `${cnt} cancelled/skipped services` });
    }

    // 7. Low satisfaction + complaints
    const satDetails = scores.satisfactionDetails || {};
    if (satDetails.avgRating && satDetails.avgRating < 3) {
      signals.push({ signal: 'low_satisfaction', severity: 'high', message: `Average rating ${satDetails.avgRating}/5` });
    }
    if (satDetails.complaintCount && satDetails.complaintCount >= 2) {
      signals.push({ signal: 'complaints', severity: 'moderate', message: `${satDetails.complaintCount} complaints on record` });
    }

    // 8. Downgraded tier
    if (customer.previous_tier && customer.waveguard_tier) {
      const tierRank = { platinum: 4, gold: 3, silver: 2, bronze: 1 };
      const prev = tierRank[customer.previous_tier?.toLowerCase()] || 0;
      const curr = tierRank[customer.waveguard_tier?.toLowerCase()] || 0;
      if (prev > curr) {
        signals.push({ signal: 'tier_downgrade', severity: 'moderate', message: `Downgraded from ${customer.previous_tier} to ${customer.waveguard_tier}` });
      }
    }

    // 9. Low payment score
    if (scores.payment < 30) {
      signals.push({ signal: 'payment_risk', severity: 'high', message: `Payment score critically low (${scores.payment})` });
    }

    // 10. Short tenure + low engagement
    const loyaltyDetails = scores.loyaltyDetails || {};
    if (loyaltyDetails.tenureMonths < 6 && scores.engagement < 40) {
      signals.push({ signal: 'new_disengaged', severity: 'moderate', message: 'New customer with low engagement' });
    }

    // 11. Multiple sub-scores below 30
    const subScores = [scores.payment, scores.service, scores.engagement, scores.satisfaction, scores.loyalty, scores.growth];
    const belowThreshold = subScores.filter(s => s < 30).length;
    if (belowThreshold >= 3) {
      signals.push({ signal: 'multi_factor_risk', severity: 'critical', message: `${belowThreshold} sub-scores below 30` });
    }
  } catch (err) {
    logger.debug(`[health] churn signal error for ${customerId}: ${err.message}`);
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Determine churn risk level
// ---------------------------------------------------------------------------
function determineChurnRisk(signals, overallScore) {
  const hasCritical = signals.some(s => s.severity === 'critical');
  const highCount = signals.filter(s => s.severity === 'high').length;

  if (hasCritical || overallScore < 25) return 'critical';
  if (highCount >= 2 || overallScore < 40) return 'high';
  if (signals.length >= 2 || overallScore < 55) return 'moderate';
  return 'low';
}

function estimateChurnProbability(risk, overallScore) {
  const base = { critical: 0.80, high: 0.55, moderate: 0.30, low: 0.10 };
  const b = base[risk] || 0.10;
  // Adjust based on score distance from 50
  const adj = (50 - overallScore) * 0.003;
  return Math.max(0, Math.min(1, Math.round((b + adj) * 10000) / 10000));
}

function estimateDaysUntilChurn(risk) {
  const days = { critical: 30, high: 60, moderate: 120, low: null };
  return days[risk] || null;
}

// ---------------------------------------------------------------------------
// Score trend from history
// ---------------------------------------------------------------------------
async function computeTrend(customerId) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const history = await db('customer_health_history')
      .where('customer_id', customerId)
      .where('scored_at', '>=', thirtyDaysAgo)
      .orderBy('scored_at', 'asc');

    if (history.length < 2) return { trend: 'stable', previousScore: null, change30d: null };

    const oldest = history[0].overall_score;
    const newest = history[history.length - 1].overall_score;
    const change = newest - oldest;

    let trend = 'stable';
    if (change >= 5) trend = 'improving';
    else if (change <= -5) trend = 'declining';

    return { trend, previousScore: oldest, change30d: change };
  } catch {
    return { trend: 'stable', previousScore: null, change30d: null };
  }
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------
async function scoreCustomer(customerId) {
  try {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) {
      logger.warn(`[health] Customer ${customerId} not found`);
      return null;
    }

    // Compute all sub-scores in parallel
    const [payment, service, engagement, satisfaction, loyalty, growth] = await Promise.all([
      computePaymentScore(customerId),
      computeServiceScore(customerId),
      computeEngagementScore(customerId),
      computeSatisfactionScore(customerId),
      computeLoyaltyScore(customerId),
      computeGrowthScore(customerId),
    ]);

    // Weighted composite
    const overall = clamp(Math.round(
      payment.score * WEIGHTS.payment +
      service.score * WEIGHTS.service +
      satisfaction.score * WEIGHTS.satisfaction +
      engagement.score * WEIGHTS.engagement +
      loyalty.score * WEIGHTS.loyalty +
      growth.score * WEIGHTS.growth
    ));

    const grade = getGrade(overall);

    // Trend
    const { trend, previousScore, change30d } = await computeTrend(customerId);

    // Build score data for signal detection
    const scoreData = {
      overall,
      payment: payment.score,
      service: service.score,
      engagement: engagement.score,
      satisfaction: satisfaction.score,
      loyalty: loyalty.score,
      growth: growth.score,
      paymentDetails: payment.details,
      serviceDetails: service.details,
      engagementDetails: engagement.details,
      satisfactionDetails: satisfaction.details,
      loyaltyDetails: loyalty.details,
      growthDetails: growth.details,
      scoreChange30d: change30d,
    };

    // Churn signals
    const churnSignals = await detectChurnSignals(customerId, scoreData);
    const churnRisk = determineChurnRisk(churnSignals, overall);
    const churnProbability = estimateChurnProbability(churnRisk, overall);
    const daysUntilChurn = estimateDaysUntilChurn(churnRisk);

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Upsert into customer_health_scores
    const record = {
      customer_id: customerId,
      overall_score: overall,
      score_grade: grade,
      payment_score: payment.score,
      service_score: service.score,
      engagement_score: engagement.score,
      satisfaction_score: satisfaction.score,
      loyalty_score: loyalty.score,
      growth_score: growth.score,
      payment_details: JSON.stringify(payment.details),
      service_details: JSON.stringify(service.details),
      engagement_details: JSON.stringify(engagement.details),
      satisfaction_details: JSON.stringify(satisfaction.details),
      loyalty_details: JSON.stringify(loyalty.details),
      growth_details: JSON.stringify(growth.details),
      churn_risk: churnRisk,
      churn_probability: churnProbability,
      churn_signals: JSON.stringify(churnSignals),
      days_until_predicted_churn: daysUntilChurn,
      score_trend: trend,
      previous_score: previousScore,
      score_change_30d: change30d,
      scored_at: now,
      updated_at: now,
    };

    // Ensure sub-score columns exist before writing (Railway auto-heal may have created table without them)
    try {
      const hasPmtScore = await db.schema.hasColumn('customer_health_scores', 'payment_score');
      if (!hasPmtScore) {
        for (const col of ['payment_score', 'service_score', 'engagement_score', 'satisfaction_score', 'loyalty_score', 'growth_score']) {
          if (!(await db.schema.hasColumn('customer_health_scores', col))) {
            await db.schema.alterTable('customer_health_scores', t => { t.integer(col).defaultTo(50); });
          }
        }
        for (const col of ['payment_details', 'service_details', 'engagement_details', 'satisfaction_details', 'loyalty_details', 'growth_details', 'churn_signals']) {
          if (!(await db.schema.hasColumn('customer_health_scores', col))) {
            await db.schema.alterTable('customer_health_scores', t => { t.jsonb(col); });
          }
        }
        for (const col of ['score_grade', 'churn_risk', 'score_trend']) {
          if (!(await db.schema.hasColumn('customer_health_scores', col))) {
            await db.schema.alterTable('customer_health_scores', t => { t.string(col, col === 'score_grade' ? 1 : 10); });
          }
        }
        for (const col of ['churn_probability']) {
          if (!(await db.schema.hasColumn('customer_health_scores', col))) {
            await db.schema.alterTable('customer_health_scores', t => { t.decimal(col, 5, 4); });
          }
        }
        for (const col of ['days_until_predicted_churn', 'previous_score', 'score_change_30d']) {
          if (!(await db.schema.hasColumn('customer_health_scores', col))) {
            await db.schema.alterTable('customer_health_scores', t => { t.integer(col); });
          }
        }
        if (!(await db.schema.hasColumn('customer_health_scores', 'scored_at'))) {
          await db.schema.alterTable('customer_health_scores', t => { t.timestamp('scored_at').defaultTo(db.fn.now()); });
        }
        if (!(await db.schema.hasColumn('customer_health_scores', 'overall_score'))) {
          await db.schema.alterTable('customer_health_scores', t => { t.integer('overall_score').defaultTo(50); });
        }
        logger.info('[health] Auto-added missing sub-score columns');
      }
    } catch (e) { logger.error('[health] Column check error:', e.message); }

    const existing = await db('customer_health_scores').where('customer_id', customerId).first();
    try {
      if (existing) {
        await db('customer_health_scores').where('customer_id', customerId).update(record);
      } else {
        await db('customer_health_scores').insert({ ...record, created_at: now });
      }
    } catch (e) {
      // Fallback: write only columns that exist
      logger.error('[health] Score write error, trying minimal:', e.message);
      const minimal = { customer_id: customerId, overall_score: overall, updated_at: now };
      if (existing) await db('customer_health_scores').where('customer_id', customerId).update(minimal).catch(err => logger.error(`[health] Minimal score write failed: ${err.message}`));
      else await db('customer_health_scores').insert({ ...minimal, created_at: now }).catch(err => logger.error(`[health] Minimal score insert failed: ${err.message}`));
    }

    // Insert history snapshot
    try {
      await db('customer_health_history').insert({
        customer_id: customerId,
        overall_score: overall,
        payment_score: payment.score,
        service_score: service.score,
        engagement_score: engagement.score,
        satisfaction_score: satisfaction.score,
        loyalty_score: loyalty.score,
        growth_score: growth.score,
        churn_risk: churnRisk,
        scored_at: today,
      });
    } catch (e) {
      // Fallback: minimal history
      await db('customer_health_history').insert({
        customer_id: customerId, overall_score: overall, scored_at: today,
      }).catch(() => {});
    }

    // Generate alerts
    try {
      const alertService = require('./health-alerts');
      await alertService.generateAlerts(customerId, {
        ...scoreData,
        grade,
        churnRisk,
        churnSignals,
        churnProbability,
        daysUntilChurn,
        customer,
      });
    } catch (err) {
      logger.error(`[health] Alert generation failed for ${customerId}: ${err.message}`);
    }

    // Trigger save sequences for high/critical risk
    if (churnRisk === 'critical' || churnRisk === 'high') {
      try {
        const saveSeq = require('./save-sequences');
        await saveSeq.enrollCustomer(customerId, 'churn_save');
      } catch (err) {
        logger.error(`[health] Save sequence enrollment failed for ${customerId}: ${err.message}`);
      }
    }

    return {
      customerId,
      overall,
      grade,
      payment: payment.score,
      service: service.score,
      engagement: engagement.score,
      satisfaction: satisfaction.score,
      loyalty: loyalty.score,
      growth: growth.score,
      churnRisk,
      churnProbability,
      churnSignals,
      trend,
    };
  } catch (err) {
    logger.error(`[health] Score computation failed for ${customerId}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Batch scoring
// ---------------------------------------------------------------------------
async function scoreAllCustomers() {
  _tableCache = {}; // reset cache per batch
  let scored = 0;
  let failed = 0;

  try {
    const customers = await db('customers').where('active', true).select('id');
    logger.info(`[health] Scoring ${customers.length} active customers`);

    for (const cust of customers) {
      try {
        await scoreCustomer(cust.id);
        scored++;
      } catch (err) {
        failed++;
        logger.error(`[health] Failed to score ${cust.id}: ${err.message}`);
      }
    }

    logger.info(`[health] Batch scoring complete: ${scored} scored, ${failed} failed`);
  } catch (err) {
    logger.error(`[health] Batch scoring error: ${err.message}`);
  }

  return { scored, failed };
}

module.exports = {
  scoreCustomer,
  scoreAllCustomers,
  getGrade,
  WEIGHTS,
};
