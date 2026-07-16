'use strict';

// Assignment-only request updates do not send a customer SMS. Keep the receipt
// message accurate: the team will follow up, but do not promise a specific
// assignment notification that the workflow does not emit.
const TEMPLATE_KEY = 'service_request_confirmation';
const OLD_BODY = "Hello {first_name}! We received your {category} request. Our team will review it within {response_time}. We'll text you when it has been assigned to a technician.\n\nTrack progress in your customer portal or reply here.";
const NEW_BODY = 'Hello {first_name}! We received your {category} request. Our team will review it within {response_time} and follow up directly.\n\nTrack progress in your customer portal or reply here.';

async function replaceBody(knex, from, to) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const columns = await knex('sms_templates').columnInfo();
  const patch = { body: to };
  if (columns.updated_at) patch.updated_at = new Date();
  await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY, body: from })
    .update(patch);
}

exports.up = async function up(knex) {
  await replaceBody(knex, OLD_BODY, NEW_BODY);
};

exports.down = async function down(knex) {
  await replaceBody(knex, NEW_BODY, OLD_BODY);
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.OLD_BODY = OLD_BODY;
exports.NEW_BODY = NEW_BODY;
