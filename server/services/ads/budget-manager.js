const db = require('../../models/db');
const logger = require('../logger');
const { etParts, etDateString, addETDays } = require('../../utils/datetime-et');
const { isEnabled } = require('../../config/feature-gates');

// Lazy so requiring budget-manager (e.g. from the scheduler at boot) doesn't
// load the google-ads-api client until a push is actually attempted.
let _googleAds;
function getGoogleAds() { return _googleAds || (_googleAds = require('./google-ads')); }

// ad_campaigns.daily_budget_base / daily_budget_current are decimal(10,2), so
// the largest storable value is 99,999,999.99. A budget above that (a typo like
// 100000000) could be accepted by Google BEFORE the local write, then fail the
// DB update — leaving the live campaign changed but the DB out of sync. Reject
// it up front, before any push. (Google itself enforces its own maxima too.)
const MAX_DAILY_BUDGET = 99999999.99;

// ad_budget_log.reason is a varchar(255). A caller-supplied reason longer than
// that would make the ad_budget_log insert fail AFTER the live Google push (and,
// in setBudget, after the campaign write) — losing the audit row and 500-ing an
// otherwise-successful change. Bound it up front so the audit insert can't fail
// on length. Cron-generated reasons are short by construction.
const MAX_REASON_LEN = 255;
function boundReason(reason) {
  return String(reason == null ? '' : reason).slice(0, MAX_REASON_LEN);
}

class BudgetManager {
  /**
   * Core budget adjustment — runs every 2 hours via cron.
   *
   * Sunday algorithm: always check Monday's capacity, full power.
   * Weekday <2PM: check today.  Weekday >=2PM: check tomorrow.
   *
   * With the adsBudgetLivePush gate on, each mode change is pushed to the
   * Google Ads API before being committed locally; with it off, changes are
   * DB-only intent tracking (dashboard/advisor state, no real spend change).
   * Gate-on runs with no mode transition also reconcile drift — a recorded
   * mode whose budget never reached Google (shadow-written while the gate
   * was off, or a failed manual push) is re-pushed.
   */
  async adjustBudgets() {
    const now = new Date();
    // Read ET wall-clock — server is UTC, getDay/getHours would be 4-5h off.
    const { dayOfWeek, hour } = etParts(now);

    let checkDate;

    if (dayOfWeek === 0) {
      // SUNDAY: Always check Monday's capacity. No time-of-day logic.
      // People plan their week ahead on Sunday — run ads at full power
      // if Monday has availability.
      checkDate = etDateString(addETDays(now, 1));
    } else if (hour < 14) {
      // Weekday morning (ET): check today's capacity
      checkDate = etDateString(now);
    } else {
      // Weekday afternoon (ET): check tomorrow's capacity
      checkDate = etDateString(addETDays(now, 1));
    }

    logger.info(`Budget adjust: checking capacity for ${checkDate} (${dayOfWeek === 0 ? 'Sunday→Monday' : hour < 14 ? 'today' : 'tomorrow'})`);

    // Only campaigns we can control remotely. Meta (platform='facebook') is
    // ingested read-only (no Marketing API budget control here), so this
    // capacity-based budget automation must not throttle Meta budgets locally —
    // that would drift the dashboard from Ads Manager until the next Meta sync.
    const campaigns = await db('ad_campaigns').where('status', 'active').where('platform', 'google_ads');
    const targets = await db('ad_targets').first();
    const thresholds = {
      green: parseFloat(targets?.capacity_green_max || 70),
      yellow: parseFloat(targets?.capacity_yellow_max || 85),
      orange: parseFloat(targets?.capacity_orange_max || 95),
    };

    for (const campaign of campaigns) {
      try {
        const area = campaign.target_area || 'general';
        const capacity = await this.getCapacityForArea(area, checkDate);
        const pct = capacity.utilizationPct;

        let newMode;
        if (pct <= thresholds.green) {
          newMode = 'base'; // Full budget
        } else if (pct <= thresholds.yellow) {
          newMode = 'spent'; // Cap at today's spend level
        } else if (pct <= thresholds.orange) {
          newMode = 'spent'; // Hard cap
        } else {
          newMode = 'stop'; // 1% budget (never pause — kills QS)
        }

        if (newMode !== campaign.budget_mode) {
          const newBudget = this.calculateBudget(campaign, newMode);

          // Push to Google FIRST, then commit locally — daily_budget_current
          // must never record a budget Google isn't actually running. On a
          // failed push we skip the local write entirely so the next 2-hour
          // run retries the same transition. Gate off / unlinked campaign /
          // missing API creds keep the legacy DB-only intent tracking — as
          // does a NULL daily_budget_base: calculateBudget falls back to $20
          // there, and an invented fallback must never become a real Google
          // budget. Once sync backfills (or the owner sets) the base, the
          // reconcile branch below converges Google onto the recorded mode.
          let pushedLive = false;
          if (isEnabled('adsBudgetLivePush') && campaign.platform_campaign_id && campaign.daily_budget_base != null && getGoogleAds().isConfigured()) {
            const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, newBudget);
            if (!pushed) {
              logger.error(`Budget: ${campaign.campaign_name} ${campaign.budget_mode}→${newMode} NOT applied — Google Ads push failed; will retry next run`);
              continue;
            }
            pushedLive = true;
          }

          await db('ad_campaigns').where({ id: campaign.id }).update({
            budget_mode: newMode,
            daily_budget_current: newBudget,
          });

          await db('ad_budget_log').insert({
            campaign_id: campaign.id,
            campaign_name: campaign.campaign_name,
            previous_mode: campaign.budget_mode,
            new_mode: newMode,
            previous_budget: campaign.daily_budget_current,
            new_budget: newBudget,
            reason: `Capacity ${pct.toFixed(0)}% for ${area} on ${checkDate}${pushedLive ? ' — pushed to Google Ads' : ''}`,
            trigger: 'auto',
            capacity_pct: pct,
            check_date: checkDate,
          });

          logger.info(`Budget: ${campaign.campaign_name} ${campaign.budget_mode}→${newMode} (capacity ${pct.toFixed(0)}%${pushedLive ? ', pushed to Google Ads' : ', local only'})`);
        } else if (isEnabled('adsBudgetLivePush') && campaign.platform_campaign_id && campaign.daily_budget_base != null && getGoogleAds().isConfigured()) {
          // No transition this run, but the recorded mode may never have
          // reached Google: modes shadow-written before the gate was enabled
          // (or committed by a manual setMode whose push failed) leave
          // budget_mode at e.g. 'stop' while Google runs the old budget — and
          // since the mode already matches, the transition branch above never
          // fires to correct it. The daily sync writes Google's live amount
          // back into daily_budget_current, so a mismatch between that and
          // the mode's calculated budget is exactly this drift. Push the
          // mode's budget to reconcile. 'spent' is freeze-at-current by
          // definition, so it can never trigger this.
          // Compare in integer cents: daily_budget_current is decimal(10,2),
          // so a sub-cent expected value (pre-rounding stop budgets) or float
          // representation would otherwise read as permanent drift and
          // re-push the same budget every run. NULL current (never synced,
          // never set) is skipped — the daily sync populates it within a day.
          const expectedBudget = this.calculateBudget(campaign, campaign.budget_mode);
          const currentCents = Math.round(parseFloat(campaign.daily_budget_current) * 100);
          if (Number.isFinite(currentCents) && currentCents !== Math.round(expectedBudget * 100)) {
            const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, expectedBudget);
            if (!pushed) {
              logger.error(`Budget: ${campaign.campaign_name} reconcile of ${campaign.budget_mode} budget NOT applied — Google Ads push failed; will retry next run`);
              continue;
            }

            await db('ad_campaigns').where({ id: campaign.id }).update({
              daily_budget_current: expectedBudget,
            });

            await db('ad_budget_log').insert({
              campaign_id: campaign.id,
              campaign_name: campaign.campaign_name,
              previous_mode: campaign.budget_mode,
              new_mode: campaign.budget_mode,
              previous_budget: campaign.daily_budget_current,
              new_budget: expectedBudget,
              reason: `Reconcile: local ${campaign.budget_mode} budget was not live on Google — pushed to Google Ads`,
              trigger: 'auto',
              capacity_pct: pct,
              check_date: checkDate,
            });

            logger.info(`Budget: ${campaign.campaign_name} reconciled ${campaign.budget_mode} budget to ${expectedBudget} (pushed to Google Ads)`);
          }
        }
      } catch (err) {
        logger.error(`Budget adjust failed for ${campaign.campaign_name}: ${err.message}`);
      }
    }
  }

  calculateBudget(campaign, mode) {
    // $20 is the fallback ONLY for a NULL/blank/non-numeric base (legacy DB-only
    // campaign not yet backfilled). A real stored 0 stays 0 — writes reject a
    // non-positive base, so a genuine 0 never reaches a live campaign, and the
    // old `|| 20` collapsing 0→$20 can't silently spend money.
    const parsed = parseFloat(campaign.daily_budget_base);
    const base = Number.isFinite(parsed) ? parsed : 20;
    switch (mode) {
      case 'base': return base;
      case 'spent': return parseFloat(campaign.daily_budget_current || base); // freeze at current
      // 1% of base — never zero (pausing kills Quality Score). Cent-rounded
      // because ad_campaigns budget columns are decimal(10,2): a half-cent
      // value (base 30.50 → 0.305) would store as 0.31 and read back as
      // drift against the unrounded calculation forever.
      case 'stop': return Math.max(0.01, Math.round(base) / 100);
      default: return base;
    }
  }

  /**
   * Get capacity for an area on a given date.
   * Returns { booked, slots, utilizationPct, techs }.
   */
  async getCapacityForArea(area, dateStr) {
    const targets = await db('ad_targets').first();
    const maxPerTech = parseInt(targets?.max_services_per_tech || 8);

    // Count booked services for the date
    let query = db('scheduled_services')
      .where({ scheduled_date: dateStr })
      .whereNotIn('status', ['cancelled']);

    // Filter by area if not "general"
    if (area && area !== 'general') {
      // Join with customers to filter by city/area
      query = db('scheduled_services')
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .where({ 'scheduled_services.scheduled_date': dateStr })
        .whereNotIn('scheduled_services.status', ['cancelled'])
        .where(function () {
          this.where('customers.city', 'ilike', `%${area}%`)
            .orWhere('customers.address_line1', 'ilike', `%${area}%`);
        });
    }

    const booked = await query.count('* as count').first();
    const bookedCount = parseInt(booked?.count || 0);

    // Count techs available (simplified — in production this would check tech schedules)
    const techCount = await this.getTechCountForArea(area, dateStr);
    const totalSlots = techCount * maxPerTech;

    // Saturday = half day (5 slots per tech), Sunday = limited (2 per tech)
    const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();
    let adjustedSlots = totalSlots;
    if (dayOfWeek === 6) adjustedSlots = techCount * 5;  // Saturday half-day
    if (dayOfWeek === 0) adjustedSlots = techCount * 2;  // Sunday minimal

    const utilizationPct = adjustedSlots > 0 ? (bookedCount / adjustedSlots) * 100 : 100;

    return {
      booked: bookedCount,
      slots: adjustedSlots,
      totalSlots,
      utilizationPct: Math.min(utilizationPct, 100),
      techs: techCount,
      date: dateStr,
      area,
    };
  }

  async getTechCountForArea(_area, _dateStr) {
    // Capacity is driven by the real active-technician count. There is no
    // per-area tech roster in the data (one field crew covers the whole service
    // area), so every area uses the same live count — the old hardcoded
    // {area: [names]} map invented 2–3 phantom techs per zone and overstated
    // capacity, holding budgets at full base while the real schedule was full.
    const techs = await db('technicians').where({ active: true });
    return techs.length;
  }

  /**
   * Get the full weekly capacity heatmap for all areas.
   */
  async getWeeklyHeatmap(startDate) {
    const start = startDate ? new Date(startDate + 'T12:00:00') : new Date();
    // Always start from Monday of the current week
    const dayOffset = start.getDay() === 0 ? -6 : 1 - start.getDay();
    const monday = new Date(start);
    monday.setDate(monday.getDate() + dayOffset);

    const areas = ['all', 'Lakewood Ranch', 'Parrish', 'Sarasota', 'Venice'];
    const targets = await db('ad_targets').first();
    const thresholds = {
      green: parseFloat(targets?.capacity_green_max || 70),
      yellow: parseFloat(targets?.capacity_yellow_max || 85),
      orange: parseFloat(targets?.capacity_orange_max || 95),
    };

    const heatmap = {};

    for (const area of areas) {
      heatmap[area] = { days: [], weeklyBooked: 0, weeklySlots: 0, techs: 0 };

      for (let d = 0; d < 7; d++) {
        const date = new Date(monday);
        date.setDate(date.getDate() + d);
        const dateStr = date.toISOString().split('T')[0];
        const queryArea = area === 'all' ? 'general' : area;
        const cap = await this.getCapacityForArea(queryArea, dateStr);

        // Determine budget mode from current campaigns for this area
        const campaignsForArea = await db('ad_campaigns')
          .where('status', 'active')
          .where(function () {
            if (area === 'all') return;
            this.where('target_area', area).orWhere('target_area', 'general');
          })
          .select('budget_mode');

        const primaryMode = campaignsForArea.length > 0
          ? this.dominantMode(campaignsForArea.map(c => c.budget_mode))
          : 'base';

        let colorZone;
        if (cap.utilizationPct <= thresholds.green) colorZone = 'green';
        else if (cap.utilizationPct <= thresholds.yellow) colorZone = 'yellow';
        else if (cap.utilizationPct <= thresholds.orange) colorZone = 'orange';
        else colorZone = 'red';

        heatmap[area].days.push({
          date: dateStr,
          dayName: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }),
          dayLabel: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
          booked: cap.booked,
          slots: cap.slots,
          utilizationPct: Math.round(cap.utilizationPct),
          colorZone,
          budgetMode: primaryMode,
          isSunday: date.getDay() === 0,
        });

        heatmap[area].weeklyBooked += cap.booked;
        heatmap[area].weeklySlots += cap.slots;
      }

      heatmap[area].techs = area === 'all'
        ? (await db('technicians').where({ active: true })).length
        : await this.getTechCountForArea(area);

      heatmap[area].weeklyUtilization = heatmap[area].weeklySlots > 0
        ? Math.round((heatmap[area].weeklyBooked / heatmap[area].weeklySlots) * 100)
        : 0;
    }

    return { heatmap, thresholds };
  }

  dominantMode(modes) {
    if (modes.includes('stop')) return 'stop';
    if (modes.includes('spent')) return 'spent';
    return 'base';
  }

  /**
   * Manually set a campaign's budget mode (from advisor "Apply" button).
   */
  async setMode(campaignId, mode, reason = 'manual') {
    reason = boundReason(reason);
    // Now that setMode can mutate real Google Ads spend, an unknown mode
    // must be rejected up front — calculateBudget's default case would
    // silently price a typo as the full base budget AND persist the invalid
    // mode, which the capacity cron could then never match or reconcile.
    if (!['base', 'spent', 'stop'].includes(mode)) {
      throw new Error(`Invalid budget mode "${mode}" — must be base, spent, or stop`);
    }

    const campaign = await db('ad_campaigns').where({ id: campaignId }).first();
    if (!campaign) throw new Error('Campaign not found');
    // Source-level guard so EVERY caller (incl. /advisor/apply) is covered: only
    // Google campaigns are remotely controllable here — never mutate a read-only
    // Meta row's local budget/mode (it would drift from Ads Manager).
    if (campaign.platform !== 'google_ads') {
      throw new Error(`Budget control is not supported for ${campaign.platform} campaigns (managed in Ads Manager)`);
    }

    const newBudget = this.calculateBudget(campaign, mode);

    await db('ad_campaigns').where({ id: campaignId }).update({
      budget_mode: mode,
      daily_budget_current: newBudget,
    });

    await db('ad_budget_log').insert({
      campaign_id: campaignId,
      campaign_name: campaign.campaign_name,
      previous_mode: campaign.budget_mode,
      new_mode: mode,
      previous_budget: campaign.daily_budget_current,
      new_budget: newBudget,
      reason,
      trigger: 'manual',
    });

    // Mirror the manual /campaigns/:id/budget route: DB first, then
    // best-effort live push, outcome reported so the caller can tell whether
    // Google actually took the new budget. Human-initiated, so not gated by
    // adsBudgetLivePush — that gate covers only the autonomous cron. NULL
    // daily_budget_base skips the push like the cron does: calculateBudget's
    // $20 fallback must never reach a real campaign.
    let googleAdsUpdated = false;
    if (campaign.platform_campaign_id && campaign.daily_budget_base != null && getGoogleAds().isConfigured()) {
      const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, newBudget);
      googleAdsUpdated = !!pushed;
    }

    return { campaign: campaign.campaign_name, previousMode: campaign.budget_mode, newMode: mode, newBudget, googleAdsUpdated };
  }

  /**
   * Manually update a campaign's base daily budget.
   */
  async setBudget(campaignId, newBaseBudget, reason = 'manual') {
    reason = boundReason(reason);
    // Validate the amount up front — a non-positive / NaN / non-finite base would
    // be written locally and pushed to Google as garbage micros (or, at 0,
    // collapse to the $20 fallback), and the 2-hourly reconcile would keep
    // re-pushing it. A daily budget must be strictly positive; use mode 'stop'
    // to throttle. parseFloat is deliberately avoided so '50junk' is rejected.
    let base = typeof newBaseBudget === 'number'
      ? newBaseBudget
      : (typeof newBaseBudget === 'string' && newBaseBudget.trim() !== '' ? Number(newBaseBudget) : NaN);
    if (!Number.isFinite(base) || base <= 0) {
      throw new Error(`Invalid budget "${newBaseBudget}" — must be a number > 0`);
    }
    // Cap at the storable maximum BEFORE the Google push, so an over-large value
    // can't change the live campaign and then fail the decimal(10,2) DB write.
    if (base > MAX_DAILY_BUDGET) {
      throw new Error(`Budget ${base} exceeds the maximum of ${MAX_DAILY_BUDGET}`);
    }
    // Round to cents so Google receives EXACTLY what the decimal(10,2) columns
    // store — a value like 50.001 would otherwise push exact micros to Google
    // while the DB rounds to 50.00, re-creating the live/local drift this path
    // is meant to prevent.
    base = Math.round(base * 100) / 100;
    // Re-check after rounding: a sub-cent input like 0.004 passes the > 0 check
    // above but rounds to 0, which would push an invalid $0 to Google / persist a
    // 0 base. The minimum daily budget is one cent.
    if (base <= 0) {
      throw new Error(`Invalid budget "${newBaseBudget}" — rounds to $0; the minimum is $0.01`);
    }

    const campaign = await db('ad_campaigns').where({ id: campaignId }).first();
    if (!campaign) throw new Error('Campaign not found');
    if (campaign.platform !== 'google_ads') {
      throw new Error(`Budget control is not supported for ${campaign.platform} campaigns (managed in Ads Manager)`);
    }

    // What Google should actually run given the campaign's CURRENT mode: editing
    // the base while a campaign is throttled ('stop') or frozen ('spent') must
    // NOT blast the raw new base live — push the mode-derived amount, exactly
    // like setMode and the capacity cron. In 'base' mode this is the new base
    // itself; 'spent' stays frozen at daily_budget_current; 'stop' recomputes 1%.
    const effectiveBudget = this.calculateBudget({ ...campaign, daily_budget_base: base }, campaign.budget_mode);

    // Push FIRST so daily_budget_current only ever records a budget Google is
    // actually running: if Google rejects the change (shared budget, API error)
    // we keep the prior current, so a requested decrease can't leave local state
    // claiming the lower budget is live while Google keeps overspending. An
    // unlinked/unconfigured campaign has no live counterpart, so its current
    // advances to the intended amount (DB-only intent tracking).
    let googleAdsUpdated = false;
    let pushAttempted = false;
    if (campaign.platform_campaign_id && getGoogleAds().isConfigured()) {
      pushAttempted = true;
      const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, effectiveBudget);
      googleAdsUpdated = !!pushed;
    }
    const newCurrent = (pushAttempted && !googleAdsUpdated)
      ? campaign.daily_budget_current   // push failed → Google still runs the old amount
      : effectiveBudget;

    // If the live push already changed Google but we then fail to record it
    // locally (a transient DB error — the deterministic cases, over-max budget
    // and over-long reason, are rejected up front), roll Google back to the
    // amount it was running before so live spend and local state don't drift,
    // then surface the failure. No false success, and the reconcile cron isn't
    // left chasing a phantom. (calculateBudget's fallbacks mean a null prior
    // current can't be safely restored — log for manual follow-up instead.)
    // Atomic: the campaign write and the audit insert must land together, or the
    // catch below would roll Google back while the campaign row keeps the new
    // base — in base mode the reconcile check then sees current === base and
    // never restores Google, leaving the old higher spend running.
    try {
      await db.transaction(async (trx) => {
        await trx('ad_campaigns').where({ id: campaignId }).update({
          daily_budget_base: base,
          daily_budget_current: newCurrent,
        });

        await trx('ad_budget_log').insert({
          campaign_id: campaignId,
          campaign_name: campaign.campaign_name,
          previous_mode: campaign.budget_mode,
          new_mode: campaign.budget_mode,
          previous_budget: campaign.daily_budget_base,
          new_budget: base,
          reason,
          trigger: 'manual',
        });
      });
    } catch (persistErr) {
      if (googleAdsUpdated && campaign.platform_campaign_id) {
        const prevLive = parseFloat(campaign.daily_budget_current);
        if (Number.isFinite(prevLive)) {
          // updateBudget RETURNS null on an API error (it doesn't throw), so a
          // failed rollback must be detected on the return value, not just via a
          // catch — otherwise it fails silently and Google keeps running the new
          // budget while local state shows the old one.
          let rolled = null;
          try {
            rolled = await getGoogleAds().updateBudget(campaign.platform_campaign_id, prevLive);
          } catch (rollbackErr) {
            logger.error(`setBudget: rollback push threw for ${campaign.campaign_name} after a persist error — Google may run ${effectiveBudget} while local shows the old base: ${rollbackErr.message}`);
          }
          if (!rolled) {
            logger.error(`setBudget: rollback push did NOT take for ${campaign.campaign_name} after a persist error — Google may still run ${effectiveBudget} while local shows the old base; manual reconciliation may be needed`);
          }
        } else {
          logger.error(`setBudget: persist failed for ${campaign.campaign_name} after pushing ${effectiveBudget} live, and prior live budget is unknown — manual reconciliation may be needed`);
        }
      }
      throw persistErr;
    }

    return {
      campaign: campaign.campaign_name,
      previousBudget: campaign.daily_budget_base,
      newBudget: base,
      effectiveBudget,
      googleAdsUpdated,
    };
  }
}

module.exports = new BudgetManager();
module.exports.MAX_DAILY_BUDGET = MAX_DAILY_BUDGET;
