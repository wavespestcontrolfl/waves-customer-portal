const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const EmailAutomationService = require('../services/email-automations');
const beehiiv = require('../services/beehiiv');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /automations — list all automation definitions + stats
router.get('/automations', async (req, res, next) => {
  try {
    const automations = Object.entries(EmailAutomationService.AUTOMATIONS).map(([key, auto]) => ({
      key,
      ...auto,
      smsTemplate: auto.smsTemplate ? '(configured)' : null,
    }));

    // Get run counts per automation
    const counts = await db('email_automation_log')
      .select('automation_key')
      .count('* as total')
      .select(db.raw("COUNT(*) FILTER (WHERE status = 'success') as success_count"))
      .select(db.raw("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7d"))
      .groupBy('automation_key');

    const countMap = {};
    counts.forEach(c => { countMap[c.automation_key] = c; });

    automations.forEach(a => {
      const c = countMap[a.key] || {};
      a.totalRuns = parseInt(c.total || 0);
      a.successCount = parseInt(c.success_count || 0);
      a.last7Days = parseInt(c.last_7d || 0);
    });

    res.json({ automations, beehiivConfigured: beehiiv.configured });
  } catch (err) { next(err); }
});

// GET /log — automation run history
router.get('/log', async (req, res, next) => {
  try {
    const { customer_id, automation_key, status, limit = 50, page = 1 } = req.query;

    let query = db('email_automation_log')
      .leftJoin('customers', 'email_automation_log.customer_id', 'customers.id')
      .select(
        'email_automation_log.*',
        'customers.first_name', 'customers.last_name',
        'customers.email as customer_email', 'customers.phone as customer_phone'
      )
      .orderBy('email_automation_log.created_at', 'desc');

    if (customer_id) query = query.where('email_automation_log.customer_id', customer_id);
    if (automation_key) query = query.where('email_automation_log.automation_key', automation_key);
    if (status) query = query.where('email_automation_log.status', status);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const log = await query.limit(parseInt(limit)).offset(offset);

    // Total count
    let countQuery = db('email_automation_log');
    if (customer_id) countQuery = countQuery.where({ customer_id });
    if (automation_key) countQuery = countQuery.where({ automation_key });
    if (status) countQuery = countQuery.where({ status });
    const [{ count: total }] = await countQuery.count('* as count');

    res.json({ log, total: parseInt(total), page: parseInt(page) });
  } catch (err) { next(err); }
});

// POST /trigger — manually trigger an automation for a customer
router.post('/trigger', async (req, res, next) => {
  try {
    const { automationKey, customerId } = req.body;
    if (!automationKey || !customerId) {
      return res.status(400).json({ error: 'automationKey and customerId required' });
    }

    const result = await EmailAutomationService.manualTrigger(automationKey, customerId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /trigger-bulk — trigger an automation for multiple customers
router.post('/trigger-bulk', async (req, res, next) => {
  try {
    const { automationKey, customerIds } = req.body;
    if (!automationKey || !Array.isArray(customerIds) || customerIds.length === 0) {
      return res.status(400).json({ error: 'automationKey and customerIds[] required' });
    }

    const results = [];
    for (const cid of customerIds) {
      try {
        const result = await EmailAutomationService.manualTrigger(automationKey, cid);
        results.push({ customerId: cid, ...result });
      } catch (err) {
        results.push({ customerId: cid, success: false, error: err.message });
      }
    }

    res.json({ results, total: customerIds.length, success: results.filter(r => r.success).length });
  } catch (err) { next(err); }
});

// PUT /automations/:key — toggle automation enabled/disabled
router.put('/automations/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const auto = EmailAutomationService.AUTOMATIONS[key];
    if (!auto) return res.status(404).json({ error: `Unknown automation: ${key}` });

    if (req.body.enabled !== undefined) auto.enabled = !!req.body.enabled;

    res.json({ key, enabled: auto.enabled, name: auto.name });
  } catch (err) { next(err); }
});

// GET /beehiiv/automations — list Beehiiv automations (for mapping)
router.get('/beehiiv/automations', async (req, res, next) => {
  try {
    if (!beehiiv.configured) {
      return res.json({ automations: [], configured: false });
    }
    const automations = await beehiiv.listAutomations();
    res.json({ automations, configured: true });
  } catch (err) { next(err); }
});

// GET /beehiiv/subscribers — list Beehiiv subscribers
router.get('/beehiiv/subscribers', async (req, res, next) => {
  try {
    if (!beehiiv.configured) {
      return res.json({ subscribers: [], configured: false });
    }
    const { page = 1, limit = 50 } = req.query;
    const data = await beehiiv.listSubscribers({ page: parseInt(page), limit: parseInt(limit) });
    res.json({ ...data, configured: true });
  } catch (err) { next(err); }
});

// GET /stats — dashboard stats
router.get('/stats', async (req, res, next) => {
  try {
    const [totals] = await db('email_automation_log')
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'success') as success"),
        db.raw("COUNT(*) FILTER (WHERE status = 'partial') as partial"),
        db.raw("COUNT(*) FILTER (WHERE status = 'failed') as failed"),
        db.raw("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h"),
        db.raw("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7d"),
        db.raw("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as last_30d"),
        db.raw("COUNT(DISTINCT customer_id) as unique_customers")
      );

    res.json({
      total: parseInt(totals.total),
      success: parseInt(totals.success),
      partial: parseInt(totals.partial),
      failed: parseInt(totals.failed),
      last24h: parseInt(totals.last_24h),
      last7d: parseInt(totals.last_7d),
      last30d: parseInt(totals.last_30d),
      uniqueCustomers: parseInt(totals.unique_customers),
      beehiivConfigured: beehiiv.configured,
    });
  } catch (err) { next(err); }
});

module.exports = router;
