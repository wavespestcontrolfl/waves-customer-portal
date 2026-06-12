/**
 * Project types registry — declarative config for the Projects feature.
 *
 * Each type defines its label, whether it supports a follow-up visit, the
 * photo categories the tech picks from, and the structured findings fields
 * that render into the form and the customer-facing report.
 *
 * Adding a new type = add a row here + seed a report section in
 * client/src/pages/ReportViewPage.jsx. No schema change required.
 */

const WDO_TARGET_OPTIONS = [
  'Subterranean termites',
  'Formosan subterranean termites',
  'Drywood termites',
  'Dampwood termites',
  'Powderpost beetles',
  'Old house borers',
  'Wood-decay fungi',
  'Wood-destroying beetles',
  'Other',
];

const PROJECT_TYPES = {
  wdo_inspection: {
    label: 'WDO Inspection',
    short: 'WDO',
    description: 'FDACS-13645 wood-destroying organism inspection report for real estate / pre-purchase files.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'living_area', 'kitchen', 'bathroom', 'garage', 'attic', 'crawlspace', 'previous_treatment', 'other'],
    findingsFields: [
      { key: 'property_address', label: 'Property inspected', type: 'text', placeholder: 'Street address, city, state, ZIP' },
      { key: 'structures_inspected', label: 'Structure(s) inspected', type: 'textarea', placeholder: 'Main home, detached garage, shed, addition…' },
      { key: 'structure_sqft', label: 'Structure footprint (approx. sq ft)', type: 'text', placeholder: 'Under-roof area, e.g. 2200 — used for the fee tier if no fee is picked' },
      { key: 'inspection_fee', label: 'Inspection fee ($)', type: 'text', placeholder: 'Any amount, e.g. 175 — varies by construction (wood frame), new build, prior termite history' },
      { key: 'requested_by', label: 'Inspection requested by', type: 'text', placeholder: 'Name and contact information' },
      { key: 'report_sent_to', label: 'Report sent to', type: 'text', placeholder: 'Name and contact information if different' },
      { key: 'inspection_scope', label: 'Visible / accessible areas inspected', type: 'textarea', placeholder: 'Interior, attic access, garage, exterior perimeter, crawlspace…' },
      { key: 'wdo_finding', label: 'FDACS Section 2 finding', type: 'select', options: ['No visible signs of WDO observed', 'Visible evidence of WDO observed'] },
      { key: 'live_wdo', label: 'Live WDO(s)', type: 'textarea', placeholder: 'Common name of organism and location, if any' },
      { key: 'wdo_evidence', label: 'Evidence of WDO(s)', type: 'textarea', placeholder: 'Dead insects/parts, frass, shelter tubes, exit holes, description and location' },
      { key: 'wdo_damage', label: 'Damage caused by WDO(s)', type: 'textarea', placeholder: 'Common name, description, and location of visible damage' },
      { key: 'inaccessible_areas', label: 'Obstructions / inaccessible areas', type: 'textarea', placeholder: 'Attic, interior, exterior, crawlspace, other: specific areas and reasons' },
      { key: 'previous_treatment_evidence', label: 'Evidence of previous treatment', type: 'select', options: ['No', 'Yes'] },
      { key: 'previous_treatment_notes', label: 'Previous treatment observations', type: 'textarea', placeholder: 'Visible evidence suggesting possible previous treatment' },
      { key: 'notice_location', label: 'Notice of Inspection location', type: 'text', placeholder: 'Where the notice was affixed to the structure' },
      { key: 'treated_at_inspection', label: 'Treated at time of inspection', type: 'select', options: ['No', 'Yes'] },
      { key: 'organism_treated', label: 'Organism treated', type: 'multi_select', options: WDO_TARGET_OPTIONS },
      { key: 'pesticide_used', label: 'Pesticide used', type: 'product_search', placeholder: 'Search product catalog or type product name' },
      { key: 'treatment_terms', label: 'Treatment terms and conditions', type: 'textarea' },
      { key: 'treatment_method', label: 'Treatment method', type: 'select', options: ['Whole structure', 'Spot treatment', 'Not applicable'] },
      { key: 'treatment_notice_location', label: 'Treatment notice location', type: 'text' },
      { key: 'comments', label: 'Comments / financial disclosure notes', type: 'textarea', placeholder: 'Additional FDACS Section 5 comments' },
    ],
  },

  termite_inspection: {
    label: 'Termite Inspection',
    short: 'Termite',
    description: 'Standalone termite inspection (not for real-estate transactions — use WDO for those).',
    requiresFollowup: false,
    photoCategories: ['exterior', 'foundation', 'garage', 'attic', 'crawlspace', 'evidence', 'other'],
    findingsFields: [
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea' },
      { key: 'termite_type', label: 'Termite species (if found)', type: 'select', options: ['None observed', 'Eastern subterranean', 'Formosan', 'Drywood', 'Dampwood', 'Unknown — sample collected'] },
      { key: 'activity_status', label: 'Activity status', type: 'select', options: ['No activity', 'Old / inactive damage', 'Active infestation'] },
      { key: 'infestation_extent', label: 'Infestation extent', type: 'textarea' },
      { key: 'treatment_recommendation', label: 'Recommended treatment', type: 'textarea' },
    ],
  },

  pest_inspection: {
    label: 'Pest Inspection',
    short: 'Pest',
    description: 'General pest survey (ants, roaches, spiders, etc.) — often pre-treatment scoping.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'kitchen', 'bathroom', 'garage', 'attic', 'entry_point', 'evidence', 'other'],
    findingsFields: [
      { key: 'inspection_type', label: 'Inspection type', type: 'select', section: 'Inspection scope', options: ['General pest inspection', 'Callback diagnostic', 'Estimate inspection', 'Follow-up inspection'] },
      { key: 'areas_inspected', label: 'Areas inspected', type: 'chips', section: 'Inspection scope', options: [
        'Exterior perimeter', 'Foundation', 'Garage', 'Attic entry', 'Kitchen', 'Bathrooms',
        'Bedrooms', 'Lanai', 'Pool cage', 'Eaves / soffits', 'Crawlspace', 'Landscaping',
        'Utility penetrations', 'Roofline from ground',
      ] },
      { key: 'severity', label: 'Severity', type: 'select', section: 'Findings', options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
      { key: 'pests_identified', label: 'Pests identified', type: 'text', section: 'Findings', placeholder: 'e.g. German roaches (kitchen), ghost ants (bath #2)' },
      { key: 'findings_observed', label: 'What we observed', type: 'chips', section: 'Findings', options: [
        'Active pest activity', 'Past evidence only', 'No live activity observed',
        'Moisture concern', 'Entry points found', 'Sanitation concern', 'Structural gaps',
        'Damage observed',
      ] },
      { key: 'conducive_conditions', label: 'Conducive conditions', type: 'chips', section: 'Findings', options: [
        'Moisture present', 'Food debris', 'Clutter / cardboard', 'Vegetation touching structure',
        'Gaps / unsealed penetrations', 'Trash storage issues',
      ] },
      { key: 'access_limitations', label: 'Access limitations', type: 'chips', section: 'Limitations', options: [
        'No limitations', 'Attic not accessible', 'Stored items limited inspection',
        'Heavy vegetation', 'Locked gate', 'Pet present', 'Weather limited exterior',
        'Customer not home', 'Area not safely accessible',
      ] },
      { key: 'customer_recommendations', label: 'Customer recommendations', type: 'chips', section: 'Recommendations', options: [
        'Seal entry gaps', 'Reduce clutter', 'Trim vegetation', 'Correct moisture issue',
        'Treatment program recommended', 'Monitor activity',
      ] },
    ],
  },

  flea: {
    label: 'Flea Service',
    short: 'Flea',
    description: 'Flea inspection, treatment notes, host pressure, and customer prep/follow-up documentation.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'living_area', 'bedroom', 'pet_area', 'yard', 'evidence', 'treatment_area', 'other'],
    findingsFields: [
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea', placeholder: 'Pet resting areas, rugs, furniture edges, bedrooms, yard, shaded exterior areas…' },
      { key: 'evidence_level', label: 'Evidence level', type: 'select', options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
      { key: 'host_activity', label: 'Host / activity notes', type: 'textarea', placeholder: 'Pets in home, recent bites, wildlife pressure, shaded yard activity…' },
      { key: 'treatment_areas', label: 'Treatment areas', type: 'textarea', placeholder: 'Interior rooms, pet resting zones, exterior shaded areas, crawlspace, lanai…' },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'prep_for_customer', label: 'Customer prep / responsibilities', type: 'textarea', placeholder: 'Vacuuming, washing pet bedding, coordinating vet flea control, staying off treated areas until dry…' },
      { key: 'followup_plan', label: 'Follow-up plan', type: 'textarea' },
    ],
  },

  cockroach: {
    label: 'Cockroach Treatment',
    short: 'Cockroach',
    description: 'Cockroach inspection + treatment — species ID, harborage and conducive conditions, treatment notes, and customer prep. German cockroach always warrants a follow-up visit.',
    requiresFollowup: true,
    photoCategories: ['kitchen', 'bathroom', 'interior', 'exterior', 'entry_point', 'harborage', 'evidence', 'treatment_area', 'other'],
    findingsFields: [
      { key: 'species', label: 'Species', type: 'select', section: 'Species & activity', options: ['German', 'American', 'Smoky brown', 'Mixed', 'Unknown'] },
      { key: 'activity_level', label: 'Activity level', type: 'select', section: 'Species & activity', options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
      { key: 'activity_locations', label: 'Where activity was noted', type: 'chips', section: 'Species & activity', options: [
        'Kitchen', 'Bathrooms', 'Laundry', 'Garage', 'Pantry', 'Under sink',
        'Behind refrigerator', 'Behind stove', 'Dishwasher area', 'Cabinet hinges',
        'Plumbing penetrations', 'Exterior mulch / landscape', 'Lanai',
      ] },
      { key: 'evidence_observed', label: 'Evidence observed', type: 'chips', section: 'Evidence', options: [
        'Live roaches', 'Dead roaches', 'Droppings', 'Egg cases', 'Cast skins', 'Odor',
        'Grease / food debris', 'Moisture present',
      ] },
      { key: 'conducive_conditions', label: 'Conducive conditions', type: 'chips', section: 'Evidence', options: [
        'Moisture / leaks', 'Food debris', 'Clutter', 'Cardboard storage', 'Open trash',
        'Pet food out', 'Gaps / unsealed penetrations',
      ] },
      { key: 'work_completed', label: 'Work completed today', type: 'chips', section: 'Work completed', options: [
        'Bait placement', 'Insect growth regulator', 'Crack & crevice treatment',
        'Dust application', 'Flush-out treatment', 'Exterior perimeter treatment',
        'Glue boards placed', 'Monitoring stations placed', 'Sanitation review completed',
      ] },
      { key: 'customer_prep', label: 'How the customer can help', type: 'chips', section: 'Customer prep', options: [
        'Remove food debris', 'No over-the-counter sprays', 'Keep counters clean',
        'Reduce clutter', 'Empty trash nightly', 'Fix plumbing leaks',
        'Do not disturb bait placements',
      ] },
    ],
  },

  rodent_exclusion: {
    label: 'Rodent Exclusion',
    short: 'Rodent',
    description: 'Entry-point mapping, trapping, and exclusion work.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'entry_point', 'trap_placement', 'damage', 'exclusion_work', 'attic', 'crawlspace', 'other'],
    findingsFields: [
      { key: 'species', label: 'Species', type: 'select', options: ['Roof rat', 'Norway rat', 'House mouse', 'Mixed', 'Unknown'] },
      { key: 'entry_points_found', label: 'Entry points identified', type: 'textarea', placeholder: 'Dryer vent (S wall), gable vent (attic), garage door seal…' },
      { key: 'traps_set', label: 'Traps set (count + locations)', type: 'textarea' },
      { key: 'exclusion_completed', label: 'Exclusion work completed', type: 'textarea' },
      { key: 'exclusion_pending', label: 'Exclusion work pending', type: 'textarea' },
      { key: 'followup_plan', label: 'Follow-up plan', type: 'textarea' },
    ],
  },

  rodent_trapping: {
    label: 'Rodent Trapping',
    short: 'Rodent Trap',
    description: 'Active trapping setup, trap checks, activity findings, and follow-up plan.',
    requiresFollowup: true,
    photoCategories: ['trap_placement', 'entry_point', 'droppings', 'damage', 'attic', 'garage', 'crawlspace', 'other'],
    // Sectioned tap-to-fill checklists (owner spec, 2026-06-12): the tech
    // checks what they saw/did instead of thumb-typing prose; the report
    // narrative is composed from these selections. `chips` fields store a
    // comma-joined string (multi_select convention); only `species` is
    // required — everything else is optional quick-checks.
    findingsFields: [
      { key: 'species', label: 'Species', type: 'select', section: 'Evidence observed', options: ['Roof rat', 'Norway rat', 'House mouse', 'Mixed', 'Unknown'] },
      { key: 'evidence_observed', label: 'Evidence observed', type: 'chips', section: 'Evidence observed', options: [
        'Droppings', 'Urine staining', 'Gnaw marks', 'Rub marks / grease trails',
        'Nesting material', 'Noises reported by customer', 'Odor', 'Burrows / runways',
        'Damaged insulation / wiring / stored items',
      ] },
      { key: 'traps_checked', label: 'Traps checked', type: 'count', section: 'Trap activity' },
      { key: 'captures', label: 'Captures', type: 'count', section: 'Trap activity' },
      { key: 'trap_actions', label: 'Trap actions', type: 'chips', section: 'Trap activity', options: [
        'Traps reset', 'Traps moved', 'Traps replaced', 'New traps added',
        'Bait/lure refreshed', 'Damaged or missing traps found',
      ] },
      { key: 'trap_activity_locations', label: 'Locations with activity', type: 'text', section: 'Trap activity', placeholder: 'Attic near A/C plenum, garage corner…' },
      { key: 'trap_quiet_locations', label: 'Locations with no activity', type: 'text', section: 'Trap activity', placeholder: 'Soffit traps, crawlspace…' },
      { key: 'conducive_conditions', label: 'Conducive conditions', type: 'chips', section: 'Conducive conditions', options: [
        'Gaps under doors', 'Garage door seal gaps', 'A/C line penetrations', 'Roof returns',
        'Soffit / fascia gaps', 'Weep holes', 'Utility penetrations', 'Vents / screens',
        'Vegetation touching structure', 'Pet food / bird seed accessible', 'Trash / clutter',
        'Open water source',
      ] },
      { key: 'work_completed', label: 'Work completed today', type: 'chips', section: 'Work completed', options: [
        'Traps checked', 'Captures removed', 'Traps reset', 'Trap locations adjusted',
        'New traps added', 'Bait/lure replaced', 'Exterior inspection completed',
        'Entry points photographed', 'Recommendations reviewed with customer',
      ] },
      { key: 'sanitation_recommendations', label: 'Sanitation recommendations', type: 'chips', section: 'Recommendations', options: [
        'Remove pet food overnight', 'Store seed in sealed containers',
        'Clean droppings only with proper PPE', 'Reduce garage clutter',
        'Trim vegetation off roofline', 'Seal or secure food sources', 'Keep trash bins closed',
      ] },
      { key: 'exclusion_recommendation', label: 'Exclusion', type: 'select', section: 'Recommendations', options: [
        'Not needed at this time', 'Recommended after activity stops',
        'Quote provided — awaiting approval', 'Approved — scheduling', 'Completed previously',
      ] },
      { key: 'exclusion_notes', label: 'Entry points to seal', type: 'text', section: 'Recommendations', placeholder: 'A/C line gap, garage door corner…' },
      { key: 'customer_reported', label: 'Customer reported', type: 'chips', section: 'Customer communication', options: [
        'Heard noises in attic', 'Heard noises in walls', 'Saw a rodent', 'Smelled odor',
        'No activity noticed since last visit',
      ] },
      { key: 'customer_discussed', label: 'Discussed with customer', type: 'chips', section: 'Customer communication', options: [
        'Informed of capture(s)', 'Explained current trap activity', 'Reviewed exclusion recommendation',
        'Approved follow-up visit', 'Approved exclusion quote',
      ] },
    ],
  },

  // Exterior bait station program (owner spec 2026-06-12) — DISTINCT from
  // trapping: trapping reports focus on captures, station reports focus on
  // bait consumption (= exterior pressure) and station condition. Wording
  // rule: consumption indicates EXTERIOR activity — never claim interior
  // infestation from a station check.
  rodent_bait_station: {
    label: 'Rodent Bait Station Check',
    short: 'Bait Station',
    description: 'Quarterly exterior rodent bait station service: consumption, evidence, station condition, attractants.',
    requiresFollowup: false,
    photoCategories: ['station', 'droppings', 'harborage', 'entry_point', 'exterior', 'other'],
    findingsFields: [
      { key: 'total_stations', label: 'Total stations on property', type: 'count', section: 'Station inspection' },
      { key: 'stations_checked', label: 'Stations checked', type: 'count', section: 'Station inspection' },
      { key: 'stations_inaccessible', label: 'Stations inaccessible', type: 'count', section: 'Station inspection' },
      { key: 'station_actions', label: 'Station service performed', type: 'chips', section: 'Station inspection', options: [
        'Cleaned', 'Refilled', 'Reset', 'Secured', 'Relocated', 'Replaced', 'New station added',
      ] },
      { key: 'bait_consumption', label: 'Bait consumption level', type: 'select', section: 'Bait & activity', options: [
        'None', 'Light', 'Moderate', 'Heavy', 'Empty',
      ] },
      { key: 'bait_replaced', label: 'Bait replaced', type: 'select', section: 'Bait & activity', options: ['Yes', 'No'] },
      { key: 'highest_activity_location', label: 'Highest-activity station / location', type: 'text', section: 'Bait & activity', placeholder: 'Rear-left near A/C pad…' },
      { key: 'bait_issues', label: 'Bait / station contents', type: 'chips', section: 'Bait & activity', options: [
        'Moldy / deteriorated bait', 'Non-target disturbance', 'Insects in station', 'Water intrusion',
      ] },
      { key: 'evidence_observed', label: 'Rodent evidence nearby', type: 'chips', section: 'Rodent evidence', options: [
        'Droppings', 'Gnaw marks', 'Rub marks', 'Burrows', 'Runways', 'Tracks',
        'Nesting material', 'Odor', 'Exterior harborage',
      ] },
      { key: 'station_issues', label: 'Station condition issues', type: 'chips', section: 'Station condition', options: [
        'Station damaged', 'Station missing', 'Station unlocked / open', 'Anchor damaged', 'Needs replacement',
      ] },
      { key: 'conducive_conditions', label: 'Attractants / harborage', type: 'chips', section: 'Conducive conditions', options: [
        'Pet food outside', 'Bird seed accessible', 'Fallen fruit', 'Trash bins open',
        'Compost', 'Dense vegetation', 'Woodpile', 'Stored items / clutter',
        'Garage door gaps', 'Crawlspace / utility gaps', 'Standing water', 'Livestock or chicken feed',
      ] },
      { key: 'sanitation_recommendations', label: 'Customer recommendations', type: 'chips', section: 'Recommendations', options: [
        'Store pet food / bird seed in sealed containers', 'Remove fallen fruit', 'Keep trash lids closed',
        'Reduce clutter', 'Trim vegetation off structure', 'Do not move bait stations',
        'Keep stations accessible', 'Notify office if a station is damaged',
      ] },
    ],
  },

  wildlife_trapping: {
    label: 'Wildlife Trapping',
    short: 'Wildlife',
    description: 'Wildlife trap setup, monitoring notes, access points, and required daily check plan.',
    requiresFollowup: true,
    photoCategories: ['trap_placement', 'entry_point', 'damage', 'yard', 'attic', 'crawlspace', 'other'],
    findingsFields: [
      { key: 'target_animal', label: 'Suspected species', type: 'select', section: 'Species & evidence', options: ['Raccoon', 'Opossum', 'Squirrel', 'Armadillo', 'Bat', 'Bird', 'Snake', 'Unknown'] },
      { key: 'evidence_observed', label: 'Evidence observed', type: 'chips', section: 'Species & evidence', options: [
        'Droppings', 'Tracks', 'Hair / fur', 'Nesting material', 'Chewing marks', 'Digging',
        'Burrows', 'Odor', 'Noises reported', 'Damaged vent / screen', 'Attic disturbance',
        'Insulation damage',
      ] },
      { key: 'entry_points', label: 'Entry / access points', type: 'chips', section: 'Entry points', options: [
        'Roof returns', 'Soffit gaps', 'Fascia damage', 'Gable vents', 'Ridge vents',
        'Crawlspace openings', 'Foundation gaps', 'Dryer vents', 'Pool cage gaps',
        'Fence gaps', 'Burrow under structure', 'Tree limbs touching roof',
      ] },
      { key: 'traps_checked', label: 'Traps checked', type: 'count', section: 'Trap activity' },
      { key: 'captures', label: 'Captures', type: 'count', section: 'Trap activity' },
      { key: 'trap_actions', label: 'Trap / device status', type: 'chips', section: 'Trap activity', options: [
        'Trap installed', 'Trap checked', 'Capture removed', 'Traps reset', 'Bait/lure refreshed',
        'One-way door installed', 'Trap removed', 'No activity at traps',
      ] },
      { key: 'customer_recommendations', label: 'Customer recommendations', type: 'chips', section: 'Recommendations', options: [
        'Trim branches off roofline', 'Repair vent screen', 'Secure trash', 'Remove attractants',
        'Approve exclusion repair', 'Attic sanitation recommended', 'Monitor noise / odor',
      ] },
    ],
  },

  one_time_pest_treatment: {
    label: 'One-Time Pest Treatment',
    short: 'One-Time Pest',
    description: 'Documentation for one-time pest cleanouts, removals, and specialty pest treatments.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'interior', 'kitchen', 'bathroom', 'garage', 'evidence', 'treatment_area', 'other'],
    findingsFields: [
      { key: 'target_pest', label: 'Target pest', type: 'text', placeholder: 'German roaches, wasps, fire ants, fleas/ticks…' },
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea' },
      { key: 'activity_level', label: 'Activity level', type: 'select', options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
      { key: 'treatment_performed', label: 'Treatment performed', type: 'textarea' },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'customer_instructions', label: 'Customer instructions', type: 'textarea' },
      { key: 'followup_plan', label: 'Follow-up plan', type: 'textarea' },
    ],
  },

  one_time_lawn_treatment: {
    label: 'One-Time Lawn Treatment',
    short: 'One-Time Lawn',
    description: 'Standalone lawn assessment or treatment documentation outside the recurring WaveGuard flow.',
    requiresFollowup: false,
    photoCategories: ['front_yard', 'back_yard', 'side_yard', 'problem_area', 'weeds', 'disease', 'insects', 'other'],
    findingsFields: [
      { key: 'turf_type', label: 'Turf type', type: 'select', section: 'Lawn condition', options: ['St. Augustine', 'Bahia', 'Zoysia', 'Bermuda', 'Centipede', 'Mixed', 'Unknown'] },
      { key: 'lawn_condition', label: 'Lawn condition', type: 'select', section: 'Lawn condition', options: ['Excellent', 'Good', 'Fair', 'Poor', 'Recovering', 'Stressed'] },
      { key: 'turf_color', label: 'Turf color', type: 'select', section: 'Lawn condition', options: ['Dark green', 'Moderate', 'Pale', 'Yellowing', 'Browning'] },
      { key: 'weed_pressure', label: 'Weed pressure', type: 'select', section: 'Pressure observed', options: ['None observed', 'Light', 'Moderate', 'Heavy'] },
      { key: 'insect_pressure', label: 'Insect pressure', type: 'select', section: 'Pressure observed', options: ['None observed', 'Suspected', 'Confirmed'] },
      { key: 'disease_pressure', label: 'Disease pressure', type: 'select', section: 'Pressure observed', options: ['None observed', 'Suspected', 'Confirmed'] },
      { key: 'turf_issues', label: 'Issues observed', type: 'chips', section: 'Pressure observed', options: [
        'Chinch bug damage', 'Sod webworm signs', 'Armyworm signs', 'Grub activity',
        'Brown patch / large patch', 'Gray leaf spot', 'Dollarweed', 'Sedge', 'Crabgrass',
        'Broadleaf weeds', 'Drought stress', 'Scalping', 'Excess shade', 'Compaction', 'Pet damage',
      ] },
      { key: 'irrigation_mowing', label: 'Irrigation & mowing notes', type: 'chips', section: 'Irrigation & mowing', options: [
        'Dry zones', 'Overwatering', 'Irrigation runoff', 'Broken head suspected', 'Poor coverage',
        'Fungal risk from overwatering', 'Mowing too low', 'Dull blade signs', 'Clumping',
        'Excessive height',
      ] },
      { key: 'work_completed', label: 'Work completed today', type: 'chips', section: 'Work completed', options: [
        'Fertilizer applied', 'Weed control applied', 'Insect control applied',
        'Disease control applied', 'Iron / micronutrients applied', 'Biostimulant applied',
        'Soil amendment applied', 'Wetting agent applied', 'Spot treatment completed',
        'Inspection completed',
      ] },
      { key: 'spot_treatment_areas', label: 'Spot-treated areas', type: 'text', section: 'Work completed', placeholder: 'Front right lawn, rear fence line…' },
      { key: 'customer_recommendations', label: 'Customer recommendations', type: 'chips', section: 'Recommendations', options: [
        'Water deeply and less frequently', 'Adjust irrigation coverage', 'Avoid mowing too low',
        'Sharpen mower blades', 'Reduce watering while fungus is active',
        'Bag clippings until recovered', 'Keep pets off until dry',
        'Hold irrigation until treatment dries',
      ] },
    ],
  },

  mosquito_event: {
    label: 'Mosquito Event Spray',
    short: 'Mosquito Event',
    description: 'One-time mosquito event treatment documentation and weather/site notes.',
    requiresFollowup: false,
    photoCategories: ['yard', 'foliage', 'pool_area', 'lanai', 'standing_water', 'equipment', 'other'],
    // Sectioned tap-to-fill checklists (owner spec, 2026-06-12). chips store
    // a comma-joined string — option values must never contain commas.
    findingsFields: [
      { key: 'activity_level', label: 'Mosquito activity level', type: 'select', section: 'Mosquito activity', options: ['None observed', 'Light', 'Moderate', 'Heavy'] },
      { key: 'activity_locations', label: 'Where activity was noted', type: 'chips', section: 'Mosquito activity', options: [
        'Front yard', 'Backyard', 'Side yard', 'Lanai / screened enclosure', 'Pool cage',
        'Fence line', 'Shaded vegetation', 'Rear patio', 'Entryways',
      ] },
      { key: 'treatment_completed', label: 'Treatment completed', type: 'chips', section: 'Treatment', options: [
        'Barrier treatment', 'Adulticide treatment', 'Larvicide applied',
        'Resting-site treatment', 'Source reduction', 'Inspection only',
      ] },
      { key: 'treatment_zones', label: 'Treatment zones', type: 'chips', section: 'Treatment', options: [
        'Front yard', 'Backyard', 'Side yards', 'Lanai exterior', 'Shrubs & ornamentals',
        'Fence lines', 'Shaded vegetation', 'Under decks', 'Pool cage perimeter',
        'Patio / outdoor furniture areas', 'Trash / recycling area', 'Entryways',
        'A/C pad', 'Gutters / downspouts', 'Drainage areas',
      ] },
      { key: 'standing_water', label: 'Standing water found', type: 'select', section: 'Breeding sources', options: ['Yes', 'No'] },
      { key: 'breeding_sources', label: 'Breeding sources noted', type: 'chips', section: 'Breeding sources', options: [
        'Plant saucers', 'Buckets', 'Toys', 'Tarps', 'Bird baths', 'Pet bowls',
        'Clogged gutters', 'French drains', 'Pooling water', 'Wheelbarrow',
        'Boat / kayak', 'Trash can lids', 'Bromeliads', 'Tree holes',
        'Low spots in lawn', 'Unmaintained pool / spa', 'Drainage boxes', 'Irrigation runoff',
      ] },
      { key: 'source_reduction', label: 'Source reduction completed', type: 'chips', section: 'Breeding sources', options: [
        'Emptied standing water', 'Flipped containers', 'Moved items under cover',
        'Treated water-holding plants', 'Noted areas for customer attention',
      ] },
      { key: 'sensitive_areas', label: 'Sensitive areas present', type: 'chips', section: 'Sensitive areas & weather', options: [
        'Fish pond', 'Beehive', 'Blooming plants / pollinators', 'Vegetable garden',
        'Pet areas', 'Pool / spa', 'Water feature', "Children's toys", 'Outdoor dishes / grill',
      ] },
      { key: 'sensitive_areas_avoided', label: 'Sensitive-area handling', type: 'select', section: 'Sensitive areas & weather', options: ['Avoided', 'Treated with care', 'None present'] },
      { key: 'weather_conditions', label: 'Weather conditions', type: 'chips', section: 'Sensitive areas & weather', options: [
        'Calm conditions', 'Light wind', 'Windy', 'Wet foliage', 'Recent rainfall',
        'Rain expected', 'Service limited by weather',
      ] },
      { key: 'customer_recommendations', label: 'Customer recommendations', type: 'chips', section: 'Recommendations', options: [
        'Empty standing water weekly', 'Refresh bird baths every 2-3 days', 'Keep gutters clear',
        'Store buckets and toys upside down', 'Trim dense vegetation', 'Repair screen tears',
        'Reduce irrigation runoff', 'Maintain pool / spa', 'Remove yard debris',
        'Check bromeliads and plant saucers',
      ] },
      { key: 'customer_reported', label: 'Customer reported', type: 'chips', section: 'Customer communication', options: [
        'Mosquitoes near lanai', 'Bites in backyard', 'Evening activity', 'Pets on property',
        'Pond / beehive / garden on property', 'Requested focus area',
      ] },
      { key: 'customer_discussed', label: 'Discussed with customer', type: 'chips', section: 'Customer communication', options: [
        'Standing water findings', 'Dry-time guidance', 'Treatment areas reviewed',
      ] },
    ],
  },

  palm_injection: {
    label: 'Palm Injection',
    short: 'Palm Injection',
    description: 'Standalone palm injection treatment documentation.',
    requiresFollowup: false,
    photoCategories: ['palm', 'trunk', 'canopy', 'injection_site', 'disease', 'other'],
    findingsFields: [
      { key: 'palm_species', label: 'Palm species', type: 'text', section: 'Palm condition' },
      { key: 'palms_serviced', label: 'Palms serviced', type: 'count', section: 'Palm condition' },
      { key: 'palm_condition', label: 'Overall palm condition', type: 'select', section: 'Palm condition', options: ['Good', 'Fair', 'Poor', 'Declining'] },
      { key: 'condition_observations', label: 'Canopy & growth observations', type: 'chips', section: 'Palm condition', options: [
        'Healthy canopy color', 'Yellowing lower fronds', 'Thin canopy', 'Weak new growth',
        'New growth present', 'Firm spear leaf', 'Spear leaf concern', 'Trunk concern', 'Crown concern',
      ] },
      { key: 'deficiency_signs', label: 'Nutrient observations', type: 'chips', section: 'Nutrient health', options: [
        'Potassium deficiency signs', 'Magnesium deficiency signs', 'Manganese deficiency signs',
        'General chlorosis', 'Frizzle top symptoms', 'Necrotic spotting on older fronds',
        'None observed today',
      ] },
      { key: 'pest_disease_signs', label: 'Pest & disease check', type: 'chips', section: 'Pests & disease', options: [
        'Scale', 'Mealybugs', 'Mites', 'Palm aphids', 'Weevil concern', 'Ganoderma conk visible',
        'Trunk decay signs', 'Crown rot symptoms', 'Leaf spot', 'Fungal staining',
        'None observed today',
      ] },
      { key: 'work_completed', label: 'Work completed today', type: 'chips', section: 'Work completed', options: [
        'Palm fertilizer applied', 'Liquid micronutrient treatment', 'Soil drench',
        'Insect treatment', 'Disease treatment', 'Palm injection completed',
        'Soil acidifier applied', 'Canopy / crown inspection', 'Photos taken',
        'Palm flagged for monitoring',
      ] },
      { key: 'customer_recommendations', label: 'Customer recommendations', type: 'chips', section: 'Recommendations', options: [
        'Avoid over-pruning', 'Do not remove green fronds', 'Improve irrigation consistency',
        'Keep mulch away from trunks', 'Monitor spear leaf', 'Injection recommended',
        'Arborist evaluation recommended',
      ] },
    ],
  },

  // Tree & Shrub program visit (owner spec 2026-06-12, Phase 2 §6) —
  // plant-health storytelling: base scope/condition + palm, shrub/ornamental,
  // and bed/pre-emergent modules. Modules render as optional sections; the
  // palm module core becomes required via cross-field validation when
  // 'Palms' is among the serviced plant groups. The two `internal: true`
  // compliance fields feed the ported closeout checks (pollinator block,
  // IRAC/FRAC) and never render on customer reports.
  tree_shrub: {
    label: 'Tree & Shrub Service',
    short: 'Tree & Shrub',
    description: 'Tree & Shrub program visit: plant groups serviced, landscape condition, observed issues, treatments, and module detail for palms, shrubs, and beds.',
    requiresFollowup: false,
    photoCategories: ['palm', 'shrub', 'bed', 'disease', 'pest_activity', 'treatment_area', 'before', 'after', 'other'],
    findingsFields: [
      { key: 'plant_groups', label: 'Plant groups serviced', type: 'chips', section: 'Service scope', options: [
        'Palms', 'Shrubs', 'Ornamentals', 'Hedges', 'Small trees',
        'Flowering plants', 'Groundcover beds', 'Other',
      ] },
      { key: 'landscape_condition', label: 'Overall landscape condition', type: 'select', section: 'Service scope', options: [
        'Excellent', 'Good', 'Fair', 'Poor', 'Declining', 'Recovering',
      ] },
      { key: 'observed_conditions', label: 'Observed plant conditions', type: 'chips', section: 'Observed conditions', options: [
        'Healthy / new growth', 'Yellowing / chlorosis', 'Leaf spot', 'Scale',
        'Mealybug', 'Aphids', 'Whitefly', 'Mites', 'Caterpillar damage',
        'Sooty mold', 'Fungal pressure', 'Nutrient deficiency', 'Drought stress',
        'Overwatering stress', 'Pruning stress', 'Freeze / cold damage',
        'Salt / wind stress', 'No major issues observed',
      ] },
      { key: 'treatments_completed', label: 'Treatment completed', type: 'chips', section: 'Treatments', options: [
        'Fertilizer', 'Palm fertilizer', 'Micronutrients', 'Insect treatment',
        'Disease / fungicide treatment', 'Horticultural oil', 'Soil drench',
        'Foliar treatment', 'Pre-emergent bed treatment', 'Weed spot treatment',
        'Soil amendment / acidifier', 'Inspection only',
      ] },
      { key: 'palms_serviced', label: 'Palms serviced', type: 'count', section: 'Palm module' },
      { key: 'palm_condition', label: 'Palm condition', type: 'select', section: 'Palm module', options: ['Good', 'Fair', 'Poor', 'Declining'] },
      { key: 'palm_nutrient_stress', label: 'Palm nutrient stress', type: 'select', section: 'Palm module', options: ['Yes', 'No'] },
      { key: 'spear_leaf_condition', label: 'Spear leaf condition', type: 'select', section: 'Palm module', options: ['Firm', 'Soft', 'Pulling', 'Not checked'] },
      { key: 'canopy_density', label: 'Canopy density', type: 'select', section: 'Palm module', options: ['Full', 'Moderate', 'Thin', 'Declining'] },
      { key: 'palm_trunk_concern', label: 'Trunk concern', type: 'select', section: 'Palm module', options: ['Yes', 'No'] },
      { key: 'ganoderma_conk_observed', label: 'Visible Ganoderma conk', type: 'select', section: 'Palm module', options: ['Yes', 'No'] },
      { key: 'injection_recommended', label: 'Injection recommended', type: 'select', section: 'Palm module', options: ['Yes', 'No'] },
      { key: 'pest_pressure', label: 'Pest pressure', type: 'select', section: 'Shrub & ornamental module', options: ['None', 'Light', 'Moderate', 'Heavy'] },
      { key: 'disease_pressure', label: 'Disease pressure', type: 'select', section: 'Shrub & ornamental module', options: ['None', 'Light', 'Moderate', 'Heavy'] },
      { key: 'deficiency_symptoms', label: 'Deficiency symptoms', type: 'select', section: 'Shrub & ornamental module', options: ['None', 'Light', 'Moderate', 'Heavy'] },
      { key: 'new_growth_present', label: 'New growth present', type: 'select', section: 'Shrub & ornamental module', options: ['Yes', 'No'] },
      { key: 'pruning_issue_observed', label: 'Pruning issue observed', type: 'select', section: 'Shrub & ornamental module', options: ['Yes', 'No'] },
      { key: 'irrigation_issue_observed', label: 'Irrigation issue observed', type: 'select', section: 'Shrub & ornamental module', options: ['Yes', 'No'] },
      { key: 'bed_weed_pressure', label: 'Bed weeds present', type: 'select', section: 'Bed & pre-emergent module', options: ['None', 'Light', 'Moderate', 'Heavy'] },
      { key: 'pre_emergent_applied', label: 'Pre-emergent applied', type: 'select', section: 'Bed & pre-emergent module', options: ['Yes', 'No'] },
      { key: 'mulch_depth_concern', label: 'Mulch depth concern', type: 'select', section: 'Bed & pre-emergent module', options: ['Yes', 'No'] },
      { key: 'weed_breakthrough_areas', label: 'Weed breakthrough areas', type: 'text', section: 'Bed & pre-emergent module', placeholder: 'Front bed near driveway…' },
      // Ported closeout compliance (internal-only; see tree-shrub-closeout
      // validateTreeShrubTypedCompliance): pollinator status gates
      // bee-sensitive insect applications, IRAC/FRAC confirms resistance
      // rotation was checked for pesticide products.
      { key: 'pollinator_status', label: 'Flowering / pollinator status', type: 'select', section: 'Compliance', internal: true, options: [
        'No blooms or no bees', 'Blooming — no bees active', 'Blooming — bees active', 'No insecticide applied',
      ] },
      { key: 'irac_frac_logged', label: 'IRAC / FRAC rotation checked & logged', type: 'select', section: 'Compliance', internal: true, options: ['Yes', 'No'] },
      { key: 'customer_recommendations', label: 'Customer recommendations', type: 'chips', section: 'Recommendations', options: [
        'Adjust irrigation', 'Avoid over-pruning', 'Remove dead plant material',
        'Trim away from structure', 'Keep mulch off trunks / stems', 'Monitor decline',
        'Replace severely declining plant', 'Approve injection', 'Improve drainage',
        'Continue program',
      ] },
    ],
  },

  termite_treatment: {
    label: 'Termite Treatment',
    short: 'Termite Treatment',
    description: 'Termite treatment documentation for spot treatment, liquid treatment, trenching, cartridge work, and setup visits.',
    requiresFollowup: false,
    photoCategories: ['foundation', 'trench', 'drill_point', 'station', 'damage', 'treatment_area', 'before', 'after', 'other'],
    findingsFields: [
      { key: 'target_termite', label: 'Target termite / WDO', type: 'select', options: ['Subterranean termites', 'Formosan subterranean termites', 'Drywood termites', 'Unknown / preventive'] },
      { key: 'areas_treated', label: 'Areas treated', type: 'textarea' },
      { key: 'treatment_method', label: 'Treatment method', type: 'select', options: ['Spot treatment', 'Liquid perimeter', 'Trenching', 'Bait station setup', 'Cartridge replacement', 'Wood treatment', 'Other'] },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'linear_feet_or_stations', label: 'Linear feet / stations', type: 'textarea' },
      { key: 'gallons_or_amount', label: 'Gallons / amount applied', type: 'textarea' },
      { key: 'followup_plan', label: 'Follow-up / warranty plan', type: 'textarea' },
    ],
  },

  // Bait station monitoring (owner spec 2026-06-12) — inspection/compliance
  // style, not treatment style: station condition, termite activity, bait
  // status, conducive conditions, next monitoring step. Wording rule: absence
  // claims are scoped to the ACCESSIBLE stations inspected today — never
  // "no termites on property".
  termite_bait_station: {
    label: 'Termite Bait Station Inspection',
    short: 'Termite Bait',
    description: 'Bait station monitoring visit: station-by-station inspection, activity, bait condition, and next monitoring step.',
    requiresFollowup: false,
    photoCategories: ['station', 'activity', 'foundation', 'conducive_condition', 'exterior', 'other'],
    findingsFields: [
      { key: 'total_stations', label: 'Total stations on property', type: 'count', section: 'Station inspection' },
      { key: 'stations_checked', label: 'Stations checked', type: 'count', section: 'Station inspection' },
      { key: 'stations_inaccessible', label: 'Stations inaccessible', type: 'count', section: 'Station inspection' },
      { key: 'stations_with_activity', label: 'Stations with termite activity', type: 'count', section: 'Station inspection' },
      { key: 'termite_activity', label: 'Termite activity', type: 'select', section: 'Termite activity', options: [
        'None observed', 'Active termites present', 'Previous feeding noted',
      ] },
      { key: 'activity_signs', label: 'Activity signs', type: 'chips', section: 'Termite activity', options: [
        'Live termites in station', 'Mud tubing in station', 'Bait feeding',
        'Previous feeding evidence', 'Favorable moisture / soil conditions',
      ] },
      { key: 'active_station_location', label: 'Active station number / location', type: 'text', section: 'Termite activity', placeholder: 'Station #7, rear exterior wall…' },
      { key: 'bait_consumption', label: 'Bait consumption', type: 'select', section: 'Bait condition', options: [
        'None — bait intact', 'Light feeding', 'Moderate feeding', 'Heavy feeding',
      ] },
      { key: 'bait_actions', label: 'Bait service performed', type: 'chips', section: 'Bait condition', options: [
        'Bait replaced', 'Bait added', 'Monitor cartridge replaced', 'Station cleaned',
      ] },
      { key: 'bait_issues', label: 'Bait condition issues', type: 'chips', section: 'Bait condition', options: [
        'Excess moisture in station', 'Mold / deterioration',
      ] },
      { key: 'station_issues', label: 'Station condition issues', type: 'chips', section: 'Station condition', options: [
        'Cap damaged', 'Station missing', 'Station flooded', 'Station buried',
        'Station obstructed', 'Mower damage', 'Needs replacement',
      ] },
      { key: 'station_actions', label: 'Station service performed', type: 'chips', section: 'Station condition', options: [
        'Obstruction removed', 'Re-secured', 'Relocated', 'Replaced',
      ] },
      { key: 'conducive_conditions', label: 'Conducive conditions', type: 'chips', section: 'Conducive conditions', options: [
        'Wood-to-ground contact', 'Mulch against foundation', 'Moisture near foundation',
        'Irrigation hitting structure', 'Downspout drainage issues', 'Stacked firewood near structure',
        'Tree roots / stumps', 'Soil grade above slab', 'Dense vegetation', 'Leaking hose bib',
      ] },
      { key: 'customer_recommendations', label: 'Customer recommendations', type: 'chips', section: 'Recommendations', options: [
        'Keep stations visible and accessible', 'Unlock gate on service day',
        'Do not cover stations with mulch or rock', 'Do not remove station caps',
        'Pull mulch back from foundation', 'Reduce moisture near foundation',
        'Move firewood away from structure', 'Trim vegetation off walls',
        'Correct irrigation spraying the structure',
      ] },
    ],
  },

  bed_bug: {
    label: 'Bed Bug Treatment',
    short: 'Bed Bug',
    description: 'Bed-bug inspection + initial treatment. Supports an optional 14-day follow-up.',
    requiresFollowup: true,
    photoCategories: ['bedroom', 'evidence', 'equipment', 'room_treated', 'furniture', 'other'],
    findingsFields: [
      { key: 'rooms_treated', label: 'Rooms treated', type: 'text', section: 'Inspection', placeholder: 'Primary bedroom, guest bedroom…' },
      { key: 'areas_inspected', label: 'Areas inspected', type: 'chips', section: 'Inspection', options: [
        'Mattress seams', 'Box spring', 'Bed frame', 'Headboard', 'Nightstands', 'Baseboards',
        'Couch / seating', 'Recliners', 'Curtains', 'Closet edges', 'Luggage areas',
        'Wall hangings', 'Adjacent rooms',
      ] },
      { key: 'evidence_level', label: 'Evidence level', type: 'select', section: 'Evidence', options: ['No active signs observed', 'Low (few bugs)', 'Moderate', 'Heavy', 'Severe infestation'] },
      { key: 'evidence_observed', label: 'Evidence observed', type: 'chips', section: 'Evidence', options: [
        'Live bed bugs', 'Dead bed bugs', 'Eggs', 'Cast skins', 'Fecal spotting',
        'Blood spotting', 'Bites reported by customer', 'No visible evidence',
      ] },
      { key: 'treatment_method', label: 'Treatment method', type: 'select', section: 'Work completed', options: ['Chemical only', 'Heat only', 'Chemical + heat', 'Steam + chemical'] },
      { key: 'work_completed', label: 'Work completed today', type: 'chips', section: 'Work completed', options: [
        'Crack & crevice treatment', 'Mattress / box spring treatment', 'Bed frame treatment',
        'Baseboard treatment', 'Furniture treatment', 'Dust application', 'Steam treatment',
        'Vacuuming completed', 'Encasement installed', 'Encasement recommended',
        'Interceptors installed', 'Adjacent rooms inspected',
      ] },
      { key: 'prep_status', label: 'Customer prep status', type: 'select', section: 'Customer prep', options: ['Completed', 'Partial', 'Not started'] },
      { key: 'customer_prep', label: 'How the customer can help', type: 'chips', section: 'Customer prep', options: [
        'Dry bedding on high heat', 'Reduce clutter', 'Do not move items between rooms',
        'Do not discard furniture without guidance', 'Install encasements',
        'No over-the-counter sprays', 'Keep treated areas undisturbed',
      ] },
    ],
  },

  pre_treatment_termite_certificate: {
    label: 'Pre-Treatment Certificate of Compliance',
    short: 'Pre-Treat Cert',
    description: 'Florida Building Code 1816.1.7 Certificate of Compliance for pre-construction subterranean termite soil treatment. Doubles as the FDACS Rule 5E-14.106 treatment record.',
    requiresFollowup: false,
    photoCategories: ['slab_prep', 'soil_treatment', 'perimeter', 'equipment', 'before', 'after', 'other'],
    findingsFields: [
      { key: 'treatment_address', label: 'Treatment address', type: 'address', placeholder: 'Start typing the treatment address' },
      { key: 'lot_block', label: 'Lot / Block', type: 'text', placeholder: 'Lot 12, Block C (pre-construction lots)' },
      { key: 'subdivision', label: 'Subdivision / Community', type: 'text', placeholder: 'e.g. Lakewood Ranch — Star Farms' },
      { key: 'permit_number', label: 'Building permit #', type: 'text', placeholder: 'Issued by the building department' },
      { key: 'builder_contractor', label: 'Builder / General contractor', type: 'customer_search', placeholder: 'Search customer database or type contractor name' },
      { key: 'treatment_date', label: 'Date of treatment', type: 'date' },
      { key: 'treatment_time', label: 'Time of treatment', type: 'time' },
      { key: 'treatment_method', label: 'Method of treatment', type: 'select', options: ['Soil barrier (chemical)', 'Wood treatment (borate)', 'Bait system', 'Other'] },
      { key: 'treatment_method_other', label: 'Method description (if Other)', type: 'text' },
      { key: 'wdo_target', label: 'Wood-destroying organism treated for', type: 'multi_select', options: WDO_TARGET_OPTIONS },
      { key: 'product_name', label: 'Product used', type: 'product_search', placeholder: 'Search product catalog or type product name', options: ['Termidor SC', 'Talstar P', 'Premise 2', 'Trelona ATBB', 'Bora-Care', 'Other'] },
      { key: 'product_name_other', label: 'Product (if Other)', type: 'text' },
      { key: 'epa_registration', label: 'EPA registration #', type: 'text', placeholder: 'e.g. 7969-210' },
      { key: 'active_ingredient', label: 'Active ingredient', type: 'text', placeholder: 'e.g. fipronil' },
      { key: 'concentration_pct', label: 'Concentration (%)', type: 'text', placeholder: 'e.g. 0.060' },
      { key: 'square_footage', label: 'Square footage treated', type: 'text' },
      { key: 'linear_feet', label: 'Linear feet treated', type: 'text', placeholder: 'For trenching / perimeter applications' },
      { key: 'gallons_applied', label: 'Gallons of finished solution applied', type: 'text' },
      { key: 'applicator_name', label: "Applicator's printed name", type: 'text' },
      { key: 'applicator_fdacs_id', label: 'Applicator FDACS ID #', type: 'text' },
      // FBC 1816.1.7 requires an "authorized signature of the licensed
      // applicator." A typed attestation paired with the printed name +
      // FDACS ID + treatment date is the standard pattern for portal-
      // generated certificates accepted by Florida building departments.
      { key: 'applicator_attestation', label: 'Applicator attestation', type: 'select', options: ['I am the licensed Florida applicator who performed the treatment described above, and I certify the information is true and complete (FBC 1816.1.7 / FDACS Rule 5E-14.106).'] },
      { key: 'warranty_type', label: 'Warranty / retreatment bond', type: 'select', options: ['Builder 1-year', 'Renewable 5-year retreatment bond', 'Renewable 10-year retreatment bond', 'No warranty'] },
      { key: 'renewal_due', label: 'Renewal due by', type: 'text', placeholder: 'YYYY-MM-DD' },
      { key: 'comments', label: 'Additional notes', type: 'textarea', placeholder: 'Pre-pour conditions, weather, retreatment triggers, etc.' },
    ],
  },
};

const PROJECT_TYPE_KEYS = Object.keys(PROJECT_TYPES);

function getProjectType(key) {
  return PROJECT_TYPES[key] || null;
}

function isValidProjectType(key) {
  return Object.prototype.hasOwnProperty.call(PROJECT_TYPES, key);
}

module.exports = { PROJECT_TYPES, PROJECT_TYPE_KEYS, getProjectType, isValidProjectType };
