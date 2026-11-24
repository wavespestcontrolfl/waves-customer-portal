'use strict';

// GATE_CALL_GIVEN_CONTACT_CONSENT (owner ruling 2026-10-29): customers.service_preferences.call_given_phone_keys lists the slot phones
// the call pipeline stamped as text-consented because the caller gave them on a call. The list only means something while the phone
// still sits in a contact slot: a phone removed by any writer (admin edit, the holder's portal save, a dedupe merge, a script) must
// drop out, so a number the holder later adds through the ordinary portal flow and confirms with its own YES is judged on its own
// history, not as a caller-given one (login stays refused and review asks stay held back for call-given phones only).
//
// Same chokepoint as login_attested_phone_keys (migration 20261105060000, frozen): when any of the three slot phone columns changes,
// the list is cut down to the phones that still sit in a slot. The call pipeline's own UPDATE writes the slot and the key together, so
// it passes through unchanged. Rows without the key are not touched.
const FN = 'customers_prune_call_given_phone_keys';
const TRG = 'trg_customers_prune_call_given_phone_keys';

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
         OR jsonb_typeof(NEW.service_preferences -> 'call_given_phone_keys') IS DISTINCT FROM 'array' THEN
        RETURN NEW;
      END IF;
      SELECT COALESCE(jsonb_agg(k.key), '[]'::jsonb) INTO kept
        FROM jsonb_array_elements_text(NEW.service_preferences -> 'call_given_phone_keys') AS k(key)
       WHERE k.key <> ''
         AND k.key IN (
           right(regexp_replace(COALESCE(NEW.service_contact_phone, ''), '\\D', '', 'g'), 10),
           right(regexp_replace(COALESCE(NEW.service_contact2_phone, ''), '\\D', '', 'g'), 10),
           right(regexp_replace(COALESCE(NEW.service_contact3_phone, ''), '\\D', '', 'g'), 10)
         );
      IF kept IS DISTINCT FROM (NEW.service_preferences -> 'call_given_phone_keys') THEN
        NEW.service_preferences := jsonb_set(NEW.service_preferences, '{call_given_phone_keys}', kept);
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
