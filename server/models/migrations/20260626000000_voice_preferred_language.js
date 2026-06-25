/**
 * Migration — preferred_language hint on customers + leads
 *
 * Set by the bilingual AI voice agent when it detects a caller speaking
 * Spanish. NON-ROUTING: used only as the agent's opening-language hint the next
 * time it answers (greet in Spanish vs. auto-detect from scratch). It does NOT
 * change inbound call routing — daytime calls from these numbers still ring
 * staff first like any other call.
 *
 * Idempotent + re-runnable: guarded by columnInfo() so it is safe on any
 * environment whether or not the column already exists.
 */
const TABLES = ['customers', 'leads'];

exports.up = async function (knex) {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    const cols = await knex(table).columnInfo();
    if (!cols.preferred_language) {
      await knex.schema.alterTable(table, (t) => {
        t.string('preferred_language', 8); // ISO-639-1, e.g. 'en' | 'es'; null = unknown
      });
    }
  }
};

exports.down = async function (knex) {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    const cols = await knex(table).columnInfo();
    if (cols.preferred_language) {
      await knex.schema.alterTable(table, (t) => {
        t.dropColumn('preferred_language');
      });
    }
  }
};
