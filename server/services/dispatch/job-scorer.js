// server/services/dispatch/job-scorer.js
const Anthropic = require('@anthropic-ai/sdk');
const WikiQA = require('../knowledge/wiki-qa');
const MODELS = require('../../config/models');

let db;
function getDb() {
  if (!db) db = require('../../models/db');
  return db;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Haversine — returns estimated drive minutes
function driveMins(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 12;
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 2.5);
}

function ruleBasedScore(job, driveMin = 12) {
  const revMap = { termite: 39, wdo_inspection: 36, bora_care: 38, tree_shrub: 30, lawn: 25, german_roach: 25, mosquito: 20, general_pest: 18, stinging_insect: 20, rodent: 18, callback: 15 };
  const tierMap = { platinum: 24, gold: 21, silver: 17, bronze: 13, recurring: 12, none: 9 };
  const revPts = revMap[job.service_type] || 18;
  const renPts = tierMap[job.waveguard_tier] || 9;
  const upsPts = ['estimate', 'wdo_inspection'].includes(job.job_category) ? 18 : job.waveguard_tier === 'platinum' ? 14 : 8;
  const effPts = driveMin < 5 ? 14 : driveMin < 10 ? 12 : driveMin < 15 ? 10 : driveMin < 20 ? 8 : driveMin < 30 ? 5 : 2;
  const boost = job.job_category === 'callback' ? 15 : 0;
  const score = Math.min(100, revPts + renPts + upsPts + effPts + boost);
  return {
    score,
    breakdown: { revenue_pts: revPts, renewal_pts: renPts, upsell_pts: upsPts, efficiency_pts: effPts },
    priority: score >= 85 ? 'critical' : score >= 70 ? 'high' : score >= 55 ? 'standard' : 'low',
    upsell_flags: [],
    protect_slot: score >= 80,
  };
}

async function resolveRevenue(job) {
  const est = parseFloat(job.estimated_revenue || 0);
  if (est > 0) return est;

  // Try to look up from scheduled_services → customers.monthly_rate
  if (job.sheet_row_id) {
    try {
      const svc = await getDb()('scheduled_services')
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .where('scheduled_services.id', job.sheet_row_id)
        .select('customers.monthly_rate')
        .first();
      if (svc && parseFloat(svc.monthly_rate || 0) > 0) return parseFloat(svc.monthly_rate);
    } catch { /* table may not have the join column */ }
  }

  // Fall back to service-type revenue map
  const revMap = { termite: 200, wdo_inspection: 185, bora_care: 380, tree_shrub: 130, lawn: 75, german_roach: 149, mosquito: 89, general_pest: 110, stinging_insect: 129, rodent: 95, callback: 0, estimate: 185 };
  return revMap[job.service_type] || 95;
}

async function scoreJob(job, prevLat = null, prevLng = null) {
  const driveMin = driveMins(prevLat, prevLng, job.lat, job.lng);
  const realRevenue = await resolveRevenue(job);
  try {
    const rules = await WikiQA.lookup('job scoring formula') || '';
    const res = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 350,
      messages: [{
        role: 'user',
        content: `Score this pest control job 0-100.\n\nJob:\n- Service: ${job.service_type}\n- Category: ${job.job_category}\n- WaveGuard tier: ${job.waveguard_tier}\n- Estimated revenue: $${realRevenue}\n- Drive from prior stop: ${driveMin} min\n- Notes: ${job.notes || 'none'}\n\nRules:\n${rules}\n\nReturn ONLY JSON: {"score":0-100,"breakdown":{"revenue_pts":0,"renewal_pts":0,"upsell_pts":0,"efficiency_pts":0},"priority":"critical|high|standard|low","upsell_flags":[],"protect_slot":true}`,
      }],
    });
    const result = JSON.parse(res.content[0].text.replace(/```json|```/g, '').trim());
    await getDb()('dispatch_jobs').where('id', job.id).update({ job_score: result.score, score_breakdown: result.breakdown, upsell_flags: result.upsell_flags, is_high_value: result.protect_slot, estimated_revenue: realRevenue }).catch(() => {});
    return { ...job, ...result };
  } catch {
    return { ...job, ...ruleBasedScore(job, driveMin) };
  }
}

async function scoreAll(date, techId = null) {
  const q = getDb()('dispatch_jobs').where('scheduled_date', date).where('status', 'scheduled');
  if (techId) q.where('assigned_tech_id', techId);
  const jobs = await q;
  const scored = [];
  let pLat = null, pLng = null;
  for (const job of jobs) {
    const s = await scoreJob(job, pLat, pLng);
    scored.push(s);
    pLat = job.lat; pLng = job.lng;
  }
  return scored.sort((a, b) => b.score - a.score);
}

module.exports = { scoreJob, scoreAll, ruleBasedScore, driveMins };
