'use strict';

/**
 * Admin report preview: the customer service report for a visit that is NOT
 * completed yet, rendered from the live visit instead of a service_records row.
 *
 * Today a report exists only after completeScheduledService inserts the record
 * (and texts/emails the customer and charges autopay). The owner wants to see
 * the report as the customer will, BEFORE completing. This module builds the
 * in-memory stand-in for that record; routes/admin-report-preview.js feeds it
 * through the SAME builder the customer route uses, with `preview: true`
 * threaded so the render path writes nothing (see buildReportV1Data).
 *
 * The stand-in is never inserted. It carries a null record id and a null token
 * on purpose: every id-keyed lookup (products, findings, photos, scores) reads
 * as "none yet", and every freeze/persist guard that needs a record id is inert
 * even before the explicit preview flag skips it.
 */

const db = require('../../models/db');
const { detectServiceLine } = require('./service-line-configs');
const { stampedDivergesSql, stampedLine2Sql } = require('../stamped-address');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A visit in one of these states already has (or will never have) a real report:
// the preview refuses it so the owner is not shown a rendering that disagrees
// with the record the customer actually holds.
const NO_PREVIEW_STATUSES = new Set(['completed', 'cancelled']);

/**
 * Load the preview stand-in for a scheduled visit.
 * Returns { service } on success, or { error: 'invalid_id' | 'not_found' |
 * 'completed' | 'cancelled' | 'has_report' } (the route maps these to 404/409).
 */
async function loadPreviewService(scheduledServiceId, knex = db) {
  const id = String(scheduledServiceId || '').trim();
  if (!UUID_RE.test(id)) return { error: 'invalid_id' };

  // Same customer / technician / address columns the public GET /:token/data
  // route selects (routes/reports-public.js), joined from the visit instead of
  // from service_records: the stamped visit address wins, the customer mirror is
  // the fallback; map center follows the treated parcel; the weekly watering
  // plan is withheld when the stamped address diverges from the home.
  const row = await knex('scheduled_services as ss')
    .where('ss.id', id)
    .leftJoin('customers', 'ss.customer_id', 'customers.id')
    .leftJoin('technicians', 'ss.technician_id', 'technicians.id')
    .select(
      'ss.id as ss_id', 'ss.customer_id as ss_customer_id', 'ss.technician_id as ss_technician_id',
      'ss.scheduled_date', 'ss.service_type', 'ss.status as ss_status', 'ss.is_callback',
      'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
      knex.raw('COALESCE(ss.service_address_line1, customers.address_line1) as address_line1'),
      knex.raw(`${stampedLine2Sql('ss', 'customers')} as address_line2`),
      knex.raw('COALESCE(ss.service_address_city, customers.city) as city'),
      knex.raw('COALESCE(ss.service_address_state, customers.state) as state'),
      knex.raw('COALESCE(ss.service_address_zip, customers.zip) as zip'),
      'customers.nearest_location_id',
      'customers.has_left_google_review',
      'customers.waveguard_tier',
      knex.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.latitude END) as customer_latitude`),
      knex.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.longitude END) as customer_longitude`),
      knex.raw(`${stampedDivergesSql('ss', 'customers')} as stamped_address_diverges`),
      'technicians.name as technician_name',
      'technicians.photo_url as technician_photo_url',
      'technicians.avatar_url as technician_avatar_url',
      'technicians.photo_s3_key as technician_photo_s3_key',
      'technicians.fl_applicator_license as technician_fdacs_id',
      'technicians.license_expiry as technician_license_expiry',
    )
    .first();
  if (!row) return { error: 'not_found' };

  const status = String(row.ss_status || '').toLowerCase();
  if (NO_PREVIEW_STATUSES.has(status)) return { error: status };

  // A record already linked to this visit (a reopened or incomplete closeout)
  // means a real report exists: show that one, not a stand-in.
  const existing = await knex('service_records').where({ scheduled_service_id: id }).first('id');
  if (existing) return { error: 'has_report' };

  // The ss_* aliases keep the visit's own columns from colliding with the
  // customer/technician columns in the select; they are re-keyed below.
  const joined = { ...row };
  ['ss_id', 'ss_customer_id', 'ss_technician_id', 'scheduled_date', 'ss_status'].forEach((key) => delete joined[key]);

  return {
    service: {
      ...joined,
      // No row, no id, no token: nothing is ever written under this record.
      id: null,
      report_view_token: null,
      report_template_version: 'service_report_v1',
      scheduled_service_id: row.ss_id,
      customer_id: row.ss_customer_id,
      technician_id: row.ss_technician_id,
      service_date: row.scheduled_date,
      service_type: row.service_type,
      // completeScheduledService stamps detectServiceLine(svc.service_type) on the record.
      service_line: detectServiceLine(row.service_type),
      status: 'completed',
      is_callback: row.is_callback === true,
      structured_notes: {},
      service_data: {},
      technician_notes: '',
    },
  };
}

module.exports = { loadPreviewService, NO_PREVIEW_STATUSES };
