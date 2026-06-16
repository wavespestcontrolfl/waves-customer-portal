/**
 * Customers commonly have more than one type of sprinkler on a property
 * (e.g. in-ground spray in the beds + rotors on the lawn). Convert
 * irrigation_system_type from a single varchar to a jsonb array so the
 * portal can store multiple selections, matching the watering_days pattern.
 *
 * Existing scalar values are wrapped into single-element arrays; null/empty
 * become null.
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE property_preferences
    ALTER COLUMN irrigation_system_type TYPE jsonb
    USING CASE
      WHEN irrigation_system_type IS NULL OR irrigation_system_type = '' THEN NULL
      ELSE to_jsonb(ARRAY[irrigation_system_type])
    END
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE property_preferences
    ALTER COLUMN irrigation_system_type TYPE varchar(30)
    USING CASE
      WHEN irrigation_system_type IS NULL THEN NULL
      WHEN jsonb_typeof(irrigation_system_type) = 'array'
           AND jsonb_array_length(irrigation_system_type) > 0
        THEN (irrigation_system_type ->> 0)
      ELSE NULL
    END
  `);
};
