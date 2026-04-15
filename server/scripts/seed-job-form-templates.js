#!/usr/bin/env node
/**
 * Seed — Job Form Templates
 *
 * Per-service-type checklists techs fill out on-site. Upserts by service_type.
 * Safe to re-run — existing rows are updated (bumps version on real change).
 *
 *   node server/scripts/seed-job-form-templates.js
 */

const db = require('../models/db');

// ─── Field helpers ──────────────────────────────────────────────────
const cb = (id, label, required = false) => ({ id, type: 'checkbox', label, ...(required ? { required: true } : {}) });
const sel = (id, label, options, required = false) => ({ id, type: 'select', label, options, ...(required ? { required: true } : {}) });
const ms = (id, label, options) => ({ id, type: 'multi_select', label, options });
const num = (id, label, unit) => ({ id, type: 'number', label, ...(unit ? { unit } : {}) });
const txt = (id, label, placeholder) => ({ id, type: 'textarea', label, ...(placeholder ? { placeholder } : {}) });

// ─── Templates ──────────────────────────────────────────────────────
const TEMPLATES = [
  {
    service_type: 'pest_quarterly',
    name: 'Pest Control — Quarterly',
    description: 'Standard residential quarterly — interior + exterior treatment.',
    sections: [
      {
        id: 'exterior', title: 'Exterior Treatment', fields: [
          cb('perimeter_spray', 'Perimeter band spray (3ft out, 3ft up)', true),
          cb('foundation_cracks', 'Treated foundation cracks & entry points'),
          cb('eave_deweb', 'De-webbed eaves & overhangs'),
          cb('window_frames', 'Treated around window & door frames'),
          cb('garage_entry', 'Treated garage entry points'),
          sel('bait_stations', 'Bait station status',
            ['All active — no issues', 'Replaced bait in stations', 'Repositioned stations', 'Added new stations', 'N/A — no stations']),
          cb('granular_beds', 'Granular treatment in landscape beds'),
          txt('exterior_notes', 'Exterior notes', 'Pest activity observed, areas of concern…'),
        ],
      },
      {
        id: 'interior', title: 'Interior Treatment', fields: [
          sel('interior_done', 'Interior treatment',
            ['Full interior treatment', 'Kitchen & bathrooms only', 'Customer declined — exterior only', 'Customer not home — exterior only'],
            true),
          cb('baseboards', 'Baseboard crack & crevice treatment'),
          cb('kitchen_treatment', 'Kitchen — under sink, behind appliances'),
          cb('bathroom_treatment', 'Bathrooms — under sinks, around pipes'),
          cb('gel_bait', 'Applied gel bait (roaches/ants)'),
          txt('interior_notes', 'Interior notes'),
        ],
      },
      {
        id: 'findings', title: 'Findings & Recommendations', fields: [
          ms('pest_activity', 'Pest activity observed',
            ['Ghost ants', 'Fire ants', 'Carpenter ants', 'German roaches', 'American roaches', 'Palmetto bugs',
              'Spiders', 'Silverfish', 'Earwigs', 'Millipedes', 'Centipedes', 'Wasps/hornets', 'Rodent signs',
              'Termite signs', 'Whitefly', 'No significant activity']),
          sel('activity_level', 'Overall activity level',
            ['None observed', 'Minimal — normal for area', 'Moderate — monitoring', 'Heavy — recommend follow-up', 'Severe — recommend callback ASAP']),
          txt('recommendations', 'Recommendations for customer or next visit'),
          cb('follow_up_needed', 'Flag for callback / follow-up visit'),
        ],
      },
    ],
  },

  {
    service_type: 'pest_monthly',
    name: 'Pest Control — Monthly',
    description: 'Monthly commercial / heavy-infestation residential — more detailed interior.',
    sections: [
      {
        id: 'exterior', title: 'Exterior Treatment', fields: [
          cb('perimeter_spray', 'Perimeter band spray', true),
          cb('foundation_cracks', 'Foundation cracks & entry points'),
          cb('eave_deweb', 'De-webbed eaves'),
          cb('dumpster_area', 'Treated dumpster/trash area (if applicable)'),
          cb('granular_beds', 'Granular in landscape beds'),
        ],
      },
      {
        id: 'interior', title: 'Interior Treatment', fields: [
          cb('kitchen_full', 'Full kitchen treatment — cabinets, appliances, voids', true),
          cb('bathrooms_full', 'All bathrooms — plumbing penetrations, voids'),
          cb('common_areas', 'Common areas (living room, hallways, closets)'),
          cb('storage_areas', 'Storage / utility rooms'),
          cb('gel_bait_refresh', 'Refreshed gel bait placements'),
          cb('monitor_traps', 'Checked/replaced monitor traps'),
        ],
      },
      {
        id: 'findings', title: 'Findings', fields: [
          ms('pest_activity', 'Pest activity observed',
            ['German roaches', 'American roaches', 'Ghost ants', 'Fire ants', 'Rodent droppings', 'Flies', 'No significant activity']),
          sel('activity_trend', 'Activity trend vs last visit',
            ['Improving', 'Stable', 'Worsening — investigate further']),
          txt('findings_notes', 'Notes'),
          cb('follow_up_needed', 'Flag for follow-up'),
        ],
      },
    ],
  },

  {
    service_type: 'lawn_visit',
    name: 'Lawn Care — Application Visit',
    description: 'Turf assessment + applications + post-treatment guidance.',
    sections: [
      {
        id: 'assessment', title: 'Pre-Treatment Assessment', fields: [
          sel('turf_color', 'Turf color', ['Dark green — healthy', 'Green — acceptable', 'Pale — stressed', 'Yellowing — chlorotic', 'Brown patches']),
          sel('density', 'Turf density', ['Thick', 'Medium', 'Thin — overseed recommended', 'Bare spots']),
          sel('weed_pressure', 'Weed pressure', ['None', 'Light', 'Moderate', 'Heavy']),
          ms('disease_symptoms', 'Disease / issues',
            ['None', 'Brown patch', 'Dollar spot', 'Gray leaf spot', 'Take-all root rot', 'Chinch bug damage', 'Sod webworm', 'Mole cricket activity']),
          sel('soil_moisture_level', 'Soil moisture', ['Dry', 'Moderate', 'Wet — hold off irrigation']),
        ],
      },
      {
        id: 'measurements', title: 'Measurements (if taken)', fields: [
          num('soil_temp_f', 'Soil temperature', '°F'),
          num('thatch_depth_in', 'Thatch depth', 'in'),
          num('soil_ph', 'Soil pH', ''),
        ],
      },
      {
        id: 'application', title: 'Application', fields: [
          cb('fertilizer_applied', 'Fertilizer applied'),
          cb('herbicide_applied', 'Pre/post-emergent herbicide applied'),
          cb('insecticide_applied', 'Insecticide applied'),
          cb('fungicide_applied', 'Fungicide applied'),
          txt('application_notes', 'Application notes', 'Products handled via product picker — any spot treatments or exceptions?'),
        ],
      },
      {
        id: 'post', title: 'Post-Treatment', fields: [
          sel('irrigation_instructions', 'Irrigation guidance to customer',
            ['Water in within 24 hrs', 'Hold irrigation 24 hrs', 'Resume normal schedule', 'No change']),
          num('re_entry_hours', 'Re-entry time', 'hrs'),
          txt('next_visit_notes', 'Notes for next visit'),
        ],
      },
    ],
  },

  {
    service_type: 'mosquito_monthly',
    name: 'Mosquito — Monthly Barrier',
    description: 'WaveGuard mosquito treatment — barrier spray + larvicide + education.',
    sections: [
      {
        id: 'spray', title: 'Barrier Spray', fields: [
          cb('shrubs', 'Shrubs & ornamentals', true),
          cb('fence_line', 'Fence line & perimeter'),
          cb('eaves', 'Eaves & overhangs'),
          cb('lanai', 'Lanai / pool cage exterior'),
          cb('under_decks', 'Under decks / crawl areas'),
        ],
      },
      {
        id: 'standing_water', title: 'Standing Water Check', fields: [
          cb('bromeliads', 'Bromeliads flushed/treated'),
          cb('gutters', 'Gutters checked'),
          cb('birdbaths', 'Birdbaths checked'),
          cb('ac_drip_pans', 'AC drip pans'),
          cb('plant_saucers', 'Plant saucers'),
          cb('toys_containers', 'Toys / containers / buckets'),
          txt('water_notes', 'Notes on standing water sources'),
        ],
      },
      {
        id: 'larvicide', title: 'Larvicide', fields: [
          cb('larvicide_applied', 'Larvicide applied where needed'),
          sel('larvicide_areas', 'Areas treated',
            ['Bromeliads only', 'Bromeliads + gutters', 'Full property', 'N/A — no standing water']),
        ],
      },
      {
        id: 'education', title: 'Customer Education', fields: [
          cb('told_customer_dump_water', 'Reminded customer to dump standing water weekly'),
          txt('education_notes', 'Any specific advice given'),
        ],
      },
    ],
  },

  {
    service_type: 'tree_shrub',
    name: 'Tree & Shrub — Quarterly',
    description: 'Ornamental health — scale, whitefly, sooty mold, nutrient deficiencies.',
    sections: [
      {
        id: 'assessment', title: 'Visual Assessment', fields: [
          ms('plants_inspected', 'Plant types inspected',
            ['Palms', 'Crape myrtle', 'Hibiscus', 'Gardenia', 'Ixora', 'Viburnum', 'Ficus hedge', 'Oaks', 'Citrus', 'Other ornamentals']),
          ms('issues_found', 'Issues observed',
            ['Scale', 'Whitefly', 'Sooty mold', 'Nutrient deficiency (yellowing)', 'Spider mites', 'Aphids', 'Mealybugs', 'Lacebugs', 'No significant issues']),
          sel('severity', 'Overall severity', ['Healthy — preventive only', 'Light issues', 'Moderate — active treatment', 'Heavy — follow-up recommended']),
        ],
      },
      {
        id: 'treatments', title: 'Treatments Applied', fields: [
          cb('soil_drench', 'Systemic soil drench'),
          cb('foliar_spray', 'Foliar spray'),
          cb('trunk_injection', 'Trunk injection'),
          cb('granular_fertilizer', 'Granular fertilizer'),
          txt('treatment_notes', 'Treatment notes'),
        ],
      },
      {
        id: 'recommendations', title: 'Recommendations', fields: [
          txt('recommendations', 'Recommendations for customer'),
          cb('follow_up_needed', 'Flag for follow-up'),
        ],
      },
    ],
  },

  {
    service_type: 'wdo_inspection',
    name: 'WDO Inspection',
    description: 'Wood-destroying organism inspection — structured findings for NPMA-33.',
    sections: [
      {
        id: 'subterranean', title: 'Subterranean Termite', fields: [
          cb('sub_mud_tubes', 'Mud tubes present'),
          cb('sub_damage', 'Active damage observed'),
          cb('sub_swarmers', 'Swarmers / wings'),
          txt('sub_locations', 'Location of findings'),
        ],
      },
      {
        id: 'drywood', title: 'Drywood Termite', fields: [
          cb('dry_frass', 'Frass / pellets'),
          cb('dry_kickout', 'Kick-out holes'),
          cb('dry_damage', 'Active damage'),
          txt('dry_locations', 'Location of findings'),
        ],
      },
      {
        id: 'decay', title: 'Wood Decay', fields: [
          cb('moisture_damage', 'Moisture damage observed'),
          cb('fungal_growth', 'Fungal growth'),
          txt('decay_locations', 'Location'),
        ],
      },
      {
        id: 'other_wdo', title: 'Other WDO', fields: [
          cb('powderpost', 'Powderpost beetles'),
          cb('old_house_borer', 'Old house borers'),
          cb('carpenter_ants', 'Carpenter ants'),
          txt('other_notes', 'Notes'),
        ],
      },
      {
        id: 'areas', title: 'Areas Inspected', fields: [
          cb('attic', 'Attic'),
          cb('crawlspace', 'Crawlspace'),
          cb('garage', 'Garage'),
          cb('exterior_walls', 'All exterior walls'),
          cb('bathrooms', 'Bathrooms'),
          cb('kitchen', 'Kitchen'),
          cb('windows', 'Windows'),
          txt('inaccessible_areas', 'Inaccessible areas (must disclose)'),
        ],
      },
      {
        id: 'finding', title: 'Overall Finding', fields: [
          sel('overall', 'Finding',
            ['No WDO / No evidence', 'Evidence of past activity — no active', 'Active WDO — treatment recommended', 'Inaccessible — unable to determine'],
            true),
          txt('inspector_comments', 'Inspector comments'),
        ],
      },
    ],
  },

  {
    service_type: 'rodent_visit',
    name: 'Rodent — Service Visit',
    description: 'Bait station service, interior inspection, exclusion work.',
    sections: [
      {
        id: 'stations', title: 'Bait Station Check', fields: [
          num('stations_serviced', 'Stations serviced', ''),
          num('stations_with_activity', 'Stations with activity', ''),
          cb('bait_replaced', 'Replaced bait where needed'),
          cb('stations_repositioned', 'Repositioned stations for better placement'),
          txt('station_notes', 'Station notes'),
        ],
      },
      {
        id: 'interior', title: 'Interior Inspection', fields: [
          cb('droppings_found', 'Droppings observed'),
          cb('gnaw_marks', 'Gnaw marks'),
          cb('grease_rubs', 'Grease rubs / travel paths'),
          txt('entry_points', 'Entry points identified'),
        ],
      },
      {
        id: 'exclusion', title: 'Exclusion Work', fields: [
          cb('sealed_gaps', 'Sealed gaps / holes'),
          cb('installed_door_sweeps', 'Installed door sweeps'),
          cb('steel_wool_copper_mesh', 'Stuffed penetrations with steel wool / copper mesh'),
          txt('exclusion_notes', 'Exclusion notes'),
        ],
      },
      {
        id: 'recommendations', title: 'Recommendations', fields: [
          sel('activity_level', 'Current activity level',
            ['None', 'Minimal', 'Moderate', 'Heavy — increase visit frequency']),
          txt('recommendations', 'Notes / recommendations'),
          cb('follow_up_needed', 'Flag for follow-up'),
        ],
      },
    ],
  },

  {
    service_type: 'termite_treatment',
    name: 'Termite Treatment',
    description: 'Liquid termiticide application — trench/inject + monitoring.',
    sections: [
      {
        id: 'treatment_area', title: 'Treatment Area', fields: [
          num('linear_feet', 'Linear feet treated', 'ft'),
          num('trench_depth', 'Trench depth', 'in'),
          num('injection_points', 'Injection points drilled', ''),
          sel('construction_type', 'Construction', ['Pre-construction', 'Post-construction']),
        ],
      },
      {
        id: 'product', title: 'Product Application', fields: [
          num('gallons_mixed', 'Gallons mixed', 'gal'),
          num('concentration_pct', 'Concentration', '%'),
          txt('epa_reg', 'EPA reg number'),
          txt('product_notes', 'Product notes'),
        ],
      },
      {
        id: 'monitoring', title: 'Monitoring Stations', fields: [
          num('stations_placed', 'Stations placed', ''),
          txt('station_locations', 'Station locations'),
        ],
      },
      {
        id: 'warranty', title: 'Warranty', fields: [
          sel('warranty_type', 'Warranty', ['1-year renewable', '5-year renewable', '10-year renewable', 'None']),
          txt('warranty_notes', 'Warranty notes / customer briefed'),
        ],
      },
    ],
  },
];

async function run() {
  console.log(`\n[seed-templates] Seeding ${TEMPLATES.length} job form templates…\n`);

  let created = 0, updated = 0;
  for (const tpl of TEMPLATES) {
    const existing = await db('job_form_templates').where({ service_type: tpl.service_type }).first();
    if (existing) {
      const existingJson = JSON.stringify(existing.sections);
      const newJson = JSON.stringify(tpl.sections);
      if (existingJson !== newJson || existing.name !== tpl.name || existing.description !== tpl.description) {
        await db('job_form_templates').where({ id: existing.id }).update({
          name: tpl.name,
          description: tpl.description,
          sections: JSON.stringify(tpl.sections),
          version: (existing.version || 1) + 1,
          updated_at: new Date(),
        });
        console.log(`  ↻ ${tpl.service_type} (v${(existing.version || 1) + 1})`);
        updated++;
      } else {
        console.log(`  = ${tpl.service_type} (unchanged)`);
      }
    } else {
      await db('job_form_templates').insert({
        service_type: tpl.service_type,
        name: tpl.name,
        description: tpl.description,
        sections: JSON.stringify(tpl.sections),
      });
      console.log(`  + ${tpl.service_type}`);
      created++;
    }
  }

  console.log(`\n[seed-templates] Done — ${created} created, ${updated} updated, ${TEMPLATES.length - created - updated} unchanged.\n`);
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(err => { console.error('[seed-templates] FATAL:', err); process.exit(1); });
}

module.exports = { run };
