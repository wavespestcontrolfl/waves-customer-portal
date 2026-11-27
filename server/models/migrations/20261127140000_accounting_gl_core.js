/**
 * Accounting Core (QuickBooks-style double-entry General Ledger — GATE_ACCOUNTING_GL).
 *
 * Tables:
 * - gl_accounts:       Chart of Accounts (Assets, Liabilities, Equity, Revenue, COGS, Expenses)
 * - gl_periods:        Monthly accounting periods with hard DB-enforced lock triggers
 * - gl_vendors:        Vendor master with W-9 / 1099-NEC tracking & app-encrypted TIN
 * - gl_reconciliations: Bank / credit-card / clearing statement reconciliation sessions
 * - gl_journal_entries: Immutable double-entry journal headers (unique idempotency_key)
 * - gl_journal_lines:  Strict integer-cent debit/credit lines + deferred balance trigger
 *
 * Hard DB invariants:
 * 1. Every gl_journal_lines row has strictly positive debit_cents OR credit_cents (never both/zero).
 * 2. Every committed posted gl_journal_entries row has >= 2 lines and SUM(debit_cents) = SUM(credit_cents)
 *    via a DEFERRABLE INITIALLY DEFERRED constraint trigger.
 * 3. Locked periods in gl_periods reject INSERT/UPDATE/DELETE on entries and lines in that month.
 * 4. Lines attached to a finalized ('reconciled') gl_reconciliations row cannot be silently modified.
 */

const { SYSTEM_ACCOUNTS } = require('../../services/accounting/coa-seed');

exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // ── 1. Chart of Accounts ─────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('gl_accounts'))) {
    await knex.schema.createTable('gl_accounts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('code', 16).notNullable().unique();
      t.string('name', 120).notNullable();
      t.string('account_type', 20).notNullable();
      t.string('sub_type', 40).notNullable();
      t.string('normal_balance', 10).notNullable();
      t.uuid('parent_account_id').references('id').inTable('gl_accounts').onDelete('SET NULL');
      t.uuid('expense_category_id').references('id').inTable('expense_categories').onDelete('SET NULL');
      t.uuid('plaid_account_id').references('id').inTable('plaid_accounts').onDelete('SET NULL');
      t.string('schedule_c_line', 16);
      t.string('form_1120s_line', 16);
      t.integer('deductible_pct').notNullable().defaultTo(100);
      t.boolean('is_system').notNullable().defaultTo(false);
      t.boolean('active').notNullable().defaultTo(true);
      t.text('description');
      t.integer('sort_order').notNullable().defaultTo(0);
      t.timestamps(true, true);

      t.index('account_type');
      t.index('sub_type');
      t.index('expense_category_id');
      t.index('plaid_account_id');
    });

    await knex.raw(`
      ALTER TABLE gl_accounts
      ADD CONSTRAINT gl_accounts_type_check
        CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense')),
      ADD CONSTRAINT gl_accounts_normal_balance_check
        CHECK (normal_balance IN ('debit', 'credit')),
      ADD CONSTRAINT gl_accounts_deductible_pct_check
        CHECK (deductible_pct >= 0 AND deductible_pct <= 100)
    `);
  }

  // ── 2. Accounting Periods (Close the Books) ──────────────────────────────
  if (!(await knex.schema.hasTable('gl_periods'))) {
    await knex.schema.createTable('gl_periods', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('period_month', 7).notNullable().unique();
      t.string('status', 16).notNullable().defaultTo('open');
      t.timestamp('closed_at', { useTz: true });
      t.uuid('closed_by');
      t.timestamp('locked_at', { useTz: true });
      t.uuid('locked_by');
      t.timestamp('reopened_at', { useTz: true });
      t.uuid('reopened_by');
      t.text('notes');
      t.timestamps(true, true);

      t.index('status');
    });

    await knex.raw(`
      ALTER TABLE gl_periods
      ADD CONSTRAINT gl_periods_month_format_check
        CHECK (period_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      ADD CONSTRAINT gl_periods_status_check
        CHECK (status IN ('open', 'soft_closed', 'locked'))
    `);
  }

  // ── 3. Vendors (Vendor Master & 1099 / W-9 Tracking) ─────────────────────
  if (!(await knex.schema.hasTable('gl_vendors'))) {
    await knex.schema.createTable('gl_vendors', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('display_name', 160).notNullable();
      t.string('legal_name', 200);
      t.string('entity_type', 30).notNullable().defaultTo('unknown');
      t.boolean('is_1099_eligible').notNullable().defaultTo(false);
      t.date('w9_received_at');
      t.string('tin_last4', 4);
      t.text('tin_enc');
      t.uuid('default_account_id').references('id').inTable('gl_accounts').onDelete('SET NULL');
      t.string('email', 200);
      t.string('phone', 40);
      t.string('address_line1', 200);
      t.string('city', 100);
      t.string('state', 20);
      t.string('zip', 20);
      t.boolean('active').notNullable().defaultTo(true);
      t.text('notes');
      t.timestamps(true, true);

      t.index('is_1099_eligible');
      t.index('active');
    });

    await knex.raw(`
      ALTER TABLE gl_vendors
      ADD CONSTRAINT gl_vendors_entity_type_check
        CHECK (entity_type IN ('individual', 'sole_prop', 'single_member_llc', 'partnership', 's_corp', 'c_corp', 'government', 'unknown'))
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS gl_vendors_display_name_lower_uniq
        ON gl_vendors (lower(trim(display_name)))
    `);
  }

  // ── 4. Reconciliations (Bank & Credit Card Statements) ───────────────────
  if (!(await knex.schema.hasTable('gl_reconciliations'))) {
    await knex.schema.createTable('gl_reconciliations', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('account_id').notNullable().references('id').inTable('gl_accounts').onDelete('RESTRICT');
      t.date('statement_start_date');
      t.date('statement_end_date').notNullable();
      t.bigInteger('opening_balance_cents').notNullable().defaultTo(0);
      t.bigInteger('ending_balance_cents').notNullable();
      t.bigInteger('cleared_balance_cents').notNullable().defaultTo(0);
      t.bigInteger('difference_cents').notNullable().defaultTo(0);
      t.integer('cleared_line_count').notNullable().defaultTo(0);
      t.string('status', 16).notNullable().defaultTo('in_progress');
      t.timestamp('reconciled_at', { useTz: true });
      t.uuid('reconciled_by');
      t.timestamp('reopened_at', { useTz: true });
      t.uuid('reopened_by');
      t.text('notes');
      t.timestamps(true, true);

      t.index(['account_id', 'statement_end_date']);
      t.index('status');
    });

    await knex.raw(`
      ALTER TABLE gl_reconciliations
      ADD CONSTRAINT gl_reconciliations_status_check
        CHECK (status IN ('in_progress', 'reconciled', 'reopened'))
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS gl_reconciliations_one_open_per_acct_uniq
        ON gl_reconciliations (account_id)
        WHERE status = 'in_progress'
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS gl_reconciliations_account_end_reconciled_uniq
        ON gl_reconciliations (account_id, statement_end_date)
        WHERE status = 'reconciled'
    `);
  }

  // ── 5. Journal Entries (Immutable Headers) ───────────────────────────────
  if (!(await knex.schema.hasTable('gl_journal_entries'))) {
    await knex.schema.createTable('gl_journal_entries', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.bigIncrements('entry_number').notNullable().unique();
      t.date('entry_date').notNullable();
      t.string('entry_type', 24).notNullable().defaultTo('operational');
      t.string('basis_scope', 16).notNullable().defaultTo('both');
      t.string('source_type', 40).notNullable().defaultTo('manual');
      t.string('source_id', 120);
      t.string('idempotency_key', 200).unique();
      t.string('status', 16).notNullable().defaultTo('posted');
      t.uuid('reverses_entry_id').references('id').inTable('gl_journal_entries').onDelete('RESTRICT');
      t.uuid('reversed_by_entry_id').references('id').inTable('gl_journal_entries').onDelete('SET NULL');
      t.string('memo', 500).notNullable();
      t.string('reference', 120);
      t.uuid('created_by');
      t.timestamp('voided_at', { useTz: true });
      t.uuid('voided_by');
      t.string('void_reason', 300);
      t.timestamps(true, true);

      t.index('entry_date');
      t.index(['source_type', 'source_id']);
      t.index('status');
      t.index('entry_type');
    });

    await knex.raw(`
      ALTER TABLE gl_journal_entries
      ADD CONSTRAINT gl_journal_entries_type_check
        CHECK (entry_type IN ('operational', 'adjusting', 'opening_balance', 'depreciation', 'transfer', 'reversal', 'closing')),
      ADD CONSTRAINT gl_journal_entries_basis_check
        CHECK (basis_scope IN ('both', 'accrual_only', 'cash_only')),
      ADD CONSTRAINT gl_journal_entries_status_check
        CHECK (status IN ('posted', 'voided'))
    `);
  }

  // ── 6. Journal Lines (Strict Integer-Cent Debits & Credits) ──────────────
  if (!(await knex.schema.hasTable('gl_journal_lines'))) {
    await knex.schema.createTable('gl_journal_lines', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('entry_id').notNullable().references('id').inTable('gl_journal_entries').onDelete('CASCADE');
      t.integer('line_order').notNullable().defaultTo(0);
      t.uuid('account_id').notNullable().references('id').inTable('gl_accounts').onDelete('RESTRICT');
      t.bigInteger('debit_cents').notNullable().defaultTo(0);
      t.bigInteger('credit_cents').notNullable().defaultTo(0);
      t.string('memo', 300);
      t.uuid('customer_id');
      t.uuid('vendor_id').references('id').inTable('gl_vendors').onDelete('SET NULL');
      t.string('service_line', 40);
      t.string('invoice_ref', 120);
      t.uuid('scheduled_service_id');
      t.uuid('bank_transaction_id');
      t.uuid('reconciliation_id').references('id').inTable('gl_reconciliations').onDelete('SET NULL');
      t.timestamp('cleared_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index('entry_id');
      t.index('account_id');
      t.index('vendor_id');
      t.index('customer_id');
      t.index('invoice_ref');
      t.index('bank_transaction_id');
      t.index('reconciliation_id');
    });

    await knex.raw(`
      ALTER TABLE gl_journal_lines
      ADD CONSTRAINT gl_journal_lines_single_side_positive_check
        CHECK (
          debit_cents >= 0
          AND credit_cents >= 0
          AND ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
        )
    `);
  }

  // ── 7. Hard Postgres Invariant Triggers ──────────────────────────────────

  // 7a. Deferred Double-Entry Balance Constraint (runs at COMMIT)
  await knex.raw(`
    CREATE OR REPLACE FUNCTION gl_assert_entry_balanced()
    RETURNS TRIGGER AS $$
    DECLARE
      v_entry_id UUID;
      v_line_count INTEGER;
      v_debits BIGINT;
      v_credits BIGINT;
      v_status TEXT;
    BEGIN
      v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);
      SELECT status INTO v_status FROM gl_journal_entries WHERE id = v_entry_id;
      IF v_status IS NULL THEN
        RETURN NULL;
      END IF;

      SELECT COUNT(*), COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0)
        INTO v_line_count, v_debits, v_credits
        FROM gl_journal_lines
       WHERE entry_id = v_entry_id;

      IF v_line_count < 2 THEN
        RAISE EXCEPTION 'gl_journal_entry % must have at least 2 lines (found %)', v_entry_id, v_line_count
          USING ERRCODE = '23514';
      END IF;

      IF v_debits <> v_credits THEN
        RAISE EXCEPTION 'gl_journal_entry % is out of balance: debits=% credits=%', v_entry_id, v_debits, v_credits
          USING ERRCODE = '23514';
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_gl_lines_balanced ON gl_journal_lines;
    CREATE CONSTRAINT TRIGGER trg_gl_lines_balanced
      AFTER INSERT OR UPDATE OR DELETE ON gl_journal_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION gl_assert_entry_balanced();
  `);

  // 7b. Header-level deferred check so a bare header with 0 lines can never commit
  await knex.raw(`
    CREATE OR REPLACE FUNCTION gl_assert_header_has_balanced_lines()
    RETURNS TRIGGER AS $$
    DECLARE
      v_line_count INTEGER;
      v_debits BIGINT;
      v_credits BIGINT;
    BEGIN
      SELECT COUNT(*), COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0)
        INTO v_line_count, v_debits, v_credits
        FROM gl_journal_lines
       WHERE entry_id = NEW.id;

      IF v_line_count < 2 OR v_debits <> v_credits THEN
        RAISE EXCEPTION 'gl_journal_entry % failed balance check: lines=% debits=% credits=%',
          NEW.id, v_line_count, v_debits, v_credits
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_gl_entry_header_balanced ON gl_journal_entries;
    CREATE CONSTRAINT TRIGGER trg_gl_entry_header_balanced
      AFTER INSERT ON gl_journal_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION gl_assert_header_has_balanced_lines();
  `);

  // 7c. Period Lock Serialization Trigger on gl_periods + Period Lock Trigger on gl_journal_entries
  await knex.raw(`
    CREATE OR REPLACE FUNCTION gl_serialize_period_transition()
    RETURNS TRIGGER AS $$
    DECLARE
      v_month TEXT;
    BEGIN
      v_month := COALESCE(NEW.period_month, OLD.period_month);
      IF v_month IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtext('gl-period:' || v_month));
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_gl_periods_serialize ON gl_periods;
    CREATE TRIGGER trg_gl_periods_serialize
      BEFORE INSERT OR UPDATE OR DELETE ON gl_periods
      FOR EACH ROW
      EXECUTE FUNCTION gl_serialize_period_transition();
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION gl_enforce_period_lock_on_entry()
    RETURNS TRIGGER AS $$
    DECLARE
      v_month TEXT;
      v_old_month TEXT;
      v_first TEXT;
      v_second TEXT;
      v_locked BOOLEAN;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.entry_date = NEW.entry_date
         AND OLD.memo = NEW.memo
         AND OLD.status = NEW.status
         AND OLD.entry_type = NEW.entry_type
         AND OLD.basis_scope = NEW.basis_scope
         AND OLD.reversed_by_entry_id IS DISTINCT FROM NEW.reversed_by_entry_id THEN
        -- Allow linking a future-dated reversal back to an earlier entry without altering its figures.
        RETURN NEW;
      END IF;

      v_month := to_char(COALESCE(NEW.entry_date, OLD.entry_date), 'YYYY-MM');

      IF TG_OP = 'UPDATE' AND OLD.entry_date <> NEW.entry_date THEN
        v_old_month := to_char(OLD.entry_date, 'YYYY-MM');
        IF v_old_month <> v_month THEN
          v_first := LEAST(v_month, v_old_month);
          v_second := GREATEST(v_month, v_old_month);
          PERFORM pg_advisory_xact_lock(hashtext('gl-period:' || v_first));
          PERFORM pg_advisory_xact_lock(hashtext('gl-period:' || v_second));
        ELSE
          PERFORM pg_advisory_xact_lock(hashtext('gl-period:' || v_month));
        END IF;
      ELSE
        PERFORM pg_advisory_xact_lock(hashtext('gl-period:' || v_month));
      END IF;

      SELECT EXISTS(
        SELECT 1 FROM gl_periods WHERE period_month = v_month AND status = 'locked'
      ) INTO v_locked;

      IF v_locked THEN
        RAISE EXCEPTION 'Accounting period % is locked — post an adjusting or reversing entry in an open period', v_month
          USING ERRCODE = 'P0001';
      END IF;

      IF v_old_month IS NOT NULL AND v_old_month <> v_month THEN
        SELECT EXISTS(
          SELECT 1 FROM gl_periods WHERE period_month = v_old_month AND status = 'locked'
        ) INTO v_locked;
        IF v_locked THEN
          RAISE EXCEPTION 'Accounting period % is locked — cannot move entry out of a locked period', v_old_month
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_gl_entries_period_lock ON gl_journal_entries;
    CREATE TRIGGER trg_gl_entries_period_lock
      BEFORE INSERT OR UPDATE OR DELETE ON gl_journal_entries
      FOR EACH ROW
      EXECUTE FUNCTION gl_enforce_period_lock_on_entry();
  `);

  // 7d. Period Lock + Finalized Reconciliation Guard on gl_journal_lines
  await knex.raw(`
    CREATE OR REPLACE FUNCTION gl_enforce_line_immutability()
    RETURNS TRIGGER AS $$
    DECLARE
      v_entry_date DATE;
      v_month TEXT;
      v_locked BOOLEAN;
      v_rec_status TEXT;
    BEGIN
      SELECT entry_date INTO v_entry_date
        FROM gl_journal_entries
       WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);

      IF v_entry_date IS NOT NULL THEN
        v_month := to_char(v_entry_date, 'YYYY-MM');
        -- Allow toggling reconciliation_id/cleared_at only; money & account fields never mutate in locked periods.
        IF TG_OP <> 'UPDATE'
           OR OLD.account_id <> NEW.account_id
           OR OLD.debit_cents <> NEW.debit_cents
           OR OLD.credit_cents <> NEW.credit_cents
           OR OLD.entry_id <> NEW.entry_id THEN
          PERFORM pg_advisory_xact_lock(hashtext('gl-period:' || v_month));
          SELECT EXISTS(
            SELECT 1 FROM gl_periods WHERE period_month = v_month AND status = 'locked'
          ) INTO v_locked;
          IF v_locked THEN
            RAISE EXCEPTION 'Accounting period % is locked — journal lines cannot be changed', v_month
              USING ERRCODE = 'P0001';
          END IF;
        END IF;
      END IF;

      IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.reconciliation_id IS NOT NULL THEN
        SELECT status INTO v_rec_status FROM gl_reconciliations WHERE id = OLD.reconciliation_id;
        IF v_rec_status = 'reconciled' THEN
          RAISE EXCEPTION 'Journal line % belongs to a finalized reconciliation — reopen the reconciliation first', OLD.id
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_gl_lines_immutability ON gl_journal_lines;
    CREATE TRIGGER trg_gl_lines_immutability
      BEFORE INSERT OR UPDATE OR DELETE ON gl_journal_lines
      FOR EACH ROW
      EXECUTE FUNCTION gl_enforce_line_immutability();
  `);

  // ── 8. Seed Canonical Chart of Accounts & Map Existing Expense Categories ─
  const existingCats = (await knex.schema.hasTable('expense_categories'))
    ? await knex('expense_categories').select('id', 'name')
    : [];
  const catByLower = new Map(existingCats.map((c) => [String(c.name || '').trim().toLowerCase(), c.id]));

  for (const acct of SYSTEM_ACCOUNTS) {
    const matchedCatId = acct.legacy_category_name
      ? (catByLower.get(acct.legacy_category_name.toLowerCase()) || null)
      : null;
    await knex('gl_accounts')
      .insert({
        code: acct.code,
        name: acct.name,
        account_type: acct.account_type,
        sub_type: acct.sub_type,
        normal_balance: acct.normal_balance,
        expense_category_id: matchedCatId,
        schedule_c_line: acct.schedule_c_line || null,
        form_1120s_line: acct.form_1120s_line || null,
        deductible_pct: acct.deductible_pct ?? 100,
        is_system: true,
        active: true,
        description: acct.description || null,
        sort_order: acct.sort_order,
      })
      .onConflict('code')
      .ignore();
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS trg_gl_lines_immutability ON gl_journal_lines');
  await knex.raw('DROP FUNCTION IF EXISTS gl_enforce_line_immutability()');
  await knex.raw('DROP TRIGGER IF EXISTS trg_gl_entries_period_lock ON gl_journal_entries');
  await knex.raw('DROP FUNCTION IF EXISTS gl_enforce_period_lock_on_entry()');
  await knex.raw('DROP TRIGGER IF EXISTS trg_gl_periods_serialize ON gl_periods');
  await knex.raw('DROP FUNCTION IF EXISTS gl_serialize_period_transition()');
  await knex.raw('DROP TRIGGER IF EXISTS trg_gl_entry_header_balanced ON gl_journal_entries');
  await knex.raw('DROP FUNCTION IF EXISTS gl_assert_header_has_balanced_lines()');
  await knex.raw('DROP TRIGGER IF EXISTS trg_gl_lines_balanced ON gl_journal_lines');
  await knex.raw('DROP FUNCTION IF EXISTS gl_assert_entry_balanced()');

  await knex.schema.dropTableIfExists('gl_journal_lines');
  await knex.schema.dropTableIfExists('gl_journal_entries');
  await knex.schema.dropTableIfExists('gl_reconciliations');
  await knex.schema.dropTableIfExists('gl_vendors');
  await knex.schema.dropTableIfExists('gl_periods');
  await knex.schema.dropTableIfExists('gl_accounts');
};
