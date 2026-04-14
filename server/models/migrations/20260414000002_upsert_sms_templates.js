/**
 * Upsert all SMS templates so the admin UI reflects the latest copies.
 * The sms_templates table was already created, but seed data only runs on first create.
 * This migration inserts missing templates and updates existing ones.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const templates = [
    { template_key: 'appointment_confirmation', name: 'Appointment Confirmation', category: 'service', body: 'Hi {first_name}! Your {service_type} with Waves is confirmed for {date} between {time}. Reply to reschedule.\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','service_type','date','time']), sort_order: 1 },
    { template_key: 'reminder_72h', name: '72-Hour Reminder', category: 'service', body: 'Hello {first_name}! This is a reminder from Waves that your {service_type} appointment is scheduled for {day} at {time}. Expect your technician to arrive within a two-hour window of your scheduled start time. Need to reschedule? Log into your Waves Customer Portal at portal.wavespestcontrol.com. If you have any questions or need assistance, simply reply to this message. — Waves', variables: JSON.stringify(['first_name','service_type','day','time']), sort_order: 2 },
    { template_key: 'reminder_24h', name: '24-Hour Reminder', category: 'service', body: 'Hello {first_name}! This is a reminder from Waves that your {service_type} appointment is scheduled for tomorrow at {time}. Expect your technician to arrive within a two-hour window of your scheduled start time. Your tech will text you when they are 15 minutes out. If you have any questions or need assistance, simply reply to this message. — Waves', variables: JSON.stringify(['first_name','service_type','time']), sort_order: 3 },
    { template_key: 'service_complete', name: 'Service Complete', category: 'service', body: 'Hello {first_name}! Your service report is ready. View it here: portal.wavespestcontrol.com\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name']), sort_order: 4 },
    { template_key: 'invoice_sent', name: 'Invoice Sent', category: 'billing', body: 'Hi {first_name}! Your invoice for {service_type} completed on {service_date} is ready: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','service_type','service_date','pay_url']), sort_order: 10 },
    { template_key: 'payment_failed', name: 'Payment Failed', category: 'billing', body: "Hi {first_name}, your payment for {service_type} completed on {service_date} didn't go through. Please update your payment method or reply for help.", variables: JSON.stringify(['first_name','service_type','service_date']), sort_order: 11 },
    { template_key: 'late_payment_7d', name: 'Late Payment — 7 Day', category: 'billing', body: 'Hello {first_name}! This is a reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 7 days overdue.\n\nPlease make your payment here: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 12 },
    { template_key: 'late_payment_14d', name: 'Late Payment — 14 Day', category: 'billing', body: 'Hello {first_name}, this is a reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 14 days overdue.\n\nPlease make your payment as soon as possible at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 13 },
    { template_key: 'late_payment_30d', name: 'Late Payment — 30 Day', category: 'billing', body: 'Hello {first_name}, this is a final reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 30 days overdue.\n\nPlease make your payment immediately at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 14 },
    { template_key: 'late_payment_60d', name: 'Late Payment — 60 Day', category: 'billing', body: 'Hello {first_name}, this is an urgent notice from Waves. Your invoice for {invoice_title} completed on {service_date} is now 60 days overdue.\n\nPlease make payment or contact us immediately to avoid further action: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 15 },
    { template_key: 'late_payment_90d', name: 'Late Payment — 90 Day', category: 'billing', body: 'Hello {first_name}, your invoice from Waves for {invoice_title} completed on {service_date} is now 90 days overdue.\n\nFinal notice: This account will be sent to collections if payment is not received today. Please pay now: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 16 },
    { template_key: 'estimate_sent', name: 'Estimate Sent', category: 'estimates', body: 'Hi {first_name}! Your Waves estimate is ready: {estimate_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','estimate_url']), sort_order: 20 },
    { template_key: 'lead_auto_reply_biz', name: 'Lead Auto-Reply (Business Hours)', category: 'estimates', body: 'Hello {first_name}! Thanks for reaching out to Waves! What are you interested in — Pest Control, Lawn Care, or a One-Time Service? Reply and we\'ll get you a quote right away.', variables: JSON.stringify(['first_name']), sort_order: 21 },
    { template_key: 'review_request', name: 'Review Request', category: 'reviews', body: "Hi {first_name}! How was your service? We'd love your feedback: {review_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!", variables: JSON.stringify(['first_name','review_url']), sort_order: 30 },
  ];

  for (const t of templates) {
    const exists = await knex('sms_templates').where({ template_key: t.template_key }).first();
    if (exists) {
      await knex('sms_templates').where({ template_key: t.template_key }).update({
        name: t.name, body: t.body, variables: t.variables, sort_order: t.sort_order, updated_at: new Date(),
      });
    } else {
      await knex('sms_templates').insert(t);
    }
  }
};

exports.down = async () => {};
