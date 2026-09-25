/** Appointment stage of the existing hourly geocoder backstop.
 * Repairs stored service-address pins, never the customer's primary address.
 * Provider lookups happen before locks; a changed appointment is retried later.
 * No dates, promises, statuses, assignments or customer communications change.
 */
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { toDateStr } = require('./auto-dispatch/dates');
const { geocodeAddressWithStatus } = require('./geocoder');
const { guardedCoordSelects } = require('./scheduling/day-stops');
const { lockTechDays } = require('./scheduling/tech-day-lock');
const { recordAuditEvent } = require('./audit-log');

const ADDRESS_COLUMNS = ['service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip'];
const SNAPSHOT_COLUMNS = ['id', 'customer_id', 'property_id', 'technician_id', 'scheduled_date', 'status',
  'visit_id', 'lat', 'lng', 'auto_dispatch_locked', 'auto_dispatch_excluded', 'reservation_expires_at', ...ADDRESS_COLUMNS];
const enabled = () => ['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR'].every(gateEnvValue);
// Same permanent-address exclusion policy as the customer backstop. A changed
// stamp is eligible again, and unresolved early rows cannot starve later stops.
const unresolved = new Map();
const fingerprint = row => JSON.stringify(SNAPSHOT_COLUMNS.map(column => column === 'scheduled_date' ? toDateStr(row[column]) : row[column]));

async function pruneUnresolved(conn) {
  while (unresolved.size > 2000) unresolved.delete(unresolved.keys().next().value);
  if (!unresolved.size) return;
  const rows = await conn('scheduled_services').whereIn('id', [...unresolved.keys()]).select(SNAPSHOT_COLUMNS);
  const current = new Map(rows.map(row => [row.id, fingerprint(row)]));
  for (const [id, stamp] of unresolved) if (current.get(id) !== stamp) unresolved.delete(id);
}

function candidatesQuery(conn, now) {
  // Canonical unclaimed holds have customer_id NULL, so this inner join is
  // their discriminator. Do not filter reservation_expires_at: a committed
  // customer visit can carry a stray expiry and still needs its route pin.
  const stops = conn('scheduled_services')
    .join('customers', 'customers.id', 'scheduled_services.customer_id')
    .whereNull('customers.deleted_at')
    .whereIn('scheduled_services.status', ['pending', 'confirmed'])
    .whereBetween('scheduled_services.scheduled_date', [etDateString(now), etDateString(addETDays(now, 30))])
    .whereRaw('NOT COALESCE(scheduled_services.auto_dispatch_locked, false) AND NOT COALESCE(scheduled_services.auto_dispatch_excluded, false)')
    .whereRaw('(scheduled_services.lat IS NULL OR scheduled_services.lng IS NULL OR scheduled_services.lat = 0 OR scheduled_services.lng = 0)')
    .whereRaw("NULLIF(btrim(scheduled_services.service_address_line1), '') IS NOT NULL")
    .select([...SNAPSHOT_COLUMNS.map(column => ['lat', 'lng'].includes(column)
      ? { [`stored_${column}`]: `scheduled_services.${column}` } : `scheduled_services.${column}`), ...guardedCoordSelects(conn)]);
  // A matching primary-address fallback already gives the route a usable pin.
  // Recover only locations the shared route reader actually considers missing.
  return conn.from(stops.as('stops')).whereRaw('(lat IS NULL OR lng IS NULL OR lat = 0 OR lng = 0)');
}

async function persistServicePin(conn, snapshot, location) {
  return conn.transaction(async trx => {
    await lockTechDays(trx, [{ techId: snapshot.technician_id, date: toDateStr(snapshot.scheduled_date) }]);
    if (!enabled()) return false;
    // Every input to the lookup and eligibility decision stays pinned. This
    // also refuses a concurrent map correction, start, cancellation or move.
    let write = trx('scheduled_services');
    for (const column of SNAPSHOT_COLUMNS) {
      const value = column === 'scheduled_date' ? toDateStr(snapshot[column]) : snapshot[column];
      write = value == null ? write.whereNull(column) : write.where(column, value);
    }
    const count = await write.update({ lat: location.lat, lng: location.lng, updated_at: trx.fn.now() });
    if (!count) return false;
    await recordAuditEvent({ actor_type: 'system', action: 'service_coordinates_recovered',
      resource_type: 'scheduled_service', resource_id: snapshot.id, critical: true, trx,
      metadata: { source: 'verified_service_address_geocode', property_id: snapshot.property_id,
        scheduled_date: toDateStr(snapshot.scheduled_date) } });
    if (!enabled()) throw Object.assign(new Error('Coordinate recovery disabled'), { code: 'COORDINATE_RECOVERY_DISABLED' });
    return true;
  });
}

/** dryRun lists only upcoming affected appointments; it does not geocode,
 * write, broadcast, or mutate the permanent-failure exclusions. */
async function sweepUngeocodedServices({ limit = 25, now = new Date(), dryRun = true } = {}, conn = db) {
  if (!dryRun && !enabled()) return { status: 'gate_off' };
  if (!dryRun) await pruneUnresolved(conn);
  const query = candidatesQuery(conn, now).whereNotIn('id', dryRun ? [] : [...unresolved.keys()]);
  const rows = (await query.orderBy('scheduled_date').orderBy('id').limit(limit))
    .map(row => ({ ...row, lat: row.stored_lat, lng: row.stored_lng }));
  const result = { status: 'dry_run', checked: rows.length, geocoded: 0, unresolved: 0, stale: 0, failed: 0,
    stops: rows.map(row => ({ id: row.id, date: toDateStr(row.scheduled_date), reason: 'missing_service_coordinates' })) };
  if (dryRun) return result;
  result.status = 'completed';
  const dates = new Set();
  for (const [index, row] of rows.entries()) {
    if (!enabled()) { result.status = 'gate_off'; break; }
    const stop = result.stops[index];
    try {
      // A divergent stamp must stand on its own: filling its missing city or
      // ZIP from the primary address could produce a valid pin at another home.
      const complete = ['service_address_line1', 'service_address_city', 'service_address_state', 'service_address_zip']
        .every(column => String(row[column] || '').trim());
      if (!complete) {
        stop.reason = 'incomplete_service_address';
        unresolved.set(row.id, fingerprint(row));
        result.unresolved += 1;
        continue;
      }
      const address = ADDRESS_COLUMNS.map(column => row[column]).filter(Boolean).join(', ');
      const { location, permanent } = await geocodeAddressWithStatus(address);
      if (!location) {
        stop.reason = permanent ? 'service_address_unresolved' : 'geocode_temporarily_unavailable';
        if (permanent) unresolved.set(row.id, fingerprint(row));
        result.unresolved += 1;
        continue;
      }
      if (await persistServicePin(conn, row, location)) {
        stop.reason = 'coordinates_recovered';
        result.geocoded += 1;
        dates.add(stop.date);
        // Publish the committed row immediately; collect dates so a batch
        // still repairs and reconciles each route only once. A socket error
        // cannot turn a committed pin into a failed repair or skip refresh.
        await require('./dispatch-assignment').emitDispatchJobUpdate({ jobId: row.id, qualityDates: dates })
          .catch(error => logger.error(`[geocoder] service refresh failed for ${row.id} (${error.code || 'broadcast_error'})`));
      } else {
        stop.reason = 'appointment_changed';
        result.stale += 1;
      }
    } catch (error) {
      stop.reason = 'recovery_failed';
      result.failed += 1;
      logger.error(`[geocoder] service recovery failed for ${row.id}`, { code: error.code });
    }
  }
  if (dates.size) await require('./scheduling/quality-after-change').refreshScheduleQualityAfterChange({ dates: [...dates], now }, conn);
  logger.info(`[geocoder] service backstop: checked=${result.checked} geocoded=${result.geocoded} unresolved=${result.unresolved} stale=${result.stale} failed=${result.failed}`);
  return result;
}

module.exports = { sweepUngeocodedServices };
