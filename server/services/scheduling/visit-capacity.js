// Version-2 allocations share an arrival anchor even when visit grouping is
// disabled. Their work still occupies the sum of the members after a rollback.
function allocationKey(row) {
  const mix = row.reservation_service_mix;
  if (mix?.version !== 2 || !Array.isArray(mix.allocatedServiceIds)
    || !mix.allocatedServiceIds.includes(row.id)) return null;
  const date = row.scheduled_date instanceof Date ? row.scheduled_date.toISOString().slice(0, 10)
    : String(row.scheduled_date || '').slice(0, 10);
  return JSON.stringify([mix.allocatedServiceIds.slice().sort(), row.customer_id,
    row.technician_id, date, String(row.window_start || '').slice(0, 5)]);
}

function minutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function occupiedRows(rows) {
  const totals = new Map();
  for (const row of rows) {
    const key = allocationKey(row);
    if (!key) continue;
    const span = (minutes(row.window_end) ?? 0) - (minutes(row.window_start) ?? 0);
    totals.set(key, (totals.get(key) || 0) + (Math.max(span, Number(row.estimated_duration_minutes) || 0) || 60));
  }
  return rows.map(row => {
    const startMin = minutes(row.window_start);
    const total = totals.get(allocationKey(row));
    return { ...row, startMin, endMin: total ? startMin + total
      : (minutes(row.window_end) ?? startMin + (Number(row.estimated_duration_minutes) || 60)) };
  });
}

module.exports = { allocationKey, occupiedRows };
