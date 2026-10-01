/**
 * Email division — automation catalog rows for the templates 20260928235000
 * seeded (the WIRING PR's seed; nothing here sends).
 *
 * That migration deliberately wrote templates only: the executor used to
 * dispatch straight through sendTemplate, and its marketing streams were
 * fenced (ledger_required). The executor now routes the email division's own
 * keys (nurture.* / lc.*) through email-division/ledger.js sendWithLedger and
 * builds their payloads (email-division/payload-builders.js), so the catalog
 * rows can exist. They exist PAUSED:
 *   - status 'paused' — loadAutomations reads 'active' only, and executeRun
 *     settles any non-active automation skipped, so no trigger creates a run;
 *   - the templates stay DRAFT (assertTemplateSendable refuses anything but
 *     'active'), so a send is refused a second way;
 *   - GATE_EMAIL_TEMPLATE_AUTOMATIONS (off / shadow / live) gates the whole
 *     executor on top of both.
 * Turning any of these on is three deliberate acts (publish the template,
 * activate the row, flip the gate), never a side effect of this file.
 *
 * Three rows; the fourth template is deliberately NOT here:
 *   lc.first_visit_pest  <- visit.completed_first (mapped in the executor;
 *                           emitter emitVisitCompletedFirst, no caller yet)
 *   lc.why_91_days       <- service_report.ready  (mapped; a service record;
 *                           the payload builder admits only the customer's
 *                           second quarterly pest visit, once per customer)
 *   nurture.expired_1    <- estimate.expired      (mapped AND emitted today)
 *   lc.rain_and_treatment — NO row: no rain / weather trigger exists (none is
 *                           mapped, emitted or catalogued anywhere) and this
 *                           lane invents none. Its wiring contract (Talak
 *                           7.9% F only, NOAA + NWS sentences) waits for a
 *                           real trigger.
 *
 * Insert-once, never update (same rule as 20260928235000, for the same
 * reason: an operator edit through the admin UI must never be reverted by a
 * re-run). A row is skipped when its automation_key already exists or when
 * its template row is missing (the FK is RESTRICT). One critical
 * `email_template_automation.seeded` audit_log event per row actually
 * INSERTED, recorded on the migration's own knex exactly like the template
 * seed's `email_template.seeded`. down() is a documented no-op (waves-db §4):
 * a rollback must never delete a row an operator has since edited or
 * activated.
 *
 * Every idempotency key is PII-free and built from ids (and one ET date) the
 * trigger context always carries (executor contextFor: the payload, recipient_id, entity_id
 * and `<entity type>_id`). The same key is the marketing ledger's
 * reservation key for the run, and the email_messages key.
 */

const MIGRATION = '20260930200000_seed_email_division_automations';

const RETRY_POLICY = { max_attempts: 2, backoff_minutes: [15, 60] };

const AUTOMATIONS = [
  {
    automation_key: 'lc.first_visit_pest',
    name: 'Pest Control · First Visit Follow-Up',
    description: 'Sent after a customer\'s first performed pest visit: what was done, what was recorded, how to reach us between visits. Paused; the payload builder re-checks that it really is the first performed, customer-visible pest visit.',
    trigger_event_key: 'visit.completed_first',
    trigger_description: 'A customer\'s first performed visit on the pest line has been completed.',
    template_key: 'lc.first_visit_pest',
    delay_minutes: 0,
    audience: 'customer',
    legal_classification: 'transactional_relationship',
    frequency_cap: 'once_per_entity',
    // One email per completed visit record; the builder also refuses any
    // visit that is not the customer's first performed pest visit.
    idempotency_key_template: 'lc.first_visit_pest:{service_record_id}',
    conditions: {},
    exit_conditions: {},
    dry_run_notes: 'No producer emits visit.completed_first yet (emitVisitCompletedFirst has no caller). Shadow first, then activate.',
  },
  {
    automation_key: 'lc.why_91_days',
    name: 'Pest Control · Why 91 Days',
    description: 'Explains the quarterly cadence from Waves\' own visit records. Sent once per customer, after the second pest visit, only when the plan\'s non-repellent is Taurus SC and the activity averages come from a cohort of at least 20 rated visits; otherwise the run is skipped.',
    trigger_event_key: 'service_report.ready',
    trigger_description: 'A service report is ready for a completed visit; the payload builder admits only the customer\'s second quarterly pest visit.',
    template_key: 'lc.why_91_days',
    delay_minutes: 0,
    audience: 'customer',
    legal_classification: 'transactional_relationship',
    frequency_cap: 'once_per_customer',
    // Per EVENT (one report), never per customer: the first visit's report
    // arrives first and the builder skips it (not the second visit), so a
    // per-customer key would be consumed by that skipped run and the second
    // visit's report would dedupe against it and never run. Once per customer
    // is enforced at send time instead: the builder skips a customer with a
    // sent or in-flight lc.why_91_days run or ledger row.
    idempotency_key_template: 'lc.why_91_days:{service_record_id}',
    conditions: {},
    exit_conditions: {},
    dry_run_notes: 'service_report.ready is mapped in the executor but no producer emits it through processTrigger yet (the report email sends directly). Shadow first, then activate.',
  },
  {
    automation_key: 'nurture.expired_1',
    name: 'Nurture · Estimate Expired (Touch 1)',
    description: 'One touch after an estimate expires: the estimate is saved, one question. Marketing stream; sends only through the email division ledger (eligibility, caps, reservation). Three days after expiry so the estimate page can have been extended first.',
    trigger_event_key: 'estimate.expired',
    trigger_description: 'An estimate reached its expiry date and was flipped to expired.',
    template_key: 'nurture.expired_1',
    // Three days (4320 minutes): the template copy assumes the estimate page
    // has already told the customer the estimate lapsed. The executor
    // re-checks at send time that the estimate is still expired and not
    // archived, so an extension in the window cancels the run.
    delay_minutes: 4320,
    audience: 'lead',
    legal_classification: 'commercial_marketing',
    frequency_cap: 'once_per_entity',
    // Per EXPIRY (estimate + its expiry date), not per estimate: an estimate
    // extended inside the delay is skipped (no longer expired), and a per-
    // estimate key would let that skipped run swallow the estimate's next
    // expiry. One touch per estimate is enforced at send time: the builder
    // skips an estimate that already has a sent or in-flight touch.
    idempotency_key_template: 'nurture.expired_1:{estimate_id}:{expires_on}',
    conditions: {},
    exit_conditions: { stop_if: ['estimate.accepted', 'estimate.archived'] },
    dry_run_notes: 'Marketing stream: the ledger is the only send path. consultation_url stays blank while the shared consultation eligibility refuses an expired estimate.',
  },
];

function rowFor(automation, template) {
  return {
    automation_key: automation.automation_key,
    name: automation.name,
    description: automation.description,
    trigger_event_key: automation.trigger_event_key,
    trigger_description: automation.trigger_description,
    template_key: automation.template_key,
    delay_minutes: automation.delay_minutes,
    audience: automation.audience,
    // PAUSED: not runnable (loadAutomations reads 'active' only).
    status: 'paused',
    suppression_group_key: template.suppression_group_key || template.send_stream || null,
    legal_classification: automation.legal_classification,
    frequency_cap: automation.frequency_cap,
    idempotency_key_template: automation.idempotency_key_template,
    conditions: JSON.stringify(automation.conditions),
    exit_conditions: JSON.stringify(automation.exit_conditions),
    retry_policy: JSON.stringify(RETRY_POLICY),
    quiet_hours: JSON.stringify({ enabled: false }),
    timezone: 'America/New_York',
    owner: 'email_division',
    dry_run_notes: automation.dry_run_notes,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

async function seedAutomation(knex, automation) {
  const existing = await knex('email_template_automations')
    .where({ automation_key: automation.automation_key })
    .first('id');
  if (existing) return;

  const template = await knex('email_templates')
    .where({ template_key: automation.template_key })
    .first('template_key', 'suppression_group_key', 'send_stream');
  if (!template) return;

  const [inserted] = await knex('email_template_automations')
    .insert(rowFor(automation, template))
    .returning('*');

  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template_automation.seeded',
      resource_type: 'email_template_automation',
      resource_id: inserted.id,
      metadata: { automationKey: automation.automation_key, templateKey: automation.template_key, migration: MIGRATION },
      trx: knex,
      critical: true,
    });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_template_automations'))
    || !(await knex.schema.hasTable('email_templates'))) return;
  for (const automation of AUTOMATIONS) {
    await seedAutomation(knex, automation);
  }
};

// Documented no-op (waves-db §4): never delete-by-key on rollback — an
// operator may have edited or activated one of these rows since it ran.
exports.down = async function down() {};

exports.AUTOMATIONS = AUTOMATIONS;
exports.__private = { AUTOMATIONS, rowFor };
