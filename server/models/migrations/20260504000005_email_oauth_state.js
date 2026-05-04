exports.up = async function (knex) {
  const hasOauthState = await knex.schema.hasColumn('email_sync_state', 'oauth_state');
  const hasOauthStateExpires = await knex.schema.hasColumn('email_sync_state', 'oauth_state_expires_at');

  await knex.schema.alterTable('email_sync_state', (t) => {
    if (!hasOauthState) t.text('oauth_state');
    if (!hasOauthStateExpires) t.timestamp('oauth_state_expires_at');
  });
};

exports.down = async function (knex) {
  const hasOauthState = await knex.schema.hasColumn('email_sync_state', 'oauth_state');
  const hasOauthStateExpires = await knex.schema.hasColumn('email_sync_state', 'oauth_state_expires_at');

  await knex.schema.alterTable('email_sync_state', (t) => {
    if (hasOauthStateExpires) t.dropColumn('oauth_state_expires_at');
    if (hasOauthState) t.dropColumn('oauth_state');
  });
};
