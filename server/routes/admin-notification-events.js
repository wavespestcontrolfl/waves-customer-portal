const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const catalog = require('../config/notification-events');

router.use(adminAuthenticate, requireTechOrAdmin);

function asCatalogMap() {
  return new Map(catalog.map((event) => [event.event_key, event]));
}

function fallbackEvent(eventKey) {
  return {
    event_key: eventKey,
    name: eventKey,
    audience: null,
    description: '',
    fires_when: '',
    source: '',
    channels_expected: [],
  };
}

function eventStatus(smsTemplates) {
  if (smsTemplates.length) return 'sms_only';
  return 'unmapped';
}

async function tableExists(table) {
  return db.schema.hasTable(table);
}

async function hasColumn(table, column) {
  if (!(await tableExists(table))) return false;
  return db.schema.hasColumn(table, column);
}

// GET /api/admin/notification-events
router.get('/', async (req, res, next) => {
  try {
    const catalogMap = asCatalogMap();
    const eventKeys = new Set(catalog.map((event) => event.event_key));

    const hasSmsTrigger = await hasColumn('sms_templates', 'trigger_event_key');

    let mappedSmsRows = [];
    let unmappedSmsRows = [];
    if (hasSmsTrigger) {
      mappedSmsRows = await db('sms_templates')
        .whereNotNull('trigger_event_key')
        .select('id', 'template_key', 'name', 'body', 'is_active', 'category', 'variables', 'trigger_event_key')
        .orderBy('category')
        .orderBy('sort_order');
      unmappedSmsRows = await db('sms_templates')
        .whereNull('trigger_event_key')
        .select('id', 'template_key', 'name', 'body', 'is_active', 'category', 'variables', 'trigger_event_key')
        .orderBy('category')
        .orderBy('sort_order');
      mappedSmsRows.forEach((row) => {
        if (row.trigger_event_key) eventKeys.add(row.trigger_event_key);
      });
    } else if (await tableExists('sms_templates')) {
      unmappedSmsRows = await db('sms_templates')
        .select('id', 'template_key', 'name', 'body', 'is_active', 'category', 'variables')
        .orderBy('category')
        .orderBy('sort_order');
    }

    const smsByEvent = new Map();
    for (const row of mappedSmsRows) {
      if (!row.trigger_event_key) continue;
      if (!smsByEvent.has(row.trigger_event_key)) smsByEvent.set(row.trigger_event_key, []);
      smsByEvent.get(row.trigger_event_key).push(row);
    }

    const orderedKeys = [
      ...catalog.map((event) => event.event_key),
      ...[...eventKeys].filter((eventKey) => !catalogMap.has(eventKey)).sort(),
    ];

    const events = orderedKeys.map((eventKey) => {
      const meta = catalogMap.get(eventKey) || fallbackEvent(eventKey);
      const smsTemplates = smsByEvent.get(eventKey) || [];
      return {
        ...meta,
        status: eventStatus(smsTemplates),
        sms_templates: smsTemplates,
      };
    });

    events.push({
      event_key: '__sms_only__',
      name: 'Channel-only - SMS',
      audience: null,
      description: 'SMS templates that are not mapped to a shared notification event.',
      fires_when: '',
      source: '',
      channels_expected: ['sms'],
      status: unmappedSmsRows.length ? 'sms_only' : 'unmapped',
      sms_templates: unmappedSmsRows,
    });

    res.json({ events, catalog });
  } catch (err) { next(err); }
});

module.exports = router;
