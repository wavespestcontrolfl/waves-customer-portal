const express = require('express');
const multer = require('multer');
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { warranty13692CheckLive } = require('../config/feature-gates');
const notices = require('../services/consumer-notices');

// FDACS-13692 consumer notices on file for a customer (GATE_WARRANTY_13692_CHECK,
// dark). Staff-only. The list shows e-signed Document Requests and uploaded
// paper scans; a scan is never returned as a key, only through a short signed
// link. Mounted at /api/admin/customers/:customerId/consumer-notices.
const router = express.Router({ mergeParams: true });
router.use(adminAuthenticate, requireAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// Gate off = the whole surface answers 404, exactly as if it were not mounted.
router.use((req, res, next) => (warranty13692CheckLive() ? next() : res.status(404).json({ error: 'Not found' })));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A middleware, not router.param: the id is in the mount path, so param callbacks never fire here.
router.use(async (req, res, next) => {
  try {
    const { customerId } = req.params;
    if (!UUID.test(customerId)) return res.status(404).json({ error: 'Customer not found' });
    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    return next();
  } catch (err) {
    return next(err);
  }
});
router.param('recordId', (req, res, next, recordId) => (UUID.test(recordId) ? next() : res.status(404).json({ error: 'Notice not found' })));

const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: notices.MAX_FILE_BYTES } });
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The file is larger than 10 MB.' });
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Send one file in the "file" field.' });
    return next(err);
  });
}

router.get('/', async (req, res, next) => {
  try {
    res.json({ enabled: true, graceEnd: notices.CONSUMER_NOTICE_GRACE_END, notices: await notices.listConsumerNotices(req.params.customerId) });
  } catch (err) {
    next(err);
  }
});

router.post('/paper', receiveFile, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose the scan of the signed form.' });
    const record = await notices.recordPaperNotice(req.params.customerId, req.file, {
      signedOn: req.body?.signedOn,
      notes: req.body?.notes,
      adminId: req.technicianId,
    });
    res.status(201).json({ notice: record });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// A signed link as JSON: the page fetches with its admin token, so a redirect
// would drop the token on the way to the file.
router.get('/paper/:recordId/file', async (req, res, next) => {
  try {
    const record = await notices.getPaperRecord(req.params.customerId, req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Notice not found' });
    res.json({ url: await notices.signedViewUrl(record) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
