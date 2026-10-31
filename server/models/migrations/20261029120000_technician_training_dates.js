/**
 * Technician ID-card and training dates (GATE_TECH_TRAINING_DATES, dark).
 *
 * Owner 2026-10-28 (Tech 2 and 3 Roadmap, question 3): training and ID-card due dates on the Compliance page,
 * with a reminder before each date. The dates come from F.S. 482.091 and rule 5E-14.1421:
 *   - the ID card is applied for within 30 days after employment (482.091(1)(b));
 *   - 5 days (40 hours) of field training under a certified operator, with a written record kept 2 years;
 *   - 4 classroom hours within 6 months after the card is ISSUED (482.091(10));
 *   - 2 hours of continuing training before each yearly renewal (482.091(10)).
 *
 * technicians gets four nullable dates (card applied, card issued, classroom hours done, renewal training done).
 * technician_training_days holds one row per technician, day and category: the dated entries of the 40-hour
 * record. Both are written only with the gate on. Nothing here changes licensing or assignment: the Team tab's
 * "Can be assigned field work" stays the owner's manual gate.
 *
 * A pushed migration is frozen. The down drops only what this file added.
 */
const COLUMNS = ['id_card_applied_on', 'id_card_issued_on', 'classroom_hours_done_on', 'renewal_training_done_on'];
const CATEGORIES = ['GHP', 'L&O', 'Termite/WDO', 'Fumigation'];

exports.up = async function up(knex) {
  for (const name of COLUMNS) {
    if (!(await knex.schema.hasColumn('technicians', name))) {
      await knex.schema.alterTable('technicians', (t) => { t.date(name).nullable(); });
    }
  }
  if (!(await knex.schema.hasTable('technician_training_days'))) {
    await knex.schema.createTable('technician_training_days', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
      t.date('training_date').notNullable();
      t.decimal('hours', 4, 2).notNullable();
      t.text('category').notNullable();
      t.text('topics').notNullable();
      t.text('trainer_name').notNullable();
      t.text('materials').nullable();
      t.uuid('created_by').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['technician_id', 'training_date', 'category'], { indexName: 'technician_training_days_day_category_uniq' });
    });
    await knex.raw('ALTER TABLE technician_training_days ADD CONSTRAINT technician_training_days_hours_check CHECK (hours > 0 AND hours <= 16)');
    // DDL cannot take bind parameters; the values are the fixed list above.
    const list = CATEGORIES.map((c) => `'${c}'`).join(', ');
    await knex.raw(`ALTER TABLE technician_training_days ADD CONSTRAINT technician_training_days_category_check CHECK (category IN (${list}))`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('technician_training_days');
  for (const name of COLUMNS) {
    if (await knex.schema.hasColumn('technicians', name)) {
      await knex.schema.alterTable('technicians', (t) => { t.dropColumn(name); });
    }
  }
};
