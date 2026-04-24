/**
 * Seed the automation_templates table from the code-defined AUTOMATIONS map
 * so the operator sees familiar rows in the new editor on first load. Each
 * template gets zero steps by default — operator populates bodies (via AI
 * draft or paste) in the Automations editor, and the runtime swaps to the
 * local sender automatically once any step is non-empty.
 */

const TEMPLATES = [
  { key: 'new_recurring',      name: 'New Recurring Customer',         description: 'For any new recurring customer who signs up for a pest, lawn, or combo program',    asm_group: 'service',    tags: ['new customer', 'recurring'],        beehiiv_automation_id: 'aut_3f539f94-024a-466f-9d50-4454173627dd', sms_template: 'Hello {first_name}! Welcome to a safer, pest-free home with Waves! Check your inbox, we just emailed you our welcome guide.\n\nIf you have any questions or need assistance, simply reply to this message.' },
  { key: 'cold_lead',          name: 'Cold Lead Nurture',              description: 'For customers who declined or haven\'t responded to an estimate',                    asm_group: 'newsletter', tags: ['cold customer'],                    beehiiv_automation_id: 'aut_13dca63e-702d-4020-870c-27c742532a06', sms_template: null },
  { key: 'lawn_service',       name: 'Lawn Care Onboarding',           description: 'For new recurring lawn care customers specifically',                                asm_group: 'service',    tags: ['lawn', 'recurring'],                beehiiv_automation_id: 'aut_0c794b25-1a87-46aa-9ef3-6c508348d288', sms_template: 'Hello {first_name}! Welcome to a better lawn with Waves! We just emailed you our lawn care welcome guide + expert tips for the best results for your lawn!\n\nIf you have any questions or need assistance, simply reply to this message.' },
  { key: 'new_appointment',    name: 'New First-Time Appointment',     description: 'For non-recurring, first-time customers who have never booked with us before',      asm_group: 'service',    tags: ['new appointment', 'first-time'],    beehiiv_automation_id: 'aut_d34a894e-a5bc-43fc-af47-7efba42881e7', sms_template: 'Hello {first_name}! We just emailed you a breakdown of what to expect with your upcoming service with Waves!\n\nIf you have any questions or need assistance, simply reply to this message.' },
  { key: 'review_thank_you_lwr',     name: 'Review Thank You — Lakewood Ranch', description: 'For LWR customers who have given us a Google review', asm_group: 'service', tags: ['reviewed', 'lakewood-ranch'], beehiiv_automation_id: 'aut_7a99204b-3a0f-46db-914f-05722f2eb7f0', sms_template: null },
  { key: 'review_thank_you_venice',  name: 'Review Thank You — Venice',         description: 'For Venice customers who have given us a Google review', asm_group: 'service', tags: ['reviewed', 'venice'],      beehiiv_automation_id: 'aut_6fd321f7-dce1-4887-bd89-91cea7ac00b7', sms_template: null },
  { key: 'review_thank_you_sarasota',name: 'Review Thank You — Sarasota',       description: 'For Sarasota customers who have given us a Google review', asm_group: 'service', tags: ['reviewed', 'sarasota'],   beehiiv_automation_id: 'aut_023254b1-bd8e-443a-a59f-a54e88cf54c7', sms_template: null },
  { key: 'review_thank_you_parrish', name: 'Review Thank You — Parrish',        description: 'For Parrish customers who have given us a Google review', asm_group: 'service', tags: ['reviewed', 'parrish'],    beehiiv_automation_id: 'aut_e36ad726-024a-4741-83aa-3c7d08b054c2', sms_template: null },
  { key: 'bed_bug',            name: 'Bed Bug Treatment',              description: 'For first-time customers who have booked a bed bug treatment',                      asm_group: 'service',    tags: ['bed bug treatment', 'first-time'],  beehiiv_automation_id: 'aut_9e3657f3-82de-4d4f-84a5-ae757ac7e13b', sms_template: 'Hello {first_name}! Let\'s get your home bed bug-free. We just emailed you your Waves treatment guide—please review it to help us get the best results for your home!\n\nIf you have any questions or need assistance, simply reply to this message.' },
  { key: 'cockroach',          name: 'Cockroach Control',              description: 'For first-time customers who have booked a cockroach treatment',                    asm_group: 'service',    tags: ['roach treatment', 'first-time'],    beehiiv_automation_id: 'aut_53cfd473-982b-49fd-b03d-62a9d462909c', sms_template: 'Hello {first_name}! Let\'s get your home cockroach-free. We just emailed you your Waves treatment guide—please review it to help us get the best results for your home!\n\nIf you have any questions or need assistance, simply reply to this message.' },
  { key: 'new_lead',           name: 'New Lead',                       description: 'For new leads entering the pipeline — intro to Waves services',                     asm_group: 'newsletter', tags: ['new lead'],                         beehiiv_automation_id: 'aut_d08077d4-3079-4e69-9488-f6669caf6a6c', sms_template: 'Hi {first_name}! Thanks for your interest in Waves Pest Control. We just sent you an email with more info about our services.\n\nReply here anytime if you have questions!' },
  { key: 'service_renewal',    name: 'Service Renewal Reminder',       description: 'Reminder for customers whose service agreement is coming up for renewal',           asm_group: 'service',    tags: ['renewal reminder'],                 beehiiv_automation_id: 'aut_6e9b0067-89c9-4c11-acbe-f62eaa80b1aa', sms_template: 'Hi {first_name}! Your Waves service is coming up for renewal. We just emailed you the details — take a look when you get a chance.\n\nQuestions? Just reply here!' },
  { key: 'pricing_update',     name: 'Pricing Update',                 description: 'Notify customers about service pricing changes',                                    asm_group: 'service',    tags: ['pricing update'],                   beehiiv_automation_id: 'aut_0d249df2-79fe-4e4d-a7ad-e35259e9d706', sms_template: null },
  { key: 'payment_failed',     name: 'Payment Failed',                 description: 'Sent when autopay fails — friendly heads-up before retry',                          asm_group: 'service',    tags: ['payment failed'],                   beehiiv_automation_id: 'aut_bf915f3e-8ca2-4355-be54-9a66e9633296', sms_template: null },
  { key: 'referral_nudge',     name: 'Referral Nudge',                 description: 'Post-service nudge encouraging customer to refer friends and family',               asm_group: 'newsletter', tags: ['referral'],                         beehiiv_automation_id: 'aut_45641d64-3111-49c2-87bb-3f1fe6ccce25', sms_template: null },
];

exports.up = async function (knex) {
  for (const t of TEMPLATES) {
    // INSERT ... ON CONFLICT DO NOTHING so re-runs don't clobber operator edits.
    await knex('automation_templates')
      .insert({ ...t, tags: JSON.stringify(t.tags) })
      .onConflict('key').ignore();
  }
};

exports.down = async function (knex) {
  const keys = TEMPLATES.map((t) => t.key);
  await knex('automation_templates').whereIn('key', keys).del();
};
