/**
 * Access codes section, server half (PR 2a).
 *
 * Every access code a client gives us (neighborhood gate, property gate, door,
 * lockbox, garage, call box, visitor pass) belongs in one place, including the
 * door code for a one-time job that the strict profile rule never saves. One
 * row is one code or one way in: the capture sweep files what a customer text
 * states as `found`, the office accepts it (`active`), dismisses it, or retires
 * it later. A `visit` row belongs to one scheduled service and drops out of the
 * live list once that service is completed or cancelled.
 *
 * `value_hash` is sha256 of the canonical value (the code with inner
 * whitespace removed, or the trimmed instructions when there is no code), so
 * the sweep's re-runs and its duplicate checks never compare a raw code.
 *
 * Purely additive and dark behind GATE_ACCESS_CODES_SECTION: nothing reads or
 * writes this table until that gate is on.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customer_access_codes')) return;
  await knex.raw(`
    CREATE TABLE customer_access_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      property_id uuid REFERENCES customer_properties(id) ON DELETE SET NULL,
      kind text NOT NULL,
      code text,
      instructions text,
      life text NOT NULL,
      scheduled_service_id uuid REFERENCES scheduled_services(id) ON DELETE SET NULL,
      status text NOT NULL,
      source_type text NOT NULL,
      source_id uuid,
      source_quote text,
      source_at timestamptz,
      value_hash text NOT NULL,
      decided_by uuid,
      decided_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT customer_access_codes_kind_check CHECK (kind IN
        ('neighborhood_gate', 'property_gate', 'door', 'lockbox', 'garage', 'call_box', 'pass', 'other')),
      CONSTRAINT customer_access_codes_life_check CHECK (life IN ('standing', 'visit')),
      CONSTRAINT customer_access_codes_status_check CHECK (status IN ('found', 'active', 'dismissed', 'retired')),
      CONSTRAINT customer_access_codes_source_type_check CHECK (source_type IN ('sms', 'call', 'email', 'staff')),
      CONSTRAINT customer_access_codes_code_len CHECK (code IS NULL OR char_length(code) <= 40),
      CONSTRAINT customer_access_codes_instructions_len CHECK (instructions IS NULL OR char_length(instructions) <= 600),
      CONSTRAINT customer_access_codes_quote_len CHECK (source_quote IS NULL OR char_length(source_quote) <= 900),
      CONSTRAINT customer_access_codes_has_value CHECK (
        nullif(btrim(coalesce(code, '')), '') IS NOT NULL OR nullif(btrim(coalesce(instructions, '')), '') IS NOT NULL)
    )`);
  // The backstop for the sweep's re-runs: one text yields one row per kind and value.
  await knex.raw(
    'CREATE UNIQUE INDEX customer_access_codes_source_uniq '
    + 'ON customer_access_codes (customer_id, source_type, source_id, kind, value_hash) WHERE source_id IS NOT NULL',
  );
  await knex.raw('CREATE INDEX customer_access_codes_customer_status_idx ON customer_access_codes (customer_id, status)');
  // The office's review list: every customer's codes still waiting for a decision.
  await knex.raw("CREATE INDEX customer_access_codes_found_idx ON customer_access_codes (created_at DESC) WHERE status = 'found'");
  await knex.raw('CREATE INDEX customer_access_codes_service_idx ON customer_access_codes (scheduled_service_id) WHERE scheduled_service_id IS NOT NULL');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_access_codes');
};
