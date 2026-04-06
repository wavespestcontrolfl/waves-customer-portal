const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const InvoiceService = require('../services/invoice');
const db = require('../models/db');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /stats
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await InvoiceService.getStats();
    res.json(stats);
  } catch (err) { next(err); }
});

// GET / — list invoices
router.get('/', async (req, res, next) => {
  try {
    const { status, customer_id, limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { invoices, total } = await InvoiceService.list({
      status, customerId: customer_id, limit: parseInt(limit), offset,
    });
    res.json({ invoices, total, page: parseInt(page) });
  } catch (err) { next(err); }
});

// GET /customers/search — quick customer search for invoice creation
router.get('/customers/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ customers: [] });
    const customers = await db('customers')
      .where(function () {
        this.whereRaw("LOWER(first_name || ' ' || last_name) LIKE ?", [`%${q.toLowerCase()}%`])
          .orWhere('phone', 'like', `%${q}%`)
          .orWhere('email', 'like', `%${q.toLowerCase()}%`);
      })
      .where({ active: true })
      .select('id', 'first_name', 'last_name', 'phone', 'email', 'waveguard_tier', 'address_line1', 'city')
      .limit(10);
    res.json({ customers });
  } catch (err) { next(err); }
});

// GET /service-records/:customerId — get recent services for a customer (to link invoice)
router.get('/service-records/:customerId', async (req, res, next) => {
  try {
    const records = await db('service_records')
      .where({ customer_id: req.params.customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.id', 'service_records.service_date', 'service_records.service_type',
        'service_records.status', 'technicians.name as tech_name')
      .orderBy('service_date', 'desc')
      .limit(20);
    res.json({ records });
  } catch (err) { next(err); }
});

// GET /:id — single invoice with full details
router.get('/:id', async (req, res, next) => {
  try {
    const invoice = await InvoiceService.getById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(invoice);
  } catch (err) { next(err); }
});

// POST / — create invoice manually
router.post('/', async (req, res, next) => {
  try {
    const { customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!lineItems?.length) return res.status(400).json({ error: 'lineItems required' });

    const invoice = await InvoiceService.create({
      customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate,
    });

    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    res.status(201).json({
      ...invoice,
      payUrl: `${domain}/pay/${invoice.token}`,
    });
  } catch (err) { next(err); }
});

// POST /from-service — create from service record (convenience)
router.post('/from-service', async (req, res, next) => {
  try {
    const { serviceRecordId, amount, description, taxRate } = req.body;
    if (!serviceRecordId) return res.status(400).json({ error: 'serviceRecordId required' });
    if (!amount) return res.status(400).json({ error: 'amount required' });

    const invoice = await InvoiceService.createFromService(serviceRecordId, {
      amount: parseFloat(amount), description, taxRate,
    });

    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    res.status(201).json({
      ...invoice,
      payUrl: `${domain}/pay/${invoice.token}`,
    });
  } catch (err) { next(err); }
});

// PUT /:id — update invoice
router.put('/:id', async (req, res, next) => {
  try {
    const invoice = await InvoiceService.update(req.params.id, req.body);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(invoice);
  } catch (err) { next(err); }
});

// POST /:id/send — send invoice via SMS
router.post('/:id/send', async (req, res, next) => {
  try {
    const result = await InvoiceService.sendViaSMS(req.params.id);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /:id/void — void invoice
router.post('/:id/void', async (req, res, next) => {
  try {
    const invoice = await InvoiceService.voidInvoice(req.params.id);
    res.json(invoice);
  } catch (err) { next(err); }
});

module.exports = router;
