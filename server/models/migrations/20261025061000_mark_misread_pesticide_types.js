// Mark the EPA-registered catalog rows the portal misreads as pesticides (owner 2026-10-24: "fix all these").
// These rows have no product_type, and their category (termiticide, termite bait, rodenticide, IGR, bait, mosquito,
// fertilizer) is not one the category guess reads as a pesticide (/(herbicide|insecticide|fungicide|pgr|growth)/ in
// admin-inventory.js, report-data.js, report-copy-context.js and lawn-service-outline.js), so every reader typed them
// "other". All 18 carry a real EPA registration number (checked against EPA's label system 2026-10-24). Only rows
// whose product_type is still empty change, so a type someone set by hand is kept.
const NAMES = Object.freeze([
  'Advance Termite Bait Station',
  'Bora-Care',
  'Contrac Blox',
  'Cytogro Liquid Biostimulant',
  'Distance IGR',
  'Gentrol IGR',
  'In2Care Mosquito Station',
  'Summit Mosquito Dunk Tablets',
  'Talus 70 DF IGR',
  'Tekko Pro IGR',
  'Termidor Foam',
  'Termidor SC',
  'Trelona ATBS Bait Station',
  'Trelona Compressed Termite Bait Cartridges',
  'Vendetta Plus',
  // inactive rows, typed the same way so a reactivated row reads correctly
  'Advion Cockroach Gel',
  'Advion Cockroach Gel Bait',
  'Trelona ATBS Annual Bait Station',
]);
// Passed as a binding: a literal ? inside whereRaw would be read as a placeholder.
const REAL_EPA_PATTERN = '^[0-9]+-[0-9]+(-[0-9]+)?$';

exports.up = async function up(knex) {
  await knex('products_catalog')
    .whereIn('name', NAMES)
    .whereNull('product_type')
    .whereRaw('epa_reg_number ~ ?', [REAL_EPA_PATTERN])
    .update({ product_type: 'pesticide', updated_at: knex.fn.now() });
};

// Down leaves the types in place: they are correct data, and a rollback cannot tell a type this migration set
// from one set by hand on the same row afterwards, so clearing them could erase a classification it never made.
exports.down = async function down() {};
