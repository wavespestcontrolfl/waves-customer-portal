// server/services/recurring-series-extend.js
//
// Post-completion recurring-series maintenance bridge.
//
// The auto-extend / plan-ending logic itself lives in
// routes/admin-schedule.js (runRecurringSeriesMaintenance), alongside the
// helper web it shares with the recurring-alert extend/convert actions and
// the stored-financials stamping rules — duplicating it here would fork
// those rules. This module exposes it to the dispatch completion routes
// (POST /api/admin/dispatch/:serviceId/complete and the completed branch of
// PUT /api/admin/dispatch/:serviceId/status), which are the paths field
// completions actually flow through; without this hook the refill logic was
// dead code and exhausted ongoing plans got no future visits and no alert.
//
// The require is lazy (inside the function) to avoid a route-load cycle:
// admin-schedule and admin-dispatch both load at boot, and admin-schedule
// is the module that owns the maintenance function.
//
// Failure-isolated BY CONTRACT: this function never throws. A failed extend
// must never fail a completion that already committed.
const logger = require('./logger');

async function runPostCompletionSeriesMaintenance({ db, svc, source = 'completion' } = {}) {
  if (!db || !svc || !svc.id) return;
  try {
    const { runRecurringSeriesMaintenance } = require('../routes/admin-schedule');
    if (typeof runRecurringSeriesMaintenance !== 'function') {
      logger.warn('[recurring-series-extend] runRecurringSeriesMaintenance export missing — skipping');
      return;
    }
    await runRecurringSeriesMaintenance(db, svc);
  } catch (e) {
    logger.error(`[recurring-series-extend] post-completion series maintenance failed (${source}, service=${svc.id}): ${e.message}`);
  }
}

module.exports = { runPostCompletionSeriesMaintenance };
