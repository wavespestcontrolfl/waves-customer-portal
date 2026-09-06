/** Shared arrival for a member still in its original combined work allocation. */
async function arrivalStartForService(conn, row) {
  if (!row?.id || !row.reservation_service_mix?.allocatedServiceIds) return row?.window_start || null;
  const result = await conn.raw('SELECT reservation_arrival_start(?) AS window_start', [row.id]);
  return result.rows[0]?.window_start || row.window_start || null;
}

module.exports = { arrivalStartForService };
