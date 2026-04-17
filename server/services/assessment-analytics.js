/**
 * Assessment Analytics Service
 *
 * Computes and caches aggregate intelligence from lawn assessment
 * and treatment outcome data. Powers:
 *   - Product efficacy leaderboard
 *   - Protocol performance scoring
 *   - Assessment completion rate tracking
 *   - ROI calculator (assessment → retention → revenue)
 *   - Tech calibration scoring
 *   - Neighbor comparison benchmarks
 *   - Contradiction detection between Claudeopedia and Wiki
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays } = require('../utils/datetime-et');

function slugify(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 190);
}

function avg(arr) {
  const v = arr.filter(x => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ══════════════════════════════════════════════════════════════
// PRODUCT EFFICACY LEADERBOARD
// ══════════════════════════════════════════════════════════════

async function computeProductEfficacy() {
  const stats = { products: 0, errors: 0 };

  try {
    // Get all treatment outcomes with products
    const outcomes = await db('treatment_outcomes')
      .whereNotNull('products_applied')
      .where('products_applied', '!=', '[]')
      .select('*');

    // Extract unique product names and aggregate
    const productMap = {};

    for (const o of outcomes) {
      let products;
      try { products = typeof o.products_applied === 'string' ? JSON.parse(o.products_applied) : o.products_applied; } catch { continue; }
      if (!Array.isArray(products)) continue;

      for (const p of products) {
        const name = p.name || p.product_name;
        if (!name) continue;

        const slug = slugify(name);
        if (!productMap[slug]) {
          productMap[slug] = {
            product_name: name, product_slug: slug,
            deltas: { turf: [], weed: [], color: [], fungus: [], thatch: [] },
            customers: new Set(), seasons: { peak: [], shoulder: [], dormant: [] },
            tracks: {}, satisfactions: [],
          };
        }

        const pm = productMap[slug];
        pm.customers.add(o.customer_id);

        if (o.delta_turf_density != null) pm.deltas.turf.push(o.delta_turf_density);
        if (o.delta_weed_suppression != null) pm.deltas.weed.push(o.delta_weed_suppression);
        if (o.delta_color_health != null) pm.deltas.color.push(o.delta_color_health);
        if (o.delta_fungus_control != null) pm.deltas.fungus.push(o.delta_fungus_control);
        if (o.delta_thatch_level != null) pm.deltas.thatch.push(o.delta_thatch_level);
        if (o.satisfaction_rating != null) pm.satisfactions.push(o.satisfaction_rating);

        // Compute per-outcome overall delta
        const overallDelta = avg([o.delta_turf_density, o.delta_weed_suppression, o.delta_color_health, o.delta_fungus_control, o.delta_thatch_level]);

        if (o.season && pm.seasons[o.season]) pm.seasons[o.season].push(overallDelta);
        if (o.grass_track) {
          if (!pm.tracks[o.grass_track]) pm.tracks[o.grass_track] = [];
          pm.tracks[o.grass_track].push(overallDelta);
        }
      }
    }

    // Upsert into product_efficacy table
    for (const [slug, pm] of Object.entries(productMap)) {
      const count = pm.deltas.turf.length || pm.deltas.weed.length || 1;
      const avgOverall = avg([avg(pm.deltas.turf), avg(pm.deltas.weed), avg(pm.deltas.color), avg(pm.deltas.fungus), avg(pm.deltas.thatch)]);

      const row = {
        product_name: pm.product_name,
        product_slug: slug,
        application_count: count,
        customer_count: pm.customers.size,
        avg_delta_turf: avg(pm.deltas.turf),
        avg_delta_weed: avg(pm.deltas.weed),
        avg_delta_color: avg(pm.deltas.color),
        avg_delta_fungus: avg(pm.deltas.fungus),
        avg_delta_thatch: avg(pm.deltas.thatch),
        avg_delta_overall: avgOverall,
        peak_stats: JSON.stringify({ count: pm.seasons.peak.length, avgDelta: avg(pm.seasons.peak) }),
        shoulder_stats: JSON.stringify({ count: pm.seasons.shoulder.length, avgDelta: avg(pm.seasons.shoulder) }),
        dormant_stats: JSON.stringify({ count: pm.seasons.dormant.length, avgDelta: avg(pm.seasons.dormant) }),
        track_stats: JSON.stringify(Object.fromEntries(
          Object.entries(pm.tracks).map(([k, v]) => [k, { count: v.length, avgDelta: avg(v) }])
        )),
        avg_satisfaction: avg(pm.satisfactions),
        satisfaction_count: pm.satisfactions.length,
        efficacy_score: Math.max(0, Math.min(100, 50 + (avgOverall || 0) * 2)),
        last_computed: new Date(),
      };

      const existing = await db('product_efficacy').where({ product_slug: slug }).first();
      if (existing) {
        await db('product_efficacy').where({ id: existing.id }).update({ ...row, updated_at: new Date() });
      } else {
        await db('product_efficacy').insert(row);
      }
      stats.products++;
    }

    // Compute rankings
    const ranked = await db('product_efficacy').orderBy('efficacy_score', 'desc');
    for (let i = 0; i < ranked.length; i++) {
      await db('product_efficacy').where({ id: ranked[i].id }).update({ efficacy_rank: i + 1 });
    }

    logger.info(`[assessment-analytics] Product efficacy computed: ${stats.products} products`);
    return stats;
  } catch (err) {
    logger.error(`[assessment-analytics] computeProductEfficacy failed: ${err.message}`);
    return { ...stats, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// PROTOCOL PERFORMANCE SCORING
// ══════════════════════════════════════════════════════════════

async function computeProtocolPerformance() {
  const stats = { tracks: 0 };

  try {
    const outcomes = await db('treatment_outcomes')
      .whereNotNull('grass_track')
      .select('*');

    const trackMap = {};

    for (const o of outcomes) {
      const track = o.grass_track;
      if (!trackMap[track]) {
        trackMap[track] = {
          customers: new Set(), outcomes: [],
          visits: {}, products: {},
          satisfactions: [],
        };
      }

      const tm = trackMap[track];
      tm.customers.add(o.customer_id);
      tm.outcomes.push(o);

      if (o.satisfaction_rating != null) tm.satisfactions.push(o.satisfaction_rating);

      // Per-visit aggregation
      const vn = o.visit_number || 0;
      if (!tm.visits[vn]) tm.visits[vn] = [];
      const delta = avg([o.delta_turf_density, o.delta_weed_suppression, o.delta_color_health, o.delta_fungus_control, o.delta_thatch_level]);
      tm.visits[vn].push(delta);

      // Product aggregation within track
      let products;
      try { products = typeof o.products_applied === 'string' ? JSON.parse(o.products_applied) : o.products_applied; } catch { products = []; }
      for (const p of (products || [])) {
        const name = p.name || p.product_name;
        if (!name) continue;
        if (!tm.products[name]) tm.products[name] = [];
        tm.products[name].push(delta);
      }
    }

    for (const [track, tm] of Object.entries(trackMap)) {
      const deltas = {
        turf: tm.outcomes.map(o => o.delta_turf_density).filter(x => x != null),
        weed: tm.outcomes.map(o => o.delta_weed_suppression).filter(x => x != null),
        color: tm.outcomes.map(o => o.delta_color_health).filter(x => x != null),
        fungus: tm.outcomes.map(o => o.delta_fungus_control).filter(x => x != null),
        thatch: tm.outcomes.map(o => o.delta_thatch_level).filter(x => x != null),
      };

      const avgOverall = avg([avg(deltas.turf), avg(deltas.weed), avg(deltas.color), avg(deltas.fungus), avg(deltas.thatch)]);

      // Sort products by performance
      const productEntries = Object.entries(tm.products)
        .map(([name, vals]) => ({ name, avgDelta: avg(vals), count: vals.length }))
        .sort((a, b) => (b.avgDelta || 0) - (a.avgDelta || 0));

      const row = {
        grass_track: track,
        customer_count: tm.customers.size,
        outcome_count: tm.outcomes.length,
        avg_delta_turf: avg(deltas.turf),
        avg_delta_weed: avg(deltas.weed),
        avg_delta_color: avg(deltas.color),
        avg_delta_fungus: avg(deltas.fungus),
        avg_delta_thatch: avg(deltas.thatch),
        avg_delta_overall: avgOverall,
        visit_performance: JSON.stringify(
          Object.fromEntries(Object.entries(tm.visits).map(([v, vals]) => [v, { count: vals.length, avgDelta: avg(vals) }]))
        ),
        top_products: JSON.stringify(productEntries.slice(0, 5)),
        bottom_products: JSON.stringify(productEntries.slice(-5).reverse()),
        avg_satisfaction: avg(tm.satisfactions),
        protocol_score: Math.max(0, Math.min(100, 50 + (avgOverall || 0) * 2)),
        last_computed: new Date(),
      };

      const existing = await db('protocol_performance').where({ grass_track: track }).first();
      if (existing) {
        await db('protocol_performance').where({ id: existing.id }).update({ ...row, updated_at: new Date() });
      } else {
        await db('protocol_performance').insert(row);
      }
      stats.tracks++;
    }

    logger.info(`[assessment-analytics] Protocol performance computed: ${stats.tracks} tracks`);
    return stats;
  } catch (err) {
    logger.error(`[assessment-analytics] computeProtocolPerformance failed: ${err.message}`);
    return { ...stats, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// ASSESSMENT COMPLETION RATE TRACKING
// ══════════════════════════════════════════════════════════════

async function computeCompletionRates(dateFrom, dateTo) {
  try {
    const from = dateFrom || etDateString(addETDays(new Date(), -30));
    const to = dateTo || etDateString();

    // Get all lawn services in date range
    const services = await db('scheduled_services')
      .where('scheduled_date', '>=', from)
      .where('scheduled_date', '<=', to)
      .where(function () {
        this.where('service_type', 'ilike', '%lawn%')
          .orWhere('service_type', 'ilike', '%fertiliz%')
          .orWhere('service_type', 'ilike', '%turf%');
      })
      .select('scheduled_date', 'technician_id');

    // Get all assessments in date range
    const assessments = await db('lawn_assessments')
      .where('service_date', '>=', from)
      .where('service_date', '<=', to)
      .select('service_date', 'technician_id', 'confirmed_by_tech');

    // Aggregate by date + tech
    const byKey = {};
    for (const s of services) {
      const key = `${s.scheduled_date}|${s.technician_id || 'unknown'}`;
      if (!byKey[key]) byKey[key] = { date: s.scheduled_date, techId: s.technician_id, scheduled: 0, started: 0, confirmed: 0 };
      byKey[key].scheduled++;
    }

    for (const a of assessments) {
      const key = `${a.service_date}|${a.technician_id || 'unknown'}`;
      if (!byKey[key]) byKey[key] = { date: a.service_date, techId: a.technician_id, scheduled: 0, started: 0, confirmed: 0 };
      byKey[key].started++;
      if (a.confirmed_by_tech) byKey[key].confirmed++;
    }

    // Upsert
    const results = [];
    for (const entry of Object.values(byKey)) {
      if (!entry.scheduled && !entry.started) continue;

      // Look up tech name
      let techName = null;
      if (entry.techId) {
        const tech = await db('technicians').where({ id: entry.techId }).select('name').first();
        techName = tech?.name || null;
      }

      const rate = entry.scheduled > 0 ? entry.confirmed / entry.scheduled : 0;

      const row = {
        service_date: entry.date,
        technician_id: entry.techId || null,
        technician_name: techName,
        lawn_services_scheduled: entry.scheduled,
        assessments_started: entry.started,
        assessments_confirmed: entry.confirmed,
        completion_rate: Math.round(rate * 10000) / 10000,
        last_computed: new Date(),
      };

      await db('assessment_completion_tracking')
        .insert(row)
        .onConflict(['service_date', 'technician_id'])
        .merge();

      results.push(row);
    }

    return { rows: results.length, dateRange: { from, to } };
  } catch (err) {
    logger.error(`[assessment-analytics] computeCompletionRates failed: ${err.message}`);
    return { error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// ROI CALCULATOR
// ══════════════════════════════════════════════════════════════

async function computeROI() {
  try {
    // Customers with assessments
    const assessed = await db('lawn_assessments')
      .distinct('customer_id')
      .where({ confirmed_by_tech: true })
      .pluck('customer_id');

    // All lawn customers
    const allLawn = await db('service_records')
      .distinct('customer_id')
      .where(function () {
        this.where('service_type', 'ilike', '%lawn%')
          .orWhere('service_type', 'ilike', '%fertiliz%');
      })
      .pluck('customer_id');

    const nonAssessed = allLawn.filter(id => !assessed.includes(id));

    // Retention: active in last 90 days
    const ninetyDaysAgo = etDateString(addETDays(new Date(), -90));

    const assessedActive = assessed.length ? await db('service_records')
      .whereIn('customer_id', assessed)
      .where('service_date', '>=', ninetyDaysAgo)
      .where({ status: 'completed' })
      .distinct('customer_id')
      .pluck('customer_id') : [];

    const nonAssessedActive = nonAssessed.length ? await db('service_records')
      .whereIn('customer_id', nonAssessed)
      .where('service_date', '>=', ninetyDaysAgo)
      .where({ status: 'completed' })
      .distinct('customer_id')
      .pluck('customer_id') : [];

    // Revenue
    const assessedRevenue = assessed.length ? await db('payments')
      .whereIn('customer_id', assessed)
      .where({ status: 'paid' })
      .sum('amount as total')
      .first() : { total: 0 };

    const nonAssessedRevenue = nonAssessed.length ? await db('payments')
      .whereIn('customer_id', nonAssessed)
      .where({ status: 'paid' })
      .sum('amount as total')
      .first() : { total: 0 };

    // Improvement correlation
    const improvements = await db('lawn_assessments')
      .where({ confirmed_by_tech: true })
      .select('customer_id', 'overall_score', 'is_baseline', 'service_date')
      .orderBy('service_date', 'asc');

    const customerImprovements = {};
    for (const a of improvements) {
      if (!customerImprovements[a.customer_id]) customerImprovements[a.customer_id] = [];
      customerImprovements[a.customer_id].push(a.overall_score || 0);
    }

    let bigImprovers = 0, smallImprovers = 0, decliners = 0;
    for (const scores of Object.values(customerImprovements)) {
      if (scores.length < 2) continue;
      const delta = scores[scores.length - 1] - scores[0];
      if (delta >= 20) bigImprovers++;
      else if (delta >= 0) smallImprovers++;
      else decliners++;
    }

    return {
      assessedCustomers: assessed.length,
      nonAssessedCustomers: nonAssessed.length,
      assessedRetention: assessed.length ? Math.round((assessedActive.length / assessed.length) * 10000) / 100 : 0,
      nonAssessedRetention: nonAssessed.length ? Math.round((nonAssessedActive.length / nonAssessed.length) * 10000) / 100 : 0,
      assessedAvgRevenue: assessed.length ? Math.round((parseFloat(assessedRevenue.total) || 0) / assessed.length) : 0,
      nonAssessedAvgRevenue: nonAssessed.length ? Math.round((parseFloat(nonAssessedRevenue.total) || 0) / nonAssessed.length) : 0,
      improvementBuckets: { bigImprovers, smallImprovers, decliners },
      retentionDelta: null, // computed in response
    };
  } catch (err) {
    logger.error(`[assessment-analytics] computeROI failed: ${err.message}`);
    return { error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// TECH CALIBRATION
// ══════════════════════════════════════════════════════════════

async function recordCalibration(assessmentId, aiScores, techScores) {
  try {
    const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
    if (!assessment) return null;

    const delta = (field) => {
      const ai = aiScores[field];
      const tech = techScores[field];
      return (ai != null && tech != null) ? tech - ai : null;
    };

    const deltas = {
      delta_turf: delta('turf_density'),
      delta_weed: delta('weed_suppression'),
      delta_color: delta('color_health'),
      delta_fungus: delta('fungus_control'),
      delta_thatch: delta('thatch_level'),
    };

    const allDeltas = Object.values(deltas).filter(d => d != null);
    const avgDelta = allDeltas.length ? Math.round((allDeltas.reduce((a, b) => a + b, 0) / allDeltas.length) * 100) / 100 : 0;

    // Only record if there was a meaningful override (>5 pts difference somewhere)
    if (Math.abs(avgDelta) < 1 && allDeltas.every(d => Math.abs(d || 0) <= 5)) {
      return null; // No meaningful override
    }

    const [record] = await db('tech_calibration').insert({
      assessment_id: assessmentId,
      technician_id: assessment.technician_id,
      ai_turf_density: aiScores.turf_density,
      ai_weed_suppression: aiScores.weed_suppression,
      ai_color_health: aiScores.color_health,
      ai_fungus_control: aiScores.fungus_control,
      ai_thatch_level: aiScores.thatch_level,
      tech_turf_density: techScores.turf_density,
      tech_weed_suppression: techScores.weed_suppression,
      tech_color_health: techScores.color_health,
      tech_fungus_control: techScores.fungus_control,
      tech_thatch_level: techScores.thatch_level,
      ...deltas,
      avg_delta: avgDelta,
    }).returning('*');

    return record;
  } catch (err) {
    logger.error(`[assessment-analytics] recordCalibration failed: ${err.message}`);
    return null;
  }
}

async function getTechCalibrationSummary(technicianId) {
  try {
    const records = await db('tech_calibration')
      .where(technicianId ? { technician_id: technicianId } : {})
      .orderBy('created_at', 'desc')
      .limit(200);

    if (!records.length) return { records: 0, avgBias: 0, byMetric: {} };

    const byMetric = {
      turf: records.map(r => r.delta_turf).filter(x => x != null),
      weed: records.map(r => r.delta_weed).filter(x => x != null),
      color: records.map(r => r.delta_color).filter(x => x != null),
      fungus: records.map(r => r.delta_fungus).filter(x => x != null),
      thatch: records.map(r => r.delta_thatch).filter(x => x != null),
    };

    return {
      records: records.length,
      avgBias: avg(records.map(r => r.avg_delta)),
      byMetric: Object.fromEntries(
        Object.entries(byMetric).map(([k, v]) => [k, { avg: avg(v), count: v.length }])
      ),
      trend: records.slice(0, 20).map(r => ({
        date: r.created_at,
        avgDelta: r.avg_delta,
        assessmentId: r.assessment_id,
      })),
    };
  } catch (err) {
    logger.error(`[assessment-analytics] getTechCalibrationSummary failed: ${err.message}`);
    return { records: 0, avgBias: 0, byMetric: {}, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// NEIGHBOR COMPARISON BENCHMARKS
// ══════════════════════════════════════════════════════════════

async function computeNeighborhoodBenchmarks() {
  const stats = { segments: 0 };

  try {
    // Get all assessed customers with address info
    const customers = await db('customers as c')
      .join('lawn_assessments as la', 'c.id', 'la.customer_id')
      .where({ 'la.confirmed_by_tech': true })
      .select('c.id', 'c.zip', 'c.city', 'c.grass_type', 'la.overall_score', 'la.is_baseline', 'la.service_date')
      .orderBy('la.service_date', 'asc');

    // Segment by zip + grass_type
    const segments = {};
    for (const c of customers) {
      const zip = c.zip || 'unknown';
      const grass = c.grass_type || 'St. Augustine';
      const key = `${zip}|${slugify(grass)}`;

      if (!segments[key]) {
        segments[key] = {
          segment_key: key, segment_type: 'zip', segment_name: zip,
          grass_type: grass, customers: new Set(), scores: [],
          improvements: {}, startingScores: [],
        };
      }

      segments[key].customers.add(c.id);
      if (c.overall_score != null) segments[key].scores.push(c.overall_score);

      // Track per-customer first/last for improvement calc
      if (!segments[key].improvements[c.id]) segments[key].improvements[c.id] = { first: null, last: null };
      if (!segments[key].improvements[c.id].first) {
        segments[key].improvements[c.id].first = c.overall_score;
        segments[key].startingScores.push(c.overall_score);
      }
      segments[key].improvements[c.id].last = c.overall_score;
    }

    for (const seg of Object.values(segments)) {
      if (seg.customers.size < 3) continue; // Need minimum 3 customers for meaningful benchmarks

      const sorted = [...seg.scores].sort((a, b) => a - b);

      // Compute improvements for customers with >1 assessment
      const improvementVals = [];
      for (const imp of Object.values(seg.improvements)) {
        if (imp.first != null && imp.last != null && imp.first !== imp.last) {
          improvementVals.push(imp.last - imp.first);
        }
      }

      const row = {
        segment_key: seg.segment_key,
        segment_type: 'zip',
        segment_name: seg.segment_name,
        grass_type: seg.grass_type,
        customer_count: seg.customers.size,
        assessment_count: seg.scores.length,
        p25_overall: percentile(sorted, 25),
        p50_overall: percentile(sorted, 50),
        p75_overall: percentile(sorted, 75),
        avg_overall: Math.round(avg(seg.scores)),
        avg_improvement: avg(improvementVals),
        improvement_count: improvementVals.length,
        avg_starting_score: Math.round(avg(seg.startingScores) || 0),
        last_computed: new Date(),
      };

      await db('neighborhood_benchmarks')
        .insert(row)
        .onConflict('segment_key')
        .merge();

      stats.segments++;
    }

    logger.info(`[assessment-analytics] Neighborhood benchmarks computed: ${stats.segments} segments`);
    return stats;
  } catch (err) {
    logger.error(`[assessment-analytics] computeNeighborhoodBenchmarks failed: ${err.message}`);
    return { ...stats, error: err.message };
  }
}

async function getCustomerBenchmark(customerId) {
  try {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return null;

    const zip = customer.zip || 'unknown';
    const grass = customer.grass_type || 'St. Augustine';
    const key = `${zip}|${slugify(grass)}`;

    const benchmark = await db('neighborhood_benchmarks').where({ segment_key: key }).first();
    if (!benchmark || benchmark.customer_count < 3) return null;

    // Get customer's latest score
    const latest = await db('lawn_assessments')
      .where({ customer_id: customerId, confirmed_by_tech: true })
      .orderBy('service_date', 'desc')
      .first();

    if (!latest?.overall_score) return null;

    const score = latest.overall_score;
    let percentileLabel;
    if (score >= benchmark.p75_overall) percentileLabel = 'top 25%';
    else if (score >= benchmark.p50_overall) percentileLabel = 'top 50%';
    else if (score >= benchmark.p25_overall) percentileLabel = 'top 75%';
    else percentileLabel = 'below average';

    return {
      customerScore: score,
      percentile: percentileLabel,
      neighborhoodAvg: benchmark.avg_overall,
      p25: benchmark.p25_overall,
      p50: benchmark.p50_overall,
      p75: benchmark.p75_overall,
      avgImprovement: benchmark.avg_improvement,
      customerCount: benchmark.customer_count,
      segmentName: benchmark.segment_name,
      grassType: benchmark.grass_type,
    };
  } catch (err) {
    logger.error(`[assessment-analytics] getCustomerBenchmark failed: ${err.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// CONTRADICTION DETECTION
// ══════════════════════════════════════════════════════════════

async function detectContradictions() {
  const found = [];

  try {
    // Get all product efficacy data
    const efficacy = await db('product_efficacy').select('*');

    // Get all Claudeopedia product entries
    const kbProducts = await db('knowledge_base')
      .where({ category: 'product', status: 'active' })
      .select('id', 'title', 'content', 'slug');

    for (const kbEntry of kbProducts) {
      const kbName = kbEntry.title.replace(/^Product:\s*/i, '').toLowerCase();
      const content = (kbEntry.content || '').toLowerCase();

      for (const eff of efficacy) {
        if (!eff.product_name.toLowerCase().includes(kbName) && !kbName.includes(eff.product_name.toLowerCase())) continue;

        // Check: KB claims "best for" or "effective" but data shows negative delta
        if (eff.avg_delta_overall != null && eff.avg_delta_overall < -5 && eff.application_count >= 5) {
          if (content.includes('effective') || content.includes('recommend') || content.includes('best')) {
            const contradiction = {
              kb_entry_id: kbEntry.id,
              contradiction_type: 'claim_vs_data',
              kb_claim: `Claudeopedia describes ${eff.product_name} as effective/recommended`,
              wiki_evidence: `Outcome data shows avg ${eff.avg_delta_overall} overall delta across ${eff.application_count} applications`,
              description: `${eff.product_name}: KB claims effectiveness but outcome data shows negative results`,
              severity: Math.min(1.0, Math.abs(eff.avg_delta_overall) / 20),
            };

            // Find linked wiki entry
            const wikiEntry = await db('knowledge_entries')
              .where('slug', 'ilike', `%${slugify(eff.product_name)}%`)
              .first();

            if (wikiEntry) contradiction.wiki_entry_id = wikiEntry.id;

            // Check if already flagged
            const existing = await db('knowledge_contradictions')
              .where({ kb_entry_id: kbEntry.id, contradiction_type: 'claim_vs_data' })
              .whereRaw("kb_claim ILIKE ?", [`%${eff.product_name}%`])
              .where({ status: 'open' })
              .first();

            if (!existing) {
              await db('knowledge_contradictions').insert(contradiction);
              found.push(contradiction);
            }
          }
        }

        // Check: KB claims seasonal specificity but data disagrees
        let peakStats, shoulderStats, dormantStats;
        try { peakStats = typeof eff.peak_stats === 'string' ? JSON.parse(eff.peak_stats) : eff.peak_stats; } catch { peakStats = {}; }
        try { shoulderStats = typeof eff.shoulder_stats === 'string' ? JSON.parse(eff.shoulder_stats) : eff.shoulder_stats; } catch { shoulderStats = {}; }
        try { dormantStats = typeof eff.dormant_stats === 'string' ? JSON.parse(eff.dormant_stats) : eff.dormant_stats; } catch { dormantStats = {}; }

        if (content.includes('summer') || content.includes('peak season')) {
          if (peakStats?.count >= 5 && peakStats?.avgDelta != null && peakStats.avgDelta < -3) {
            if (shoulderStats?.avgDelta != null && shoulderStats.avgDelta > peakStats.avgDelta + 10) {
              const contradiction = {
                kb_entry_id: kbEntry.id,
                wiki_entry_id: null,
                contradiction_type: 'claim_vs_data',
                kb_claim: `Claudeopedia associates ${eff.product_name} with summer/peak season`,
                wiki_evidence: `Peak season avg delta: ${peakStats.avgDelta} (${peakStats.count} apps) vs shoulder: ${shoulderStats.avgDelta}`,
                description: `${eff.product_name} performs worse in peak season than shoulder — contradicts KB seasonal guidance`,
                severity: 0.6,
              };

              const existing = await db('knowledge_contradictions')
                .where({ kb_entry_id: kbEntry.id, contradiction_type: 'claim_vs_data' })
                .whereRaw("description ILIKE ?", [`%peak season%shoulder%`])
                .where({ status: 'open' })
                .first();

              if (!existing) {
                await db('knowledge_contradictions').insert(contradiction);
                found.push(contradiction);
              }
            }
          }
        }
      }
    }

    logger.info(`[assessment-analytics] Contradiction detection: ${found.length} new contradictions found`);
    return { contradictions: found.length, details: found };
  } catch (err) {
    logger.error(`[assessment-analytics] detectContradictions failed: ${err.message}`);
    return { contradictions: 0, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// LAWN HEALTH → CUSTOMER HEALTH BRIDGE
// ══════════════════════════════════════════════════════════════

async function getLawnHealthSignal(customerId) {
  try {
    const assessments = await db('lawn_assessments')
      .where({ customer_id: customerId, confirmed_by_tech: true })
      .orderBy('service_date', 'desc')
      .limit(5)
      .select('overall_score', 'service_date');

    if (assessments.length < 2) return { signal: 'neutral', score: 0, reason: 'insufficient_data' };

    // Check trajectory
    const scores = assessments.map(a => a.overall_score || 0).reverse(); // oldest first
    const recentDelta = scores[scores.length - 1] - scores[scores.length - 2];
    const overallDelta = scores[scores.length - 1] - scores[0];

    // Declining 3+ visits = churn risk
    let consecutive_declines = 0;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] < scores[i - 1]) consecutive_declines++;
      else consecutive_declines = 0;
    }

    if (consecutive_declines >= 3) {
      return { signal: 'churn_risk', score: -15, reason: `Lawn score declined ${consecutive_declines} consecutive visits` };
    }

    if (overallDelta >= 20) {
      return { signal: 'promoter', score: 10, reason: `Lawn improved ${overallDelta} pts — referral candidate` };
    }

    if (recentDelta < -10) {
      return { signal: 'at_risk', score: -5, reason: `Recent decline of ${Math.abs(recentDelta)} pts` };
    }

    if (overallDelta >= 5) {
      return { signal: 'healthy', score: 5, reason: `Steady improvement of ${overallDelta} pts` };
    }

    return { signal: 'neutral', score: 0, reason: 'Stable scores' };
  } catch (err) {
    logger.error(`[assessment-analytics] getLawnHealthSignal failed: ${err.message}`);
    return { signal: 'neutral', score: 0, reason: 'error' };
  }
}

// ══════════════════════════════════════════════════════════════
// TECH FIELD KNOWLEDGE SURFACING
// ══════════════════════════════════════════════════════════════

async function getTechFieldContext(customerId) {
  try {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return null;

    // Recent assessments for this customer
    const recentAssessments = await db('lawn_assessments')
      .where({ customer_id: customerId, confirmed_by_tech: true })
      .orderBy('service_date', 'desc')
      .limit(3)
      .select('service_date', 'overall_score', 'turf_density', 'weed_suppression', 'color_health',
        'fungus_control', 'thatch_level', 'observations', 'ai_summary', 'season');

    // Protocol context from wiki
    const track = customer.grass_track || 'A';
    const protocol = await db('protocol_performance').where({ grass_track: track }).first();

    // Relevant product efficacy for products likely to be used
    const topProducts = await db('product_efficacy')
      .where('application_count', '>=', 3)
      .orderBy('efficacy_score', 'desc')
      .limit(5)
      .select('product_name', 'efficacy_score', 'avg_delta_overall', 'application_count');

    // Neighborhood benchmark
    const benchmark = await getCustomerBenchmark(customerId);

    // Any needs_baseline_photos flag
    const needsBaseline = await db('lawn_assessments')
      .where({ customer_id: customerId, needs_baseline_photos: true })
      .first();

    // FAWN weather
    let weather = null;
    try {
      const FawnWeather = require('./fawn-weather');
      weather = await FawnWeather.getCurrent();
    } catch { /* ignore */ }

    return {
      customer: { name: `${customer.first_name} ${customer.last_name}`, grassTrack: track, grassType: customer.grass_type },
      recentAssessments: recentAssessments.map(a => ({
        date: a.service_date, overallScore: a.overall_score, summary: a.ai_summary,
        observations: a.observations, season: a.season,
      })),
      protocolContext: protocol ? {
        track, score: protocol.protocol_score,
        avgDelta: protocol.avg_delta_overall,
        visitPerformance: typeof protocol.visit_performance === 'string' ? JSON.parse(protocol.visit_performance) : protocol.visit_performance,
      } : null,
      topProducts,
      benchmark,
      needsBaselinePhotos: !!needsBaseline,
      weather,
      pressureSignals: require('./fawn-weather').getPressureSignals(),
    };
  } catch (err) {
    logger.error(`[assessment-analytics] getTechFieldContext failed: ${err.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// RUN ALL COMPUTATIONS (weekly cron)
// ══════════════════════════════════════════════════════════════

async function runAll() {
  logger.info('[assessment-analytics] Starting full computation run');

  const results = {};
  results.efficacy = await computeProductEfficacy();
  results.protocol = await computeProtocolPerformance();
  results.completion = await computeCompletionRates();
  results.benchmarks = await computeNeighborhoodBenchmarks();
  results.contradictions = await detectContradictions();

  logger.info(`[assessment-analytics] Full run complete: ${JSON.stringify(results)}`);
  return results;
}

module.exports = {
  computeProductEfficacy,
  computeProtocolPerformance,
  computeCompletionRates,
  computeROI,
  recordCalibration,
  getTechCalibrationSummary,
  computeNeighborhoodBenchmarks,
  getCustomerBenchmark,
  detectContradictions,
  getLawnHealthSignal,
  getTechFieldContext,
  runAll,
};
