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

function eventStatus(emailAutomations, smsTemplates) {
  if (emailAutomations.length && smsTemplates.length) return 'paired';
  if (emailAutomations.length) return 'email_only';
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

    const hasEmailAutomations = await tableExists('email_template_automations');
    const hasSmsTrigger = await hasColumn('sms_templates', 'trigger_event_key');

    let emailRows = [];
    if (hasEmailAutomations) {
      emailRows = await db('email_template_automations as a')
        .leftJoin('email_templates as t', 't.template_key', 'a.template_key')
        .leftJoin('email_template_versions as v', 'v.id', 't.active_version_id')
        .select(
          'a.automation_key',
          'a.template_key',
          'a.trigger_event_key',
          'a.status',
          'a.audience',
          'a.frequency_cap',
          'a.delay_minutes',
          't.name as template_name',
          't.active_version_id as active_version_id',
          'v.version_number as active_version_number',
          'v.status as version_status',
          'v.subject as subject',
          'v.preview_text as preview_text',
        )
        .orderBy('a.trigger_event_key', 'asc')
        .orderBy('a.name', 'asc');
      emailRows.forEach((row) => {
        if (row.trigger_event_key) eventKeys.add(row.trigger_event_key);
      });
    }

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

    const emailsByEvent = new Map();
    for (const row of emailRows) {
      if (!row.trigger_event_key) continue;
      if (!emailsByEvent.has(row.trigger_event_key)) emailsByEvent.set(row.trigger_event_key, []);
      emailsByEvent.get(row.trigger_event_key).push(row);
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
      const emailAutomations = emailsByEvent.get(eventKey) || [];
      const smsTemplates = smsByEvent.get(eventKey) || [];
      return {
        ...meta,
        status: eventStatus(emailAutomations, smsTemplates),
        email_automations: emailAutomations,
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
      email_automations: [],
      sms_templates: unmappedSmsRows,
    });

    events.push({
      event_key: '__email_only__',
      name: 'Channel-only - Email',
      audience: null,
      description: 'Reserved for email templates without an automation event.',
      fires_when: '',
      source: '',
      channels_expected: ['email'],
      status: 'unmapped',
      email_automations: [],
      sms_templates: [],
    });

    res.json({ events, catalog });
  } catch (err) { next(err); }
});

module.exports = router;
