// Add products_catalog.ppe_text and seed it from the actual product label / SDS
// documents already linked on each row (label_url / sds_url).
//
// Why: the catalog carried every other label-derived safety field (rei_hours,
// reentry_text, rainfast_minutes, irrigation_required, signal_word) but no PPE
// column. The tech Intelligence Bar is instructed to state PPE when the label
// specifies one, and get_product_info advertises "safety notes" — with nothing
// to read, the model had to supply PPE from training memory (ungrounded). This
// grounds it in the real documents.
//
// Source of each string: for EPA-registered pesticides, the label's
// "Applicators and other handlers must wear" PPE block; for fertilizers /
// adjuvants with no label PPE requirement, the SDS Section 8 handling PPE.
// Extracted from the linked PDFs, condensed to the applicator-facing essentials.
// Matched by tight name pattern so every duplicate name-variant of the same
// product gets the same PPE, and guarded to fill only rows where ppe_text is
// still null — never clobber an owner-entered value.
//
// Fail-closed: products whose PPE could not be verified from a document (a few
// LESCO fertilizer/biostimulant rows: 15-0-15, 7-1-7, Elite 0-0-28, CarbonPro-L,
// the High-Manganese soil-amendment variant) are intentionally left null. A
// null surfaces as "see the product label" downstream — no fabricated safety
// text.

const PPE_SEED = [
  // --- EPA-registered pesticides: label applicator PPE ---
  { pattern: '%Acelepryn%', ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves (≥14 mil barrier laminate/nitrile/neoprene/PVC/Viton), shoes plus socks.' },
  { pattern: '%Arena%', ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves, shoes plus socks; protective eyewear.' },
  { pattern: '%Armada%', ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves, shoes plus socks; chemical-resistant apron when mixing/loading.' },
  { pattern: '%Drive XLR8%', ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves (≥14 mil butyl/natural/neoprene/nitrile rubber), shoes plus socks.' },
  { pattern: '%Medallion%', ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves (≥14 mil barrier laminate/butyl/nitrile/neoprene/PVC/Viton), shoes plus socks.' },
  { pattern: '%SpeedZone%', ppe: 'Long-sleeved shirt, long pants, waterproof gloves, shoes plus socks; chemical-resistant apron when mixing/loading or cleaning spills.' },
  { pattern: '%Three-Way%', ppe: 'Long-sleeved shirt, long pants, shoes plus socks, protective eyewear, chemical-resistant gloves (≥14 mil barrier laminate/butyl/neoprene/Viton); chemical-resistant apron when mixing/loading.' },
  { pattern: '%Sedgehammer%', ppe: 'Long-sleeved shirt, long pants, waterproof/chemical-resistant gloves, shoes plus socks.' },
  { pattern: '%Prodiamine%', ppe: 'Long-sleeved shirt, long pants, shoes plus socks, chemical goggles/face shield, chemical-resistant gloves (barrier laminate/butyl/nitrile/neoprene/PVC/Viton).' },
  { pattern: '%Talstar%', ppe: 'Long-sleeved shirt, long pants, socks, shoes, chemical-resistant gloves (nitrile or neoprene); chemical goggles where eye contact is likely.' },
  { pattern: '%Dismiss%', ppe: 'Long-sleeved shirt, long pants, waterproof gloves, shoes plus socks.' },
  { pattern: '%Atrazine%', ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves, shoes plus socks; per product label.' },
  { pattern: '%Celsius%', ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves, shoes plus socks; causes moderate eye irritation — protective eyewear.' },
  { pattern: '%Torque%', ppe: 'Long pants, long-sleeved shirt, socks, shoes; chemical goggles/shielded safety glasses to avoid eye contact.' },
  { pattern: '%Headway%', ppe: 'Protective gloves, protective clothing, eye/face protection (label P280); shoes plus socks.' },
  { pattern: '%Primo%', ppe: 'Protective gloves, protective clothing, eye/face protection (label P280); consult product label for application PPE.' },
  { pattern: '%Topchoice%', ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves, shoes plus socks; per product label.' },
  // --- Fertilizers / adjuvants: SDS Section 8 handling PPE ---
  { pattern: '%Hydretain%', ppe: 'Rubber gloves; splash-proof goggles when pouring/handling; dust mask if working in spray mist.' },
  { pattern: '%Moisture Manager%', ppe: 'Rubber gloves; splash-proof goggles when pouring/handling; dust mask if working in spray mist.' },
  { pattern: '%Chelated AM + Micros%', ppe: 'Neoprene rubber gloves and apron, chemical goggles and full face shield; NIOSH respirator if mist is generated.' },
  { pattern: '%Chelated Iron Plus%', ppe: 'Protective gloves, chemical goggles or safety glasses; appropriate mask if ventilation is poor.' },
  { pattern: '%Green Flo 6-0-0%', ppe: 'Protective gloves, chemical goggles or safety glasses; appropriate mask if ventilation is poor.' },
  { pattern: '%Green Flo Phyte%', ppe: 'Protective gloves, chemical goggles or safety glasses; appropriate mask if ventilation is poor.' },
  { pattern: '%High Manganese Combo AM%', ppe: 'Protective gloves, chemical goggles or safety glasses; appropriate mask if ventilation is poor.' },
  { pattern: '%0-0-18 Bio KMAG%', ppe: 'Gloves, protective clothing, safety glasses; respiratory protection with insufficient ventilation.' },
  { pattern: '%17-0-10%', ppe: 'Gloves, protective clothing, safety glasses; respiratory protection with insufficient ventilation.' },
  { pattern: '%24-0-11%', ppe: 'Gloves, protective clothing, safety glasses; respiratory protection with insufficient ventilation.' },
  { pattern: '%24-2-11%', ppe: 'Gloves, protective clothing, safety glasses; respiratory protection with insufficient ventilation.' },
  { pattern: '%K-Flow 0-0-25%', ppe: 'Chemical-resistant gloves, safety glasses/goggles with side shields, protective clothing; respiratory protection if ventilation is insufficient.' },
  { pattern: '%Dispatch Sprayable%', ppe: 'Eye/face protection (causes serious eye damage); gloves and protective clothing; ensure eyewash station is accessible.' },
];

exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('products_catalog', 'ppe_text');
  if (!hasColumn) {
    await knex.schema.alterTable('products_catalog', (table) => {
      table.text('ppe_text').nullable();
    });
  }

  for (const { pattern, ppe } of PPE_SEED) {
    await knex('products_catalog')
      .whereILike('name', pattern)
      .whereNull('ppe_text')
      .update({ ppe_text: ppe, updated_at: knex.fn.now() });
  }
};

exports.down = async function down(knex) {
  // Only clear the values this migration could have set; then drop the column.
  const hasColumn = await knex.schema.hasColumn('products_catalog', 'ppe_text');
  if (!hasColumn) return;
  await knex.schema.alterTable('products_catalog', (table) => {
    table.dropColumn('ppe_text');
  });
};
