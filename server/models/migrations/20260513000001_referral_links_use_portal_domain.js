const PORTAL_REFERRAL_BASE_URL = 'https://portal.wavespestcontrol.com/r/';

const REFERRAL_STATUS_VALUES = [
  'pending',
  'contacted',
  'estimated',
  'signed_up',
  'credited',
  'rejected',
  'lost',
  'active',
  'sms_failed',
];

const ROLLBACK_REFERRAL_STATUS_VALUES = REFERRAL_STATUS_VALUES.filter(status => status !== 'sms_failed');

function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function replaceReferralStatusConstraint(knex, statusValues) {
  const hasReferrals = await knex.schema.hasTable('referrals');
  if (!hasReferrals || !(await knex.schema.hasColumn('referrals', 'status'))) return;

  const allowedStatuses = new Set(statusValues);
  const currentStatuses = await knex('referrals').distinct('status').whereNotNull('status');
  currentStatuses.forEach(row => {
    if (row.status) allowedStatuses.add(row.status);
  });

  const valuesSql = Array.from(allowedStatuses).sort().map(quoteSqlLiteral).join(', ');

  await knex.raw('ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_check');
  await knex.raw(`
    ALTER TABLE referrals
      ADD CONSTRAINT referrals_status_check
      CHECK (status IN (${valuesSql}))
  `);
}

exports.up = async function up(knex) {
  await replaceReferralStatusConstraint(knex, REFERRAL_STATUS_VALUES);

  const hasSettings = await knex.schema.hasTable('referral_program_settings');
  if (hasSettings) {
    await knex('referral_program_settings')
      .whereIn('base_url', [
        'https://wavespestcontrol.com/r/',
        'https://www.wavespestcontrol.com/r/',
        'http://wavespestcontrol.com/r/',
        'http://www.wavespestcontrol.com/r/',
      ])
      .orWhereNull('base_url')
      .update({
        base_url: PORTAL_REFERRAL_BASE_URL,
        updated_at: new Date(),
      });
  }

  const hasPromoters = await knex.schema.hasTable('referral_promoters');
  if (hasPromoters) {
    await knex('referral_promoters')
      .where('referral_link', 'like', 'https://wavespestcontrol.com/r/%')
      .update({
        referral_link: knex.raw("replace(referral_link, 'https://wavespestcontrol.com/r/', ?)", [PORTAL_REFERRAL_BASE_URL]),
        updated_at: new Date(),
      });

    await knex('referral_promoters')
      .where('referral_link', 'like', 'https://www.wavespestcontrol.com/r/%')
      .update({
        referral_link: knex.raw("replace(referral_link, 'https://www.wavespestcontrol.com/r/', ?)", [PORTAL_REFERRAL_BASE_URL]),
        updated_at: new Date(),
      });

    await knex('referral_promoters')
      .where('referral_link', 'like', 'http://wavespestcontrol.com/r/%')
      .update({
        referral_link: knex.raw("replace(referral_link, 'http://wavespestcontrol.com/r/', ?)", [PORTAL_REFERRAL_BASE_URL]),
        updated_at: new Date(),
      });

    await knex('referral_promoters')
      .where('referral_link', 'like', 'http://www.wavespestcontrol.com/r/%')
      .update({
        referral_link: knex.raw("replace(referral_link, 'http://www.wavespestcontrol.com/r/', ?)", [PORTAL_REFERRAL_BASE_URL]),
        updated_at: new Date(),
      });
  }
};

exports.down = async function down(knex) {
  const hasReferrals = await knex.schema.hasTable('referrals');
  if (hasReferrals && await knex.schema.hasColumn('referrals', 'status')) {
    await knex('referrals')
      .where({ status: 'sms_failed' })
      .update({ status: 'pending', updated_at: new Date() });
  }
  await replaceReferralStatusConstraint(knex, ROLLBACK_REFERRAL_STATUS_VALUES);

  const hasSettings = await knex.schema.hasTable('referral_program_settings');
  if (hasSettings) {
    await knex('referral_program_settings')
      .where('base_url', PORTAL_REFERRAL_BASE_URL)
      .update({
        base_url: 'https://wavespestcontrol.com/r/',
        updated_at: new Date(),
      });
  }

  const hasPromoters = await knex.schema.hasTable('referral_promoters');
  if (hasPromoters) {
    await knex('referral_promoters')
      .where('referral_link', 'like', `${PORTAL_REFERRAL_BASE_URL}%`)
      .update({
        referral_link: knex.raw('replace(referral_link, ?, ?)', [PORTAL_REFERRAL_BASE_URL, 'https://wavespestcontrol.com/r/']),
        updated_at: new Date(),
      });
  }
};
