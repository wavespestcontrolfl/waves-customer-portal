const { randomUUID } = require('crypto');
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

    for (const listed of campaigns) {
      // Set once Google accepts a TRANSITION push inside the transaction —
      // if the local writes (or COMMIT) then fail, PostgreSQL rolls the row
      // back while Google keeps the new amount, so the catch compensates via
      // the same lock-reacquiring rollback the advisor apply uses. The
      // reconcile branch never sets it: its push moves Google TOWARD the
      // recorded local state, so a failed write self-heals next run and a
      // rollback would undo a correct fix.
      let cronPushed = null;
      const opStartedAt = new Date();
      const opId = randomUUID();
      try {
        const area = listed.target_area || 'general';
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

        // The guard→push→persist below runs against a FOR UPDATE re-read of
        // the row, inside one transaction — the same lock the advisor apply
        // holds. Without it, this cron could push a stale mode's budget from
        // its unlocked list read, block on the advisor's lock, then commit
        // its stale amount OVER the advisor's newer one (DB saying stopped
        // while Google runs the advisor budget until the next reconcile).
         
        await db.transaction(async (trx) => {
          const campaign = await trx('ad_campaigns').where({ id: listed.id }).forUpdate().first();
          if (!campaign || campaign.status !== 'active') return;

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
              return;
            }
            pushedLive = true;
            cronPushed = { campaign, attempted: newBudget, startedAt: opStartedAt, opId };
          }

          await trx('ad_campaigns').where({ id: campaign.id }).update({
            budget_mode: newMode,
            daily_budget_current: newBudget,
            updated_at: trx.fn.now(),
          });

          await trx('ad_budget_log').insert({
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
            op_id: opId,
            google_ads_updated: pushedLive,
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
              return;
            }

            await trx('ad_campaigns').where({ id: campaign.id }).update({
              daily_budget_current: expectedBudget,
              updated_at: trx.fn.now(),
            });

            await trx('ad_budget_log').insert({
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
              op_id: opId,
              google_ads_updated: true,
            });

            logger.info(`Budget: ${campaign.campaign_name} reconciled ${campaign.budget_mode} budget to ${expectedBudget} (pushed to Google Ads)`);
          }
        }
        });
      } catch (err) {
        if (cronPushed) {
          const rollback = await this.rollbackAfterLivePush(cronPushed.campaign, err, cronPushed.attempted, cronPushed.startedAt, cronPushed.opId);
          if (rollback.code === 'apply_committed') {
            logger.info(`Budget adjust: ${listed.campaign_name} COMMIT ack was lost but the change is durable — no compensation needed`);
          } else {
            logger.error(`Budget adjust: ${listed.campaign_name} persist failed after live push — ${rollback.message}`);
          }
        } else {
          logger.error(`Budget adjust failed for ${listed.campaign_name}: ${err.message}`);
        }
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
   *
   * opts.requireLivePush: for callers that must never record an intent the
   * live campaign didn't take (the advisor apply). Runs the WHOLE change —
   * the row re-read, every guard, the Google push, and both local writes —
   * inside ONE transaction holding a FOR UPDATE lock on the campaign row, so
   * a concurrent mode/status transition (capacity cron, another admin) can't
   * slip between the guard and the mutation. A refused push throws
   * 'live_push_failed', an unrunnable one 'live_push_unavailable', both
   * BEFORE any local write; a persist failure after a successful push rolls
   * the transaction back (campaign write AND audit row together) and pushes
   * the prior live budget back ('live_push_rolled_back' /
   * 'live_push_ambiguous'). Unlinked campaigns keep DB-only intent.
   * opts.requireActive: reject ('campaign_inactive') unless status='active',
   * re-checked under the same lock.
   * opts.trigger: ad_budget_log.trigger attribution (default 'manual';
   * the advisor route passes 'advisor').
   */
  async setMode(campaignId, mode, reason = 'manual', { requireLivePush = false, requireActive = false, trigger = 'manual' } = {}) {
    reason = boundReason(reason);
    // Anchor for the rollback's newer-writer audit check, and this
    // operation's identity stamp on its own audit row (lets the rollback
    // recognize a lost-COMMIT-ack as "actually committed").
    const opStartedAt = new Date();
    const opId = randomUUID();
    // Now that setMode can mutate real Google Ads spend, an unknown mode
    // must be rejected up front — calculateBudget's default case would
    // silently price a typo as the full base budget AND persist the invalid
    // mode, which the capacity cron could then never match or reconcile.
    if (!['base', 'spent', 'stop'].includes(mode)) {
      throw new Error(`Invalid budget mode "${mode}" — must be base, spent, or stop`);
    }

    if (requireLivePush) {
      // Holding the row lock across the Google call is a deliberate tradeoff:
      // it serializes this row against the 2-hourly cron and other admin
      // writes for the duration of one API call, which is what makes the
      // guard→push→persist sequence actually atomic. Scale here is one admin
      // and a slow cron — contention is not a concern.
      let pushedCampaign = null;
      try {
        return await db.transaction(async (trx) => {
          const campaign = await trx('ad_campaigns').where({ id: campaignId }).forUpdate().first();
          if (!campaign) throw new Error('Campaign not found');
          if (campaign.platform !== 'google_ads') {
            throw new Error(`Budget control is not supported for ${campaign.platform} campaigns (managed in Ads Manager)`);
          }
          if (requireActive && campaign.status !== 'active') {
            const err = new Error(`"${campaign.campaign_name}" is ${campaign.status || 'not active'} — advisor changes only apply to active campaigns.`);
            err.code = 'campaign_inactive';
            throw err;
          }
          // Under the lock: two concurrent applies of the same rec both pass
          // the route's unlocked no-op check; the loser must not re-push the
          // already-current mode and count a second "applied" change.
          if (mode === campaign.budget_mode) {
            const err = new Error(`"${campaign.campaign_name}" is already in ${mode} mode — nothing to apply.`);
            err.code = 'mode_noop';
            throw err;
          }

          const newBudget = this.calculateBudget(campaign, mode);
          const linked = Boolean(campaign.platform_campaign_id);
          let googleAdsUpdated = false;
          if (linked) {
            const canPush = campaign.daily_budget_base != null && getGoogleAds().isConfigured();
            if (!canPush) {
              const err = new Error(`"${campaign.campaign_name}" is linked to a live Google Ads campaign, but the live push can't run (Google Ads API not configured, or no base budget set) — nothing was changed.`);
              err.code = 'live_push_unavailable';
              throw err;
            }
            const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, newBudget);
            googleAdsUpdated = !!pushed;
            if (!googleAdsUpdated) {
              const err = new Error(`Google Ads refused the budget update for "${campaign.campaign_name}" — nothing was changed. Check the campaign in Google Ads (shared budgets can't be updated from here).`);
              err.code = 'live_push_failed';
              throw err;
            }
            pushedCampaign = {
              campaign,
              attempted: newBudget,
              startedAt: opStartedAt,
              opId,
              // Returned as-is if the rollback discovers the COMMIT actually
              // landed (lost acknowledgement) — the apply succeeded.
              successResult: { campaign: campaign.campaign_name, previousMode: campaign.budget_mode, newMode: mode, newBudget, googleAdsUpdated: true, livePushAttempted: true },
            };
          }

          await trx('ad_campaigns').where({ id: campaignId }).update({
            budget_mode: mode,
            daily_budget_current: newBudget,
            updated_at: trx.fn.now(),
          });
          await trx('ad_budget_log').insert({
            campaign_id: campaignId,
            campaign_name: campaign.campaign_name,
            previous_mode: campaign.budget_mode,
            new_mode: mode,
            previous_budget: campaign.daily_budget_current,
            new_budget: newBudget,
            reason,
            trigger,
            op_id: opId,
            google_ads_updated: googleAdsUpdated,
          });

          return { campaign: campaign.campaign_name, previousMode: campaign.budget_mode, newMode: mode, newBudget, googleAdsUpdated, livePushAttempted: linked };
        });
      } catch (err) {
        // Every guard throws BEFORE pushedCampaign is set, so any rejection
        // after it — the persist statements OR the transaction's own COMMIT —
        // is a local failure after Google accepted the change, and it gets
        // the compensating rollback instead of reading as an ordinary error.
        if (pushedCampaign) {
          const recovery = await this.rollbackAfterLivePush(pushedCampaign.campaign, err, pushedCampaign.attempted, pushedCampaign.startedAt, pushedCampaign.opId);
          if (recovery.code === 'apply_committed') return pushedCampaign.successResult;
          throw recovery;
        }
        throw err;
      }
    }

    // Legacy (manual route) path: DB-first with a best-effort push, but now
    // inside the SAME row-locked transaction the advisor apply and the cron
    // hold — a direct edit overlapping an advisor apply serializes instead of
    // committing its Google call and DB write in opposite orders. Semantics
    // are otherwise unchanged: the write commits even when the push fails
    // (googleAdsUpdated reports the outcome; the gate-on reconcile converges
    // Google later), so a thrown push is swallowed into googleAdsUpdated:false.
    // Because the push now runs BEFORE the COMMIT, a commit failure after an
    // accepted push gets the same compensating rollback the advisor path uses
    // (previously the write was already committed, so there was no divergence).
    let manualPushed = null;
    try {
    return await db.transaction(async (trx) => {
      const campaign = await trx('ad_campaigns').where({ id: campaignId }).forUpdate().first();
      if (!campaign) throw new Error('Campaign not found');
      // Source-level guard so EVERY caller is covered: only Google campaigns
      // are remotely controllable here — never mutate a read-only Meta row's
      // local budget/mode (it would drift from Ads Manager).
      if (campaign.platform !== 'google_ads') {
        throw new Error(`Budget control is not supported for ${campaign.platform} campaigns (managed in Ads Manager)`);
      }

      const newBudget = this.calculateBudget(campaign, mode);

      await trx('ad_campaigns').where({ id: campaignId }).update({
        budget_mode: mode,
        daily_budget_current: newBudget,
        updated_at: trx.fn.now(),
      });

      // Human-initiated, so not gated by adsBudgetLivePush — that gate covers
      // only the autonomous cron. NULL daily_budget_base skips the push like
      // the cron does: calculateBudget's $20 fallback must never reach a real
      // campaign. The push runs BEFORE the audit insert so the row records
      // whether Google actually changed (google_ads_updated is what the
      // rollback's supersession proof keys on).
      let googleAdsUpdated = false;
      let livePushAttempted = false;
      if (campaign.platform_campaign_id && campaign.daily_budget_base != null && getGoogleAds().isConfigured()) {
        livePushAttempted = true;
        try {
          const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, newBudget);
          googleAdsUpdated = !!pushed;
        } catch { googleAdsUpdated = false; }
        if (googleAdsUpdated) {
          manualPushed = {
            campaign,
            attempted: newBudget,
            startedAt: opStartedAt,
            opId,
            successResult: { campaign: campaign.campaign_name, previousMode: campaign.budget_mode, newMode: mode, newBudget, googleAdsUpdated: true, livePushAttempted: true },
          };
        }
      }

      await trx('ad_budget_log').insert({
        campaign_id: campaignId,
        campaign_name: campaign.campaign_name,
        previous_mode: campaign.budget_mode,
        new_mode: mode,
        previous_budget: campaign.daily_budget_current,
        new_budget: newBudget,
        reason,
        trigger,
        op_id: opId,
        google_ads_updated: googleAdsUpdated,
      });

      return { campaign: campaign.campaign_name, previousMode: campaign.budget_mode, newMode: mode, newBudget, googleAdsUpdated, livePushAttempted };
    });
    } catch (err) {
      if (manualPushed) {
        const recovery = await this.rollbackAfterLivePush(manualPushed.campaign, err, manualPushed.attempted, manualPushed.startedAt, manualPushed.opId);
        if (recovery.code === 'apply_committed') return manualPushed.successResult;
        throw recovery;
      }
      throw err;
    }
  }

  /**
   * A requireLivePush caller's DB write failed AFTER Google accepted the
   * push. Try a compensating push restoring the prior live budget so "not
   * applied" stays true; report honestly either way. The local rows still
   * hold the OLD state, so the budget reconcile converges Google back to it
   * even in the ambiguous case.
   */
  async rollbackAfterLivePush(campaign, persistErr, attemptedLiveBudget = null, opStartedAt = null, opId = null) {
    const previousLive = Number(campaign.daily_budget_current);
    // 'restored' — we pushed the prior live budget back; nothing changed.
    // 'superseded' — a writer queued behind our failed apply committed (and
    //   pushed) a NEWER state after our rollback released the lock; restoring
    //   the old amount would clobber it on Google while the DB records the
    //   newer change, so we leave the newer state alone. Our apply still
    //   persisted nothing.
    // 'ambiguous' — we couldn't safely determine/restore.
    let outcome = 'ambiguous';
    try {
      const canRestore = Number.isFinite(previousLive) && previousLive > 0;
      if (opId || canRestore) {
        await db.transaction(async (trx) => {
          // Reacquire the row lock and verify the row still matches our
          // pre-apply snapshot before touching Google.
          const row = await trx('ad_campaigns').where({ id: campaign.id }).forUpdate().first();
          const centsEq = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
          const sameMode = row && String(row.budget_mode ?? '') === String(campaign.budget_mode ?? '');
          // Lost-COMMIT-acknowledgement check: if OUR OWN audit row (op_id)
          // exists, the transaction actually committed and every local write
          // is durable — the apply SUCCEEDED and needs no compensation. The
          // caller converts 'apply_committed' back into its success result.
          // Runs regardless of canRestore: a durable commit is a durable
          // commit even when there's no prior amount to restore.
          if (opId) {
            const ownRow = await trx('ad_budget_log').where({ op_id: opId }).first();
            if (ownRow) {
              outcome = 'committed';
              return;
            }
          }
          if (!canRestore) return; // nothing safe to compare/restore against → ambiguous
          // Authoritative supersession signal: every REAL writer (advisor,
          // cron, manual routes) inserts an ad_budget_log row inside its own
          // transaction; the Google sync never does. Supersession additionally
          // requires PROOF the newer writer changed Google
          // (google_ads_updated) — a best-effort manual write that only
          // recorded local intent must not suppress the compensation that
          // restores the live budget.
          let newerWriter = false;
          if (opStartedAt) {
            const newerAudit = await trx('ad_budget_log')
              .where({ campaign_id: campaign.id })
              .where('created_at', '>=', opStartedAt)
              .where({ google_ads_updated: true })
              .where(function notOwnOp() {
                this.whereNull('op_id');
                if (opId) this.orWhereNot({ op_id: opId });
              })
              .first();
            newerWriter = Boolean(newerAudit);
          }
          const snapshotBaseNull = campaign.daily_budget_base == null;
          // Sync-mirror signature: mode untouched, current == exactly what we
          // pushed, and the base either unchanged (sync never writes base for
          // rows that have one) or — for a null-base snapshot — mirrored to
          // the same pushed amount (google-ads sync writes base only when the
          // stored base was null).
          const mirrored = sameMode && attemptedLiveBudget != null
            && centsEq(row?.daily_budget_current, attemptedLiveBudget)
            && (snapshotBaseNull
              ? centsEq(row?.daily_budget_base, attemptedLiveBudget)
              : centsEq(row?.daily_budget_base, campaign.daily_budget_base));
          if (newerWriter) {
            outcome = 'superseded';
          } else if (sameMode && centsEq(row.daily_budget_current, previousLive)) {
            const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, previousLive);
            if (pushed) {
              // Touch the row inside the lock: a daily sync that FETCHED
              // Google before this restore but is queued on the lock would
              // otherwise land its stale (pre-restore) observation — the
              // sync skips rows whose updated_at moved after its fetch began.
              await trx('ad_campaigns').where({ id: campaign.id }).update({ updated_at: trx.fn.now() });
              outcome = 'restored';
            }
          } else if (mirrored) {
            // Restore Google AND the mirrored columns, or the failed budget
            // stays live with local state agreeing with it (a mirrored
            // null-base snapshot also gets its base cleared back to null so
            // the failed amount never becomes the canonical base).
            const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, previousLive);
            if (pushed) {
              await trx('ad_campaigns').where({ id: campaign.id }).update({
                daily_budget_current: previousLive,
                updated_at: trx.fn.now(),
                ...(snapshotBaseNull ? { daily_budget_base: null } : {}),
              });
              outcome = 'restored';
            }
          } else {
            outcome = 'superseded';
          }
        });
      }
    } catch { outcome = 'ambiguous'; }
    if (outcome === 'committed') {
      // Not a failure at all — the COMMIT landed but its acknowledgement was
      // lost. Callers return their success result.
      logger.warn(`[budget-manager] COMMIT ack lost for ${campaign.id} (${persistErr.message}) but the change is durable — treating as applied`);
      const committedErr = new Error('The change committed (acknowledgement was lost in transit).');
      committedErr.code = 'apply_committed';
      return committedErr;
    }
    logger.error(`[budget-manager] persist failed after live push for ${campaign.id} (${persistErr.message}); live rollback: ${outcome}`);
    // The reconcile promise is only true while the adsBudgetLivePush gate is
    // ON — with it off, no cron run converges Google back, and the daily sync
    // would mirror the unintended live amount instead. Say so, loudly.
    const reconcileActive = isEnabled('adsBudgetLivePush');
    const messages = {
      restored: 'Recording the change failed after Google accepted it — the live budget was rolled back and nothing was changed. Try again.',
      superseded: 'This apply failed to record and was not applied — a newer budget change committed in the meantime and owns the live budget; nothing from this apply persisted.',
      ambiguous: `Google accepted the change but recording it locally failed, and the rollback push could not safely run — the live campaign may be running the new amount. Local records still hold the previous state. ${reconcileActive
        ? 'This corrects after the next daily Google Ads sync exposes the drift (up to ~24h) — the 2-hourly reconcile cannot see it until then, so check the campaign in Google Ads now if it matters today.'
        : 'Automatic budget reconciliation is currently OFF (GATE_ADS_BUDGET_LIVE_PUSH), so this will NOT self-heal — fix the budget in Google Ads or the campaign editor now.'}`,
    };
    const err = new Error(messages[outcome]);
    err.code = outcome === 'ambiguous' ? 'live_push_ambiguous' : 'live_push_rolled_back';
    return err;
  }

  /**
   * Manually update a campaign's base daily budget.
   *
   * opts.requireLivePush: same contract as setMode — on a LINKED campaign a
   * refused or unrunnable push throws ('live_push_failed' /
   * 'live_push_unavailable') BEFORE the new base is persisted, so a failed
   * apply leaves no local intent for the reconcile cron to re-push later;
   * a post-push persist failure rolls the live budget back (or reports
   * 'live_push_ambiguous').
   * opts.requireBaseMode: reject ('mode_conflict') unless the row — re-read
   * under the transaction's FOR UPDATE lock — is still in base mode, so a
   * concurrent mode change can't slip between the guard and the push.
   * opts.requireActive: reject ('campaign_inactive') unless status='active',
   * checked under the same lock.
   * opts.requireBoundFactor: reject ('budget_out_of_bounds' /
   * 'budget_unbounded' / 'budget_noop') unless the amount is within this
   * factor of the LOCKED row's base (falling back to current) and actually
   * changes something — the caller's unlocked pre-checks can be raced by a
   * concurrent base edit or a duplicate apply.
   * opts.trigger: ad_budget_log.trigger attribution (default 'manual').
   */
  async setBudget(campaignId, newBaseBudget, reason = 'manual', { requireLivePush = false, requireBaseMode = false, requireActive = false, requireBoundFactor = null, trigger = 'manual' } = {}) {
    reason = boundReason(reason);
    const opStartedAt = new Date();
    const opId = randomUUID();
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

    if (requireLivePush) {
      // Same locked-transaction shape as setMode: the FOR UPDATE re-read
      // makes the base-mode and active-status guards atomic with the push
      // and persist (a concurrent cron/admin transition can't slip between
      // them), and transaction atomicity keeps the campaign write and audit
      // row together — a failed insert rolls both back before the
      // compensating Google rollback runs.
      let pushedCampaign = null;
      try {
        return await db.transaction(async (trx) => {
          const campaign = await trx('ad_campaigns').where({ id: campaignId }).forUpdate().first();
          if (!campaign) throw new Error('Campaign not found');
          if (campaign.platform !== 'google_ads') {
            throw new Error(`Budget control is not supported for ${campaign.platform} campaigns (managed in Ads Manager)`);
          }
          if (requireActive && campaign.status !== 'active') {
            const err = new Error(`"${campaign.campaign_name}" is ${campaign.status || 'not active'} — advisor changes only apply to active campaigns.`);
            err.code = 'campaign_inactive';
            throw err;
          }
          // Under the lock, so a mode transition can no longer race this
          // check: a throttled campaign must not take a raw-target push the
          // caller would report as the live daily budget.
          if (requireBaseMode && campaign.budget_mode && campaign.budget_mode !== 'base') {
            const err = new Error(`"${campaign.campaign_name}" switched to "${campaign.budget_mode}" mode — the new daily budget wouldn't take effect, so nothing was changed.`);
            err.code = 'mode_conflict';
            throw err;
          }
          // Bound + no-op re-checked against the LOCKED row: the caller's
          // pre-checks read an unlocked snapshot, so a concurrent base edit
          // could turn an in-bounds amount into a wild jump, and a duplicate
          // apply from a second tab could re-push an already-current budget.
          if (requireBoundFactor) {
            const lockedBase = Number(campaign.daily_budget_base);
            const boundRef = Number.isFinite(lockedBase) && lockedBase > 0 ? lockedBase : Number(campaign.daily_budget_current);
            if (!(boundRef > 0)) {
              const err = new Error(`"${campaign.campaign_name}" has no recorded daily budget to sanity-check the amount against — set the budget manually in the campaign editor.`);
              err.code = 'budget_unbounded';
              throw err;
            }
            if (base > boundRef * requireBoundFactor || base < boundRef / requireBoundFactor) {
              const err = new Error(`Refusing a budget change from $${boundRef}/day to $${base}/day (more than a ${requireBoundFactor}× move) — if that's really intended, set it in the campaign's budget editor.`);
              err.code = 'budget_out_of_bounds';
              throw err;
            }
            if (base === lockedBase && base === Number(campaign.daily_budget_current)) {
              const err = new Error(`"${campaign.campaign_name}" is already at $${base}/day — nothing to apply.`);
              err.code = 'budget_noop';
              throw err;
            }
          }

          const effectiveBudget = this.calculateBudget({ ...campaign, daily_budget_base: base }, campaign.budget_mode);
          const linked = Boolean(campaign.platform_campaign_id);
          let googleAdsUpdated = false;
          if (linked) {
            if (!getGoogleAds().isConfigured()) {
              const err = new Error(`"${campaign.campaign_name}" is linked to a live Google Ads campaign, but the live push can't run (Google Ads API not configured) — nothing was changed.`);
              err.code = 'live_push_unavailable';
              throw err;
            }
            const pushed = await getGoogleAds().updateBudget(campaign.platform_campaign_id, effectiveBudget);
            googleAdsUpdated = !!pushed;
            if (!googleAdsUpdated) {
              const err = new Error(`Google Ads refused the budget update for "${campaign.campaign_name}" — nothing was changed. Check the campaign in Google Ads (shared budgets can't be updated from here).`);
              err.code = 'live_push_failed';
              throw err;
            }
            pushedCampaign = {
              campaign,
              attempted: effectiveBudget,
              startedAt: opStartedAt,
              opId,
              successResult: { campaign: campaign.campaign_name, previousBudget: campaign.daily_budget_base, newBudget: base, effectiveBudget, googleAdsUpdated: true, livePushAttempted: true },
            };
          }

          await trx('ad_campaigns').where({ id: campaignId }).update({
            daily_budget_base: base,
            daily_budget_current: effectiveBudget,
            updated_at: trx.fn.now(),
          });
          await trx('ad_budget_log').insert({
            campaign_id: campaignId,
            campaign_name: campaign.campaign_name,
            previous_mode: campaign.budget_mode,
            new_mode: campaign.budget_mode,
            previous_budget: campaign.daily_budget_base,
            new_budget: base,
            reason,
            trigger,
            op_id: opId,
            google_ads_updated: googleAdsUpdated,
          });

          return {
            campaign: campaign.campaign_name,
            previousBudget: campaign.daily_budget_base,
            newBudget: base,
            effectiveBudget,
            googleAdsUpdated,
            livePushAttempted: linked,
          };
        });
      } catch (err) {
        // Guards all throw before pushedCampaign is set — any later rejection
        // (persist statements or the COMMIT itself) is a post-push local
        // failure and takes the compensating rollback.
        if (pushedCampaign) {
          const recovery = await this.rollbackAfterLivePush(pushedCampaign.campaign, err, pushedCampaign.attempted, pushedCampaign.startedAt, pushedCampaign.opId);
          if (recovery.code === 'apply_committed') return pushedCampaign.successResult;
          throw recovery;
        }
        throw err;
      }
    }

    // Legacy (manual route) path: push-first as before, but inside the SAME
    // row-locked transaction as the advisor apply and the cron so overlapping
    // writers serialize instead of interleaving their Google calls and DB
    // writes in opposite orders. Semantics unchanged: a refused push still
    // records the new base with the prior current. Because the push precedes
    // the COMMIT, a post-push local failure gets the same compensating
    // rollback the other writers use.
    let manualPushed = null;
    try {
    return await db.transaction(async (trx) => {
      const campaign = await trx('ad_campaigns').where({ id: campaignId }).forUpdate().first();
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
        if (googleAdsUpdated) {
          manualPushed = {
            campaign,
            attempted: effectiveBudget,
            startedAt: opStartedAt,
            opId,
            successResult: { campaign: campaign.campaign_name, previousBudget: campaign.daily_budget_base, newBudget: base, effectiveBudget, googleAdsUpdated: true, livePushAttempted: true },
          };
        }
      }
      const newCurrent = (pushAttempted && !googleAdsUpdated)
        ? campaign.daily_budget_current   // push failed → Google still runs the old amount
        : effectiveBudget;

      await trx('ad_campaigns').where({ id: campaignId }).update({
        daily_budget_base: base,
        daily_budget_current: newCurrent,
        updated_at: trx.fn.now(),
      });

      await trx('ad_budget_log').insert({
        campaign_id: campaignId,
        campaign_name: campaign.campaign_name,
        previous_mode: campaign.budget_mode,
        new_mode: campaign.budget_mode,
        previous_budget: campaign.daily_budget_base,
        new_budget: base,
        reason,
        trigger,
        op_id: opId,
        google_ads_updated: googleAdsUpdated,
      });

      return {
        campaign: campaign.campaign_name,
        previousBudget: campaign.daily_budget_base,
        newBudget: base,
        effectiveBudget,
        googleAdsUpdated,
        livePushAttempted: pushAttempted,
      };
    });
    } catch (err) {
      if (manualPushed) {
        const recovery = await this.rollbackAfterLivePush(manualPushed.campaign, err, manualPushed.attempted, manualPushed.startedAt, manualPushed.opId);
        if (recovery.code === 'apply_committed') return manualPushed.successResult;
        throw recovery;
      }
      throw err;
    }
  }
}

module.exports = new BudgetManager();
module.exports.MAX_DAILY_BUDGET = MAX_DAILY_BUDGET;
