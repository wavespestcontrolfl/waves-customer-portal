exports.up = async function (knex) {
  await knex('automation_steps')
    .whereIn('template_key', ['new_lead', 'service_renewal'])
    .update({
      html_body: knex.raw(
        'REPLACE(REPLACE(html_body, ?, ?), ?, ?)',
        ['+19412101983', '+19412975749', '(941) 210-1983', '(941) 297-5749']
      ),
      text_body: knex.raw(
        'REPLACE(text_body, ?, ?)',
        ['(941) 210-1983', '(941) 297-5749']
      ),
      updated_at: knex.fn.now(),
    });
};

exports.down = async function (knex) {
  await knex('automation_steps')
    .whereIn('template_key', ['new_lead', 'service_renewal'])
    .update({
      html_body: knex.raw(
        'REPLACE(REPLACE(html_body, ?, ?), ?, ?)',
        ['+19412975749', '+19412101983', '(941) 297-5749', '(941) 210-1983']
      ),
      text_body: knex.raw(
        'REPLACE(text_body, ?, ?)',
        ['(941) 297-5749', '(941) 210-1983']
      ),
      updated_at: knex.fn.now(),
    });
};
