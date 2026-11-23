'use strict';

/**
 * The page of one home on the new-home mail list (mailer step 2c, server half). A later postcard carries a QR code to
 * it; routes/mail-home-public.js serves it at GET /api/public/home/:token.
 *
 * The token is the credential: the row's page_token (32 lowercase hex, migration 20261123200000). A malformed token, an
 * unknown token, a row of another list and a row that is not live (not_eligible, unmatched) all give null.
 *
 * It returns ONLY the address, the shadow quarterly pest plan price and the plan name. The recipient names, the parcel,
 * the permit, the sale and deed fields, the engine digest, the reasons and the row id never leave this module. The price
 * is there only for an `eligible` home the price pass settled as `priced`: a held_back home (the comparison group, which
 * gets no postcard) and a home with no price get price null. It sends nothing.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { toPrice } = require('../prospects/mail-list');

const LIST_KEY = 'new_home'; // services/mail/new-home-list.js LIST_KEY
const LIVE_STATUSES = ['eligible', 'held_back'];
const TOKEN_RE = /^[0-9a-f]{32}$/;
const PLAN = 'pest_quarterly';

function priceOf(row) {
  if (row.status !== 'eligible' || row.price_status !== 'priced') return null;
  const price = toPrice(row);
  if (price.annual == null) return null;
  return { monthly: price.monthly, annual: price.annual, setupFee: price.setupFee, pricedAt: price.pricedAt };
}

// One atomic write. It never throws: a failed view write must not fail the read, and only the error code is logged
// (a Knex message carries SQL text and the bound token).
async function countView(id) {
  try {
    await db('mail_prospects').where({ id }).update({
      page_views: db.raw('page_views + 1'),
      page_first_viewed_at: db.raw('coalesce(page_first_viewed_at, now())'),
      page_last_viewed_at: db.raw('now()'),
    });
  } catch (err) {
    try {
      const code = err && (typeof err.code === 'string' || typeof err.code === 'number') ? String(err.code).slice(0, 32) : 'unknown';
      logger.warn(`[mail-home-page] view write failed (code=${code})`);
    } catch { /* never throw */ }
  }
}

/**
 * @param {string} token
 * @param {{ recordView?: boolean }} [options] recordView true counts this open (one atomic UPDATE).
 * @returns {Promise<null | { address: { line1: string|null, city: string|null, zip: string|null },
 *   price: { monthly: number, annual: number, setupFee: number|null, pricedAt: string|null } | null, plan: string }>}
 */
async function getHomePage(token, { recordView = false } = {}) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = await db('mail_prospects')
    .where({ page_token: token, list_key: LIST_KEY })
    .whereIn('status', LIVE_STATUSES)
    .first('id', 'status', 'address_line1', 'city', 'zip', 'price_status', 'price_annual', 'price_setup_fee', 'priced_at');
  if (!row) return null;
  if (recordView === true) await countView(row.id);
  return {
    address: { line1: row.address_line1 || null, city: row.city || null, zip: row.zip || null },
    price: priceOf(row),
    plan: PLAN,
  };
}

module.exports = { getHomePage, TOKEN_RE };
