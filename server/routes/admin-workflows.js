const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');

/**
 * GET /api/admin/workflows/status
 * Returns counts and status for each workflow type.
 */
router.get('/status', async (req, res) => {
  try {
    // Active SMS sequences by type
    const activeSequences = await db('sms_sequences')
      .where({ status: 'active' })
      .select('sequence_type')
      .count('id as count')
      .groupBy('sequence_type');

    const sequenceMap = {};
    activeSequences.forEach(row => {
      sequenceMap[row.sequence_type] = parseInt(row.count, 10);
    });

    // Upcoming renewals in next 30 days
    const renewalCount = await db('customers')
      .where(function () {
        this.whereBetween('termite_renewal_date', [db.raw('CURRENT_DATE'), db.raw("CURRENT_DATE + INTERVAL '30 days'")])
          .orWhereBetween('mosquito_season_start', [db.raw('CURRENT_DATE'), db.raw("CURRENT_DATE + INTERVAL '30 days'")])
          .orWhereBetween('waveguard_renewal_date', [db.raw('CURRENT_DATE'), db.raw("CURRENT_DATE + INTERVAL '30 days'")]);
      })
      .count('id as count')
      .first();

    // Expiring cards (this month + next)
    const now = new Date();
    const thisMonth = now.getMonth() + 1;
    const thisYear = now.getFullYear();
    const nextMonth = thisMonth === 12 ? 1 : thisMonth + 1;
    const nextYear = thisMonth === 12 ? thisYear + 1 : thisYear;

    const expiringCards = await db('payment_methods')
      .where(function () {
        this.where({ exp_month: thisMonth, exp_year: thisYear })
          .orWhere({ exp_month: nextMonth, exp_year: nextYear });
      })
      .count('id as count')
      .first();

    // Reactivation sends in last 7 days
    const recentReactivations = await db('sms_log')
      .where({ message_type: 'reactivation' })
      .where('created_at', '>', db.raw("NOW() - INTERVAL '7 days'"))
      .count('id as count')
      .first();

    // Active cancellation saves
    const activeCancellations = await db('sms_sequences')
      .where({ sequence_type: 'cancellation_save', status: 'active' })
      .count('id as count')
      .first();

    res.json({
      activeSequences: sequenceMap,
      upcomingRenewals: parseInt(renewalCount.count, 10),
      expiringCards: parseInt(expiringCards.count, 10),
      recentReactivationSends: parseInt(recentReactivations.count, 10),
      activeCancellationSaves: parseInt(activeCancellations.count, 10),
    });
  } catch (err) {
    logger.error(`Workflow status error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch workflow status' });
  }
});

module.exports = router;
