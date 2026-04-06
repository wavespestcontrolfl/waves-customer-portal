/**
 * Square Customer Sync — pulls all customers from Square into the portal DB.
 *
 * Deduplicates by square_customer_id, phone, or email.
 * Updates existing records with any new info from Square.
 * Creates new portal customers for unmatched Square customers.
 */

const db = require('../models/db');
const config = require('../config');
const { resolveLocation } = require('../config/locations');
const logger = require('./logger');
const { Client, Environment } = require('square');

let squareClient, customersApi;
if (config.square?.accessToken) {
  squareClient = new Client({
    accessToken: config.square.accessToken,
    environment: config.square.environment === 'production' ? Environment.Production : Environment.Sandbox,
  });
  customersApi = squareClient.customersApi;
}

function cleanPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return raw;
}

const SquareCustomerSync = {
  /**
   * Sync all Square customers into portal DB.
   * Pages through the entire Square customer list.
   */
  async sync() {
    if (!customersApi) throw new Error('Square not configured — check SQUARE_ACCESS_TOKEN');

    let cursor;
    let totalFetched = 0, created = 0, updated = 0, skipped = 0;
    const errors = [];

    do {
      let response;
      try {
        response = await customersApi.listCustomers(cursor);
      } catch (err) {
        const detail = err.errors?.[0]?.detail || err.message;
        throw new Error(`Square Customers API failed: ${detail}`);
      }

      const customers = response.result?.customers || [];
      cursor = response.result?.cursor;
      totalFetched += customers.length;

      for (const sq of customers) {
        try {
          const phone = cleanPhone(sq.phoneNumber);
          const email = sq.emailAddress || null;
          const firstName = sq.givenName || '';
          const lastName = sq.familyName || '';
          const company = sq.companyName || null;

          if (!firstName && !lastName && !company) { skipped++; continue; }

          // Address
          const addr = sq.address || {};
          const addressLine1 = addr.addressLine1 || '';
          const city = addr.locality || '';
          const state = addr.administrativeDistrictLevel1 || 'FL';
          const zip = addr.postalCode || '';

          // Check if already exists by square_customer_id
          let existing = await db('customers').where({ square_customer_id: sq.id }).first();

          // Fallback: match by phone
          if (!existing && phone) {
            existing = await db('customers').where({ phone }).first();
          }

          // Fallback: match by email
          if (!existing && email) {
            existing = await db('customers').where({ email }).first();
          }

          if (existing) {
            // Update with any new info from Square
            const upd = {};
            if (!existing.square_customer_id) upd.square_customer_id = sq.id;
            if (!existing.email && email) upd.email = email;
            if (!existing.phone && phone) upd.phone = phone;
            if (!existing.address_line1 && addressLine1) upd.address_line1 = addressLine1;
            if (!existing.city && city) upd.city = city;
            if (!existing.zip && zip) upd.zip = zip;
            if (!existing.company_name && company) upd.company_name = company;

            if (Object.keys(upd).length > 0) {
              upd.updated_at = new Date();
              await db('customers').where({ id: existing.id }).update(upd);
              updated++;
            } else {
              skipped++;
            }
          } else {
            // Create new customer
            const loc = resolveLocation(city);
            const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

            await db('customers').insert({
              first_name: firstName || company || 'Unknown',
              last_name: lastName || '',
              phone: phone || null,
              email: email || null,
              address_line1: addressLine1,
              city, state, zip,
              company_name: company,
              square_customer_id: sq.id,
              referral_code: code,
              pipeline_stage: 'active_customer',
              pipeline_stage_changed_at: new Date(),
              lead_source: 'square',
              nearest_location_id: loc.id,
              member_since: sq.createdAt ? sq.createdAt.split('T')[0] : new Date().toISOString().split('T')[0],
            });
            created++;
          }
        } catch (err) {
          errors.push({ squareId: sq.id, name: `${sq.givenName} ${sq.familyName}`, error: err.message });
          skipped++;
        }
      }

      logger.info(`[sq-cust-sync] Page: ${customers.length} customers (cursor: ${cursor ? 'yes' : 'done'})`);

    } while (cursor);

    logger.info(`[sq-cust-sync] Done: ${totalFetched} fetched, ${created} created, ${updated} updated, ${skipped} skipped, ${errors.length} errors`);
    return { totalFetched, created, updated, skipped, errors: errors.slice(0, 20) };
  },
};

module.exports = SquareCustomerSync;
