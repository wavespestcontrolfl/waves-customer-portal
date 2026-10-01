// Canonical treatment-target vocabulary — the server-readable half of the
// completion picker's own suggestion lists in
// client/src/pages/admin/SchedulePage.jsx. The picker also accepts free
// text (SchedulePage.jsx ~23610-23615: a custom chip on the datalist input),
// so a hand-typed value ("technicians treated no pests - prevention")
// persists on service_products.targets exactly like a real species — email
// division's area-intel sentence (server/services/email-division/area-intel.js)
// must never quote one of those verbatim to a customer (codex round 9 P2 on
// #5164). Server code never imports client code (SchedulePage.jsx is a
// large admin-only React bundle), so this is ONE hand-kept copy of the four
// `_TARGET_SUGGESTIONS` arrays; server/tests/treatment-target-vocabulary.test.js
// parses the client file's own arrays and asserts they match this module
// exactly, so the two cannot silently drift.
//
// The picker lists are only PART of the canonical vocabulary — the other
// half is products_catalog.target_pests (read from the DB at compute time,
// see area-intel.js's canonicalTargetVocabulary()), which uses its own,
// more generic strings ("ants", "roaches", "turf disease") the picker
// never offers. Both count.

// PEST_TARGET_SUGGESTIONS — SchedulePage.jsx ~23392-23434.
const PEST_TARGET_SUGGESTIONS = [
  'Ghost ants',
  'Big-headed ants',
  'Crazy ants',
  'White-footed ants',
  'Carpenter ants',
  'Fire ants',
  'Argentine ants',
  'Pharaoh ants',
  'Rover ants',
  'German cockroaches',
  'American cockroaches',
  'Smokybrown cockroaches',
  'Australian cockroaches',
  'Florida woods cockroaches',
  'Wolf spiders',
  'Widow spiders',
  'Orb-weaver spiders',
  'Jumping spiders',
  'Silverfish',
  'Earwigs',
  'Millipedes',
  'Centipedes',
  'Springtails',
  'Booklice',
  'Crickets',
  'Paper wasps',
  'Mud daubers',
  'Yellowjackets',
  'Drain flies',
  'House flies',
  'Fleas',
  'Ticks',
  'Bed bugs',
  'Pantry moths & beetles',
  'Subterranean termites',
  'Drywood termites',
  'Roof rats',
  'Norway rats',
  'House mice',
  'Mosquitoes',
  'Scorpions',
];

// LAWN_TARGET_SUGGESTIONS — SchedulePage.jsx ~23438-23464.
const LAWN_TARGET_SUGGESTIONS = [
  'Broadleaf weeds',
  'Crabgrass',
  'Nutsedge / sedge',
  'Green kyllinga',
  'Dollarweed',
  'Doveweed',
  'Chamberbitter',
  'Spurge',
  'Clover',
  'Goosegrass',
  'Torpedograss',
  'Annual bluegrass (Poa annua)',
  'Southern chinch bugs',
  'Fall armyworms',
  'Tropical sod webworms',
  'White grubs',
  'Tawny mole crickets',
  'Fire ants',
  'Nematodes',
  'Large patch',
  'Dollar spot',
  'Gray leaf spot',
  'Take-all root rot',
  'Fairy ring',
  'Pythium root rot',
];

// ORNAMENTAL_TARGET_SUGGESTIONS — SchedulePage.jsx ~23468-23483.
const ORNAMENTAL_TARGET_SUGGESTIONS = [
  'Ficus whitefly',
  'Rugose spiraling whitefly',
  'Chilli thrips',
  'Sri Lanka weevil',
  'Aphids',
  'Scale insects',
  'Mealybugs',
  'Spider mites',
  'Leafminers',
  'Caterpillars',
  'Wood borers',
  'Sooty mold (sap-feeder cleanup)',
  'Fungal leaf spot',
  'Powdery mildew',
];

// NUTRITION_TARGET_SUGGESTIONS — SchedulePage.jsx ~23487-23501. Never
// reaches area-intel's counting (treatmentTargets() already excludes
// nutrition-family products), included anyway so the drift test covers
// every `_TARGET_SUGGESTIONS` array in the client file, not a chosen subset.
const NUTRITION_TARGET_SUGGESTIONS = [
  'Nitrogen green-up',
  'Deep green color',
  'Color & density',
  'Iron chlorosis (yellowing turf)',
  'Potassium deficiency',
  'Root strength & stress tolerance',
  'Balanced feeding',
  'Micronutrient deficiency',
  'Slow-release feeding',
  'Winter hardiness',
  'Magnesium deficiency (palms)',
  'Manganese deficiency (palms)',
  'Potassium deficiency (palms)',
];

module.exports = {
  PEST_TARGET_SUGGESTIONS, LAWN_TARGET_SUGGESTIONS, ORNAMENTAL_TARGET_SUGGESTIONS, NUTRITION_TARGET_SUGGESTIONS,
};
