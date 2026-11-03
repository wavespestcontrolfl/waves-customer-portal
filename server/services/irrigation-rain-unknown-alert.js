'use strict';

// The office hears about each customer the weekly watering sweep skipped because the rain at
// the home was unknown (the radar relay and Open-Meteo both failed for it). Nothing re-runs the
// sweep, so before this the customer silently got no email that week (2026-11-02: one of 45).
// One bell per customer per week (dedupe key irrigation-rain-unknown:<customerId>:<weekEnding>).
// A later run that emails the customer closes every open one of theirs. Sending late contacts
// the customer, so the bell is the owner's (who 'person'). Contract: docs/admin-notifications.md.
const db = require('../models/db');
const logger = require('./logger');

const KEY_PREFIX = 'irrigation-rain-unknown:';
const WHY = 'Rain at the home was unknown when the weekly email ran, so no watering email went out this week';
const AREA = 'Comms';

const keyFor = (customerId, weekEnding) => `${KEY_PREFIX}${customerId}:${weekEnding}`;
const customerOfKey = (key) => String(key).slice(KEY_PREFIX.length).split(':')[0];

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

// Close the open bells of every customer this run emailed. One read of the open keys per run.
async function closeForSent(conn, sentCustomerIds) {
  if (!sentCustomerIds.size) return 0;
  const episodes = require('./admin-alert-episodes');
  const keys = (await episodes.openAdminAlertKeys(conn, KEY_PREFIX)).filter((key) => sentCustomerIds.has(customerOfKey(key)));
  if (!keys.length) return 0;
  return episodes.closeAdminAlertKeys(conn, keys, 'irrigation_email_sent', {
    resolution: 'A later weekly watering email reached the customer',
  });
}

// After a sweep: close the bells of customers it emailed, then raise one for each customer it
// skipped as rain-unknown. Never throws: the sweep's result stands whatever happens here.
async function settleRainUnknownAlerts({ sentCustomerIds = [], rainUnknownCustomerIds = [], weekEnding, conn = db } = {}) {
  const out = { closed: 0, raised: 0 };
  try {
    out.closed = await closeForSent(conn, new Set([...sentCustomerIds].map(String)));
  } catch (err) {
    logger.warn(`[irrigation-weekly-email] rain-unknown bell close failed: ${err.message}`);
  }
  for (const customerId of new Set([...rainUnknownCustomerIds].map(String))) {
    try {
      if (await raiseOne(conn, customerId, weekEnding)) out.raised += 1;
    } catch (err) {
      logger.warn(`[irrigation-weekly-email] rain-unknown bell failed for ${customerId}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { settleRainUnknownAlerts, KEY_PREFIX, _test: { actionFor, keyFor, customerOfKey, WHY } };
