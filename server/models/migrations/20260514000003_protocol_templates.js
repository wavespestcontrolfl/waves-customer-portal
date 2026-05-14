/**
 * protocol_templates + child tables — audit-safe foundation for the
 * one-tap "Complete — Protocol Performed" attestation flow.
 *
 * Three durability rules this schema enforces:
 *
 * 1. Once a protocol row has status='active' or 'retired', its content
 *    (products, areas, actions, names, attestation text) is immutable.
 *    A 2027 swap of "Demand CS → Tempo" cannot silently rewrite the
 *    history of every 2026 completion that referenced this row. To
 *    change a protocol, INSERT a new version row (draft → active) and
 *    flip the prior row to retired. Edits to active or retired rows
 *    are blocked by a Postgres trigger.
 *
 * 2. Exactly one active version per protocol_key at a time
 *    (partial unique index). New versions enter as 'draft'; an admin
 *    transition activates them. Activating a new version is the only
 *    write permitted against the prior active row (active → retired
 *    with retired_at + retired_by set in the same UPDATE).
 *
 * 3. is_deterministic is a column on the template, not an inference
 *    from service_type. WaveGuard mosquito (fixed protocol per tier)
 *    can be flagged deterministic and use one-tap. WaveGuard lawn
 *    (season + blackout + N-budget + calibration dependent) is
 *    flagged non-deterministic and routes to the detailed form.
 *
 * Child tables (products, areas, actions) inherit the parent's
 * immutability: rows under an active/retired parent cannot be
 * modified or deleted.
 */

exports.up = async function (knex) {
  // pgcrypto provides gen_random_uuid() used by the .defaultTo() below
  // and by the child tables. The repo's convention (every migration
  // that calls gen_random_uuid()) is to ensure the extension defensively
  // rather than rely on an earlier migration having enabled it.
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  // ─── Parent table ────────────────────────────────────────────────
  await knex.schema.createTable('protocol_templates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Stable identity across versions. (protocol_key, version) is unique;
    // (protocol_key) WHERE status='active' is unique. To swap products
    // next year, insert a new (same protocol_key, new version) row.
    t.string('protocol_key', 80).notNullable();
    t.string('version', 40).notNullable();
    t.uuid('supersedes_protocol_template_id')
      .references('id').inTable('protocol_templates');

    // Display
    t.string('display_name', 160).notNullable();
    t.string('service_type', 100).notNullable();
    t.string('service_line', 40);

    // The big gate for the one-tap path. Only deterministic templates
    // are eligible for the "Complete — Protocol Performed" attestation.
    t.boolean('is_deterministic').notNullable().defaultTo(false);

    // Lifecycle
    t.string('status', 16).notNullable().defaultTo('draft');
    t.timestamp('effective_from');
    t.timestamp('effective_to');
    t.timestamp('activated_at');
    t.uuid('activated_by').references('id').inTable('technicians');
    t.timestamp('retired_at');
    t.uuid('retired_by').references('id').inTable('technicians');

    // Attestation text template — what the tech sees on the button.
    // Tokens like {products}, {areas}, {protocol_name} get substituted
    // at resolve time by the snapshot builder. Kept here (not generated)
    // so the exact wording the tech tapped on is recoverable from the
    // template version referenced by the service_record.
    t.text('attestation_template').notNullable();
    t.string('attestation_template_version', 20).notNullable().defaultTo('2026.05');

    // Tech-facing notes / regulatory context
    t.text('notes');

    t.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE protocol_templates
    ADD CONSTRAINT protocol_templates_status_check
    CHECK (status IN ('draft', 'active', 'retired'))
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX protocol_templates_key_version_idx
    ON protocol_templates (protocol_key, version)
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX protocol_templates_one_active_per_key_idx
    ON protocol_templates (protocol_key)
    WHERE status = 'active'
  `);

  // ─── Child: products ─────────────────────────────────────────────
  // rate_basis = how to read this row.
  //   'label_compliant_default' — apply at label rate; system does not
  //   record a numeric mix because the tech did not enter one. The
  //   record attests to the named protocol, not to a specific rate.
  //   'fixed_rate' — system DOES record a numeric rate (rate + unit).
  //   This is used for protocols where the rate is invariant (e.g. a
  //   pre-mixed bait station replacement).
  await knex.schema.createTable('protocol_template_products', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('protocol_template_id').notNullable()
      .references('id').inTable('protocol_templates').onDelete('CASCADE');
    t.uuid('product_id').notNullable()
      .references('id').inTable('products_catalog');
    t.string('product_name_snapshot', 160).notNullable();
    t.string('rate_basis', 32).notNullable().defaultTo('label_compliant_default');
    t.decimal('rate', 10, 4);
    t.string('rate_unit', 20);
    t.string('application_method', 80);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE protocol_template_products
    ADD CONSTRAINT protocol_template_products_rate_basis_check
    CHECK (rate_basis IN ('label_compliant_default', 'fixed_rate'))
  `);

  await knex.raw(`
    ALTER TABLE protocol_template_products
    ADD CONSTRAINT protocol_template_products_fixed_rate_has_values
    CHECK (
      rate_basis <> 'fixed_rate'
      OR (rate IS NOT NULL AND rate_unit IS NOT NULL)
    )
  `);

  // ─── Child: areas ────────────────────────────────────────────────
  await knex.schema.createTable('protocol_template_areas', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('protocol_template_id').notNullable()
      .references('id').inTable('protocol_templates').onDelete('CASCADE');
    t.string('area_key', 60).notNullable();
    t.string('area_label', 80).notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);

    t.unique(['protocol_template_id', 'area_key']);
  });

  // ─── Child: actions (protocol checklist items) ───────────────────
  await knex.schema.createTable('protocol_template_actions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('protocol_template_id').notNullable()
      .references('id').inTable('protocol_templates').onDelete('CASCADE');
    t.string('action_key', 80).notNullable();
    t.string('action_label', 200).notNullable();
    t.boolean('required').notNullable().defaultTo(false);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);

    t.unique(['protocol_template_id', 'action_key']);
  });

  // ─── Immutability triggers ───────────────────────────────────────
  // Parent: once active or retired, only one update is legal — the
  // active → retired transition, and only when status, retired_at,
  // retired_by are the columns changing. All other UPDATEs and any
  // DELETE on a non-draft row raise.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION protocol_templates_protect_active()
    RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        IF OLD.status IN ('active', 'retired') THEN
          RAISE EXCEPTION
            'protocol_templates row is immutable (id=%, status=%, version=%). Insert a new version instead of deleting.',
            OLD.id, OLD.status, OLD.version;
        END IF;
        RETURN OLD;
      END IF;

      IF (TG_OP = 'UPDATE') THEN
        IF OLD.status = 'retired' THEN
          RAISE EXCEPTION
            'protocol_templates row is retired and immutable (id=%, version=%).',
            OLD.id, OLD.version;
        END IF;

        IF OLD.status = 'active' THEN
          -- The only legal mutation on an active row is the
          -- active → retired transition. Every other column must
          -- compare IS NOT DISTINCT FROM its prior value.
          IF NEW.status <> 'retired'
             OR NEW.retired_at IS NULL
             OR NEW.retired_by IS NULL
          THEN
            RAISE EXCEPTION
              'protocol_templates row is active and immutable except for retire transition (id=%, version=%).',
              OLD.id, OLD.version;
          END IF;
          -- Only status, retired_at, retired_by, and effective_to may
          -- change on the retire transition. Every other column —
          -- including created_at and updated_at — must remain pinned
          -- to its prior value, so the row's audit timestamps reflect
          -- creation/last-pre-retire state, not the retirement event
          -- (retired_at carries that signal explicitly).
          IF NEW.protocol_key IS DISTINCT FROM OLD.protocol_key
             OR NEW.version IS DISTINCT FROM OLD.version
             OR NEW.supersedes_protocol_template_id IS DISTINCT FROM OLD.supersedes_protocol_template_id
             OR NEW.display_name IS DISTINCT FROM OLD.display_name
             OR NEW.service_type IS DISTINCT FROM OLD.service_type
             OR NEW.service_line IS DISTINCT FROM OLD.service_line
             OR NEW.is_deterministic IS DISTINCT FROM OLD.is_deterministic
             OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
             OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
             OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
             OR NEW.attestation_template IS DISTINCT FROM OLD.attestation_template
             OR NEW.attestation_template_version IS DISTINCT FROM OLD.attestation_template_version
             OR NEW.notes IS DISTINCT FROM OLD.notes
             OR NEW.created_at IS DISTINCT FROM OLD.created_at
             OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
          THEN
            RAISE EXCEPTION
              'protocol_templates active row content is immutable; only status/retired_at/retired_by/effective_to may change (id=%, version=%).',
              OLD.id, OLD.version;
          END IF;
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    CREATE TRIGGER protocol_templates_protect_active_trg
    BEFORE UPDATE OR DELETE ON protocol_templates
    FOR EACH ROW EXECUTE FUNCTION protocol_templates_protect_active();
  `);

  // Child tables: block INSERT/UPDATE/DELETE whenever the (old or new)
  // parent template is active or retired.
  //
  // Three attack vectors covered:
  //   1. INSERT a fresh child row under an active parent — would silently
  //      add a product/area/action to an active protocol's content.
  //   2. UPDATE a child row's protocol_template_id to move it from an
  //      active parent to a draft parent — would silently remove a row
  //      from the active protocol's content. The trigger must check the
  //      OLD parent, not just NEW. Belt-and-suspenders: we forbid
  //      protocol_template_id changes on UPDATE outright, since a child
  //      row legitimately belongs to one template version forever.
  //   3. DELETE a child row under an active or retired parent — already
  //      covered by the prior trigger, retained here.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION protocol_template_child_protect()
    RETURNS trigger AS $$
    DECLARE
      old_parent_status text;
      new_parent_status text;
    BEGIN
      -- IMPORTANT: parent status reads use FOR NO KEY UPDATE to lock
      -- the parent row for the duration of the trigger's transaction.
      -- Without the lock, a child INSERT under a draft parent + a
      -- concurrent draft→active UPDATE on the parent could interleave
      -- under READ COMMITTED:
      --   T1: BEGIN; INSERT child; trigger SELECT status='draft' → allow
      --   T2: BEGIN; UPDATE parent SET status='active'; COMMIT
      --   T1: COMMIT  ← active template now has post-activation content
      -- FOR NO KEY UPDATE serializes against the parent UPDATE without
      -- blocking concurrent reads of unrelated columns. T1 waits for
      -- T2 to commit, re-reads status='active', and rejects.

      IF (TG_OP = 'INSERT') THEN
        SELECT status INTO new_parent_status
        FROM protocol_templates
        WHERE id = NEW.protocol_template_id
        FOR NO KEY UPDATE;
        IF new_parent_status IN ('active', 'retired') THEN
          RAISE EXCEPTION
            'INSERT on % blocked: parent protocol_template % is %.',
            TG_TABLE_NAME, NEW.protocol_template_id, new_parent_status;
        END IF;
        RETURN NEW;
      END IF;

      IF (TG_OP = 'UPDATE') THEN
        IF NEW.protocol_template_id IS DISTINCT FROM OLD.protocol_template_id THEN
          RAISE EXCEPTION
            'UPDATE on % blocked: protocol_template_id is immutable (child rows belong to a single template version).',
            TG_TABLE_NAME;
        END IF;
        SELECT status INTO old_parent_status
        FROM protocol_templates
        WHERE id = OLD.protocol_template_id
        FOR NO KEY UPDATE;
        IF old_parent_status IN ('active', 'retired') THEN
          RAISE EXCEPTION
            'UPDATE on % blocked: parent protocol_template % is %.',
            TG_TABLE_NAME, OLD.protocol_template_id, old_parent_status;
        END IF;
        RETURN NEW;
      END IF;

      IF (TG_OP = 'DELETE') THEN
        SELECT status INTO old_parent_status
        FROM protocol_templates
        WHERE id = OLD.protocol_template_id
        FOR NO KEY UPDATE;
        IF old_parent_status IN ('active', 'retired') THEN
          RAISE EXCEPTION
            'DELETE on % blocked: parent protocol_template % is %.',
            TG_TABLE_NAME, OLD.protocol_template_id, old_parent_status;
        END IF;
        RETURN OLD;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  for (const child of ['protocol_template_products', 'protocol_template_areas', 'protocol_template_actions']) {
    await knex.raw(`
      CREATE TRIGGER ${child}_protect_trg
      BEFORE INSERT OR UPDATE OR DELETE ON ${child}
      FOR EACH ROW EXECUTE FUNCTION protocol_template_child_protect();
    `);
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP TRIGGER IF EXISTS protocol_template_actions_protect_trg ON protocol_template_actions');
  await knex.raw('DROP TRIGGER IF EXISTS protocol_template_areas_protect_trg ON protocol_template_areas');
  await knex.raw('DROP TRIGGER IF EXISTS protocol_template_products_protect_trg ON protocol_template_products');
  await knex.raw('DROP TRIGGER IF EXISTS protocol_templates_protect_active_trg ON protocol_templates');
  await knex.raw('DROP FUNCTION IF EXISTS protocol_template_child_protect()');
  await knex.raw('DROP FUNCTION IF EXISTS protocol_templates_protect_active()');

  await knex.schema.dropTableIfExists('protocol_template_actions');
  await knex.schema.dropTableIfExists('protocol_template_areas');
  await knex.schema.dropTableIfExists('protocol_template_products');
  await knex.schema.dropTableIfExists('protocol_templates');
};
