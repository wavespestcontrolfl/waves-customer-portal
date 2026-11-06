// Contact login (GATE_CONTACT_LOGIN_HOLDER_ONLY, dark): a phone signs in only
// while it is listed in customers.service_preferences.login_attested_phone_keys,
// a list only the account holder's signed-in portal save writes. Every OTHER
// writer of the three service_contact*_phone columns (admin edits, the call
// pipeline, dedupe merges, scripts, the Intelligence Bar) rewrites slots
// without touching that list, so a removed phone would keep its attestation and
// a later re-add (a call naming the same number) would inherit it.
//
// One chokepoint instead of one patch per writer: when any of the three slot
// phone columns changes, the list is cut down to the phones that still sit in a
// slot. A holder save lists exactly the phones it stores, so it passes through
// unchanged; a removal drops the key, and nothing but a holder save adds it back.
// Rows without the key are not touched. Inert while the gate is dark.
const FN = 'customers_prune_login_attested_phone_keys';
const TRG = 'trg_customers_prune_login_attested_phone_keys';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  for (const col of ['service_preferences', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone']) {
    if (!(await knex.schema.hasColumn('customers', col))) return;
  }
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger AS $fn$
    DECLARE
      kept jsonb;
    BEGIN
      IF NEW.service_preferences IS NULL
         OR jsonb_typeof(NEW.service_preferences) <> 'object'
         OR jsonb_typeof(NEW.service_preferences -> 'login_attested_phone_keys') IS DISTINCT FROM 'array' THEN
        RETURN NEW;
      END IF;
      SELECT COALESCE(jsonb_agg(k.key), '[]'::jsonb) INTO kept
        FROM jsonb_array_elements_text(NEW.service_preferences -> 'login_attested_phone_keys') AS k(key)
       WHERE k.key <> ''
         AND k.key IN (
           right(regexp_replace(COALESCE(NEW.service_contact_phone, ''), '\\D', '', 'g'), 10),
           right(regexp_replace(COALESCE(NEW.service_contact2_phone, ''), '\\D', '', 'g'), 10),
           right(regexp_replace(COALESCE(NEW.service_contact3_phone, ''), '\\D', '', 'g'), 10)
         );
      IF kept IS DISTINCT FROM (NEW.service_preferences -> 'login_attested_phone_keys') THEN
        NEW.service_preferences := jsonb_set(NEW.service_preferences, '{login_attested_phone_keys}', kept);
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS ${TRG} ON customers`);
  await knex.raw(`
    CREATE TRIGGER ${TRG}
    BEFORE UPDATE OF service_contact_phone, service_contact2_phone, service_contact3_phone ON customers
    FOR EACH ROW
    WHEN (
      OLD.service_contact_phone IS DISTINCT FROM NEW.service_contact_phone
      OR OLD.service_contact2_phone IS DISTINCT FROM NEW.service_contact2_phone
      OR OLD.service_contact3_phone IS DISTINCT FROM NEW.service_contact3_phone
    )
    EXECUTE FUNCTION ${FN}()
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  await knex.raw(`DROP TRIGGER IF EXISTS ${TRG} ON customers`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN}()`);
};
