const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const NotificationService = require('../services/notification-service');

router.use(adminAuthenticate);

// GET /api/admin/notifications — list with pagination
router.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const notifications = await NotificationService.getAdminNotifications(limit, offset);
    res.json({ notifications, page, limit });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/unread-count — just the count (for bell badge polling)
router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await NotificationService.getAdminUnreadCount();
    res.json({ count });
  } catch (err) { next(err); }
});

// PUT /api/admin/notifications/read-all — mark all as read
router.put('/read-all', async (req, res, next) => {
  try {
    await NotificationService.markAllReadAdmin();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/notifications/:id/read — mark one as read
router.put('/:id/read', async (req, res, next) => {
  try {
    await NotificationService.markRead(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
