const db = require('../../models/db');
const logger = require('../logger');

class BudgetManager {
  /**
   * Core budget adjustment — runs every 2 hours via cron.
   *
   * Sunday algorithm: always check Monday's capacity, full power.
   * Weekday <2PM: check today.  Weekday >=2PM: check tomorrow.
   */
  async adjustBudgets() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const hour = now.getHours();

    let checkDate;

    if (dayOfWeek === 0) {
      // SUNDAY: Always check Monday's capacity. No time-of-day logic.
      // People plan their week ahead on Sunday — run ads at full power
      // if Monday has availability.
      const monday = new Date(now);
      monday.setDate(monday.getDate() + 1);
      checkDate = monday.toISOString().split('T')[0];
    } else if (hour < 14) {
      // Weekday morning: check today's capacity
      checkDate = now.toISOString().split('T')[0];
    } else {
      // Weekday afternoon: check tomorrow's capacity
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      checkDate = tomorrow.toISOString().split('T')[0];
    }

    logger.info(`Budget adjust: checking capacity for ${checkDate} (${dayOfWeek === 0 ? 'Sunday→Monday' : hour < 14 ? 'today' : 'tomorrow'})`);

    const campaigns = await db('ad_campaigns').where('status', 'active');
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
            reason: `Capacity ${pct.toFixed(0)}% for ${area} on ${checkDate}`,
            trigger: 'auto',
            capacity_pct: pct,
            check_date: checkDate,
          });

          logger.info(`Budget: ${campaign.campaign_name} ${campaign.budget_mode}→${newMode} (capacity ${pct.toFixed(0)}%)`);
        }
      } catch (err) {
        logger.error(`Budget adjust failed for ${campaign.campaign_name}: ${err.message}`);
      }
    }
  }

  calculateBudget(campaign, mode) {
    const base = parseFloat(campaign.daily_budget_base || 20);
    switch (mode) {
      case 'base': return base;
      case 'spent': return parseFloat(campaign.daily_budget_current || base); // freeze at current
      case 'stop': return Math.max(0.01, base * 0.01); // 1% — never zero
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

  async getTechCountForArea(area, dateStr) {
    // Get active technicians
    const techs = await db('technicians').where({ active: true });
    if (!area || area === 'general') return techs.length;

    // Filter by service area (simplified — techs cover zones)
    const areaMap = {
      'Lakewood Ranch': ['Adam', 'Jose'],
      'LWR': ['Adam', 'Jose'],
      'Parrish': ['Jacob'],
      'Sarasota': ['Adam', 'Jose'],
      'Venice': ['Jacob'],
      'Bradenton': ['Adam', 'Jose', 'Jacob'],
    };

    const techNames = areaMap[area] || techs.map(t => t.name);
    return techNames.length;
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
          dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
          dayLabel: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
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
    const campaign = await db('ad_campaigns').where({ id: campaignId }).first();
    if (!campaign) throw new Error('Campaign not found');

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

    return { campaign: campaign.campaign_name, previousMode: campaign.budget_mode, newMode: mode, newBudget };
  }

  /**
   * Manually update a campaign's base daily budget.
   */
  async setBudget(campaignId, newBaseBudget, reason = 'manual') {
    const campaign = await db('ad_campaigns').where({ id: campaignId }).first();
    if (!campaign) throw new Error('Campaign not found');

    await db('ad_campaigns').where({ id: campaignId }).update({
      daily_budget_base: newBaseBudget,
      daily_budget_current: campaign.budget_mode === 'base' ? newBaseBudget : campaign.daily_budget_current,
    });

    await db('ad_budget_log').insert({
      campaign_id: campaignId,
      campaign_name: campaign.campaign_name,
      previous_mode: campaign.budget_mode,
      new_mode: campaign.budget_mode,
      previous_budget: campaign.daily_budget_base,
      new_budget: newBaseBudget,
      reason,
      trigger: 'manual',
    });

    return { campaign: campaign.campaign_name, previousBudget: campaign.daily_budget_base, newBudget: newBaseBudget };
  }
}

module.exports = new BudgetManager();
