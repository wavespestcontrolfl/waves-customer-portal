/**
 * conversion-feedback-miner.js — closes the loop on opportunity scoring
 * by feeding actual business outcomes (form submissions, calls,
 * estimates, closed jobs, revenue) back into the engine.
 *
 * Per scoring-config:
 *   + leadQualityScore(0, 20)        weighted form+call volume per impression
 *   + closeRateScore(0, 15)          historical close-rate of this {city,service}
 *   + revenueRealizationScore(0, 20) avg_ticket × forecasted lead lift
 *
 * Reader only — never mutates source tables. Writes only to
 * conversion_feedback_snapshots. The decision-router (Step 5) reads
 * the cached snapshot when scoring each opportunity.
 *
 * Source tables (existing, already populated):
 *   - leads               attribution + service_interest + city + monthly_value
 *   - lead_sources        source_type, channel
 *   - estimates           status, monthly_total, annual_total, onetime_total
 *   - call_log            direction, call_outcome
 *   - google_reviews      location_id (for GBP location → city)
 *
 * Service + city are normalized to the canonical sets from
 * scoring-config; unmatched rows roll up under '_global'.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { WEIGHTS, CITIES } = require('../content/scoring-config');

// ── normalization (pure, test-friendly) ──────────────────────────────

const CITY_NORM_MAP = (() => {
  const m = new Map();
  for (const c of CITIES) {
    m.set(c.toLowerCase(), c);
    m.set(c.toLowerCase().replace(/\s+/g, '_'), c);
    m.set(c.toLowerCase().replace(/\s+/g, '-'), c);
  }
  return m;
})();

function normalizeCity(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  if (CITY_NORM_MAP.has(key)) return CITY_NORM_MAP.get(key);
  // Common variants: "Bradenton, FL", "Lakewood Ranch FL"
  const stripped = key.replace(/\s*,?\s*fl(orida)?\s*$/, '');
  return CITY_NORM_MAP.get(stripped) || null;
}

function normalizeService(raw) {
  if (!raw) return null;
  const t = String(raw).toLowerCase();
  // Stem patterns (no trailing \b so they catch -ing / -er / -ion / etc.)
  // are written as separate tests; strict alternations keep their \b.
  if (/\btermite|\bwdo\b|\bwood.?destroying/.test(t)) return 'termite';
  if (/\b(rodent|rat|rats|mice|mouse)\b/.test(t)) return 'rodent';
  if (/\bmosquito(es)?\b/.test(t)) return 'mosquito';
  // Tree-shrub before lawn so "palm fertilizing" classifies as
  // tree-shrub (palm is the dominant noun; fertilizing is the action).
  if (/\b(tree|shrub|palm|ornamental)\b/.test(t)) return 'tree-shrub';
  if (/\b(lawn|grass|chinch|aeration|weed)\b|\bfertiliz/.test(t)) return 'lawn';
  if (/\bbed.?bug\b/.test(t)) return 'specialty';
  if (/\b(pest|bug|roach|ant|spider|cockroach|insect)\b|\bexterminat/.test(t)) return 'pest';
  return null;
}

const SENTINEL = '_global';
const sentinelize = (v) => v || SENTINEL;
const desentinelize = (v) => (v === SENTINEL ? null : v);

// ── scoring (pure, test-friendly) ────────────────────────────────────

function leadQualityScore({ leads_total, form_submissions, calls_handled }) {
  // Volume weighted: 1 form ≈ 1 call ≈ 1 lead, capped at W.
  const total = (leads_total || 0) + (form_submissions || 0) * 0.5 + (calls_handled || 0) * 0.5;
  if (total <= 0) return 0;
  // Logarithmic-ish: 5 leads → ~half score, 25 leads → full.
  const ratio = Math.min(1, Math.log10(total + 1) / Math.log10(26));
  return Math.round(WEIGHTS.leadQuality * ratio);
}

function closeRateScore({ estimates_sent, estimates_accepted }) {
  if (!estimates_sent || estimates_sent < 3) return 0; // insufficient sample
  const rate = estimates_accepted / estimates_sent;
  // 0% → 0, 50% → ~full. Local pest typical close rate sits 20-40%.
  return Math.round(WEIGHTS.closeRate * Math.min(1, rate * 2));
}

function revenueRealizationScore({ estimated_revenue, leads_total }) {
  if (!leads_total || !estimated_revenue) return 0;
  const perLead = estimated_revenue / leads_total;
  // $0 → 0, $500/lead → ~half, $2000/lead → full.
  const ratio = Math.min(1, Math.log10(perLead + 1) / Math.log10(2001));
  return Math.round(WEIGHTS.revenueRealization * ratio);
}

// ── source-table joins ───────────────────────────────────────────────

class ConversionFeedbackMiner {
  async mineWindow({ windowDays = 90, persist = true } = {}) {
    const windowEndDate = etDateString(new Date());
    // ET-pinned cutoff: leads.first_contact_at + call_log.created_at
    // are timestamptz columns. Comparing them against an ET date STRING
    // would let Postgres convert at UTC-midnight, shifting the window
    // 4–5 hours. Build an actual Date at ET-midnight N days ago so the
    // driver serializes it with timezone info.
    const sinceETString = etDateString(addETDays(new Date(), -windowDays));
    const since = parseETDateTime(`${sinceETString}T00:00`);

    const rolls = new Map(); // key: city||_global :: service||_global → row

    const bump = (city, service, patch) => {
      const key = `${sentinelize(city)}::${sentinelize(service)}`;
      const row = rolls.get(key) || {
        city: sentinelize(city),
        service: sentinelize(service),
        form_submissions: 0,
        calls_handled: 0,
        calls_booked: 0,
        leads_total: 0,
        estimates_sent: 0,
        estimates_accepted: 0,
        estimated_revenue: 0,
        source_breakdown: {},
      };
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'source_breakdown') continue;
        row[k] += v || 0;
      }
      if (patch.source_breakdown) {
        for (const [src, sb] of Object.entries(patch.source_breakdown)) {
          const cur = row.source_breakdown[src] || { leads: 0, accepted: 0, revenue: 0 };
          row.source_breakdown[src] = {
            leads: cur.leads + (sb.leads || 0),
            accepted: cur.accepted + (sb.accepted || 0),
            revenue: cur.revenue + (sb.revenue || 0),
          };
        }
      }
      rolls.set(key, row);
    };

    // ── leads + estimates joined ───────────────────────────────────
    // Each lead might have an estimate; the estimate's status drives
    // sent/accepted counts and revenue.
    try {
      const leads = await db('leads')
        .where('leads.first_contact_at', '>=', since)
        .leftJoin('estimates', 'leads.estimate_id', 'estimates.id')
        .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
        .select(
          'leads.city as city',
          'leads.service_interest as service_interest',
          'leads.first_contact_channel as first_contact_channel',
          'leads.monthly_value as lead_monthly_value',
          'leads.status as lead_status',
          'estimates.status as estimate_status',
          'estimates.monthly_total as estimate_monthly',
          'estimates.annual_total as estimate_annual',
          'estimates.onetime_total as estimate_onetime',
          'lead_sources.name as source_name',
          'lead_sources.source_type as source_type'
        );

      for (const r of leads) {
        const city = normalizeCity(r.city);
        const service = normalizeService(r.service_interest);

        const isForm = (r.source_type === 'form' || r.first_contact_channel === 'form' || r.first_contact_channel === 'web');
        // Include 'expired' — it's a post-send terminal state. Earlier
        // iteration excluded it, which inflated close_rate by shrinking
        // the denominator (expired = sent but customer never decided).
        const estSent = r.estimate_status && ['sent', 'viewed', 'accepted', 'declined', 'expired'].includes(r.estimate_status) ? 1 : 0;
        const estAccepted = r.estimate_status === 'accepted' ? 1 : 0;
        const revenue = estAccepted
          ? (parseFloat(r.estimate_monthly || 0) * 12) + parseFloat(r.estimate_annual || 0) + parseFloat(r.estimate_onetime || 0)
          : 0;

        const patch = {
          leads_total: 1,
          form_submissions: isForm ? 1 : 0,
          estimates_sent: estSent,
          estimates_accepted: estAccepted,
          estimated_revenue: revenue,
          source_breakdown: r.source_name
            ? { [r.source_name]: { leads: 1, accepted: estAccepted, revenue } }
            : {},
        };
        bump(city, service, patch);
      }
    } catch (err) {
      logger.warn(`[conversion-miner] leads read failed: ${err.message}`);
    }

    // ── inbound calls ──────────────────────────────────────────────
    // Calls don't carry a city/service classification themselves; we
    // attribute via the linked lead when present, otherwise roll into
    // the global bucket. Service inference from lead_synopsis is left
    // to a future iteration (would need to load synopsis text per row).
    try {
      const calls = await db('call_log')
        .where('call_log.direction', 'inbound')
        .where('call_log.created_at', '>=', since)
        .leftJoin('leads', function () {
          this.on('leads.twilio_call_sid', '=', 'call_log.twilio_call_sid');
        })
        .select(
          'call_log.call_outcome as call_outcome',
          'leads.city as lead_city',
          'leads.service_interest as lead_service'
        );

      for (const r of calls) {
        if (['spam', 'wrong_number'].includes(r.call_outcome)) continue;
        const city = normalizeCity(r.lead_city);
        const service = normalizeService(r.lead_service);
        bump(city, service, {
          calls_handled: 1,
          calls_booked: r.call_outcome === 'booked' ? 1 : 0,
        });
      }
    } catch (err) {
      logger.warn(`[conversion-miner] call_log read failed: ${err.message}`);
    }

    // ── compute derived ratios + scores, finalize ─────────────────
    const finalized = [];
    for (const row of rolls.values()) {
      row.avg_ticket = row.estimates_accepted > 0
        ? row.estimated_revenue / row.estimates_accepted
        : null;
      row.close_rate = row.estimates_sent > 0
        ? row.estimates_accepted / row.estimates_sent
        : null;
      row.call_book_rate = row.calls_handled > 0
        ? row.calls_booked / row.calls_handled
        : null;
      row.lead_quality_score = leadQualityScore(row);
      row.close_rate_score = closeRateScore(row);
      row.revenue_realization_score = revenueRealizationScore(row);
      finalized.push(row);
    }

    finalized.sort((a, b) => {
      const aScore = a.lead_quality_score + a.close_rate_score + a.revenue_realization_score;
      const bScore = b.lead_quality_score + b.close_rate_score + b.revenue_realization_score;
      return bScore - aScore;
    });

    let persisted = 0;
    if (persist) persisted = await this.persist(finalized, { windowDays, windowEndDate });

    return {
      window_days: windowDays,
      window_end_date: windowEndDate,
      rollup_count: finalized.length,
      persisted,
      rollups: finalized,
    };
  }

  async persist(rollups, { windowDays, windowEndDate }) {
    if (!rollups.length) return 0;
    let count = 0;
    for (const r of rollups) {
      try {
        await db.raw(
          `INSERT INTO conversion_feedback_snapshots
            (window_end_date, window_days, city, service,
             form_submissions, calls_handled, calls_booked,
             leads_total, estimates_sent, estimates_accepted,
             estimated_revenue, avg_ticket, close_rate, call_book_rate,
             lead_quality_score, close_rate_score, revenue_realization_score,
             source_breakdown, computed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, now(), now(), now())
           ON CONFLICT (window_end_date, window_days, city, service) DO UPDATE
             SET form_submissions = EXCLUDED.form_submissions,
                 calls_handled = EXCLUDED.calls_handled,
                 calls_booked = EXCLUDED.calls_booked,
                 leads_total = EXCLUDED.leads_total,
                 estimates_sent = EXCLUDED.estimates_sent,
                 estimates_accepted = EXCLUDED.estimates_accepted,
                 estimated_revenue = EXCLUDED.estimated_revenue,
                 avg_ticket = EXCLUDED.avg_ticket,
                 close_rate = EXCLUDED.close_rate,
                 call_book_rate = EXCLUDED.call_book_rate,
                 lead_quality_score = EXCLUDED.lead_quality_score,
                 close_rate_score = EXCLUDED.close_rate_score,
                 revenue_realization_score = EXCLUDED.revenue_realization_score,
                 source_breakdown = EXCLUDED.source_breakdown,
                 computed_at = EXCLUDED.computed_at,
                 updated_at = now()
          `,
          [
            windowEndDate, windowDays, r.city, r.service,
            r.form_submissions, r.calls_handled, r.calls_booked,
            r.leads_total, r.estimates_sent, r.estimates_accepted,
            r.estimated_revenue, r.avg_ticket, r.close_rate, r.call_book_rate,
            r.lead_quality_score, r.close_rate_score, r.revenue_realization_score,
            JSON.stringify(r.source_breakdown || {}),
          ]
        );
        count++;
      } catch (err) {
        logger.warn(`[conversion-miner] persist failed for ${r.city}/${r.service}: ${err.message}`);
      }
    }
    return count;
  }

  // Read-only lookup used by the decision-router (Step 5).
  async lookup({ city, service, windowDays = 90, maxAgeDays = 7 } = {}) {
    const cutoff = etDateString(addETDays(new Date(), -maxAgeDays));
    const row = await db('conversion_feedback_snapshots')
      .where('city', sentinelize(city))
      .where('service', sentinelize(service))
      .where('window_days', windowDays)
      .where('window_end_date', '>=', cutoff)
      .orderBy('window_end_date', 'desc')
      .first()
      .catch(() => null);
    if (!row) return null;
    return {
      ...row,
      city: desentinelize(row.city),
      service: desentinelize(row.service),
      source_breakdown: typeof row.source_breakdown === 'string'
        ? JSON.parse(row.source_breakdown)
        : row.source_breakdown,
    };
  }
}

module.exports = new ConversionFeedbackMiner();
module.exports.ConversionFeedbackMiner = ConversionFeedbackMiner;
module.exports._internals = {
  normalizeCity,
  normalizeService,
  leadQualityScore,
  closeRateScore,
  revenueRealizationScore,
  sentinelize,
  desentinelize,
};
