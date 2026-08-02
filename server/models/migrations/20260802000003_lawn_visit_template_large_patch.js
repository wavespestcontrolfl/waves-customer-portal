// Retire the "Brown patch" option from a deployed lawn job-form template.
//
// 20260802000000 renamed the disease across products_catalog, and the
// completion quick-pick, lawn project findings and the template SEED were all
// updated with it. But changing a seed does not change data that has already
// been seeded: the seed script is run by hand, no start or migration flow
// invokes it, and the runtime reads the persisted job_form_templates row. Any
// environment that HAS been seeded would keep offering the retired spelling
// and keep writing it into new service reports.
//
// Production is not such an environment — verified read-only 2026-08-02:
// job_form_templates has 0 rows, so the seed has never run there and this
// migration is a no-op. It exists for the environments where it HAS run
// (a developer or preview database restored from one), because those are
// exactly the places a stale template would go unnoticed.
//
// Admin-edit-preserving: this rewrites ONLY the exact option string, inside
// the one field that offers it, and only where that string is still present.
// Any other edit to the template — reordered options, added choices, reworded
// labels — survives untouched, and a template whose author already renamed it
// simply does not match.

const OLD = 'Brown patch';
const NEW = 'Large patch';
const FIELD_KEY = 'disease_symptoms';

exports.OLD = OLD;
exports.NEW = NEW;
exports.FIELD_KEY = FIELD_KEY;

// Swap the option inside the target field only, leaving every other section,
// field and option exactly as-is. jsonb round-trips through JS so the nested
// rewrite stays readable rather than becoming a jsonb_path_query expression.
function renameOption(sections, from, to) {
  if (!Array.isArray(sections)) return { sections, changed: false };
  let changed = false;
  const next = sections.map((section) => {
    const fields = Array.isArray(section?.fields) ? section.fields : null;
    if (!fields) return section;
    return {
      ...section,
      fields: fields.map((field) => {
        if (field?.key !== FIELD_KEY || !Array.isArray(field.options)) return field;
        if (!field.options.includes(from)) return field;
        changed = true;
        return { ...field, options: field.options.map((o) => (o === from ? to : o)) };
      }),
    };
  });
  return { sections: next, changed };
}

exports.renameOption = renameOption;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('job_form_templates'))) return;

  const rows = await knex('job_form_templates').select('id', 'sections', 'version');
  for (const row of rows) {
    const sections = typeof row.sections === 'string' ? JSON.parse(row.sections) : row.sections;
    const { sections: next, changed } = renameOption(sections, OLD, NEW);
    if (!changed) continue;
    await knex('job_form_templates')
      .where({ id: row.id })
      .update({
        sections: JSON.stringify(next),
        version: (row.version || 1) + 1,
        updated_at: new Date(),
      });
  }
};

// Deliberately a no-op, for the same reason as its sibling migrations: a
// template already offering "Large patch" because its author renamed it by
// hand is indistinguishable from one this migration rewrote, and reverting
// would undo their correction. Both strings name the same disease, so there is
// nothing worth restoring at that cost.
exports.down = async function down() {};
