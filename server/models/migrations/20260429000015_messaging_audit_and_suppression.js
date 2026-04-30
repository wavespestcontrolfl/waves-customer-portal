/**
 * messaging_audit_log + messaging_suppression
 *
 * Two tables that anchor the customer-message-middleware (the
 * send_customer_message wrapper).
 *
 * messaging_audit_log — every send attempt the wrapper sees, blocked or
 *   sent. Records the resolved policy outcome (validators_passed,
 *   validators_failed, blocked_reason), the deterministic message
 *   fingerprint (body_hash, segment_count, encoding), and the consent
 *   basis at the moment of send. Bodies are NOT stored in full — only
 *   a sha256 hash plus a 240-char preview, mirroring the existing
 *   sms_log + agent_messages retention patterns. Recipient phone is
 *   stored as last4 + sha256(full) so an exfiltrated audit dump
 *   doesn't leak SMS recipients.
 *
 * messaging_suppression — the application-side opt-out / wrong-number
 *   suppression list, keyed on phone. Carriers handle the real STOP
 *   semantics; this list lets us short-circuit in our own code and
 *   survives a Twilio-side mishap. STOP / "stop texting me" / "wrong
 *   number" / "do not contact me" all land here. START on the inbound
 *   webhook clears the row (active=false, cleared_at set).
 *
 * Both tables are read by server/services/messaging/* — see
 * validators/suppression.js and audit.js.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('messaging_suppression', (t) => {
    t.string('phone', 32).primary();
    t.string('reason', 40).notNullable();
    //   opt_out_keyword
    //   opt_out_natural_language
    //   wrong_number
    //   manual_dnc
    //   other
    t.boolean('active').notNullable().defaultTo(true);
    t.string('source', 80).nullable();
    //   e.g. 'twilio_webhook_STOP', 'admin_manual', 'voice_agent_optout'
    t.text('captured_body').nullable();
    //   the inbound text that triggered it (capped 1000 chars upstream)
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('cleared_at', { useTz: true }).nullable();

    t.index(['active', 'reason'], 'idx_msg_suppression_active_reason');
  });

  await knex.schema.createTable('messaging_audit_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Recipient — never the raw phone in plaintext
    t.string('to_hash', 64).notNullable();           // sha256(E.164 phone)
    t.string('to_last4', 4).notNullable();           // last 4 digits of recipient — for operator debugging

    // Linkage (nullable — anonymous lead replies have no customer/lead id yet)
    t.uuid('customer_id').nullable();
    t.uuid('lead_id').nullable();
    t.string('invoice_id', 64).nullable();
    t.string('estimate_id', 64).nullable();
    t.string('appointment_id', 64).nullable();

    // Policy resolution
    t.string('audience', 16).notNullable();          // customer | lead | internal | tech | admin
    t.string('purpose', 32).notNullable();           // see policy.MESSAGE_PURPOSES
    t.string('channel', 16).notNullable();           // sms | email | portal_chat | website_chat
    t.string('entry_point', 32).nullable();
    t.string('identity_trust_level', 32).nullable();

    // Body fingerprint — never stored in full
    t.string('body_hash', 64).notNullable();
    t.string('body_preview', 240).nullable();        // first 240 chars only — same retention shape as sms_log
    t.integer('segment_count').nullable();
    t.string('encoding', 8).nullable();              // GSM_7 | UCS_2

    // Consent context at send time
    t.string('consent_status', 24).nullable();       // opted_in | transactional_allowed | unknown | opted_out
    t.string('consent_source', 80).nullable();
    t.string('consent_campaign', 80).nullable();

    // Validator outcome
    t.specificType('validators_passed', 'text[]').notNullable().defaultTo('{}');
    t.specificType('validators_failed', 'text[]').notNullable().defaultTo('{}');
    t.string('blocked_code', 40).nullable();         // null when sent
    t.text('blocked_reason').nullable();

    // Provider outcome
    t.string('provider', 24).nullable();             // twilio | gmail | internal
    t.string('provider_message_id', 64).nullable();
    t.timestamp('sent_at', { useTz: true }).nullable();
    t.text('provider_error').nullable();

    // Free-form metadata for forensics
    t.jsonb('metadata').nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['audience', 'purpose'], 'idx_msg_audit_audience_purpose');
    t.index(['blocked_code'], 'idx_msg_audit_blocked');
    t.index(['customer_id'], 'idx_msg_audit_customer');
    t.index(['created_at'], 'idx_msg_audit_created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('messaging_audit_log');
  await knex.schema.dropTableIfExists('messaging_suppression');
};
