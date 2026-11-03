'use strict';

// The office hears about each customer the weekly watering sweep skipped because the rain at
// the home was unknown (the radar relay and Open-Meteo both failed for it). Nothing re-runs the
// sweep, so before this the customer silently got no email that week (2026-11-02: one of 45).
// One bell per customer per week (dedupe key irrigation-rain-unknown:<customerId>:<weekEnding>),
// and none when that week's email already went out (a re-run inside the week). A bell closes when
// a later run emails the customer, or when its week's email is found sent. Sending late contacts
// the customer, so the bell is the owner's (who 'person'). Contract: docs/admin-notifications.md.
const db = require('../models/db');
const logger = require('./logger');

const KEY_PREFIX = 'irrigation-rain-unknown:';
const WHY = 'Rain at the home was unknown when the weekly email ran, so no watering email went out this week';
const AREA = 'Comms';

// The template library's statuses for an email that went out (email-template-library.js).
const EMAILED_STATUSES = ['sent', 'delivered', 'opened', 'clicked'];

const keyFor = (customerId, weekEnding) => `${KEY_PREFIX}${customerId}:${weekEnding}`;
const customerOfKey = (key) => String(key).slice(KEY_PREFIX.length).split(':')[0];
// The sweep's trigger_event_id for the same customer-week (irrigation-weekly-email.js).
const triggerOfKey = (key) => `irrigation.weekly:${String(key).slice(KEY_PREFIX.length)}`;

// The customer-weeks among `triggerIds` whose weekly email went out.
async function emailedTriggers(conn, triggerIds) {
  if (!triggerIds.length) return new Set();
  const rows = await conn('email_messages').whereIn('trigger_event_id', triggerIds).whereIn('status', EMAILED_STATUSES)
    .select('trigger_event_id');
  return new Set(rows.map((r) => String(r.trigger_event_id)));
}

// The headline's action. A name that breaks the alert rules (a typed full stop before a
// capital, a code-shaped word) falls back to the first word, then to no name.
function actionFor(name) {
  const { breaksAlertRules } = require('./admin-alert-compose');
  const { tidyName, fitAction } = require('./admin-alert-names');
  const full = tidyName(name);
  for (const who of [full, full.split(' ')[0]]) {
    if (!who) continue;
    const action = fitAction(AREA, who, [(n) => `decide on ${n}'s missed watering email`, (n) => `decide on ${n}'s watering email`]);
    if (!breaksAlertRules(action)) return action;
  }
  return 'decide on a missed watering email';
}

async function raiseOne(conn, customerId, weekEnding) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { lookupCustomerName } = require('./admin-alert-names');
  const result = await raiseAdminAlert('alert', {
    area: AREA,
    action: actionFor(await lookupCustomerName(conn, customerId)),
    why: WHY,
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
    subject: { type: 'customer', id: customerId },
    doneWhen: 'irrigation_email_sent',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: keyFor(customerId, weekEnding),
    metadata: { customerId, weekEnding, source: 'irrigation-weekly-email' },
  });
  return Boolean(result?.id) && !result.suppressed;
}

// Close an open bell when this run emailed its customer, or when its own week's email went out
// (a deduped re-run, or a send this run did not make). One read of the open keys per run.
async function closeEmailed(conn, sentCustomerIds) {
  const episodes = require('./admin-alert-episodes');
  const open = await episodes.openAdminAlertKeys(conn, KEY_PREFIX);
  const emailed = await emailedTriggers(conn, open.map(triggerOfKey));
  const keys = open.filter((key) => sentCustomerIds.has(customerOfKey(key)) || emailed.has(triggerOfKey(key)));
  if (!keys.length) return 0;
  return episodes.closeAdminAlertKeys(conn, keys, 'irrigation_email_sent', {
    resolution: 'A later weekly watering email reached the customer',
  });
}

// The skipped customers whose email for this week has not gone out. A failed read keeps them
// all: a bell that may be extra beats a silent miss.
async function stillUnemailed(conn, customerIds, weekEnding) {
  try {
    const emailed = await emailedTriggers(conn, customerIds.map((id) => triggerOfKey(keyFor(id, weekEnding))));
    return customerIds.filter((id) => !emailed.has(triggerOfKey(keyFor(id, weekEnding))));
  } catch (err) {
    logger.warn(`[irrigation-weekly-email] rain-unknown delivery check failed: ${err.message}`);
    return customerIds;
  }
}

// After a sweep: close the bells whose customer got an email, then raise one for each customer it
// skipped as rain-unknown whose week has no email yet. Never throws: the sweep's result stands.
async function settleRainUnknownAlerts({ sentCustomerIds = [], rainUnknownCustomerIds = [], weekEnding, conn = db } = {}) {
  const out = { closed: 0, raised: 0 };
  const sent = new Set([...sentCustomerIds].map(String));
  const skipped = [...new Set([...rainUnknownCustomerIds].map(String))];
  try {
    out.closed = await closeEmailed(conn, sent);
  } catch (err) {
    logger.warn(`[irrigation-weekly-email] rain-unknown bell close failed: ${err.message}`);
  }
  for (const customerId of await stillUnemailed(conn, skipped, weekEnding)) {
    try {
      if (await raiseOne(conn, customerId, weekEnding)) out.raised += 1;
    } catch (err) {
      logger.warn(`[irrigation-weekly-email] rain-unknown bell failed for ${customerId}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { settleRainUnknownAlerts, KEY_PREFIX, _test: { actionFor, keyFor, customerOfKey, triggerOfKey, WHY } };
