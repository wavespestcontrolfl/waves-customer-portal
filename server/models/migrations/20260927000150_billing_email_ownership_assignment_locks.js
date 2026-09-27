// Raw ownership assignments take shared mailbox locks in a separate namespace.
// Final send boundaries try exclusive locks: contention refuses before HTTP,
// while a send already in progress delays only writers of its destination.
const sources = [
  ['customers', 'id', ['email', 'service_contact_email', 'service_contact2_email', 'service_contact3_email']],
  ['notification_prefs', 'customer_id', ['billing_email']],
  ['estimates', 'customer_id', ['customer_email']],
  ['leads', 'customer_id', ['email']],
];
const guard = 'billing_email_ownership_assignment_guard';

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      assigned jsonb := to_jsonb(NEW);
      previous jsonb;
      owner_changed boolean;
      field_index integer;
      address text;
      mailbox text;
      lock_key text;
      keys text[] := ARRAY[]::text[];
    BEGIN
      IF TG_OP = 'UPDATE' THEN previous := to_jsonb(OLD); END IF;
      owner_changed := TG_OP = 'INSERT'
        OR (assigned -> TG_ARGV[0]) IS DISTINCT FROM (previous -> TG_ARGV[0]);
      FOR field_index IN 1 .. (TG_NARGS - 1) LOOP
        IF owner_changed OR (assigned -> TG_ARGV[field_index]) IS DISTINCT FROM (previous -> TG_ARGV[field_index]) THEN
          address := lower(btrim(coalesce(assigned ->> TG_ARGV[field_index], '')));
          IF address <> '' THEN
            keys := array_append(keys, 'email-ownership:customer-email:' || address);
            IF split_part(address, '@', 2) IN ('gmail.com', 'googlemail.com') THEN
              mailbox := replace(split_part(split_part(address, '@', 1), '+', 1), '.', '');
              IF mailbox <> '' THEN keys := array_append(keys, 'email-ownership:customer-mailbox:' || mailbox || '@gmail.com'); END IF;
            END IF;
          END IF;
        END IF;
      END LOOP;
      FOR lock_key IN SELECT value FROM unnest(keys) AS entry(value) GROUP BY value ORDER BY value COLLATE "C" LOOP
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(lock_key, 0));
      END LOOP;
      RETURN NEW;
    END;
  $$`);
  for (const [table, owner, columns] of sources) {
    if (!await knex.schema.hasTable(table) || !await knex.schema.hasColumn(table, owner)) continue;
    const present = [];
    for (const column of columns) if (await knex.schema.hasColumn(table, column)) present.push(column);
    if (!present.length) continue;
    await knex.raw('DROP TRIGGER IF EXISTS ?? ON ??', [guard, table]);
    const identifiers = [owner, ...present].map(() => '??').join(', ');
    // Trigger arguments are SQL literals, not query parameters; every name
    // comes from the hardcoded source list above.
    const argumentsSql = [owner, ...present].map((column) => `'${column}'`).join(', ');
    await knex.raw(`CREATE TRIGGER ?? BEFORE INSERT OR UPDATE OF ${identifiers} ON ??
      FOR EACH ROW EXECUTE FUNCTION ${guard}(${argumentsSql})`,
    [guard, owner, ...present, table]);
  }
};

exports.down = async function down(knex) {
  for (const [table] of sources) {
    if (await knex.schema.hasTable(table)) await knex.raw('DROP TRIGGER IF EXISTS ?? ON ??', [guard, table]);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS ${guard}()`);
};
