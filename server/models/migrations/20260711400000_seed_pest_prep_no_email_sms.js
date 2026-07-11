/**
 * Self-contained pest-prep SMS templates for phone-only customers.
 *
 * The appointment tagger's prep flow is email-primary: it queues the prep
 * guide email (prep.cockroach / prep.bed_bug / prep.flea) and then sends a
 * companion SMS (auto_cockroach / auto_bed_bug / auto_flea) whose copy says
 * "we emailed your treatment guide." A customer booked with only a phone
 * number on file (e.g. a manual-SMS booking) has no email to reference, so
 * that companion text — and therefore any prep at all — was skipped.
 *
 * These auto_*_no_email variants carry the prep steps inline so those
 * phone-only flea / bed bug / cockroach customers still get prep. The copy is
 * a faithful condensation of the already-approved email prep guides
 * (20260521000004 flea, 20260527000002 bed bug, 20260526000009 cockroach) and
 * omits any reference to an email. The tagger sends the standalone variant
 * only when the email was skipped specifically because no email is on file
 * (visit still upcoming/open); every other skip reason stays silent.
 *
 * Seed-only, onConflict-ignore (matches auto_flea's introduction in
 * 20260706000010): an admin edit to a body is preserved on redeploy.
 */

const NEW_TEMPLATES = [
  {
    template_key: 'auto_flea_no_email',
    name: 'Flea Treatment Prep (No Email)',
    category: 'onboarding',
    body: "Hello {first_name}! Let's get your home flea-free. Before your visit: vacuum carpets, rugs, and pet resting areas (empty the vacuum outside) and wash pet bedding on a hot cycle. Coordinate pet flea control with your vet and keep people and pets off treated areas until they're dry.\n\nQuestions or requests? Reply here. Reply STOP to opt out.",
    description: 'Self-contained flea prep text sent when a first-time flea treatment is booked for a customer with no email on file.',
    variables: JSON.stringify(['first_name']),
    is_active: true,
    is_internal: false,
    sort_order: 101,
  },
  {
    template_key: 'auto_bed_bug_no_email',
    name: 'Bed Bug Treatment Prep (No Email)',
    category: 'onboarding',
    body: "Hello {first_name}! Let's get your home bed bug-free. Before your visit: launder all bedding and clothing from affected rooms in hot water and dry on the highest heat for 30+ minutes, then keep it in sealed bags. Vacuum mattresses, frames, and baseboards (bag the contents and toss them outside) and pull beds and furniture 12-18 in. from walls. Your 14-day follow-up is critical - please repeat these steps before it.\n\nQuestions or requests? Reply here. Reply STOP to opt out.",
    description: 'Self-contained bed bug prep text sent when a first-time bed bug treatment is booked for a customer with no email on file.',
    variables: JSON.stringify(['first_name']),
    is_active: true,
    is_internal: false,
    sort_order: 102,
  },
  {
    template_key: 'auto_cockroach_no_email',
    name: 'Cockroach Control Prep (No Email)',
    category: 'onboarding',
    body: "Hello {first_name}! Let's get your home cockroach-free. Before your visit: clear access under sinks, around appliances, and along pantry edges, and store food, dishes, and pet bowls away from treatment areas. Please avoid store-bought sprays before or between visits - they can scatter the activity.\n\nQuestions or requests? Reply here. Reply STOP to opt out.",
    description: 'Self-contained cockroach prep text sent when a first-time cockroach treatment is booked for a customer with no email on file.',
    variables: JSON.stringify(['first_name']),
    is_active: true,
    is_internal: false,
    sort_order: 103,
  },
];

exports.NEW_TEMPLATES = NEW_TEMPLATES;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  for (const template of NEW_TEMPLATES) {
    await knex('sms_templates')
      .insert(template)
      .onConflict('template_key')
      .ignore();
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .whereIn('template_key', NEW_TEMPLATES.map((t) => t.template_key))
    .del();
};
