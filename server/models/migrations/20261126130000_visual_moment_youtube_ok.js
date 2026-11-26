// A tech marks a video clip "OK to post" on the Waves YouTube channel. The mark
// is separate from visibility_status: it never changes what a customer sees.
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('visual_service_moments'))) return;
  if (!(await knex.schema.hasColumn('visual_service_moments', 'youtube_ok_at'))) {
    await knex.schema.alterTable('visual_service_moments', (t) => {
      t.timestamp('youtube_ok_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('visual_service_moments', 'youtube_ok_by'))) {
    await knex.schema.alterTable('visual_service_moments', (t) => {
      t.uuid('youtube_ok_by').nullable();
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('visual_service_moments'))) return;
  if (await knex.schema.hasColumn('visual_service_moments', 'youtube_ok_by')) {
    await knex.schema.alterTable('visual_service_moments', (t) => {
      t.dropColumn('youtube_ok_by');
    });
  }
  if (await knex.schema.hasColumn('visual_service_moments', 'youtube_ok_at')) {
    await knex.schema.alterTable('visual_service_moments', (t) => {
      t.dropColumn('youtube_ok_at');
    });
  }
};
