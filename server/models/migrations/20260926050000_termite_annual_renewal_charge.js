/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN).
 *
 * annual_prepay_terms.renewal_charge_attempted_at — the at-most-once fence
 * for the ONE automatic Stripe attempt the renewal-charge job makes against
 * a newly-minted renewal successor term. Stamped (via a conditional
 * `WHERE renewal_charge_attempted_at IS NULL` UPDATE) BEFORE the Stripe call
 * — never after — so a crash mid-charge, a concurrent double run of the
 * daily sweep, or a retried tick can never re-attempt the charge once this
 * is set. There is no automatic retry (owner ruling A-13: "never charge
 * twice" outranks "always collect"). Additive, nullable — every existing
 * term (which never went through this job) leaves it null.
 *
 * annual_prepay_terms.renewal_lapse_started_at /
 * annual_prepay_terms.renewal_lapse_completed_at — Codex round-2 P1:
 * persisted PROVENANCE for the grace-lapse pass, so recovery never has to
 * INFER "this cancelled successor is a confirmed grace lapse" from
 * status='cancelled' alone (which a staff void, a removed annual-prepay
 * flag, or a lost dispute can ALSO produce). started_at is stamped in its
 * own committed write BEFORE the invoice void is even attempted; completed_at
 * is stamped only once BOTH the station-retrieval task and the parent's
 * decided-lapse stamp have actually succeeded. The recovery pass reconciles
 * ONLY rows with started_at set and completed_at still null — it never
 * touches any other cancelled successor. Additive, nullable.
 *
 * annual_prepay_terms.renewal_charge_skipped_at /
 * annual_prepay_terms.renewal_charge_skip_reason — Codex round-4 P1: the
 * SAME persisted-provenance principle applied to decideAndCharge's own
 * pre-fence skips (no_consent / no_method / surcharge_not_authorized /
 * ineligible) — every one of these leaves renewal_charge_attempted_at NULL
 * (the Stripe-attempt fence is never claimed), which is exactly what
 * reconcileStuckSuccessors' leg 7a scans for. Without a persisted marker,
 * that scan can only tell "already handled" apart from "genuinely never
 * ran" by an inference over the notifications table (a LIKE on the bell's
 * own dedupeKey) checked AFTER the row is already selected under LIMIT — a
 * backlog of old, already-belled skips then starves newer crash-gap rows
 * from ever being reached. Stamped once, in decideAndCharge itself, the
 * moment any of those skips fires; the scan excludes on the column
 * directly in SQL instead. Additive, nullable.
 *
 * annual_prepay_terms.renewal_lapse_outcome — Codex round-5 P0: what a
 * COMPLETED lapse (renewal_lapse_completed_at set) actually was —
 * 'lapsed' (the invoice was genuinely voided and station retrieval was
 * requested) or 'retired_settled' (the invoice/successor turned out to
 * already be settled — by account credit, which voidInvoice's own
 * assertInvoiceVoidable deliberately allows voiding, or by a card
 * payment landing in the gap between the lapse starting and the void
 * actually running — so NO void and NO retrieval happened; the
 * settlement's own sync already decided the parent correctly). Additive,
 * nullable; only ever read for reporting/audit, never branched on by any
 * sweep pass (renewal_lapse_completed_at alone is what excludes a row
 * from recovery, regardless of which outcome it carries).
 *
 * annual_prepay_terms.renewal_exception_belled_at /
 * annual_prepay_terms.renewal_exception_kind — Codex round-5 P1: the SAME
 * persisted-exclusion principle applied to the three exception-bell scans
 * (bellNoWitnessTerms / bellUnanchoredOriginalTerms / bellStaleOverdueTerms).
 * Each scan orders by term_end and takes the oldest LIMIT rows; a bell's own
 * dedupeKey suppresses a REPEAT notification but does nothing to shrink the
 * scan's own candidate set, so once more than LIMIT terms sit in one
 * exception bucket, the oldest LIMIT keep being reselected and skipped
 * (via dedupe) every tick while any NEWER term past LIMIT never gets
 * scanned, hence never gets its required staff alert. Stamped once a
 * term's exception bell has actually been asked for (whether it fired
 * fresh or deduped from a prior tick — either way staff has been told),
 * and excluded on the column directly in each scan's SQL. A term whose
 * underlying condition is later fixed (e.g. staff anchors the
 * installation) simply stops matching that scan's OWN where-clauses on
 * the next tick regardless of this stamp — the stamp only suppresses
 * re-scanning the SAME still-broken condition, never a term's eligibility
 * for minting/charging once fixed. Additive, nullable.
 *
 * sms_templates row `termite_annual_renewal_charge_failed` — the customer
 * notice queued when the renewal charge declines or the outcome is
 * ambiguous (never for a no-consent/no-method skip, where nothing was ever
 * attempted against Stripe). Same upsert-by-key shape as every other
 * annual-prepay template seed in this file's lineage (see
 * 20260614000001_annual_prepay_terms_checks.js) — column-guarded so this
 * runs safely on a database missing is_active/sort_order.
 */

const TEMPLATE_KEY = 'termite_annual_renewal_charge_failed';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_attempted_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_charge_attempted_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_lapse_started_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_lapse_started_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_lapse_completed_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_lapse_completed_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_skipped_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_charge_skipped_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_skip_reason'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.text('renewal_charge_skip_reason');
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_lapse_outcome'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.text('renewal_lapse_outcome');
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_exception_belled_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_exception_belled_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_exception_kind'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.text('renewal_exception_kind');
      });
    }
  }

  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    const now = new Date();
    const template = {
      template_key: TEMPLATE_KEY,
      name: 'Termite Annual Renewal — Charge Failed',
      category: 'billing',
      body: "Hi {first_name}, we tried to charge your card on file ${amount} to renew your Waves Subterranean Termite Protection plan, but it didn't go through. Please pay here to keep your coverage active: {pay_url}.\n\nQuestions or need help? Just reply to this message.",
      variables: JSON.stringify(['first_name', 'amount', 'pay_url']),
      ...(cols.is_active ? { is_active: true } : {}),
      ...(cols.sort_order ? { sort_order: 51 } : {}),
      ...(cols.updated_at ? { updated_at: now } : {}),
      ...(cols.created_at ? { created_at: now } : {}),
    };

    const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
    if (existing) {
      await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).update({
        name: template.name,
        category: template.category,
        body: template.body,
        variables: template.variables,
        ...(cols.is_active ? { is_active: true } : {}),
        ...(cols.updated_at ? { updated_at: now } : {}),
      });
    } else {
      await knex('sms_templates').insert(template);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).del();
  }

  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_attempted_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_charge_attempted_at');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_lapse_started_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_lapse_started_at');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_lapse_completed_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_lapse_completed_at');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_skipped_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_charge_skipped_at');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_skip_reason')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_charge_skip_reason');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_lapse_outcome')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_lapse_outcome');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_exception_belled_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_exception_belled_at');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_exception_kind')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_exception_kind');
      });
    }
  }
};
