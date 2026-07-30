/**
 * Form-independent one-time exclusion for Pest Pressure (codex r5/r6 on
 * #3081): a one-time billing profile (tick control, fire ant, nest
 * removals, initial cleanouts…) must not create or surface recurring
 * pressure history — the 2026-07-30 untype migration removed the typed-form
 * gate that used to catch these, and review-window's isOneTimeServiceLabel
 * only recognizes explicit "one-time"/"single visit" labels.
 *
 * Deliberate exception (review-window.js isOneTimeServiceLabel note):
 * re-service/callback visits are extra visits on an active recurring plan
 * and still deserve a score — pest_re_service and is_callback records are
 * never excluded here.
 *
 * Fail-open on lookup errors: exclusion is a pollution guard, not a
 * security boundary — a transient profile-lookup failure must not hide a
 * legitimate recurring customer's pressure card.
 */

const db = require('../../models/db');
const { resolveCompletionProfileForScheduledService } = require('../service-completion-profiles');

async function isOneTimePressureExcludedRecord(serviceRecord, knex = db) {
  try {
    if (!serviceRecord) return false;
    if (serviceRecord.is_callback) return false;
    const scheduledServiceId = serviceRecord.scheduled_service_id;
    if (!scheduledServiceId) return false;
    const svc = await knex('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'service_id', 'service_type');
    if (!svc) return false;
    const profile = await resolveCompletionProfileForScheduledService(svc, knex);
    return String(profile?.billingType || '').toLowerCase() === 'one_time'
      && profile?.serviceKey !== 'pest_re_service';
  } catch {
    return false;
  }
}

module.exports = { isOneTimePressureExcludedRecord };
