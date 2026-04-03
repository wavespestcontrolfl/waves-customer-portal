exports.up = async function (knex) {
  // Photo reference library
  await knex.schema.createTable('protocol_photos', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('category', 30); // pest_id, disease_id, weed_id, damage_id, equipment, technique, before_after, product
    t.string('name', 200).notNullable();
    t.text('description');
    t.string('photo_url', 500);
    t.string('thumbnail_url', 500);
    t.jsonb('tags').defaultTo('[]');
    t.jsonb('service_lines').defaultTo('[]');
    t.jsonb('grass_types');
    t.jsonb('months_relevant');
    t.uuid('comparison_photo_id').references('id').inTable('protocol_photos');
    t.integer('sort_order').defaultTo(0);
    t.boolean('active').defaultTo(true);
    t.uuid('uploaded_by').references('id').inTable('technicians');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Seasonal pest pressure index
  await knex.schema.createTable('seasonal_pest_index', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.integer('month').notNullable(); // 1-12
    t.string('service_line', 30).notNullable();
    t.string('pest_name', 100).notNullable();
    t.string('pressure_level', 20); // low, moderate, high, peak, dormant
    t.text('description');
    t.text('treatment_if_found');
    t.integer('sort_order').defaultTo(0);
  });

  // Communication scripts
  await knex.schema.createTable('communication_scripts', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('scenario', 50).notNullable();
    t.string('service_line', 30);
    t.string('title', 200).notNullable();
    t.text('script').notNullable();
    t.text('tone_notes');
    t.integer('sort_order').defaultTo(0);
    t.boolean('active').defaultTo(true);
  });

  // Equipment checklists
  await knex.schema.createTable('equipment_checklists', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('service_line', 30).notNullable();
    t.string('service_type', 200).notNullable();
    t.jsonb('checklist_items').notNullable();
    t.text('notes');
    t.timestamps(true, true);
  });

  // Extend product catalog with label data
  await knex.schema.alterTable('products_catalog', (t) => {
    t.decimal('rain_free_hours', 4, 1);
    t.integer('min_temp_f');
    t.integer('max_temp_f');
    t.integer('max_wind_mph');
    t.string('dilution_rate', 100);
    t.text('mixing_instructions');
    t.jsonb('ppe_required');
    t.boolean('restricted_use').defaultTo(false);
    t.string('maximum_annual_rate', 100);
    t.integer('reapplication_interval_days');
    t.text('pollinator_precautions');
    t.integer('aquatic_buffer_ft');
    t.text('compatibility_notes');
    t.string('signal_word', 20);
    t.integer('rei_hours');
  });

  // Seed photo references (descriptions only — photos uploaded later)
  const photoRefs = [
    { category: 'damage_id', name: 'Chinch Bug Damage vs Drought Stress', description: 'CHINCH: Irregular yellow-brown patches at sunny edges near concrete. Grass pulls up easily. Float test: ≥20/sq ft = treat. DROUGHT: Uniform wilting, V-shaped leaf blades, grass stays rooted. KEY: Pull test — chinch = no resistance, drought = rooted.', tags: JSON.stringify(['chinch','drought','st_augustine','summer']), service_lines: JSON.stringify(['lawn']), months_relevant: JSON.stringify([5,6,7,8,9]) },
    { category: 'disease_id', name: 'Large Patch vs Take-All Root Rot', description: 'LARGE PATCH: Circular 1-20ft patches, orange-brown margins, smoke ring edge. Soil temps 60-75°F. TARR: Irregular thinning, dark rotted roots. CRITICAL: Do NOT use azoxystrobin on TARR. KEY: Shape + root exam + fungicide selection differs.', tags: JSON.stringify(['large_patch','tarr','fungus','st_augustine']), service_lines: JSON.stringify(['lawn']), months_relevant: JSON.stringify([1,2,3,10,11,12]) },
    { category: 'pest_id', name: 'Chinch Bug Life Stages', description: 'Nymph 1: 1mm bright red-orange with white band. Adult: 3-4mm black with white X-pattern wings. FLOAT TEST: Coffee can, fill with water, count bugs in 5 min. Threshold ≥20/sq ft. ROTATION: 1st Talstar (3A), 2nd Arena (4A). Never repeat same MOA.', tags: JSON.stringify(['chinch','float_test','identification']), service_lines: JSON.stringify(['lawn']), months_relevant: JSON.stringify([4,5,6,7,8,9]) },
    { category: 'weed_id', name: 'Common SWFL Lawn Weeds', description: 'DOLLAR WEED: Round leaves, loves wet areas, indicator of overwatering. Celsius/Dismiss. CRABGRASS: Wide blades, spreading. Prodiamine prevention. TORPEDO GRASS: NO selective control in St. Aug. DOVEWEED: Fleshy succulent-like. Celsius+MSM combo. SEDGE: Triangular stem (roll test). Sedgehammer.', tags: JSON.stringify(['weeds','dollar_weed','crabgrass','sedge']), service_lines: JSON.stringify(['lawn']), months_relevant: JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12]) },
    { category: 'pest_id', name: 'Scale Crawlers vs Dead Shells', description: 'LIVE: Tiny mobile soft-bodied, colored smear when crushed — TREAT NOW. DEAD (Ghost Scale): Hard waxy immobile, dry/flaky when scraped — NO treatment needed. KEY: Fingernail test. Customer comm: "Shells are evidence treatment is working."', tags: JSON.stringify(['scale','crawlers','ghost_scale','tree_shrub']), service_lines: JSON.stringify(['tree_shrub']), months_relevant: JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12]) },
    { category: 'pest_id', name: 'Spiraling Whitefly Protocol', description: 'White spiral egg patterns on palm frond undersides. Honeydew→sooty mold. TREATMENT: 1st Zylam bark spray, 2nd Merit drench, 3rd Kontos rotation. Sooty mold weathers off — no separate fungicide needed.', tags: JSON.stringify(['whitefly','spiraling','sooty_mold','palm']), service_lines: JSON.stringify(['tree_shrub']), months_relevant: JSON.stringify([3,4,5,6,7,8,9,10]) },
    { category: 'pest_id', name: 'Ficus Whitefly — Critical', description: 'MOST DESTRUCTIVE landscape pest in SWFL. Rapid defoliation. TREATMENT: Zylam bark IMMEDIATELY + Merit drench + Safari 20SG for severe. Spreads fast between properties — recommend treating neighbors (referral opportunity).', tags: JSON.stringify(['ficus','whitefly','critical','hedge']), service_lines: JSON.stringify(['tree_shrub']), months_relevant: JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12]) },
    { category: 'damage_id', name: 'Palm Nutrient Deficiencies', description: 'MANGANESE (Frizzle Top): Stunted crinkled new fronds. POTASSIUM: Orange translucent spots on older fronds. MAGNESIUM: Yellow bands on margins. IRON: Overall yellowing with green veins. KEY: NEVER remove yellow fronds — palm is translocating nutrients.', tags: JSON.stringify(['palm','nutrient','deficiency','manganese']), service_lines: JSON.stringify(['tree_shrub']), months_relevant: JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12]) },
    { category: 'pest_id', name: 'German vs American Roach', description: 'GERMAN: Small 1/2", tan, two dark stripes, INDOORS ONLY, rapid reproducer. Needs gel baits + IGR. AMERICAN: Large 1.5", reddish-brown, peridomestic. Perimeter treatment works. KEY: If it flies = NOT German.', tags: JSON.stringify(['roach','cockroach','german','american','identification']), service_lines: JSON.stringify(['pest']), months_relevant: JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12]) },
    { category: 'pest_id', name: 'Termite Swarmers vs Flying Ants', description: 'TERMITE: Equal wings, straight antennae, broad waist. Wings shed easily. FLYING ANT: Unequal wings, elbowed antennae, pinched waist. KEY: Antennae + waist + wing size. Swarmers inside = UPSELL OPPORTUNITY for bait stations.', tags: JSON.stringify(['termite','swarmer','flying_ant','identification','upsell']), service_lines: JSON.stringify(['pest','termite']), months_relevant: JSON.stringify([3,4,5]) },
  ];
  await knex('protocol_photos').insert(photoRefs);

  // Seed seasonal pest index (key months)
  const seasonalIndex = [
    { month: 1, service_line: 'lawn', pest_name: 'Large Patch (Rhizoctonia)', pressure_level: 'high', description: 'Cool-season fungus. Soil 60-70°F. Circular patches, orange margins.', treatment_if_found: 'Headway G or Medallion SC. Record FRAC for rotation.' },
    { month: 1, service_line: 'pest', pest_name: 'Rodent Intrusion', pressure_level: 'high', description: 'Cool nights drive rats/mice into attics. Check droppings, gnaw marks.', treatment_if_found: 'Exclusion assessment. Contrac Blox stations. Snap traps in attic.' },
    { month: 4, service_line: 'lawn', pest_name: 'Chinch Bug', pressure_level: 'moderate', description: 'First generation hatching. Scout sunny edges near concrete.', treatment_if_found: 'Float test. ≥20/sq ft: Talstar P. 14-day recheck.' },
    { month: 4, service_line: 'termite', pest_name: 'Termite Swarmers', pressure_level: 'peak', description: 'PEAK SWARM. After warm rain. Wings near windows. UPSELL: every swarm = inspection recommendation.', treatment_if_found: 'Swarmers alone: monitor. + mud tubes: liquid treatment or bait.' },
    { month: 4, service_line: 'tree_shrub', pest_name: 'Spiraling Whitefly', pressure_level: 'high', description: 'Check palm frond undersides for spiral egg patterns.', treatment_if_found: 'Zylam bark spray + Merit drench follow-up.' },
    { month: 7, service_line: 'lawn', pest_name: 'Chinch Bug', pressure_level: 'peak', description: 'PEAK. 2nd-3rd generations active. Track A highest risk.', treatment_if_found: 'Rotate MOA from previous treatment. If 3A used, switch to 4A.' },
    { month: 7, service_line: 'pest', pest_name: 'Ghost Ants', pressure_level: 'peak', description: 'SWFL most common ant. Tiny, dark head, pale legs. Multiple queens.', treatment_if_found: 'Advion Ant Gel along trails + Alpine WSG perimeter. NO repellent sprays on trails.' },
    { month: 7, service_line: 'mosquito', pest_name: 'Mosquito', pressure_level: 'peak', description: 'Peak breeding. Afternoon storms = standing water everywhere.', treatment_if_found: 'Backpack mist to vegetation + Bti dunks in standing water.' },
    { month: 10, service_line: 'lawn', pest_name: 'Large Patch (Rhizoctonia)', pressure_level: 'moderate', description: 'Soil cooling toward 70°F. Early-season pressure building.', treatment_if_found: 'Preventive Headway G if history of large patch. Rotate FRAC groups.' },
  ];
  await knex('seasonal_pest_index').insert(seasonalIndex);

  // Seed communication scripts
  const scripts = [
    { scenario: 'objection_still_seeing_bugs', service_line: 'pest', title: 'When Customer Says: "I\'m Still Seeing Bugs"', script: 'First: validate. "I understand that\'s frustrating. Let me take a look."\n\nIF DEAD/DYING: "The product is working. Bugs are being flushed out. Taper off in 7-14 days."\nIF LIVE (first 2 weeks): "Takes 10-14 days. Transfer effect carries product back to nest. Free callback under WaveGuard if still active."\nIF LIVE (2+ weeks): "Let me re-treat today, rotating to a different product class. Your WaveGuard includes unlimited callbacks."', tone_notes: 'Empathetic first, diagnostic second, solution-oriented third. Never dismiss.' },
    { scenario: 'explaining_product_safety', service_line: 'general', title: 'When Customer Asks About Safety (Kids/Pets)', script: 'Products are EPA-registered, applied at label rates. Once dry (~20-45 min), surfaces are safe for re-entry. Keep pets off treated areas until dry. Products bond to surfaces — won\'t transfer once dry.', tone_notes: 'Never say "completely safe." Say "once dry, safe for re-entry" with specific timeline.' },
    { scenario: 'fertilizer_blackout', service_line: 'lawn', title: 'Explaining Summer Nitrogen Blackout', script: 'June 1-Sept 30: Manatee/Sarasota counties prohibit nitrogen. We switch to iron, potassium, micronutrients. Slight growth slowdown is normal and beneficial. Last N app in May, recovery N app in October.', tone_notes: 'Position as professional compliance, not a limitation.' },
    { scenario: 'upsell_termite', service_line: 'pest', title: 'Upselling Termite Protection', script: 'Trigger: mud tubes, swarmers, or damaged wood. "I noticed [finding]. Recommend full inspection — 45 min, free for WaveGuard members. Protection comes with $500K damage repair guarantee, transfers with home sale."', tone_notes: 'Educational, not alarmist. Damage guarantee is the closer.' },
    { scenario: 'objection_too_expensive', service_line: 'general', title: 'When Customer Says: "Too Expensive"', script: 'Ask: comparing to competitor or budget concern? If competitor: detail what\'s included (unlimited callbacks, compliance tracking, reports). If budget: offer lower tier, one-time option, or show WaveGuard savings vs per-service.', tone_notes: 'Never discount on the spot. Present tiers as the path to lower price.' },
  ];
  await knex('communication_scripts').insert(scripts);

  // Seed equipment checklists
  const checklists = [
    { service_line: 'lawn', service_type: 'Lawn Care — Standard Visit', checklist_items: JSON.stringify([
      { category: 'Spray Rig', items: [{ item: 'Pump primed', required: true }, { item: 'Hannay reel — 200ft hose', required: true }, { item: 'TeeJet AI11004 nozzle (herbicide)', required: true }, { item: 'NIS surfactant', required: true }] },
      { category: 'Granular', items: [{ item: 'LESCO push spreader — calibrated', required: true }, { item: 'Spreader guard plate', required: true }] },
      { category: 'Measurement', items: [{ item: 'Soil probe (thatch)', required: true }, { item: 'Soil thermometer', required: true }, { item: 'Coffee can (chinch test)', required: true, note: 'Apr-Sep only' }] },
      { category: 'PPE', items: [{ item: 'Chemical gloves (nitrile)', required: true }, { item: 'Safety glasses', required: true }, { item: 'Long sleeves + pants', required: true }] },
    ]) },
    { service_line: 'pest', service_type: 'Quarterly Pest Control — Residential', checklist_items: JSON.stringify([
      { category: 'Spray Equipment', items: [{ item: 'B&G 1 gal sprayer (interior)', required: true }, { item: 'FlowZone Typhoon backpack (exterior)', required: true }, { item: 'Pin stream nozzle', required: true }, { item: 'Fan nozzle', required: true }] },
      { category: 'Baits', items: [{ item: 'Vendetta Plus gel (roach)', required: true }, { item: 'Advion Ant Gel', required: true }, { item: 'Advion WDG granular', required: true }, { item: 'Bait gun', required: true }] },
      { category: 'Tools', items: [{ item: 'Webster duster (cobweb sweep)', required: true }, { item: 'Flashlight', required: true }, { item: 'Glue boards', required: true }] },
    ]) },
    { service_line: 'tree_shrub', service_type: 'Tree & Shrub — Standard Visit', checklist_items: JSON.stringify([
      { category: 'Spray', items: [{ item: 'FlowZone backpack — charged', required: true }, { item: 'Brass cone nozzle (canopy)', required: true }, { item: 'Fan nozzle (bed broadcast)', required: true }] },
      { category: 'Inspection', items: [{ item: 'Hand lens/loupe', required: true }, { item: 'White paper (mite shake test)', required: true }] },
      { category: 'Granular', items: [{ item: 'Hand spreader', required: true }, { item: '8-2-12 palm fertilizer', required: true }] },
    ]) },
  ];
  await knex('equipment_checklists').insert(checklists);

  // Update product label data for key products
  const celsius = await knex('products_catalog').where('name', 'ilike', '%Celsius%').first();
  if (celsius) await knex('products_catalog').where({ id: celsius.id }).update({ signal_word: 'Caution', rei_hours: 0, rain_free_hours: 4, min_temp_f: 50, max_temp_f: 95, max_wind_mph: 15, dilution_rate: '0.057-0.085 oz/1000sf', ppe_required: JSON.stringify(['long_sleeves','long_pants','chemical_gloves']), maximum_annual_rate: '0.171 oz/1000sf/year', reapplication_interval_days: 60, pollinator_precautions: 'Low risk. Avoid blooming weeds.', aquatic_buffer_ft: 25, compatibility_notes: 'Requires NIS surfactant. Do NOT tank-mix with fertilizer.', mixing_instructions: 'Fill tank 1/2, add Celsius while agitating, add NIS, top off.' });

  const prodiamine = await knex('products_catalog').where('name', 'ilike', '%Prodiamine 65%').first();
  if (prodiamine) await knex('products_catalog').where({ id: prodiamine.id }).update({ signal_word: 'Caution', rei_hours: 0, rain_free_hours: 0, min_temp_f: 40, dilution_rate: '0.36-0.73 oz/1000sf', ppe_required: JSON.stringify(['long_sleeves','long_pants','chemical_gloves']), maximum_annual_rate: '1.5 lb ai/acre/year', compatibility_notes: 'Can tank-mix with liquid fertilizer. Water in within 48h.' });

  const demand = await knex('products_catalog').where('name', '=', 'Demand CS').first();
  if (demand) await knex('products_catalog').where({ id: demand.id }).update({ signal_word: 'Caution', rei_hours: 0, rain_free_hours: 1, max_wind_mph: 15, dilution_rate: '0.2-0.8 oz/gal', ppe_required: JSON.stringify(['long_sleeves','long_pants','chemical_gloves']), pollinator_precautions: 'Toxic to bees. Apply early AM or evening.', aquatic_buffer_ft: 25, compatibility_notes: 'Compatible with most insecticides and IGRs.' });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('products_catalog', (t) => {
    ['rain_free_hours','min_temp_f','max_temp_f','max_wind_mph','dilution_rate','mixing_instructions','ppe_required','restricted_use','maximum_annual_rate','reapplication_interval_days','pollinator_precautions','aquatic_buffer_ft','compatibility_notes','signal_word','rei_hours'].forEach(c => t.dropColumn(c));
  });
  await knex.schema.dropTableIfExists('equipment_checklists');
  await knex.schema.dropTableIfExists('communication_scripts');
  await knex.schema.dropTableIfExists('seasonal_pest_index');
  await knex.schema.dropTableIfExists('protocol_photos');
};
