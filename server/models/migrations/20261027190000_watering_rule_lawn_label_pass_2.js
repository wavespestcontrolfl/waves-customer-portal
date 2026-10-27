// Watering rules for the lawn products that had none (owner 2026-10-27, "do this": a rule for every lawn
// product, so no customer misses a watering text the first time a technician logs one).
//
// On 2026-10-26 a same-day lawn visit logged Merit 2F, which had no rule: one product with no rule, or with only
// the category guess, cancels the visit's whole watering text and raises an office alert (fixed for Merit 2F and
// Heritage WDG by 20261027120000). A read of production on 2026-10-27 found 83 more active lawn-relevant catalog
// products (service lines lawn or unset): 31 with no rule and 52 with only the category guess. None had been
// logged on a lawn visit yet; 22 are in stock.
//
// Labels read 2026-10-27 (EPA-stamped PPLS PDFs or the maker's specimen label; the bag, jug or product sheet for
// fertilizers); each rule's label_note quotes the label line it rests on. source 'label' = the label's own
// direction and figure. source 'owner' = the label gives no figure (or splits by target) and the rule follows the
// owner's precedent: a granular fertilizer or soil amendment, palm and landscape granules included, 0.25 inch
// within 24 hours (as LESCO 24-0-11 and 10-0-22); a liquid fertilizer no watering change (as LESCO Nutra-TECH,
// 2026-10-05); a foliar fungicide with no watering line, no watering until the spray has dried (as Artavia 2 SC);
// a post-emergent herbicide, no rain or irrigation for 24 hours (owner 2026-10-09) above the label's own minimum;
// a pre-emergent with no figure, 0.5 inch within 14 days (as LESCO Dimension 18-0-10); a trunk injection or other
// product not applied to turf, no watering change. A label range takes its top figure, except spring dead spot's
// "1/4 to 1/2 inch", kept at 0.25 as the stored Headway, Headway G and Heritage G. A label line asking to avoid
// spraying when rain is expected within 48 hours is runoff advice, never a hold (owner 2026-10-05). Products whose
// labels give different directions by target carry by_target entries. Six labels were not found or not surely the
// exact item (SUPERthrive Foliage-Pro and PGF Complete 16-4-8 not found; the 46-0-0 urea, Chelated Liquid Iron and
// LESCO 6-0-0 Liquid, whose item the catalog leaves open, read from the likely LESCO, Southern Ag and LESCO Green
// Flo Humic labels; LESCO 20-0-0 60% CRN read from its successor); their rules follow the owner precedent for their
// kind. A rule on a product not approved for service reports reaches no text until it is approved.
//
// Left out (no rule written): none.
//
// FILL rows are matched by exact catalog name and written only while post_application_watering (or
// mow_hold_days) is still empty, so any admin edit stands. validateRule runs before any write. One audit_log row
// per write with before and after. Down is a documented no-op (waves-db SKILL: a data-correction migration never
// reverts on rollback); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261027190000_watering_rule_lawn_label_pass_2';

const VERIFIED = { verified_at: '2026-10-27T00:00:00.000Z', verified_by: 'label-check-2026-10-27' };

const FILL = [
  {
    name: 'Sequestar 6% Fe EDDHA Soluble Micronutrient',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      rain_counts: true,
      source: 'owner',
      label_note: 'Label (2021): soil use "should either be incorporated into the root zone at planting, injected into the root zone, or surface applied and moved into the root zone by tillage, drenching, irrigation or rainfall" (no amount, no deadline). Older 2015 label, turf soil use: "Irrigate immediately after application." Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO Elite 0-0-50 AM 18% S SOP Turfgrass Granular Fertilizer',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 6-0-0 Liquid',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label (Green Flo Humic Supplement 6-0-0, item 511126): "Irrigate or water in to ensure maximum soil contact." (light or sandy soils, and heavy or compacted soils; no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer (#511542)',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label (palm and landscape granule): "Apply the fertilizer to dry foliage and water in soon after application for the best results." (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 0-0-16 Palm & Tropical Ornamental Fertilizer (#510513)',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label (palm and landscape granule): "Apply the fertilizer to dry foliage and water in soon after application for the best results." (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'Cytogro Liquid Biostimulant',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label: no watering line after application ("sufficient water" is the spray volume). Owner: a liquid biostimulant needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
      ...VERIFIED,
    },
  },
  {
    name: '46-0-0 Urea Professional Fertilizer',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 13-0-13 60% PolyPlus Landscape',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label (palm and landscape granule): no watering line. Owner: 0.25 inch within 24 hours, as every granular fertilizer (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'Espoma Organic Alfalfa Meal 2-0-2',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "Sprinkle on the soil surface around the drip line and then water." (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'Arborjet Palm-Jet Palm Nutrition',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Not applied to turf (palm and landscape tree trunk-injection fertilizer): no lawn watering change.',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 9-0-24 56% PolyPlus',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 17-0-10 50% CRN Mini Granular',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'Arborjet NUTRIROOT 1 qt',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Not applied to turf (liquid soil-applied fertilizer for trees, palms, shrubs and landscape plants): no lawn watering change.',
      ...VERIFIED,
    },
  },
  {
    name: 'The Andersons Humic DG',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.3,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "For best results, after application, water area with a minimum of 0.3 inches of water." (no deadline). Owner: within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'SUPERthrive Foliage-Pro 9-3-6',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label not found. Owner: a liquid fertilizer needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
      ...VERIFIED,
    },
  },
  {
    name: 'Chelated Liquid Iron (brand TBD)',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label (Southern Ag Chelated Liquid Iron, the likely brand): no watering line after application. Owner: a liquid fertilizer needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
      ...VERIFIED,
    },
  },
  {
    name: 'Espoma Organic Soil Acidifier',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "Spread evenly around the plant out to the drip line and water well." (no amount; the broadcast rate has no watering line). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 8-0-10 100% PolyPlus Landscape',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label (palm and landscape granule): "Apply the fertilizer to dry foliage and water in soon after application for the best results." (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'Southern Ag Manganese Sulfate',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: no watering line. Owner: 0.25 inch within 24 hours, the granular fertilizer rule the LESCO 24-0-11 and 10-0-22 carry.',
      ...VERIFIED,
    },
  },
  {
    name: 'Bloom City Clean Kelp',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label: no watering line after application. Owner: a liquid supplement needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 24-0-11 50% NOS 30% BIO 3% Fe MOP',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 8-0-10 50% PolyPlus OPTI45 Spar-TECH 1% Fe 1% Mg 1% Mn 0.1% B KMAG Palm & Tropical Ornamental Granular Fertilizer',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label (palm and landscape granule): "Apply the fertilizer to dry foliage and water in soon after application for the best results." (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'Arborjet NUTRIROOT 2.5 gal',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Not applied to turf (liquid soil-applied fertilizer for trees, palms, shrubs and landscape plants): no lawn watering change.',
      ...VERIFIED,
    },
  },
  {
    name: 'PGF Complete 16-4-8',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Bag label not found. The Andersons web page says to water in with at least 0.2 inch (no deadline). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22). The label was not read for this rule.',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 7-1-7 40% PolyPlus',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 24-0-10 75% PolyPlus OPTI45 Spar-TECH 10% Cl MOP Turfgrass Granular Fertilizer 50 lb. Bag',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 13-24-6 Landscape Starter',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label (palm and landscape granule): "Apply the fertilizer to dry foliage and water in soon after application for the best results." (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'BRANDT Agra Sol Micro Mix',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label: no watering line after application. Owner: a soluble micronutrient needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
      ...VERIFIED,
    },
  },
  {
    name: 'ArborJet Mn-Jet Fe Micros',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Not applied to turf (trunk-injection and foliar micronutrient for trees, palms and shrubs): no lawn watering change.',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 15-0-15 30% PolyPlus 1% Fe',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 24-2-11 50% NOS Plus BIO 6% Fe',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label: no watering line after application (its water words are the spray mix and the ways to apply). Owner: a liquid soil amendment needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
      ...VERIFIED,
    },
  },
  {
    name: 'Arborjet NUTRIROOT 1 gal',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Not applied to turf (liquid soil-applied fertilizer for trees, palms, shrubs and landscape plants): no lawn watering change.',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 20-0-0 60% CRN Plus Micros Turfgrass Liquid Fertilizer',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label (Nutra-TECH 20-0-0 60% SRN with Micros, the current LESCO label for this analysis): no watering line after application. Owner: a liquid fertilizer needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 8-2-12 100% Poly Plus OPTI Kieserite 4% Mg 9.26% S 0.15% B 0.05% Cu 0.15% Fe 2% Mn 0.15% Zn Palm & Tropical Ornamental Granular Fertilizer',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label (palm and landscape granule): "Apply the fertilizer to dry foliage and water in soon after application for the best results." (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 0-0-62 AM MOP Turfgrass Soluble Fertilize',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 20-20-20 Soluble',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label: no watering line after application. Owner: a soluble fertilizer needs no watering change (as LESCO Nutra-TECH, 2026-10-05).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO 16-4-8 50% PolyPlus OPTI 0.05%Cu 1%Fe 0.4%Mn 0.15%Zn MOP Turfgrass Granular',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'Dominion 2L 1 gal',
    rule: {
      mode: 'water_in',
      source: 'owner',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      rain_counts: true,
      label_window: 'directs',
      label_note: 'Label: "Irrigation or rainfall must occur within 24 hours after application to move the active ingredient through the thatch." No amount. Owner: 0.25 inch within 24 hours (as Merit 2F).',
      ...VERIFIED,
    },
  },
  {
    name: 'Talstar XTRA Granular Insecticide (Verge)',
    rule: {
      mode: 'water_in',
      source: 'owner',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      by_target: [
        {
          match: ['armyworm', 'cutworm', 'webworm', 'chinch'],
          mode: 'water_in',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
          water_in_same_day: true,
          label_note: 'Label: "irrigate the treated area with water immediately after application to activate (release from the granule) the insecticide." (caterpillars, no amount); chinch bugs: "Irrigate the treated area with up to 0.25 inches of water immediately after application"',
        },
        {
          match: ['flea', 'mole cricket'],
          mode: 'water_in',
          water_in_inches: 0.5,
          water_in_by_hours: 24,
          water_in_same_day: true,
          label_note: 'Label, fleas: "Irrigate the treated area with up to 0.5 inches of water immediately after application to activate (release from the granule) the insecticide." Mole crickets: "should be watered in with up to 0.5 inches of water immediately after treatment."',
        },
      ],
      label_note: 'Label: "Water treated area as directed on this label. Do not water to the point of run-off." Fire ants: "If the soil is not moist, then it is important to irrigate before or soon after application." No amount. Owner: 0.25 inch within 24 hours (granular). Ticks and perimeter pests: no watering line.',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO Tracker Green Spray Indicator Dye',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label: "The temporary color disappears with rain, dew, irrigation or sunlight." No watering direction. Tank-mix spray dye: the products in the mix set the watering rule (as LESCO 90/10 Nonionic Surfactant).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO-Wet Plus Nonionic Wetting Agent',
    rule: {
      mode: 'water_in',
      source: 'owner',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      label_note: 'Label: "If sprayed, irrigate treated areas thoroughly to incorporate LESCO-Wet Plus into the soil." and "If not applied by an irrigation system, follow the treatment with at least ¼ inch of water." No deadline. Owner: within 24 hours (as LESCO 24-0-11 and 10-0-22).',
      ...VERIFIED,
    },
  },
  {
    name: 'QP MSM 60DF Turf Herbicide',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 24,
      label_minimum: {
        hold_until: 'dry',
      },
      label_note: 'Label: post-emergent rainfast and irrigation not stated. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.',
      ...VERIFIED,
    },
  },
  {
    name: 'Tenacity Herbicide',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 24,
      label_minimum: {
        hold_until: 'dry',
      },
      then_water_in: {
        water_in_inches: 0.15,
        water_in_by_hours: 240,
      },
      label_note: 'Label: "If rainfall (0.15 inches) has not occurred within 10 days after a preemergence application, activate with 0.15 inches of irrigation." Postemergence use: rainfast and irrigation not stated. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO Crosscheck Plus',
    rule: {
      mode: 'hold',
      source: 'label',
      hold_hours: 24,
      label_minimum: {
        hold_until: 'dry',
      },
      label_best_results: true,
      label_note: 'Label: "To ensure optimum control, delay watering (irrigation) or mowing for 24 hours after application" (caterpillars; also the rule for the other uses, whose lines say nothing after application). Mole crickets: the label\'s water-in ("watered in with up to 0.5 inches of water immediately after treatment") is done by the technician with the hose before leaving (v13 protocol), so the customer\'s 24-hour hold applies to every use (as Atticus Talak 7.9 F).',
      ...VERIFIED,
    },
    mowHoldDays: 1,
  },
  {
    name: 'Roundup QuikPro SC',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Not applied to turf (non-selective residual herbicide for beds, hardscape and non-crop areas; the label bars desirable turfgrass): no lawn watering change.',
      ...VERIFIED,
    },
  },
  {
    name: 'Quali-Pro T-Nex Plant Growth Regulator',
    rule: {
      mode: 'hold',
      source: 'label',
      hold_hours: 1,
      label_note: 'Label: "Within one hour after application, Quali-Pro® T-NEX® will not wash off the grass foliage." "Watering-in is not necessary for activation of Quali-Pro® T-NEX®."',
      ...VERIFIED,
    },
  },
  {
    name: 'Barricade 4FL',
    rule: {
      mode: 'water_in',
      source: 'label',
      water_in_inches: 0.5,
      water_in_by_hours: 336,
      label_note: 'Label: "For optimum weed control, Barricade 4FL should be activated by at least 0.5 inch of rainfall or irrigation before weed seeds germinate and within 14 days following application."',
      ...VERIFIED,
    },
  },
  {
    name: 'Dominion 2L 27.5 oz',
    rule: {
      mode: 'water_in',
      source: 'owner',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      rain_counts: true,
      label_window: 'directs',
      label_note: 'Label: "Irrigation or rainfall must occur within 24 hours after application to move the active ingredient through the thatch." No amount. Owner: 0.25 inch within 24 hours (as Merit 2F).',
      ...VERIFIED,
    },
  },
  {
    name: 'Barricade 65WG',
    rule: {
      mode: 'water_in',
      source: 'label',
      water_in_inches: 0.5,
      water_in_by_hours: 336,
      label_note: 'Label: "Barricade 65WG should be activated by at least 0.5 inch of rainfall or irrigation before weed seeds germinate and within 14 days following application."',
      ...VERIFIED,
    },
  },
  {
    name: 'Manor',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 24,
      label_minimum: {
        hold_until: 'dry',
      },
      label_note: 'Label: post-emergent rainfast and irrigation not stated. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.',
      ...VERIFIED,
    },
  },
  {
    name: 'Envu Specticle Flo Pre-Emergent Liquid Herbicide',
    rule: {
      mode: 'water_in',
      source: 'owner',
      water_in_inches: 0.5,
      water_in_by_hours: 336,
      label_note: 'Label: "To activate SPECTICLE FLO HERBICIDE, irrigate lightly after application to move the herbicide into the soil. Rainfall within several days after application will negate the need to irrigate." (no amount, no deadline). Owner (2026-10-09): 0.5 inch within 14 days, as Stonewall.',
      ...VERIFIED,
    },
  },
  {
    name: 'BRANDT Indicate 5',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Label: no watering line. Tank-mix adjuvant (pH indicator, acidifier, spreader): the products in the mix set the watering rule (as LESCO 90/10 Nonionic Surfactant).',
      ...VERIFIED,
    },
  },
  {
    name: 'Primo Maxx Plant Growth Regulator for Turf',
    rule: {
      mode: 'hold',
      source: 'label',
      hold_hours: 1,
      label_note: 'Label: "Primo MAXX reaches the growing point by foliar uptake and is rainfast from rainfall or irrigation after one hour. Watering-in is not necessary for activation."',
      ...VERIFIED,
    },
  },
  {
    name: 'Monument 75WG',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 24,
      label_minimum: {
        advisory: true,
        hold_hours: 3,
      },
      label_note: 'Label: "Rainfastness: Monument 75WG is rainfast within 3 hours after application." Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.',
      ...VERIFIED,
    },
    mowHoldDays: 2,
  },
  {
    name: 'Atrazine 4L',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 72,
      label_minimum: {
        hold_until: 'dry',
      },
      label_best_results: true,
      then_water_in: {
        water_in_inches: 0.5,
        water_in_by_hours: 240,
      },
      label_note: 'Label: "Rain or watering within 2 to 3 days of application may decrease the effectiveness on emerged weeds. However, for control of weeds from seeds, rainfall or watering is necessary within 7 to 10 days after treatment." No amount. Owner: 0.5 inch (as LESCO Dimension 18-0-10). The label\'s 3 days (72 hours) is longer than the owner\'s 24-hour herbicide hold, so it wins.',
      ...VERIFIED,
    },
  },
  {
    name: 'Snapshot 2.5TG',
    rule: {
      mode: 'water_in',
      source: 'label',
      water_in_inches: 0.5,
      water_in_by_hours: 72,
      rain_counts: true,
      label_window: 'best_results',
      label_note: 'Label (landscape beds, not turf): "A single rainfall or sprinkler irrigation of 0.5 inches or more, or flood irrigation is required to activate Snapshot 2.5 TG. Optimum weed control is obtained when Snapshot 2.5 TG is activated within 3 days of application."',
      ...VERIFIED,
    },
  },
  {
    name: 'Segment II Herbicide',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 24,
      label_minimum: {
        advisory: true,
        hold_hours: 1,
      },
      label_note: 'Label: "Segment II is rainfast after one hour." Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.',
      ...VERIFIED,
    },
  },
  {
    name: 'T-Zone SE',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 24,
      label_minimum: {
        advisory: true,
        hold_hours: 3,
      },
      label_note: 'Label: "[Rainfast in as little as 3 hours.] Do not apply this product immediately before rainfall or irrigation." Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide. The label\'s dry-weather line ("a scheduled irrigation or watering 24 hours before and 24 hours after application is recommended") fits after the hold.',
      ...VERIFIED,
    },
    mowHoldDays: 2,
  },
  {
    name: 'SureGuard SC',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 24,
      label_minimum: {
        hold_hours: 1,
      },
      label_note: 'Label (dormant bermudagrass): "Do not irrigate within 1 hour before or after application." Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide (it also has early postemergence activity).',
      ...VERIFIED,
    },
  },
  {
    name: 'Tribute Total WDG',
    rule: {
      mode: 'hold',
      source: 'owner',
      hold_hours: 24,
      label_minimum: {
        advisory: true,
        hold_hours: 3,
      },
      label_note: 'Label: "Rainfall within the first 3 hours after treatment may require retreatment with this product or reduced weed control may result." Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.',
      ...VERIFIED,
    },
  },
  {
    name: 'Dylox 420 SL T&O Insecticide',
    rule: {
      mode: 'water_in',
      source: 'owner',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      water_in_same_day: true,
      label_note: 'Label: "After application (on the same day), irrigate with sufficient water to thoroughly wet the remaining thatch and top layers of the soil." (no amount; the same line covers white grubs, mole crickets, chinch bugs and the surface feeders). Owner: 0.25 inch, the same day (as Dylox 6.2 G Granular).',
      ...VERIFIED,
    },
  },
  {
    name: 'ALOFT LC G INSECTICIDE',
    rule: {
      mode: 'water_in',
      source: 'owner',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      by_target: [
        {
          match: ['armyworm', 'cutworm', 'webworm', 'surface feed', 'surface insect'],
          mode: 'hold',
          hold_hours: 24,
          label_note: 'Label: "For listed surface insects, do not water in Aloft LC G Insecticide for at least 24 hours after the application."',
        },
        {
          match: ['fire ant'],
          mode: 'water_in',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
          water_in_same_day: true,
          label_note: 'Label: "To activate the granules immediately, water in with a light (0.25 inches) irrigation to release the toxicant from the granules."',
        },
      ],
      label_note: 'Label (white grubs, the main use): "For control of existing grub populations, irrigate after application with enough water to move the insecticide into the zone where the grubs are feeding." No amount. Owner: 0.25 inch within 24 hours (granular). Mole crickets and nuisance ants: water after application, no amount.',
      ...VERIFIED,
    },
  },
  {
    name: 'Bifen XTS',
    rule: {
      mode: 'hold',
      source: 'label',
      hold_hours: 24,
      label_minimum: {
        hold_until: 'dry',
      },
      label_best_results: true,
      label_note: 'Label: "postpone watering or mowing for 24 hours following application" (caterpillars; also the rule for the other uses, whose lines say nothing after application). Mole crickets: the label\'s water-in ("Water treated areas with 0.25 to 0.5 inches of water immediately following application") is done by the technician with the hose before leaving (v13 protocol), so the customer\'s 24-hour hold applies to every use (as Atticus Talak 7.9 F).',
      ...VERIFIED,
    },
    mowHoldDays: 1,
  },
  {
    name: 'Azoxy 2SC Select',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      label_note: 'Label: no watering instruction for turf; the 48-hour line is the runoff advisory about when to spray. Owner: hold until the spray has dried (as Artavia 2 SC, same azoxystrobin).',
      ...VERIFIED,
    },
  },
  {
    name: 'Insignia SC Intrinsic',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      by_target: [
        {
          match: ['brown ring patch', 'waitea patch', 'fairy ring'],
          mode: 'water_in',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
          water_in_same_day: true,
          label_note: 'Label: "Provide short irrigation cycle directly following treatment to move fungicide through thatch." No amount. Owner: 0.25 inch, the same day (as Armada 50 WDG).',
        },
        {
          match: ['root dysfunction'],
          mode: 'water_in',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
          water_in_same_day: true,
          label_note: 'Label: "Irrigate immediately following application." No amount. Owner: 0.25 inch, the same day (as Armada 50 WDG).',
        },
      ],
      label_note: 'Label: "After application, allow foliage to dry prior to mowing or irrigating (exceptions: brown ring patch, fairy ring and Pythium root dysfunction)." The three exceptions are the by_target entries.',
      ...VERIFIED,
    },
  },
  {
    name: 'BASF Pillar SC Intrinsic Brand Fungicide',
    rule: {
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      source: 'owner',
      by_target: [
        {
          match: ['leaf spot', 'dollar spot', 'anthracnose', 'red thread', 'pink patch', 'rust', 'powdery mildew', 'yellow tuft', 'pythium blight', 'rapid blight', 'melting out', 'gray leaf spot'],
          mode: 'hold',
          hold_until: 'dry',
          label_note: 'Label: no watering line for leaf diseases. Owner: hold until the spray has dried (as Artavia 2 SC).',
        },
      ],
      label_note: 'Label: "For best results, apply 0.25 inch post-application irrigation when targeting soilborne diseases (e.g. fairy ring, large patch, Pythium root dysfunction, summer patch, take-all root rot, and take-all patch)." No deadline. Owner: within 24 hours. Large patch, the protocol use, is on that list, so this is the base; leaf diseases hold until dry.',
      ...VERIFIED,
    },
  },
  {
    name: 'Chipco Signature',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'label',
      label_note: 'Label: "Do not mow and/or water treated areas until foliage is completely dry."',
      ...VERIFIED,
    },
  },
  {
    name: 'ADORN Fungicide',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      label_minimum: {
        hold_hours: 2,
        advisory: true,
      },
      source: 'owner',
      label_note: 'Label: "Foliar sprays are rainfast 2 hours after application." It gives no instruction to hold irrigation, and "Do not apply for foliar disease control if measurable rain is expected within 2 hours of application" is forecast advice about when to spray. Owner: hold until the spray has dried (as Artavia 2 SC); the label minimum is the 2-hour rainfast figure.',
      ...VERIFIED,
    },
  },
  {
    name: 'Southern Ag Copper Fungicide 27.15%',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      label_note: 'Label: no watering instruction for turf (algae spray). "Applying this product in calm weather when rain is not predicted for the next 24 hours" is forecast advice about when to spray. Owner: hold until the spray has dried (as Artavia 2 SC).',
      ...VERIFIED,
    },
  },
  {
    name: 'KPHITE 7LP Systemic Fungicide',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      label_note: 'Label (commercial sublabel A, turf): no watering line for the foliar spray. The household sublabel of the same label says "Do not mow or irrigate treated areas until sprays have completely dried." Owner: hold until the spray has dried (as Artavia 2 SC).',
      ...VERIFIED,
    },
  },
  {
    name: 'Badge SC Bactericide/Fungicide',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      label_note: 'Label: no watering instruction for turf (algae maintenance spray). Owner: hold until the spray has dried (as Artavia 2 SC).',
      ...VERIFIED,
    },
  },
  {
    name: 'LESCO Spectator T&O',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'label',
      by_target: [
        {
          match: ['spring dead spot'],
          mode: 'water_in',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
          water_in_same_day: true,
          label_note: 'Label: "Irrigate with 0.25 to 0.50 inches water immediately after application is recommended." Owner: 0.25 inch (as Headway, Headway G and Heritage G for the same range).',
        },
      ],
      label_note: 'Label: "For control of foliar diseases, allow sprayed area to completely dry before irrigation." Soil-borne diseases: "can be watered in after application" (optional, no amount), so they keep the hold.',
      ...VERIFIED,
    },
  },
  {
    name: 'Heritage TL',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      by_target: [
        {
          match: ['spring dead spot'],
          mode: 'water_in',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
          water_in_same_day: true,
          label_note: 'Label: "1/4" to 1/2" of irrigation directly after application is recommended." Owner: 0.25 inch (as Headway, Headway G and Heritage G for the same range).',
        },
        {
          match: ['root dysfunction'],
          mode: 'water_in',
          water_in_inches: 0.2,
          water_in_by_hours: 24,
          label_window: 'directs',
          label_note: 'Label: "Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone."',
        },
      ],
      label_note: 'Label (EPA 100-1191, EPA-stamped 2026-03-11): no watering line for leaf and patch diseases, fairy ring or take-all; its "Do not allow entry into treatment area until area that was treated with Heritage Maxx is dry." is a re-entry line. Owner: no watering until the spray has dried, as Heritage WDG and Artavia 2 SC (same azoxystrobin).',
      ...VERIFIED,
    },
  },
  {
    name: 'Nufarm Cleary 3336F Fungicide',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      by_target: [
        {
          match: ['take-all', 'summer patch', 'spring dead spot', 'bermudagrass decline', 'necrotic ring spot', 'cool season brown patch'],
          mode: 'water_in',
          water_in_inches: 0.2,
          water_in_by_hours: 24,
          label_note: 'Label: "For root pathogens, lightly water the treated area to move the fungicide into the active root zone with one to two tenths inch of water." No time stated. Owner: the same day (as LESCO T-Storm Flowable, same wording).',
          water_in_same_day: true,
        },
      ],
      label_note: 'Label (tank mix with contact fungicides, foliar diseases): "When tank mixing with contact action fungicides for foliar diseases, allow applications to dry on leaf surfaces. Normal watering may proceed after sprays have dried." Foliar first (the protocol use: large patch, dollar spot, gray leaf spot).',
      ...VERIFIED,
    },
  },
  {
    name: 'Atticus Gunner',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'label',
      label_note: 'Label: "For control of foliar diseases, allow sprayed area to completely dry before irrigation." Soil-borne diseases: "can be watered in after application" (optional, no amount), so they keep the hold.',
      ...VERIFIED,
    },
  },
  {
    name: 'Banol Fungicide',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      label_note: 'Label: no watering instruction for turf. Owner: hold until the spray has dried (as Artavia 2 SC).',
      ...VERIFIED,
    },
  },
  {
    name: 'Arborjet PHOSPHO-Jet Systemic Fungicide',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Not applied to turf (palm trunk injection of a systemic fungicide): no lawn watering change.',
      ...VERIFIED,
    },
  },
  {
    name: 'Compass Fungicide',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'label',
      label_note: 'Label: "For control of both foliar and soil-borne diseases, allow sprayed area to completely dry before irrigation."',
      ...VERIFIED,
    },
  },
  {
    name: 'Eagle 20EW Fungicide',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      label_note: 'Label: no watering instruction for turf. Owner: hold until the spray has dried (as Gravex 20 EW, same myclobutanil).',
      ...VERIFIED,
    },
  },
  {
    name: 'Quali-Pro PPZ 14.3 Propiconazole',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'label',
      label_note: 'Label: "For control of foliar diseases, allow sprayed area to completely dry before irrigation." Soil-borne diseases: "can be watered in after application" (optional, no amount), so they keep the hold.',
      ...VERIFIED,
    },
  },
  {
    name: 'Arborjet Propizol Injectable Fungicide',
    rule: {
      mode: 'none',
      source: 'owner',
      label_note: 'Not applied to turf (tree trunk or flare-root injection of a systemic fungicide): no lawn watering change.',
      ...VERIFIED,
    },
  },
  {
    name: 'Subdue Maxx Fungicide',
    rule: {
      mode: 'hold',
      hold_until: 'dry',
      source: 'owner',
      by_target: [
        {
          match: ['damping-off', 'damping off'],
          mode: 'water_in',
          water_in_inches: 0.5,
          water_in_by_hours: 24,
          rain_counts: true,
          label_window: 'best_results',
          label_note: 'Label (newly seeded areas, for best efficacy): "1/2 inch irrigation or rainfall is required within 24 hours after application."',
        },
      ],
      label_note: 'Label (established turf, foliar use): no watering line. Owner: hold until the spray has dried (as Artavia 2 SC).',
      ...VERIFIED,
    },
  },
];
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

async function fillRule(knex, canAudit, item) {
  if (!validateRule(item.rule).valid) return; // never write a rule the validator rejects
  const rows = await knex('products_catalog').where({ name: item.name }).whereNull('post_application_watering').select('id', 'name');
  for (const row of rows) {
    const updated = await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
      .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
    if (updated) await audit(knex, canAudit, row, 'seeded', null, item.rule);
  }
}

async function fillMow(knex, canAudit, item) {
  const rows = await knex('products_catalog').where({ name: item.name }).whereNull('mow_hold_days').select('id', 'name');
  for (const row of rows) {
    const updated = await knex('products_catalog').where({ id: row.id }).whereNull('mow_hold_days')
      .update({ mow_hold_days: item.mowHoldDays, updated_at: knex.fn.now() });
    if (updated) await audit(knex, canAudit, row, 'mow_hold_seeded', { mow_hold_days: null }, { mow_hold_days: item.mowHoldDays });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const hasMow = await knex.schema.hasColumn('products_catalog', 'mow_hold_days');
  for (const item of FILL) {
    await fillRule(knex, canAudit, item);
    if (hasMow && item.mowHoldDays) await fillMow(knex, canAudit, item);
  }
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.FILL = FILL;
