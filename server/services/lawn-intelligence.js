/**
 * Lawn Intelligence Service
 *
 * Centralized intelligence engine powering 16 lawn assessment features:
 * - FAWN weather context on every assessment
 * - Product efficacy leaderboard
 * - Protocol performance scoring
 * - Contradiction detection across knowledge systems
 * - Tech field knowledge surfacing
 * - Assessment notification dispatch
 * - Neighborhood benchmarks (anonymized)
 * - Lawn health → customer health bridge
 * - Assessment completion rate tracking
 * - ROI metrics
 * - Tech calibration scoring
 * - Satisfaction → outcome validation
 * - Baseline photo re-capture protocol
 * - Auto-generate service reports
 * - Photo quality gating
 * - Seasonal expectation data
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { etDateString } = require('../utils/datetime-et');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// ══════════════════════════════════════════════════════════════
// 1. FAWN WEATHER CONTEXT
// ══════════════════════════════════════════════════════════════

async function fetchFawnWeather() {
  try {
    const res = await fetch('https://fawn.ifas.ufl.edu/controller.php/lastObservation/summary/');
    if (!res.ok) return null;
    const data = await res.json();
    const station = (data || []).find(s =>
      (s.StationName || '').toLowerCase().includes('manatee') ||
      (s.StationName || '').toLowerCase().includes('myakka') ||
      (s.StationName || '').toLowerCase().includes('sarasota')
    ) || data?.[0];
    if (!station) return null;
    return {
      temp_f: parseFloat(station.AirTemp_Avg || station.t2m_avg || 0),
      humidity_pct: parseFloat(station.RelHum_Avg || station.rh_avg || 0),
      rainfall_in: parseFloat(station.Rain_Tot || station.rain_sum || 0),
      soil_temp_f: parseFloat(station.SoilTemp4_Avg || station.ts4_avg || 0),
      station: station.StationName || 'FAWN SWFL',
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(`[lawn-intel] FAWN fetch failed: ${err.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// 2. PHOTO QUALITY ASSESSMENT
// ══════════════════════════════════════════════════════════════

async function assessPhotoQuality(base64Image, mimeType) {
  if (!Anthropic) return { passed: true, score: 50, issues: [] };
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODELS.VISION,
      max_tokens: 300,
      temperature: 0.2, // pin output for repeatable pass/fail decisions on the same photo
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: `Evaluate this lawn photo for quality. Return ONLY JSON, no markdown:
{
  "sharpness": <0-100>,
  "lawn_coverage_pct": <0-100 what percent of the image is lawn>,
  "lighting": <0-100>,
  "issues": [<list of: "blurry", "too_dark", "too_bright", "shadow_heavy", "feet_visible", "not_lawn", "too_far", "too_close">],
  "usable": <true/false>
}` },
        ],
      }],
    });
    const text = response.content[0].text;
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    const score = Math.round((result.sharpness * 0.4 + result.lawn_coverage_pct * 0.35 + result.lighting * 0.25));
    return {
      passed: result.usable !== false && score >= 35,
      score,
      sharpness: result.sharpness,
      coverage_pct: result.lawn_coverage_pct,
      lighting: result.lighting,
      issues: result.issues || [],
    };
  } catch (err) {
    logger.error(`[lawn-intel] Photo quality check failed: ${err.message}`);
    return { passed: true, score: 50, issues: [] }; // fail open
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ══════════════════════════════════════════════════════════════

const LawnIntelligence = {

  fetchFawnWeather,
  assessPhotoQuality,

  // ── Attach FAWN weather to an assessment ────────────────────
  async attachWeather(assessmentId) {
    const weather = await fetchFawnWeather();
    if (!weather) return null;
    await db('lawn_assessments').where({ id: assessmentId }).update({
      fawn_temp_f: weather.temp_f,
      fawn_humidity_pct: weather.humidity_pct,
      fawn_rainfall_7d: weather.rainfall_in,
      fawn_soil_temp_f: weather.soil_temp_f,
      fawn_station: weather.station,
      fawn_snapshot: JSON.stringify(weather),
    });
    return weather;
  },

  // ── 3. Product efficacy leaderboard ─────────────────────────
  async computeProductEfficacy() {
    const stats = { computed: 0, errors: 0 };
    try {
      const outcomes = await db('treatment_outcomes')
        .whereNotNull('products_applied')
        .whereNotNull('delta_turf_density');

      // Group by product × season × track
      const buckets = {};
      for (const o of outcomes) {
        let products = [];
        try { products = typeof o.products_applied === 'string' ? JSON.parse(o.products_applied) : o.products_applied || []; } catch { continue; }

        for (const p of products) {
          const name = (p.name || '').trim();
          if (!name) continue;
          const key = `${name}||${o.season || 'all'}||${o.grass_track || 'all'}`;
          if (!buckets[key]) {
            buckets[key] = { product_name: name, season: o.season || 'all', grass_track: o.grass_track || 'all', grass_type: o.grass_type, deltas: [], days: [], sats: [], temps: [], rains: [] };
          }
          const b = buckets[key];
          const overall = Math.round(((o.delta_turf_density || 0) + (o.delta_weed_suppression || 0) + (o.delta_color_health || 0) + (o.delta_fungus_control || 0) + (o.delta_thatch_level || 0)) / 5);
          b.deltas.push({ turf: o.delta_turf_density, weed: o.delta_weed_suppression, color: o.delta_color_health, fungus: o.delta_fungus_control, thatch: o.delta_thatch_level, overall });
          if (o.days_between_assessments) b.days.push(o.days_between_assessments);
          if (o.satisfaction_rating) b.sats.push(o.satisfaction_rating);
          if (o.fawn_temp_f) b.temps.push(parseFloat(o.fawn_temp_f));
          if (o.fawn_rainfall_7d) b.rains.push(parseFloat(o.fawn_rainfall_7d));
        }
      }

      const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null;

      for (const [, b] of Object.entries(buckets)) {
        if (b.deltas.length < 2) continue; // need minimum data
        const row = {
          product_name: b.product_name,
          season: b.season,
          grass_track: b.grass_track,
          grass_type: b.grass_type,
          application_count: b.deltas.length,
          avg_delta_turf: avg(b.deltas.map(d => d.turf).filter(v => v != null)),
          avg_delta_weed: avg(b.deltas.map(d => d.weed).filter(v => v != null)),
          avg_delta_color: avg(b.deltas.map(d => d.color).filter(v => v != null)),
          avg_delta_fungus: avg(b.deltas.map(d => d.fungus).filter(v => v != null)),
          avg_delta_thatch: avg(b.deltas.map(d => d.thatch).filter(v => v != null)),
          avg_overall_delta: avg(b.deltas.map(d => d.overall)),
          success_rate: b.deltas.length ? Math.round(b.deltas.filter(d => d.overall > 0).length / b.deltas.length * 100) / 100 : null,
          avg_days_to_result: avg(b.days),
          avg_satisfaction: avg(b.sats),
          best_temp_range_low: b.temps.length >= 3 ? Math.min(...b.temps) : null,
          best_temp_range_high: b.temps.length >= 3 ? Math.max(...b.temps) : null,
          best_rainfall_range: avg(b.rains),
          last_computed: new Date(),
        };

        await db('product_efficacy')
          .insert(row)
          .onConflict(['product_name', 'season', 'grass_track'])
          .merge({ ...row, updated_at: new Date() });
        stats.computed++;
      }
      logger.info(`[lawn-intel] Product efficacy computed: ${stats.computed} entries`);
    } catch (err) {
      logger.error(`[lawn-intel] computeProductEfficacy failed: ${err.message}`);
      stats.errors++;
    }
    return stats;
  },

  // ── 4. Protocol performance scoring ─────────────────────────
  async computeProtocolPerformance() {
    const stats = { computed: 0 };
    try {
      const outcomes = await db('treatment_outcomes')
        .whereNotNull('grass_track')
        .whereNotNull('delta_turf_density');

      const buckets = {};
      for (const o of outcomes) {
        const key = `${o.grass_track}||${o.visit_number || 'all'}||${o.season || 'all'}`;
        if (!buckets[key]) {
          buckets[key] = { grass_track: o.grass_track, visit_number: o.visit_number, season: o.season || 'all', customers: new Set(), deltas: [], sats: [], products: {} };
        }
        const b = buckets[key];
        b.customers.add(o.customer_id);
        const overall = Math.round(((o.delta_turf_density || 0) + (o.delta_weed_suppression || 0) + (o.delta_color_health || 0) + (o.delta_fungus_control || 0) + (o.delta_thatch_level || 0)) / 5);
        b.deltas.push({ turf: o.delta_turf_density, weed: o.delta_weed_suppression, color: o.delta_color_health, fungus: o.delta_fungus_control, thatch: o.delta_thatch_level, overall });
        if (o.satisfaction_rating) b.sats.push(o.satisfaction_rating);
        try {
          const prods = typeof o.products_applied === 'string' ? JSON.parse(o.products_applied) : o.products_applied || [];
          for (const p of prods) {
            if (p.name) b.products[p.name] = (b.products[p.name] || 0) + 1;
          }
        } catch {}
      }

      const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null;

      for (const [, b] of Object.entries(buckets)) {
        if (b.deltas.length < 2) continue;
        const topProducts = Object.entries(b.products).sort((a, c) => c[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

        const row = {
          grass_track: b.grass_track,
          visit_number: b.visit_number,
          season: b.season,
          customer_count: b.customers.size,
          outcome_count: b.deltas.length,
          avg_delta_turf: avg(b.deltas.map(d => d.turf).filter(v => v != null)),
          avg_delta_weed: avg(b.deltas.map(d => d.weed).filter(v => v != null)),
          avg_delta_color: avg(b.deltas.map(d => d.color).filter(v => v != null)),
          avg_delta_fungus: avg(b.deltas.map(d => d.fungus).filter(v => v != null)),
          avg_delta_thatch: avg(b.deltas.map(d => d.thatch).filter(v => v != null)),
          avg_overall_delta: avg(b.deltas.map(d => d.overall)),
          avg_satisfaction: avg(b.sats),
          top_products: JSON.stringify(topProducts),
          last_computed: new Date(),
        };

        await db('protocol_performance')
          .insert(row)
          .onConflict(['grass_track', 'visit_number', 'season'])
          .merge({ ...row, updated_at: new Date() });
        stats.computed++;
      }
      logger.info(`[lawn-intel] Protocol performance computed: ${stats.computed} entries`);
    } catch (err) {
      logger.error(`[lawn-intel] computeProtocolPerformance failed: ${err.message}`);
    }
    return stats;
  },

  // ── 5. Contradiction detection ──────────────────────────────
  async detectContradictions() {
    const stats = { found: 0 };
    try {
      // Get linked pairs from the bridge
      const bridges = await db('knowledge_bridge').whereNotNull('kb_entry_id').whereNotNull('wiki_entry_id');

      for (const bridge of bridges) {
        const kb = await db('knowledge_base').where({ id: bridge.kb_entry_id }).select('id', 'title', 'content').first();
        const wiki = await db('knowledge_entries').where({ id: bridge.wiki_entry_id }).select('id', 'title', 'content', 'summary', 'data_point_count').first();
        if (!kb || !wiki || !wiki.data_point_count || wiki.data_point_count < 5) continue;

        // Use AI to detect contradictions
        if (!Anthropic) continue;
        try {
          const client = new Anthropic();
          const response = await client.messages.create({
            model: MODELS.FLAGSHIP,
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: `Compare these two knowledge sources and identify any contradictions. Return ONLY JSON, no markdown:

Claudeopedia entry: "${kb.title}"
${(kb.content || '').substring(0, 1500)}

Agronomic Wiki (based on ${wiki.data_point_count} real treatment outcomes): "${wiki.title}"
${(wiki.content || '').substring(0, 1500)}

Return: { "contradictions": [{ "kb_claim": "<what Claudeopedia says>", "wiki_evidence": "<what outcome data shows>", "type": "<efficacy|timing|dosage|condition>", "severity": "<low|moderate|high>" }] }
If no contradictions, return: { "contradictions": [] }`
            }],
          });

          const text = response.content[0].text;
          const result = JSON.parse(text.replace(/```json|```/g, '').trim());

          for (const c of (result.contradictions || [])) {
            const existing = await db('knowledge_contradictions')
              .where({ kb_entry_id: kb.id, wiki_entry_id: wiki.id, contradiction_type: c.type, resolved: false })
              .first();
            if (!existing) {
              await db('knowledge_contradictions').insert({
                kb_entry_id: kb.id,
                wiki_entry_id: wiki.id,
                kb_claim: (c.kb_claim || '').substring(0, 500),
                wiki_evidence: (c.wiki_evidence || '').substring(0, 500),
                contradiction_type: c.type || 'efficacy',
                severity: c.severity || 'moderate',
              });
              stats.found++;
            }
          }
        } catch (aiErr) {
          logger.error(`[lawn-intel] Contradiction AI check failed for bridge ${bridge.id}: ${aiErr.message}`);
        }
      }
      logger.info(`[lawn-intel] Contradictions detected: ${stats.found}`);
    } catch (err) {
      logger.error(`[lawn-intel] detectContradictions failed: ${err.message}`);
    }
    return stats;
  },

  // ── 6. Tech field knowledge surfacing ───────────────────────
  async getTechContext(customerId, assessmentContext = {}) {
    const context = { recentAssessments: [], protocolInsight: null, productInsight: null, weatherContext: null };
    try {
      // Last 3 assessments
      context.recentAssessments = await db('lawn_assessments')
        .where({ customer_id: customerId, confirmed_by_tech: true })
        .orderBy('service_date', 'desc')
        .limit(3)
        .select('service_date', 'turf_density', 'weed_suppression', 'color_health', 'fungus_control', 'thatch_level', 'overall_score', 'observations', 'season');

      // Protocol insight
      const customer = await db('customers').where({ id: customerId }).first();
      const track = customer?.grass_track || assessmentContext.grass_track;
      const visitNum = assessmentContext.visit_number;
      if (track) {
        context.protocolInsight = await db('protocol_performance')
          .where({ grass_track: track })
          .where(function () { if (visitNum) this.where({ visit_number: visitNum }); else this.whereNull('visit_number'); })
          .first();
      }

      // Product insight for products being applied today
      if (assessmentContext.products?.length) {
        const productNames = assessmentContext.products.map(p => p.name || p).filter(Boolean);
        context.productInsight = await db('product_efficacy')
          .whereIn('product_name', productNames)
          .orderBy('application_count', 'desc')
          .limit(5);
      }

      // Current weather
      context.weatherContext = await fetchFawnWeather();

    } catch (err) {
      logger.error(`[lawn-intel] getTechContext failed: ${err.message}`);
    }
    return context;
  },

  // ── 7. Assessment notification ──────────────────────────────
  async sendAssessmentNotification(assessmentId) {
    try {
      const assessment = await db('lawn_assessments').where({ id: assessmentId, confirmed_by_tech: true }).first();
      if (!assessment || assessment.notification_sent) return null;

      const customer = await db('customers').where({ id: assessment.customer_id }).first();
      if (!customer) return null;

      // Build notification message
      const overall = assessment.overall_score || Math.round(
        (assessment.turf_density + assessment.weed_suppression + assessment.fungus_control +
          (assessment.color_health || 0) + (assessment.thatch_level || 0)) / 5
      );

      // Get previous assessment for delta
      const previous = await db('lawn_assessments')
        .where({ customer_id: customer.id, confirmed_by_tech: true })
        .where('service_date', '<', assessment.service_date)
        .orderBy('service_date', 'desc')
        .first();

      const delta = previous ? overall - (previous.overall_score || Math.round(
        (previous.turf_density + previous.weed_suppression + previous.fungus_control +
          (previous.color_health || 0) + (previous.thatch_level || 0)) / 5
      )) : null;

      // Parse recommendations for customer tip
      let tip = '';
      try {
        const recs = typeof assessment.recommendations === 'string' ? JSON.parse(assessment.recommendations) : assessment.recommendations;
        tip = recs?.customerTip ? `\nTip: ${recs.customerTip}` : '';
      } catch {}

      const deltaStr = delta != null && delta !== 0 ? `, ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} from last visit` : '';
      const smsMessage = `Hi ${customer.first_name}! Your lawn health report is ready — you scored ${overall}/100${deltaStr}.${tip}\n\nView full report: portal.wavespestcontrol.com\nThank you for choosing Waves!`;

      const NotificationDispatcher = require('./notification-dispatcher');
      const result = await NotificationDispatcher.notify(customer.id, 'service_complete', {
        smsMessage,
        emailSubject: `Your Lawn Health Report — Score: ${overall}/100`,
        emailBody: smsMessage,
      });

      await db('lawn_assessments').where({ id: assessmentId }).update({
        notification_sent: true,
        notification_sent_at: new Date(),
      });

      return result;
    } catch (err) {
      logger.error(`[lawn-intel] sendAssessmentNotification failed: ${err.message}`);
      return null;
    }
  },

  // ── 8. Seasonal expectation data ────────────────────────────
  getSeasonalExpectation(month, grassType = 'St. Augustine') {
    const m = month || (new Date().getMonth() + 1);
    const expectations = {
      'St. Augustine': {
        peak: { months: [5,6,7,8,9], label: 'Summer peak growth', expected: '75-95', note: 'Fastest growth period. Green, dense turf. Watch for chinch bugs and fungus from afternoon rains.' },
        shoulder: { months: [3,4,10,11], label: 'Spring/fall transition', expected: '55-80', note: 'Color greening up (spring) or slowing (fall). Normal to see some thinning. Pre-emergent and fertilization windows.' },
        dormant: { months: [12,1,2], label: 'Winter dormancy', expected: '35-60', note: 'St. Augustine naturally yellows/browns below 60°F. Lower scores are normal — your lawn is resting, not dying. Avoid overwatering.' },
      },
    };
    const grass = expectations[grassType] || expectations['St. Augustine'];
    for (const [season, data] of Object.entries(grass)) {
      if (data.months.includes(m)) {
        return { season, ...data, month: m, grassType, adjustmentApplied: season !== 'peak' };
      }
    }
    return { season: 'peak', label: 'Growing season', expected: '70-90', note: '', month: m, grassType, adjustmentApplied: false };
  },

  // ── 9. Neighborhood benchmarks ──────────────────────────────
  async computeNeighborhoodBenchmarks() {
    const stats = { computed: 0 };
    try {
      // Get all customers with assessments
      const customers = await db('customers as c')
        .join('lawn_assessments as la', 'c.id', 'la.customer_id')
        .where('la.confirmed_by_tech', true)
        .select('c.id', 'c.city', 'c.zip', 'c.address_line1', 'c.grass_type',
          db.raw('MAX(la.overall_score) as latest_score'),
          db.raw('MIN(la.overall_score) as first_score'),
          db.raw('COUNT(la.id) as assessment_count'),
          db.raw('AVG(la.overall_score) as avg_score'))
        .groupBy('c.id', 'c.city', 'c.zip', 'c.address_line1', 'c.grass_type');

      // Group by segments
      const segments = {};
      for (const c of customers) {
        const keys = [];
        if (c.city) keys.push({ type: 'city', value: c.city });
        if (c.zip) keys.push({ type: 'zip', value: c.zip });
        if (c.grass_type) keys.push({ type: 'grass_type', value: c.grass_type });
        // Try to extract subdivision from address
        const subdivMatch = (c.address_line1 || '').match(/^[\d\s]+([\w\s]+?)(?:\s+(?:Dr|St|Ave|Blvd|Ct|Ln|Way|Pl|Rd|Cir|Ter))/i);
        if (subdivMatch) keys.push({ type: 'subdivision', value: subdivMatch[1].trim() });

        for (const k of keys) {
          const segKey = `${k.type}||${k.value}`;
          if (!segments[segKey]) segments[segKey] = { type: k.type, value: k.value, scores: [], improvements: [] };
          segments[segKey].scores.push(parseFloat(c.avg_score) || 0);
          if (c.latest_score && c.first_score) {
            segments[segKey].improvements.push(c.latest_score - c.first_score);
          }
        }
      }

      for (const [, seg] of Object.entries(segments)) {
        if (seg.scores.length < 3) continue; // minimum threshold
        const sorted = [...seg.scores].sort((a, b) => a - b);
        const p25 = sorted[Math.floor(sorted.length * 0.25)];
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p75 = sorted[Math.floor(sorted.length * 0.75)];
        const avgImprovement = seg.improvements.length
          ? Math.round(seg.improvements.reduce((a, b) => a + b, 0) / seg.improvements.length * 10) / 10 : null;

        await db('neighborhood_benchmarks')
          .insert({
            segment_type: seg.type,
            segment_value: seg.value,
            customer_count: seg.scores.length,
            assessment_count: seg.scores.length, // simplified
            avg_overall_score: Math.round(seg.scores.reduce((a, b) => a + b, 0) / seg.scores.length * 10) / 10,
            avg_improvement: avgImprovement,
            percentile_25: Math.round(p25 * 10) / 10,
            percentile_50: Math.round(p50 * 10) / 10,
            percentile_75: Math.round(p75 * 10) / 10,
            last_computed: new Date(),
          })
          .onConflict(['segment_type', 'segment_value'])
          .merge();
        stats.computed++;
      }
    } catch (err) {
      logger.error(`[lawn-intel] computeNeighborhoodBenchmarks failed: ${err.message}`);
    }
    return stats;
  },

  // ── Get customer's percentile in their neighborhood ─────────
  async getCustomerPercentile(customerId) {
    try {
      const customer = await db('customers').where({ id: customerId }).first();
      if (!customer) return null;

      const latest = await db('lawn_assessments')
        .where({ customer_id: customerId, confirmed_by_tech: true })
        .orderBy('service_date', 'desc')
        .first();
      if (!latest) return null;

      const score = latest.overall_score || Math.round(
        (latest.turf_density + latest.weed_suppression + latest.fungus_control +
          (latest.color_health || 0) + (latest.thatch_level || 0)) / 5
      );

      // Find relevant benchmarks
      const benchmarks = [];
      if (customer.city) {
        const b = await db('neighborhood_benchmarks').where({ segment_type: 'city', segment_value: customer.city }).first();
        if (b && b.customer_count >= 3) benchmarks.push({ ...b, segment_label: customer.city });
      }
      if (customer.grass_type) {
        const b = await db('neighborhood_benchmarks').where({ segment_type: 'grass_type', segment_value: customer.grass_type }).first();
        if (b && b.customer_count >= 3) benchmarks.push({ ...b, segment_label: `${customer.grass_type} lawns` });
      }

      return benchmarks.map(b => {
        let percentile;
        if (score >= b.percentile_75) percentile = 'top 25%';
        else if (score >= b.percentile_50) percentile = 'top 50%';
        else if (score >= b.percentile_25) percentile = 'top 75%';
        else percentile = 'building momentum';

        return {
          segment: b.segment_label,
          segmentType: b.segment_type,
          yourScore: score,
          avgScore: parseFloat(b.avg_overall_score),
          percentile,
          customerCount: b.customer_count,
          avgImprovement: parseFloat(b.avg_improvement),
        };
      });
    } catch (err) {
      logger.error(`[lawn-intel] getCustomerPercentile failed: ${err.message}`);
      return null;
    }
  },

  // ── 10. Lawn health → customer health bridge ────────────────
  async emitHealthSignal(customerId) {
    try {
      const assessments = await db('lawn_assessments')
        .where({ customer_id: customerId, confirmed_by_tech: true })
        .orderBy('service_date', 'desc')
        .limit(4);

      if (assessments.length < 2) return null;

      const calcOverall = (a) => a.overall_score || Math.round(
        (a.turf_density + a.weed_suppression + a.fungus_control + (a.color_health || 0) + (a.thatch_level || 0)) / 5
      );

      const scores = assessments.map(calcOverall);
      const latest = scores[0];
      const trend = scores.length >= 3 ? scores.slice(0, 3) : scores;
      const declining = trend.every((s, i) => i === 0 || s <= trend[i - 1]) && (trend[0] - trend[trend.length - 1]) > 5;
      const improving = trend.every((s, i) => i === 0 || s >= trend[i - 1]) && (trend[0] - trend[trend.length - 1]) > 10;

      // Emit signals to customer_signals if table exists
      try {
        if (declining) {
          const existing = await db('customer_signals')
            .where({ customer_id: customerId, signal_type: 'LAWN_SCORE_DECLINING', resolved: false })
            .first();
          if (!existing) {
            await db('customer_signals').insert({
              customer_id: customerId,
              signal_type: 'LAWN_SCORE_DECLINING',
              signal_value: JSON.stringify({ scores: trend, delta: trend[0] - trend[trend.length - 1] }),
              severity: trend[0] - trend[trend.length - 1] > 15 ? 'warning' : 'info',
              detected_at: new Date(),
            });
          }
        }

        if (improving && latest >= 75) {
          const existing = await db('customer_signals')
            .where({ customer_id: customerId, signal_type: 'LAWN_TRANSFORMATION', resolved: false })
            .first();
          if (!existing) {
            await db('customer_signals').insert({
              customer_id: customerId,
              signal_type: 'LAWN_TRANSFORMATION',
              signal_value: JSON.stringify({ scores: trend, latest }),
              severity: 'info',
              detected_at: new Date(),
            });
          }
        }

        // Resolve stale signals
        if (!declining) {
          await db('customer_signals')
            .where({ customer_id: customerId, signal_type: 'LAWN_SCORE_DECLINING', resolved: false })
            .update({ resolved: true, resolved_at: new Date() });
        }
      } catch { /* customer_signals table may not exist */ }

      return { declining, improving, latest, trend };
    } catch (err) {
      logger.error(`[lawn-intel] emitHealthSignal failed: ${err.message}`);
      return null;
    }
  },

  // ── 11. Assessment completion tracking ──────────────────────
  async trackAssessmentCompletion(date) {
    const trackingDate = date || etDateString();
    try {
      // Get all techs
      const techs = await db('technicians').where('active', true).select('id', 'name', 'email');

      for (const tech of techs) {
        // Lawn services assigned/completed that day. scheduled_services
        // standardised on technician_id; assigned_tech_id is a column
        // on the retired dispatch AI shadow tables, not here. The prior `or assigned_tech_id`
        // branch silently 500s the whole query.
        const lawnServices = await db('scheduled_services')
          .where('scheduled_date', trackingDate)
          .where('technician_id', tech.id)
          .where('service_type', 'ilike', '%lawn%')
          .count('id as count').first();

        const totalLawn = parseInt(lawnServices?.count || 0);
        if (totalLawn === 0) continue;

        // Assessments created by this tech on that day
        const started = await db('lawn_assessments')
          .where({ technician_id: tech.id, service_date: trackingDate })
          .count('id as count').first();

        const confirmed = await db('lawn_assessments')
          .where({ technician_id: tech.id, service_date: trackingDate, confirmed_by_tech: true })
          .count('id as count').first();

        const assessmentStarted = parseInt(started?.count || 0);
        const assessmentConfirmed = parseInt(confirmed?.count || 0);

        // Quality metrics
        const qualityData = await db('lawn_assessments')
          .where({ technician_id: tech.id, service_date: trackingDate });

        let avgPhotoCount = 0, avgQuality = 0, divergenceCount = 0, overrideCount = 0;
        if (qualityData.length) {
          for (const a of qualityData) {
            try { const photos = JSON.parse(a.photos || '[]'); avgPhotoCount += photos.length; } catch {}
            try { const flags = JSON.parse(a.divergence_flags || '[]'); divergenceCount += flags.length; } catch {}
            const comp = typeof a.composite_scores === 'string' ? JSON.parse(a.composite_scores || '{}') : a.composite_scores || {};
            const adj = typeof a.adjusted_scores === 'string' ? JSON.parse(a.adjusted_scores || '{}') : a.adjusted_scores || {};
            if (JSON.stringify(comp) !== JSON.stringify(adj)) overrideCount++;
          }
          avgPhotoCount = Math.round(avgPhotoCount / qualityData.length * 10) / 10;
        }

        await db('assessment_completion_tracking')
          .insert({
            tracking_date: trackingDate,
            technician_id: tech.id,
            technician_name: tech.name || tech.email,
            lawn_services_total: totalLawn,
            assessments_started: assessmentStarted,
            assessments_confirmed: assessmentConfirmed,
            completion_rate: totalLawn > 0 ? Math.round(assessmentStarted / totalLawn * 100) / 100 : 0,
            confirmation_rate: assessmentStarted > 0 ? Math.round(assessmentConfirmed / assessmentStarted * 100) / 100 : 0,
            avg_photo_count: avgPhotoCount,
            divergence_flags_count: divergenceCount,
            tech_overrides_count: overrideCount,
          })
          .onConflict(['tracking_date', 'technician_id'])
          .merge();
      }
    } catch (err) {
      logger.error(`[lawn-intel] trackAssessmentCompletion failed: ${err.message}`);
    }
  },

  // ── 12. Tech calibration scoring ────────────────────────────
  async recordTechCalibration(assessmentId, aiScores, techScores) {
    try {
      const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
      if (!assessment || !assessment.technician_id) return null;

      const fields = ['turf_density', 'weed_suppression', 'color_health', 'fungus_control', 'thatch_level'];
      const deltas = [];
      const row = { assessment_id: assessmentId, technician_id: assessment.technician_id };

      for (const f of fields) {
        const aiKey = f;
        row[`ai_${f}`] = aiScores[aiKey] ?? null;
        row[`tech_${f}`] = techScores[aiKey] ?? null;
        if (aiScores[aiKey] != null && techScores[aiKey] != null) {
          deltas.push(Math.abs(aiScores[aiKey] - techScores[aiKey]));
        }
      }

      row.avg_delta = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length * 10) / 10 : 0;

      // Determine bias direction
      let higher = 0, lower = 0;
      for (const f of fields) {
        if (techScores[f] != null && aiScores[f] != null) {
          if (techScores[f] > aiScores[f]) higher++;
          else if (techScores[f] < aiScores[f]) lower++;
        }
      }
      row.bias_direction = higher > lower ? 'higher' : lower > higher ? 'lower' : 'mixed';

      await db('tech_calibration').insert(row);
      return row;
    } catch (err) {
      logger.error(`[lawn-intel] recordTechCalibration failed: ${err.message}`);
      return null;
    }
  },

  // ── 13. Satisfaction → outcome validation ───────────────────
  async linkSatisfactionToOutcome(customerId, serviceRecordId, rating, source = 'review') {
    try {
      const outcome = await db('treatment_outcomes')
        .where({ customer_id: customerId })
        .where(function () {
          if (serviceRecordId) this.where({ service_record_id: serviceRecordId });
        })
        .orderBy('treatment_date', 'desc')
        .first();

      if (outcome) {
        await db('treatment_outcomes').where({ id: outcome.id }).update({
          satisfaction_rating: rating,
          satisfaction_source: source,
        });
        return outcome.id;
      }
      return null;
    } catch (err) {
      logger.error(`[lawn-intel] linkSatisfactionToOutcome failed: ${err.message}`);
      return null;
    }
  },

  // ── 14. ROI metrics ─────────────────────────────────────────
  async computeROIMetrics() {
    const stats = { computed: 0 };
    try {
      // Assessed vs non-assessed customers
      const allCustomers = await db('customers').where('active', true).select('id', 'monthly_rate', 'created_at', 'waveguard_tier');

      const assessed = new Set();
      const assessments = await db('lawn_assessments')
        .where({ confirmed_by_tech: true })
        .select('customer_id')
        .groupBy('customer_id');
      assessments.forEach(a => assessed.add(a.customer_id));

      const groups = { assessed: [], not_assessed: [] };
      for (const c of allCustomers) {
        if (assessed.has(c.id)) groups.assessed.push(c);
        else groups.not_assessed.push(c);
      }

      for (const [segment, customers] of Object.entries(groups)) {
        if (!customers.length) continue;
        const rates = customers.map(c => parseFloat(c.monthly_rate || 0)).filter(v => v > 0);
        const tenures = customers.map(c => {
          const created = c.created_at ? new Date(c.created_at) : new Date();
          return Math.floor((Date.now() - created.getTime()) / (86400000 * 30));
        });

        await db('lawn_roi_metrics')
          .insert({
            segment: 'assessed_vs_not',
            segment_value: segment,
            customer_count: customers.length,
            avg_monthly_revenue: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 100) / 100 : 0,
            avg_ltv: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 12 * 100) / 100 : 0,
            avg_tenure_months: tenures.length ? Math.round(tenures.reduce((a, b) => a + b, 0) / tenures.length) : 0,
            last_computed: new Date(),
          })
          .onConflict(['segment', 'segment_value'])
          .merge();
        stats.computed++;
      }

      // By improvement tier
      const customerScores = await db('lawn_assessments')
        .where({ confirmed_by_tech: true })
        .select('customer_id')
        .max('overall_score as max_score')
        .min('overall_score as min_score')
        .groupBy('customer_id');

      const tiers = { 'high_improvement': [], 'moderate_improvement': [], 'low_improvement': [] };
      for (const cs of customerScores) {
        const delta = (cs.max_score || 0) - (cs.min_score || 0);
        if (delta >= 20) tiers.high_improvement.push(cs.customer_id);
        else if (delta >= 10) tiers.moderate_improvement.push(cs.customer_id);
        else tiers.low_improvement.push(cs.customer_id);
      }

      for (const [tier, ids] of Object.entries(tiers)) {
        if (!ids.length) continue;
        const customers = await db('customers').whereIn('id', ids).select('monthly_rate', 'created_at');
        const rates = customers.map(c => parseFloat(c.monthly_rate || 0)).filter(v => v > 0);

        await db('lawn_roi_metrics')
          .insert({
            segment: 'improvement_tier',
            segment_value: tier,
            customer_count: ids.length,
            avg_monthly_revenue: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 100) / 100 : 0,
            avg_ltv: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 12 * 100) / 100 : 0,
            last_computed: new Date(),
          })
          .onConflict(['segment', 'segment_value'])
          .merge();
        stats.computed++;
      }
    } catch (err) {
      logger.error(`[lawn-intel] computeROIMetrics failed: ${err.message}`);
    }
    return stats;
  },

  // ── 15. Auto-generate service report ────────────────────────
  async generateServiceReport(assessmentId) {
    try {
      const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
      if (!assessment || assessment.report_generated) return null;

      const customer = await db('customers').where({ id: assessment.customer_id }).first();
      if (!customer) return null;

      // Get best photo
      const bestPhoto = await db('lawn_assessment_photos')
        .where({ assessment_id: assessmentId, is_best_photo: true })
        .first();

      // Build report data
      const reportData = {
        customer_id: customer.id,
        service_date: assessment.service_date,
        service_type: 'Lawn Care',
        report_type: 'lawn_assessment',
        report_data: JSON.stringify({
          scores: {
            turf_density: assessment.turf_density,
            weed_suppression: assessment.weed_suppression,
            color_health: assessment.color_health,
            fungus_control: assessment.fungus_control,
            thatch_level: assessment.thatch_level,
            overall: assessment.overall_score,
          },
          observations: assessment.observations,
          ai_summary: assessment.ai_summary,
          recommendations: assessment.recommendations,
          season: assessment.season,
          weather: assessment.fawn_snapshot,
          photo_key: bestPhoto?.s3_key || null,
        }),
        status: 'generated',
        generated_at: new Date(),
      };

      // Insert into service_reports if table exists
      try {
        const [report] = await db('service_reports').insert(reportData).returning('*');
        await db('lawn_assessments').where({ id: assessmentId }).update({
          report_generated: true,
          report_id: report.id,
        });
        return report;
      } catch {
        // service_reports table may not exist — just mark as generated
        await db('lawn_assessments').where({ id: assessmentId }).update({ report_generated: true });
        return reportData;
      }
    } catch (err) {
      logger.error(`[lawn-intel] generateServiceReport failed: ${err.message}`);
      return null;
    }
  },

  // ── 16. Baseline re-capture ─────────────────────────────────
  async flagBaselineRecapture(customerId, resetId) {
    try {
      // Flag next assessment for this customer
      await db('lawn_baseline_resets').where({ id: resetId }).update({ needs_photo_recapture: true });

      // Also flag the customer's future assessments
      const nextAssessment = await db('scheduled_services')
        .where({ customer_id: customerId })
        .where('scheduled_date', '>=', etDateString())
        .where('service_type', 'ilike', '%lawn%')
        .orderBy('scheduled_date', 'asc')
        .first();

      return { flagged: true, nextServiceDate: nextAssessment?.scheduled_date || null };
    } catch (err) {
      logger.error(`[lawn-intel] flagBaselineRecapture failed: ${err.message}`);
      return null;
    }
  },

  // ── Master computation (runs all aggregations) ──────────────
  async runFullComputation() {
    logger.info('[lawn-intel] Starting full computation...');
    const results = {};
    results.productEfficacy = await LawnIntelligence.computeProductEfficacy();
    results.protocolPerformance = await LawnIntelligence.computeProtocolPerformance();
    results.neighborhoodBenchmarks = await LawnIntelligence.computeNeighborhoodBenchmarks();
    results.roiMetrics = await LawnIntelligence.computeROIMetrics();
    results.contradictions = await LawnIntelligence.detectContradictions();
    results.assessmentTracking = await LawnIntelligence.trackAssessmentCompletion();
    logger.info(`[lawn-intel] Full computation complete: ${JSON.stringify(results)}`);
    return results;
  },
};

module.exports = LawnIntelligence;
