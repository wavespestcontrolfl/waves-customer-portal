/**
 * Service-line map LIVE (GATE_SERVICE_LINE_MAP=live, owner 2026-10-30, build 4),
 * estimate accept: a program added to the customer's picked trip no longer rides
 * the reserved visit's technician and hour when its own line belongs to someone
 * else (a pest + lawn accept used to put lawn on the pest technician in the same
 * slot).
 *
 * Returns null when today's copy stands: the gate is not live (no query), the
 * line has no technician set, or the line's pick is the reserved visit's own
 * technician. Otherwise { technicianId }: the program's own technician, or null
 * when nobody can take it that day. Reads only; a failed read keeps today's copy.
 * The read runs in its own savepoint (`database.transaction`): the accept passes
 * its transaction, and a PostgreSQL error (a statement timeout) would otherwise
 * abort it, so every later accept query would fail instead of falling back.
 */
const logger = require('../logger');

async function ownLineTechnicianForPromotedUnit(database, { row, unit, unitDate, reservedStart }) {
  const lineTechnician = require('./line-technician');
  if (!lineTechnician.lineMapLive()) return null;
  try {
    const pick = await database.transaction((sp) => lineTechnician.pickLineTechnician(sp, {
      serviceId: row.service_id || null,
      serviceKey: unit.catalogServiceKey || null,
      serviceType: row.service_type,
      date: unitDate,
      zip: row.service_address_zip || null,
      customerId: row.customer_id || null,
    }));
    if (!pick.mapped) return null;
    const reservedTech = reservedStart.technician_id;
    if (pick.technicianId && reservedTech && String(pick.technicianId) === String(reservedTech)) return null;
    return { technicianId: pick.technicianId || null };
  } catch (err) {
    logger.warn(`[estimate-converter] service-line map read failed, keeping the reserved visit's technician: ${err.message}`);
    return null;
  }
}

module.exports = { ownLineTechnicianForPromotedUnit };
