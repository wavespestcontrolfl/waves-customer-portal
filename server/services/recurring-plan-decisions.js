// Explicit series cancellation decisions share the renewal-action ledger.
// Call inside the transaction that stops recurrence; individual visit cancels
// must never call this. The maintenance lock serializes renewal actions.
async function recordRecurringSeriesStops(trx, rows, actorId = null) {
  const series = new Map(rows.map(row => [String(row.recurring_parent_id || row.id), row]));
  for (const parentId of [...series.keys()].sort()) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['recurring-series-maintenance', parentId]);
    const row = series.get(parentId);
    // The stop also settles old ending/lapse holds. Retained prepaid visits
    // must remain dispatchable without leaving an actionable renewal card.
    await trx('recurring_plan_alerts')
      .where({ recurring_parent_id: parentId, customer_id: row.customer_id })
      .whereNull('resolved_at')
      .update({ resolved_at: trx.fn.now(), resolved_action: 'cancel_series', resolved_by: actorId });
    await trx('recurring_plan_alerts').insert({
      recurring_parent_id: parentId,
      customer_id: row.customer_id,
      alert_type: 'plan_lapsed',
      recurring_pattern: row.recurring_pattern,
      resolved_at: trx.fn.now(),
      resolved_action: 'cancel_series',
      resolved_by: actorId,
    });
  }
}

module.exports = { recordRecurringSeriesStops };
