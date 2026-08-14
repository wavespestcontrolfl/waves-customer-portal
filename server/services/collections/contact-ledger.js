/**
 * collections_contact_ledger writer — the one place the dunning rails record
 * "this customer was reached about an open balance". Additive/observational
 * (safe ungated): the ledger only ever makes the contact policy MORE
 * conservative, so a write failure must never block or fail a send that
 * already happened — hence the deliberate never-throw here, unlike the
 * fail-closed READS in contact-policy.js.
 */

const db = require('../../models/db');
const logger = require('../logger');

async function recordContact({
  customerId,
  channel,
  purpose,
  invoiceIds = [],
  source,
  metadata = null,
  occurredAt = new Date(),
}) {
  try {
    await db('collections_contact_ledger').insert({
      customer_id: customerId,
      channel,
      purpose,
      invoice_ids: JSON.stringify(invoiceIds),
      occurred_at: occurredAt,
      source,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
    return true;
  } catch (err) {
    logger.warn(`[collections-ledger] contact record failed for customer ${customerId} (${source}/${channel}): ${err.message}`);
    return false;
  }
}

module.exports = { recordContact };
