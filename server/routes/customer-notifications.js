const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const NotificationService = require('../services/notification-service');

router.use(authenticate);

// GET /api/customer-notifications — list for authenticated customer
router.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const notifications = await NotificationService.getCustomerNotifications(req.customerId, limit, offset);
    res.json({ notifications, page, limit });
  } catch (err) { next(err); }
});

// GET /api/customer-notifications/unread-count — count for badge
router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await NotificationService.getCustomerUnreadCount(req.customerId);
    res.json({ count });
  } catch (err) { next(err); }
});

// PUT /api/customer-notifications/read-all — mark all read
router.put('/read-all', async (req, res, next) => {
  try {
    await NotificationService.markAllReadCustomer(req.customerId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/customer-notifications/:id/read — mark one read
router.put('/:id/read', async (req, res, next) => {
  try {
    await NotificationService.markRead(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
