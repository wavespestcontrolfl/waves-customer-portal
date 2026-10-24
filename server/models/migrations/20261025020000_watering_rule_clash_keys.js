// Clash keys for the lawn watering label ladder (owner 2026-10-24: "if products clash, we need to develop
// a strategy ... check labels" and "I dont want an office alert for this"; then "do whatever you recommend").
// Read only under GATE_LAWN_WATERING_EVERY_VISIT (lawn-watering-instruction.js rules E, Y, H); off, every row
// reads exactly as before. The keys are the ones portal #6627 taught the validator: that code is deployed
// before this data, so no rule here is ever read by a validator that rejects it.
//
// Labels re-read 2026-10-24 (EPA PPLS; ~/lawn-watering-coverage-20261022/labels-A.md, labels-B.md;
// ~/lawn-report-rebuild-scope-20260929/appendix/label-timelines-20261003/labels-herbicides.md).
//
// 1. label_window 'directs': the label's own water-in window, counted from the application ("Irrigate within
//    24 hours of application"): Acelepryn and Acelepryn Xtra on grubs, Armada on fairy ring, Headway G and
//    Heritage G on fairy ring, Headway, Heritage Action and Heritage G on root dysfunction, Tetrino on soil
//    pests (a new grub entry; its foliar uses keep the product-wide rule, which may follow a hold).
// 2. label_window 'best_results': T-Storm 2G ("For best results, activate the application within 24 hours
//    with irrigation or natural rainfall"). It keeps rain_counts; label first writes it as a run.
// 3. label_best_results on holds whose part above the label minimum is the label's own "for best results"
//    line: Acelepryn and Acelepryn Xtra on caterpillars, Talak, Blindside, Dismiss NXT, Drive XLR8, Chelated
//    Iron Plus, High Manganese Combo, Three-Way. A best-results window never shortens them.
// 4. label_minimum.advisory on hours minimums that are label advice: Certainty ("may wash this product off"),
//    Fusilade II ("rainfast in one hour"), Recognition ("rainfast within 3 hours"), both SedgeHammers ("Avoid
//    applications when rainfall is forecasted to occur within 4 hours"), Three-Way (under "For optimum
//    results"). SpeedZone Southern is NOT advisory: "Do not irrigate or water the turfgrass within 3 hours".
// 5. New label minimums: Three-Way 4 hours, Acelepryn Xtra on caterpillars until dry, Endurant PR until dry.
// 6. yields_to_label_water_in: Advion Insect Granule (label: water "within 2 to 3 days after application may
//    reduce effectiveness and may require retreatment"; the 72 hours is our own rule). Its customer
//    precaution's "Skip your turf watering for the time shown on this report." becomes "Follow the watering
//    steps on this report.", true whether the bait's hold stands or gives way (one sentence for one, so a
//    frozen label-line decision's sentence indexes stay right).
// 7. beside_hold_by_hours 24: Hydretain Liquid and LESCO Moisture Manager (maker: "Within 24 hours, follow
//    with enough additional water to carry [it] down to and throughout the root zone").
//
// A rule is replaced only while it is still exactly the value read from production on 2026-10-24 (compared
// as jsonb, any key order); the precaution only while it still carries the old sentence exactly once. Any
// later admin edit is left alone. One audit_log row per write. Down is a documented no-op (waves-db SKILL):
// the audit rows keep every before value; a rollback is a new migration.
const { isDeepStrictEqual } = require('util');
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261025020000_watering_rule_clash_keys';
const VERIFIED_AT = '2026-10-24T00:00:00.000Z';
const VERIFIED_BY = 'label-check-2026-10-24';

// The rules as production stored them on 2026-10-24.
const BEFORE = {
  "Acelepryn Insecticide": {
    "source": "owner",
    "by_target": [
      {
        "mode": "hold",
        "match": [
          "caterpillar",
          "armyworm",
          "webworm",
          "cutworm",
          "looper",
          "grassworm"
        ],
        "hold_hours": 24,
        "label_note": "Label: \"To ensure best control, delay water (irrigation) or mowing for 24 hours after application.\" (turf caterpillars)",
        "label_minimum": {
          "hold_until": "dry"
        }
      },
      {
        "mode": "water_in",
        "match": [
          "grub"
        ],
        "label_note": "Label: \"Irrigate turf immediately after application or allow rainfall to move the product into the soil.\" (white grubs; no amount: 0.25 inch within 24 hours)",
        "water_in_inches": 0.25,
        "water_in_by_hours": 24
      }
    ],
    "label_note": "Caterpillars first (the protocol use). Other targets (billbugs, chinch bugs): no watering line.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22"
  },
  "Acelepryn Xtra": {
    "source": "label",
    "by_target": [
      {
        "mode": "hold",
        "match": [
          "caterpillar",
          "armyworm",
          "webworm",
          "cutworm",
          "looper",
          "grassworm"
        ],
        "hold_hours": 24,
        "label_note": "Label: \"for turf caterpillars, delay watering (irrigation) or mowing for 24 hours after application.\""
      },
      {
        "mode": "water_in",
        "match": [
          "grub",
          "ants"
        ],
        "label_note": "Label: \"Irrigate within 24 hours of application if sufficient rainfall (1/4-1/2 inch of water) does not occur.\"",
        "water_in_inches": 0.25,
        "water_in_by_hours": 24
      }
    ],
    "label_note": "Other targets (chinch bugs, mole crickets, billbugs): no watering line.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22"
  },
  "Advion Insect Granule": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 72,
    "label_note": "Label (EPA 100-1483): rainfall or irrigation within 2 to 3 days after application may reduce effectiveness and may require retreatment. Owner: no irrigation for 3 days (72 hours), the opposite of Acelepryn. If the soil is dry the tech waters the spot lightly BEFORE applying.",
    "verified_at": "2026-10-23T00:00:00.000Z",
    "verified_by": "owner-rule-2026-10-23"
  },
  "Armada 50 WDG": {
    "source": "owner",
    "by_target": [
      {
        "mode": "hold",
        "match": [
          "large patch",
          "brown patch",
          "dollar spot",
          "leaf spot",
          "leaf blight"
        ],
        "hold_until": "dry",
        "label_note": "Label: \"For control of both foliar and soil-borne diseases, allow sprayed area to completely dry before irrigation.\""
      },
      {
        "mode": "water_in",
        "match": [
          "summer patch",
          "take-all"
        ],
        "label_note": "Label: soil-borne diseases: \"irrigate immediately after application with sufficient water to move the active ingredient down into the crown and root zone of the turf.\" No amount.",
        "water_in_inches": 0.25,
        "water_in_by_hours": 24,
        "water_in_same_day": true
      },
      {
        "mode": "water_in",
        "match": [
          "fairy ring"
        ],
        "label_note": "Label: \"Water in application with 1/8 to 1/4 inch of irrigation within 6-8 hours after application.\"",
        "water_in_inches": 0.25,
        "water_in_by_hours": 8
      }
    ],
    "label_note": "Foliar first (the common lawn use).",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22"
  },
  "Atticus Talak 7.9 F": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Label: \"For best results, postpone watering (irrigation) or mowing for 24 hours after application\" (caterpillars; also the rule for chinch bugs and fire ants, whose lines say nothing after application). Mole crickets: the label's water-in (\"water immediately with up to 0.5 inches\") is done by the technician with the hose before leaving (v13 protocol), so the customer's 24-hour hold applies to every use.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_until": "dry"
    }
  },
  "Blindside Herbicide": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Label: \"Best weed control results will be obtained when no rainfall or irrigation occurs within 24 hours after application.\" Then: \"If no rainfall or irrigation occurs within 7 days after application [...] in the amount of 0.5 inches, then irrigation of at least 0.5 inches is recommended.\"",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_until": "dry"
    },
    "then_water_in": {
      "water_in_inches": 0.5,
      "water_in_by_hours": 168
    }
  },
  "Certainty Turf Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Label: \"Heavy rainfall or irrigation within 2 hours after application may wash this product off the foliage.\" Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_hours": 2
    }
  },
  "Dismiss NXT": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Label: \"Best weed control results will be obtained when no rainfall or irrigation occurs within 24 hours after application. If no rainfall or irrigation occurs within 10 days after application [...] then irrigation of at least 0.5 inches is recommended.\"",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_until": "dry"
    },
    "then_water_in": {
      "water_in_inches": 0.5,
      "water_in_by_hours": 240
    }
  },
  "Drive XLR8 Post Emergent Liquid Herbicide": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Label: \"For best results, DO NOT water or irrigate for 24 hours after application. If rainfall does not occur in 2 to 7 days after application, irrigation of at least 1/2 inch is desirable.\"",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_until": "dry"
    },
    "then_water_in": {
      "water_in_inches": 0.5,
      "water_in_by_hours": 168
    }
  },
  "Endurant PR Turf Colorant": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 8,
    "hold_until": "dry",
    "label_note": "No directions panel published for Endurant PR (Geoponics SDS only). Manufacturer (endurantcolorants.com): \"Allow grass to dry for 8 hours before a rain and up to 24 hours before a heavy rain.\" Rule: no watering for 8 hours and not before the spray has dried (owner approved adding it 2026-10-23).",
    "verified_at": "2026-10-23T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22"
  },
  "Fusilade II Post Emergent Liquid Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Foliar herbicide (bermuda removal mix with Recognition): do not water in; rainfast in 1 hour. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_hours": 1
    }
  },
  "Headway Fungicide": {
    "mode": "hold",
    "source": "owner",
    "by_target": [
      {
        "mode": "water_in",
        "match": [
          "spring dead spot"
        ],
        "label_note": "Label: \"1/4\" to 1/2\" of irrigation directly after application is recommended.\"",
        "water_in_inches": 0.25,
        "water_in_by_hours": 24,
        "water_in_same_day": true
      },
      {
        "mode": "water_in",
        "match": [
          "root dysfunction"
        ],
        "label_note": "Label: \"Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone.\"",
        "water_in_inches": 0.2,
        "water_in_by_hours": 24
      }
    ],
    "hold_until": "dry",
    "label_note": "Label: no watering line for large patch, brown patch, take-all root rot or gray leaf spot. Owner: hold until the spray has dried.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22"
  },
  "Headway G": {
    "mode": "water_in",
    "source": "owner",
    "by_target": [
      {
        "mode": "water_in",
        "match": [
          "fairy ring"
        ],
        "label_note": "Label: \"Irrigate with at least 0.5-inch of water within 24 hours after application if rainfall is not expected.\"",
        "water_in_inches": 0.5,
        "water_in_by_hours": 24
      },
      {
        "mode": "water_in",
        "match": [
          "spring dead spot"
        ],
        "label_note": "Label: \"It is recommended to use 1/4\" to 1/2\" of irrigation directly after application.\"",
        "water_in_inches": 0.25,
        "water_in_by_hours": 24,
        "water_in_same_day": true
      }
    ],
    "label_note": "Other diseases: no label line. Owner: 0.25 inch within 24 hours (granular).",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "water_in_inches": 0.25,
    "water_in_by_hours": 24
  },
  "Heritage Action Fungicide": {
    "source": "owner",
    "by_target": [
      {
        "mode": "hold",
        "match": [
          "large patch",
          "brown patch",
          "dollar spot",
          "leaf spot",
          "leaf blight",
          "take-all"
        ],
        "hold_until": "dry",
        "label_note": "Label: no watering line for these diseases. Owner (2026-10-22): hold until the spray has dried, as Artavia (same azoxystrobin)."
      },
      {
        "mode": "water_in",
        "match": [
          "root dysfunction"
        ],
        "label_note": "Label: \"Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone.\"",
        "water_in_inches": 0.2,
        "water_in_by_hours": 24
      },
      {
        "mode": "water_in",
        "match": [
          "spring dead spot"
        ],
        "label_note": "Label: \"1/8-1/4 inch of irrigation directly after application is recommended.\"",
        "water_in_inches": 0.25,
        "water_in_by_hours": 24,
        "water_in_same_day": true
      }
    ],
    "label_note": "The label also says \"DO NOT apply to residential lawns.\"",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22"
  },
  "Heritage G": {
    "mode": "water_in",
    "source": "owner",
    "by_target": [
      {
        "mode": "water_in",
        "match": [
          "fairy ring"
        ],
        "label_note": "Label: \"Irrigate with at least 0.5 inches water within 24 hours after application if rainfall is not expected.\"",
        "water_in_inches": 0.5,
        "water_in_by_hours": 24
      },
      {
        "mode": "water_in",
        "match": [
          "root dysfunction"
        ],
        "label_note": "Label: \"Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone.\"",
        "water_in_inches": 0.2,
        "water_in_by_hours": 24
      },
      {
        "mode": "water_in",
        "match": [
          "spring dead spot"
        ],
        "label_note": "Label: \"Irrigate with 1/4\" to 1/2\" of water after application.\"",
        "water_in_inches": 0.25,
        "water_in_by_hours": 24,
        "water_in_same_day": true
      }
    ],
    "label_note": "Other diseases: no label line. Owner: 0.25 inch within 24 hours (granular).",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "water_in_inches": 0.25,
    "water_in_by_hours": 24
  },
  "Hydretain Liquid": {
    "mode": "water_in",
    "source": "owner",
    "label_note": "Label: \"Water in with at least 1/10 inch of water within the first couple of hours ... Within 24 hours, follow with enough additional water to carry Hydretain ES Plus down to and throughout the root zone.\" Owner (2026-10-22): one 0.25 inch run within 2 hours covers both steps.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "water_in_inches": 0.25,
    "water_in_by_hours": 2
  },
  "LESCO Chelated Iron Plus": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Avoid watering for 24 hours after application for optimal results.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_until": "dry"
    }
  },
  "LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Avoid watering for 24 hours after application for optimal results.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_until": "dry"
    }
  },
  "LESCO Moisture Manager": {
    "mode": "water_in",
    "source": "owner",
    "label_note": "Label: \"Water in with at least 1/10 inch of water within the first couple of hours ... Within 24 hours, follow with enough additional water to carry Moisture Manager down to and throughout the root zone\" (quart label: within 1 hour). Owner (2026-10-22): one 0.25 inch run within 1 hour covers both steps.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "water_in_inches": 0.25,
    "water_in_by_hours": 1
  },
  "LESCO T-Storm 2G Fungicide": {
    "mode": "water_in",
    "source": "label",
    "label_note": "Label: \"For best results, activate the application within 24 hours with irrigation or natural rainfall. If activating by irrigation, apply 0.10-0.25 inch of water.\"",
    "rain_counts": true,
    "verified_at": "2026-10-23T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "water_in_inches": 0.25,
    "water_in_by_hours": 24
  },
  "LESCO Three-Way Selective Herbicide": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Delay irrigation for 24 hours after application; do not apply if rain is expected within 4 hours.",
    "verified_at": "2026-09-29T00:00:00.000Z",
    "verified_by": "label-check-2026-09-29"
  },
  "Recognition Post Emergent Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Foliar herbicide (bermuda removal mix with Fusilade II): do not water in; rainfast in about 3 hours. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_hours": 3
    }
  },
  "Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Label: \"Avoid applications when rainfall is forecasted to occur within 4 hours.\" Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_hours": 4
    }
  },
  "Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Label: \"Avoid applications when rainfall is forecasted to occur within 4 hours.\" Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-22T00:00:00.000Z",
    "verified_by": "label-check-2026-10-22",
    "label_minimum": {
      "hold_hours": 4
    }
  },
  "Tetrino Insecticide": {
    "mode": "water_in",
    "source": "label",
    "label_note": "Label, soil pests: \"use sufficient irrigation (1/4-1/2 inch of water) or equivalent rainfall, within 24 hours after the application.\" Foliar pests: not stated.",
    "verified_at": "2026-10-05T00:00:00.000Z",
    "verified_by": "label-check-2026-10-05",
    "water_in_inches": 0.25,
    "water_in_by_hours": 24
  },
};

const restamp = (rule) => ({ ...rule, verified_at: VERIFIED_AT, verified_by: VERIFIED_BY });
const plus = (extra) => (rule) => restamp({ ...rule, ...extra });
const onEntries = (pick) => (rule) => restamp({ ...rule, by_target: rule.by_target.map((entry) => ({ ...entry, ...(pick(entry) || {}) })) });
const DIRECTS = { label_window: 'directs' };
const covers = (entry, word) => entry.match.includes(word);
const advisory = (rule) => restamp({ ...rule, label_minimum: { ...rule.label_minimum, advisory: true } });
const noted = (extra) => (rule) => ({ label_note: `${rule.label_note} ${extra}` });

const AFTER = {
  'Acelepryn Insecticide': onEntries((e) => (e.mode === 'hold' ? { label_best_results: true } : covers(e, 'grub') && DIRECTS)),
  'Acelepryn Xtra': onEntries((e) => (e.mode === 'hold' ? { label_minimum: { hold_until: 'dry' }, label_best_results: true } : covers(e, 'grub') && DIRECTS)),
  'Advion Insect Granule': (rule) => plus({
    yields_to_label_water_in: true,
    ...noted('Owner (2026-10-24): a water-in the label directs on the same visit (Dylox) wins; the bait may need to go down again.')(rule),
  })(rule),
  'Armada 50 WDG': onEntries((e) => covers(e, 'fairy ring') && DIRECTS),
  'Atticus Talak 7.9 F': plus({ label_best_results: true }),
  'Blindside Herbicide': plus({ label_best_results: true }),
  'Dismiss NXT': plus({ label_best_results: true }),
  'Drive XLR8 Post Emergent Liquid Herbicide': plus({ label_best_results: true }),
  'LESCO Chelated Iron Plus': plus({ label_best_results: true }),
  'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer': plus({ label_best_results: true }),
  'Certainty Turf Herbicide': advisory,
  'Fusilade II Post Emergent Liquid Herbicide': advisory,
  'Recognition Post Emergent Herbicide': advisory,
  'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide': advisory,
  'Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide': advisory,
  'Endurant PR Turf Colorant': plus({ label_minimum: { hold_until: 'dry' } }),
  'Headway Fungicide': onEntries((e) => covers(e, 'root dysfunction') && DIRECTS),
  'Headway G': onEntries((e) => covers(e, 'fairy ring') && DIRECTS),
  'Heritage Action Fungicide': onEntries((e) => covers(e, 'root dysfunction') && DIRECTS),
  'Heritage G': onEntries((e) => (covers(e, 'fairy ring') || covers(e, 'root dysfunction')) && DIRECTS),
  'Hydretain Liquid': (rule) => plus({
    beside_hold_by_hours: 24,
    ...noted('Owner (2026-10-24): beside a hold, the hold first, then the root-zone step within 24 hours.')(rule),
  })(rule),
  'LESCO Moisture Manager': (rule) => plus({
    beside_hold_by_hours: 24,
    ...noted('Owner (2026-10-24): beside a hold, the hold first, then the root-zone step within 24 hours.')(rule),
  })(rule),
  'LESCO Three-Way Selective Herbicide': plus({
    label_minimum: { hold_hours: 4, advisory: true },
    label_best_results: true,
    label_note: 'Label: "For optimum results: ... do not apply if rain is expected within 4 hours after the application, delay irrigation cycle for 24 hours." Both lines are optimum-results advice.',
  }),
  'LESCO T-Storm 2G Fungicide': plus({ label_window: 'best_results' }),
  'Tetrino Insecticide': plus({
    by_target: [{
      match: ['grub'],
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      label_window: 'directs',
      label_note: 'Label, soil pests (white grubs): "use sufficient irrigation (1/4-1/2 inch of water) or equivalent rainfall, within 24 hours after the application."',
    }],
  }),
};

const REPLACE = Object.keys(AFTER).map((name) => ({ name, before: BEFORE[name], after: AFTER[name](BEFORE[name]) }));

const PRECAUTION_PRODUCT = 'Advion Insect Granule';
const OLD_PRECAUTION_SENTENCE = 'Skip your turf watering for the time shown on this report.';
const NEW_PRECAUTION_SENTENCE = 'Follow the watering steps on this report.';

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function audit(knex, canAudit, row, kind, before, after) {
  if (!canAudit) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${kind}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, before, after },
    critical: true,
    trx: knex,
  });
}

async function replaceRules(knex, canAudit) {
  for (const item of REPLACE) {
    if (!validateRule(item.after).valid) continue; // never write a rule the validator rejects
    const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', 'post_application_watering');
    for (const row of rows) {
      // Compare VALUES: Postgres returns jsonb with its own key order.
      if (!isDeepStrictEqual(parseJson(row.post_application_watering), item.before)) continue;
      const updated = await knex('products_catalog').where({ id: row.id })
        .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(item.before)])
        .update({ post_application_watering: JSON.stringify(item.after), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, 'clash_keys', item.before, item.after);
    }
  }
}

async function replacePrecaution(knex, canAudit) {
  if (!(await knex.schema.hasColumn('products_catalog', 'customer_precaution_summary'))) return;
  const rows = await knex('products_catalog').where({ name: PRECAUTION_PRODUCT }).select('id', 'name', 'customer_precaution_summary');
  for (const row of rows) {
    const before = row.customer_precaution_summary;
    if (typeof before !== 'string' || before.split(OLD_PRECAUTION_SENTENCE).length !== 2) continue;
    const after = before.replace(OLD_PRECAUTION_SENTENCE, NEW_PRECAUTION_SENTENCE);
    const updated = await knex('products_catalog').where({ id: row.id, customer_precaution_summary: before })
      .update({ customer_precaution_summary: after, updated_at: knex.fn.now() });
    if (updated) await audit(knex, canAudit, row, 'precaution', before, after);
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  await replaceRules(knex, canAudit);
  await replacePrecaution(knex, canAudit);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.BEFORE = BEFORE;
exports.AFTER = AFTER;
exports.REPLACE = REPLACE;
exports.OLD_PRECAUTION_SENTENCE = OLD_PRECAUTION_SENTENCE;
exports.NEW_PRECAUTION_SENTENCE = NEW_PRECAUTION_SENTENCE;
