// Per-basis rate-render backfill (owner ask 2026-08-14: "make sure rate
// renders for all inventory products — I used Advion ant gel and it did not
// render a rate").
//
// The 20260712100000 label-rate backfill verified 136 products but wrote NO
// rate fields for basis-"other" products (per-spot gels, per-100-gal
// dilutions, per-inch-DBH injections, per-acre broadcast, per-100-sq-ft bed
// rates, station/placement densities) because the schema then supported only
// per-1,000 and per-gallon semantics. Those products completed with an empty
// Rate and rendered "—" on customer service reports. The completion form now
// prefills from default_rate + default_unit for ANY "/"-suffixed per-basis
// unit (isPerBasisUnit, SchedulePage.jsx) and the server accepts the
// label-native unit vocabulary, so this migration surfaces the
// already-verified label rates through those fields.
//
// Provenance: display values come from (a) the 20260712100000 DATA entries —
// each extracted from the actual label and adversarially re-verified, with
// the verbatim label quote already stored on the row's label_source_note —
// and (b) a 2026-08-14 research pass over the products that migration did
// not cover, re-verified against manufacturer/EPA PPLS label documents. No
// entry is from memory or marketing copy. Where a product's basis could not
// be honestly reduced to a number-plus-unit (RTU foam, per-tree DBH dose
// tables, mechanical snap traps, monitoring stations, a brandless catalog
// row, a concentrate with no published dilution), NOTHING is written — those
// remain rate-less by design and are listed in the PR body.
//
// Write semantics (all fill-only-if-empty; admin edits always win):
// - basis "display" → default_rate ("X" or "X-Y" band) + default_unit
//   (label-native per-basis unit, e.g. "g/spot", "fl_oz/100gal",
//   "ml/inch dbh", "oz/acre", "lb/100sf", "each/20ft"). The pair is atomic
//   (codex P2 r3): both are written only when default_rate is empty — a
//   unit-only placeholder from the inventory create form ("oz" with no
//   rate) is replaced by the label unit rather than left to caption the
//   new rate, and a row with a preexisting rate is left entirely alone
//   (pairing an admin rate with our unit would mislabel it).
// - entries may carry `method` → application_method, filled only where the
//   column exists and the row has none (codex P1 r3: DBH-dosed injectables
//   otherwise classify as foliar_spray, an internally contradictory record
//   next to an ml/inch-DBH rate).
// - basis "per_1000_sqft" → default_rate_per_1000 (label's named rate, else
//   the label's LOW rate), min/max_label_rate_per_1000, rate_unit — the same
//   convention as 20260712100000.
// - label_source_note: written where NULL; appended (" | ...") where an
//   earlier batch's note exists, so the new values carry provenance without
//   erasing it. label_verified_at/by stamped only where NULL.
//
// down() clears only values this migration wrote. Unlike 20260712100000's
// down() it cannot gate on the label_verified_by stamp — most target rows
// were already stamped by that earlier batch, so up() writes their display
// fields WITHOUT restamping. Ownership is recorded instead in the appended
// provenance segment ("... [wrote: default_rate, default_unit]"): down()
// reverts the fields named there as one all-or-nothing group — only while
// EVERY member still holds exactly what up() wrote. Preexisting equal
// values survive (no marker), and an admin edit to any member makes the
// whole group admin-owned (reverting just the untouched member would
// orphan the edited one, e.g. an edited gel rate losing its g/spot unit).

const VERIFIED_BY = 'rate-render-backfill-2026-08-14';

const DATA = [
  // ── Gel baits: grams per spot placement ─────────────────────────────
  // Gel rows seed application_method bait_placement (codex P1 r19): their
  // catalog category is plain 'Insecticide', so method inference would
  // otherwise fall through to perimeter_spray — a spray method (demanding
  // irrelevant linear footage) beside a g/spot placement rate.
  { name: 'Advion Ant Bait Gel', basis: 'display', method: 'bait_placement', rate: '0.1-1', unit: 'g/spot',
    note: 'rate-render: 0.1-1 g per spot from the Syngenta label (EPA 100-1498, EPA PPLS 000100-01498-20200417.pdf): "Apply 0.1 to 1.0 gram spots" to active trails/nest sites.' },
  { name: 'Advion Cockroach Gel Bait', basis: 'display', method: 'bait_placement', rate: '0.5', unit: 'g/spot',
    note: 'rate-render: ~0.5 g per spot from the Syngenta label (EPA 100-1484, EPA PPLS 000100-01484-20200626.pdf): spots of about 0.5 g, 1-3 spots/10 linear ft light-moderate, 3-5 heavy.' },
  { name: 'Advion Evolution Cockroach Gel Bait', basis: 'display', method: 'bait_placement', rate: '0.5', unit: 'g/spot',
    note: 'rate-render: ~0.5 g per spot from the Syngenta Advion Evolution specimen label (EPA 100-1484): spots of about 0.5 g, 1-3 spots/10 linear ft light-moderate, 3-5 heavy.' },
  { name: 'Vendetta Plus', basis: 'display', method: 'bait_placement', rate: '0.25-0.5', unit: 'g/spot',
    note: 'rate-render: 0.25-0.5 g per bait point from the MGK label (EPA 1021-2593, EPA PPLS 001021-02593-20200319.pdf): 4-6 points/100 sq ft light, 12-24 heavy.' },

  // ── Structural dilutions: per gallon of finished mix ────────────────
  { name: 'Adjourn SC', basis: 'display', rate: '0.25-1.5', unit: 'fl_oz/gal',
    note: 'rate-render: 0.25-1.5 fl oz per gallon of water from the Atticus Adjourn SC specimen label (EPA 91234-243): 0.25 fl oz/gal (0.01%) maintenance up to 1.5 fl oz/gal (0.06%).' },
  { name: 'Tekko Trio', basis: 'display', rate: '0.5-1', unit: 'fl_oz/gal',
    note: 'rate-render: 0.5-1 fl oz per gallon of water from the Control Solutions Tekko Trio concentrate specimen label (EPA 53883-444), applied at 1 gal finished spray per 1,000-1,500 sq ft.' },
  // Tim-bor and Bora-Care seed application_method spot_treatment (codex
  // P1 r10): both are surface treatments applied to wood members, and a
  // methodless termite-line product otherwise defaults to station_check —
  // an internally contradictory record next to a lb/gal dilution rate.
  { name: 'Tim-bor Professional Insecticide and Fungicide', basis: 'display', method: 'spot_treatment', rate: '1-1.5', unit: 'lb/gal',
    note: 'rate-render: 1 lb per gallon of water (10% solution, two coats) or 1.5 lb/gal (15%, one coat) from the Nisus Tim-bor Professional specimen label (EPA 64405-8).' },
  { name: 'Bora-Care', basis: 'display', method: 'spot_treatment', rate: '1', unit: 'gal/gal',
    note: 'rate-render: 1:1 dilution — 1 gal Bora-Care per 1 gal water for remedial/preventative termite treatments per the Nisus label (EPA 64405-1, EPA PPLS 064405-00001-20210518.pdf).' },

  // ── Ornamental sprays: per 100 gallons of spray dilution ────────────
  // Avid, Floramite (both SKUs), Forbid 4F, Hexygon IQ, Kontos, and Zylam
  // are deliberately NOT seeded (codex P1, PR #3419 r6): the catalog
  // classifies them as Tree & Shrub / ornamental-only products, and the
  // global name-only picker would prefill their ornamental dilution rates
  // as lawn broadcast applications on lawn completions. They need the same
  // service/site gate (owner ruling) as the other withheld entries before
  // any of them can carry a default rate. Their verified label rates stay
  // recorded here for that follow-up: Avid 4-8 fl_oz/100gal (EPA 100-896) ·
  // Floramite 4-8 fl_oz/100gal (EPA 70506-537) · Forbid 4F 1-4 fl_oz/100gal
  // (EPA 432-1279) · Hexygon IQ 4-8 oz/100gal, fl_oz per the 20260712
  // verified entry (EPA 10163-365) · Kontos 1.7-3.4 fl_oz/100gal (EPA
  // 432-1471-59807) · Zylam 7.25-16 fl_oz/100gal (EPA 2217-937).
  // ADORN is deliberately NOT seeded (codex P1 r3): its current label has
  // ORNAMENTAL sites only — no turfgrass directions — and a global catalog
  // rate would prefill as a normal broadcast on lawn closeouts through the
  // name-only picker. Needs a site/context gate (owner ruling) first.
  // ── Trunk injections: per inch DBH / per palm ───────────────────────
  { name: 'Arborjet Ima-Jet 10', basis: 'display', method: 'trunk_injection', rate: '1-6', unit: 'ml/inch dbh',
    note: 'rate-render: 1.0-2.0 mL/inch DBH low rate up to 3.0-6.0 mL/inch for larger trees or heavier pressure from the IMA-jet 10 label (EPA 74578-6).' },
  { name: 'Arborjet Ima-Jet Systemic Insecticide', basis: 'display', method: 'trunk_injection', rate: '2-8', unit: 'ml/inch dbh',
    note: 'rate-render: 2.0-4.0 mL/inch DBH (aphids/scales) up to 4.0-8.0 mL/inch (borers/EAB) from the IMA-jet label (EPA 74578-1).' },
  { name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', basis: 'display', method: 'trunk_injection', rate: '3.5-7', unit: 'ml/inch dbh',
    note: 'rate-render: 3.5-7.0 mL per inch DBH from the PHOSPHO-jet label (EPA 74578-3): 3.5 for trees <12" DBH, up to 7.0 for larger trees.' },
  { name: 'Arborjet Propizol Injectable Fungicide', basis: 'display', method: 'trunk_injection', rate: '10-20', unit: 'ml/inch dbh',
    note: 'rate-render: 10 mL/inch DBH low rate to 20 mL/inch high rate from the Propizol micro-injection use rate table (EPA 74578-8).' },
  { name: 'ArborJet Mn-Jet Fe Micros', basis: 'display', method: 'trunk_injection', rate: '5-15', unit: 'ml/inch dbh',
    note: 'rate-render: 5 mL/inch DBH low rate; 10-15 mL/inch high rate (late summer/fall) from the Arborjet Mn-jet Fe label insert.' },
  { name: 'Arborjet Palm-Jet Palm Nutrition', basis: 'display', method: 'trunk_injection', rate: '5-30', unit: 'ml/palm',
    note: 'rate-render: 5-10 mL small palms, 10-20 mL medium, 20-30 mL large from the PALM-jet Mg palm rates table (arborjet.com label).' },
  { name: 'Arborjet Arbor OTC Fungicide 1 oz', basis: 'display', method: 'trunk_injection', rate: '0.28', unit: 'g/inch dbh',
    note: 'rate-render: 0.28 g product per inch DBH — the label mixing table dissolves 2.8 g (0.1 oz) in 25 mL water to treat 10 DBH inches (Arbor-OTC label, EPA 74578-7).' },
  { name: 'Arborjet Arbor OTC Fungicide 5 oz', basis: 'display', method: 'trunk_injection', rate: '0.28', unit: 'g/inch dbh',
    note: 'rate-render: 0.28 g product per inch DBH — the label mixing table dissolves 2.8 g (0.1 oz) in 25 mL water to treat 10 DBH inches (Arbor-OTC label, EPA 74578-7).' },
  // Shortstop 2SC is deliberately NOT seeded (codex P1, PR #3419 r6): its
  // label expresses the dose in grams of ACTIVE INGREDIENT per inch DBH
  // (0.75-4 g a.i./inch, EPA 62097-34), but the catalog product is a liquid
  // packaged by the gallon — a g-based rate defaults the amount unit to a
  // weight the inventory unit can't convert, and the compliance quantity
  // would describe a.i. rather than product applied. Needs the label's
  // concentrate-VOLUME dosage (or a separate a.i.-rate representation)
  // before it can carry a default.

  // ── Per-acre broadcast (fractional-ounce turf products) ─────────────
  { name: 'Certainty Turf Herbicide', basis: 'display', rate: '1.25-2', unit: 'oz/acre',
    note: 'rate-render: 1.25 oz/acre sedge control (sequential allowed), up to 2 oz/acre per the Certainty label (EPA 524-534).' },
  { name: 'Manor', basis: 'display', rate: '0.25-1', unit: 'oz/acre',
    note: 'rate-render: 0.25-1.0 oz/acre on St. Augustinegrass/bermudagrass/zoysiagrass from the label (EPA 228-373, EPA PPLS 000228-00373-20101118.pdf).' },
  { name: 'QP MSM 60DF Turf Herbicide', basis: 'display', rate: '0.25-1', unit: 'oz/acre',
    note: 'rate-render: 0.25-1.0 oz/acre on St. Augustinegrass/bermudagrass/zoysiagrass from the Quali-Pro MSM Turf label (EPA 66222-146-73220).' },
  { name: 'Monument 75WG', basis: 'display', rate: '0.35-0.53', unit: 'oz/acre',
    note: 'rate-render: 0.35-0.53 oz/acre (10-15 g, 2-3 packets) in 1-2 gal water per 1,000 sq ft from the Syngenta Monument 75WG label (EPA 100-1134).' },
  { name: 'Envu Specticle Flo Pre-Emergent Liquid Herbicide', basis: 'display', rate: '6', unit: 'fl_oz/acre',
    note: 'rate-render: 6 fl oz/acre maximum single application on St. Augustinegrass and centipedegrass (10 on bermuda/zoysia) from the Envu Specticle FLO label (EPA 101563-207).' },
  // Tenacity is deliberately NOT seeded (codex P1 r3): its label limits
  // St. Augustinegrass to sod-farm use, and a global catalog rate would
  // prefill on residential St. Augustine closeouts through the name-only
  // picker. Needs a turf/site gate (owner ruling) first.
  // Fusilade II is deliberately NOT seeded (codex P1, PR #3419): the label
  // says "Not for use on home lawns", standalone use here is beds/non-crop,
  // and the sanctioned St. Augustine bermuda-suppression program runs it as
  // a Recognition tank mix at a different rate
  // (20260808000001_fix_bermuda_protocol_kb_seed_product.js). A global
  // catalog rate would prefill on residential lawn closeouts. Needs a
  // site/context gate (owner ruling) before it can carry a default rate.
  // Talus 70 DF is deliberately NOT seeded (codex P1 r4): its label covers
  // ornamental/nursery/landscape sites, and a global per-acre rate would
  // prefill as a normal turf application on lawn closeouts through the
  // name-only picker. Needs a service/site gate (owner ruling) first.
  { name: 'BRANDT Agra Sol Micro Mix', basis: 'display', rate: '3-9', unit: 'lb/acre',
    note: 'rate-render: 3-9 lb/acre turf maintenance in minimum 88 gal water/acre (or watered in) from the BRANDT Agra Sol Micro Mix specimen label.' },
  { name: 'LESCO 6-0-0 Liquid', basis: 'display', rate: '1', unit: 'gal/acre',
    note: 'rate-render: 1 gal/acre per application (light/sandy soils, 4-6 applications at 8-12 week intervals) from the SiteOne label PDF cited in the prior note.' },

  // ── Ornamental-bed fertilizers: pounds per 100 sq ft of bed ─────────
  // The lb/100sf ornamental-bed fertilizers are deliberately NOT seeded
  // (codex P1, PR #3419 r7): the catalog classifies them as Tree & Shrub /
  // ornamental products, defaultApplicationMethodForLine classifies a
  // granular fertilizer as granular_broadcast, and the global name-only
  // picker would present their per-100-sq-ft BED rates as normal lawn
  // prefills on lawn completions. They need the same service/site gate
  // (owner ruling) as the other withheld entries before any of them can
  // carry a default rate. Their verified label rates stay recorded here
  // for that follow-up: LESCO 13-24-6 Landscape Starter 1 lb/100sf
  // (SiteOne item 510018) · LESCO 13-0-13 60% PolyPlus Landscape 1-1.5
  // lb/100sf (SiteOne item 510245WB) · LESCO 8-0-10 100% PolyPlus
  // Landscape, 8-0-10 50% PolyPlus OPTI45 Spar-TECH, and 8-0-10 Palm &
  // Tropical 1-1.5 lb/100sf (LESCO 8-0-10 Palm & Tropical label) · LESCO
  // 8-2-12 100% Poly Plus OPTI Kieserite 1-1.5 lb/100sf (LESCO 8-2-12
  // Palm & Tropical label) · Espoma Organic Alfalfa Meal 2-0-2 5 lb/100sf
  // new beds (espoma.com label directions).

  // ── Diluted supplements: per gallon of water ────────────────────────
  { name: 'SUPERthrive Foliage-Pro 9-3-6', basis: 'display', rate: '1.25-5', unit: 'ml/gal',
    note: 'rate-render: 1/4 tsp (1.25 mL)/gal maintenance with each watering up to 1 tsp (5 mL)/gal weekly production feeding from the Dyna-Gro Foliage-Pro 9-3-6 product data sheet.' },
  { name: 'Bloom City Clean Kelp', basis: 'display', rate: '5-10', unit: 'ml/gal',
    note: 'rate-render: 5-10 mL/gal grow phase, 5 mL/gal bloom, from the Bloom City Clean Kelp instructions (bloom.city).' },
  { name: 'Endurant PR Turf Colorant', basis: 'display', rate: '8', unit: 'fl_oz/gal',
    note: 'rate-render: 8 fl oz (236 mL) per gallon of water (15:1, do not dilute beyond) from the Geoponics Endurant PR directions.' },

  // ── Water-surface larvicides and stations ───────────────────────────
  // Larvicide placements and stations seed their placement method (codex
  // P1 r10): methodless mosquito-line products otherwise default to
  // fog_ulv, recording tablets placed in standing water (and physical
  // stations) as fogging applications.
  { name: 'Altosid 30 Day Briquets', basis: 'display', method: 'spot_treatment', rate: '1', unit: 'each/100sf',
    note: 'rate-render: 1 briquet per 100 sq ft of standing-water surface (up to 2 ft deep; add 1 per additional 2 ft depth) from the Altosid Briquets label (EPA 2724-375).' },
  { name: 'Summit Mosquito Dunk Tablets', basis: 'display', method: 'spot_treatment', rate: '1', unit: 'each/100sf',
    note: 'rate-render: 1 dunk per up to 100 sq ft of water surface regardless of depth (fractional dunks for smaller sites) from the Summit Mosquito Dunks label (EPA 6218-47).' },
  { name: 'In2Care Mosquito Station', basis: 'display', method: 'station_check', rate: '10-15', unit: 'each/acre',
    note: 'rate-render: at least 1 station per 4,300 sq ft — at least 10 and not more than 15 stations per acre — from the In2Care label (EPA 91720-1, EPA PPLS 091720-00001-20220630.pdf).' },
  { name: 'Advance Termite Bait Station', basis: 'display', rate: '1', unit: 'each/20ft',
    note: 'rate-render: stations installed so the interval between any two does not exceed 20 ft (10-20 ft practice) per the Advance Termite Bait System label cited in the prior note.' },
  { name: 'Trelona ATBS Bait Station', basis: 'display', rate: '1', unit: 'each/20ft',
    note: 'rate-render: stations installed so the maximum interval between any two does not exceed 20 ft per the Trelona ATBS label (EPA 499-557, EPA PPLS 000499-00557-20190909.pdf).' },
  { name: 'Trelona Compressed Termite Bait Cartridges', basis: 'display', rate: '2', unit: 'each/station',
    note: 'rate-render: 2 cartridges (two 124 g) per station, REQUIRED in Florida for annual service — the only interval this operation runs — per the Trelona label (EPA 499-557); 90/120-day service intervals use 1, adjust down only for those.' },
  // Contrac Blox seeds bait_placement (codex P1 r11): its catalog
  // category is rodenticide, so a pest-line completion otherwise falls
  // through to perimeter_spray — a spray method (demanding irrelevant
  // linear footage) on a tamper-resistant station bait.
  { name: 'Contrac Blox', basis: 'display', method: 'bait_placement', rate: '1-16', unit: 'each/placement',
    note: 'rate-render: mice 1 blox per placement (8-12 ft apart); rats 3-16 blox per placement (15-30 ft apart) from the Contrac Blox label (EPA 12455-79, EPA PPLS 012455-00079-20200213.pdf). Band low end is the mouse rate so the prefill is safe for either species; adjust up for rat placements.' },

  // ── Bed bug barrier ─────────────────────────────────────────────────
  { name: 'Aprehend', basis: 'display', rate: '0.5', unit: 'fl_oz/50ft',
    note: 'rate-render: ~0.5 fl oz per 50 linear ft applied as a continuous 2-inch barrier swath at ~1 ft/second from the Aprehend label (EPA 89186-1, EPA PPLS 089186-00001-20180620.pdf).' },

  // ── Per-1,000 sq ft rates the earlier passes did not cover ──────────
  { name: 'Talstar XTRA Granular Insecticide (Verge)', basis: 'per_1000_sqft', rate: null, min: 2.3, max: 4.6, unit: 'lb',
    note: 'rate-render: broadcast 2.3 lb/1,000 sq ft for most pests, up to 4.6 lb/1,000 sq ft for harder-to-control pests (fire ants, mole crickets) from the FMC Talstar XTRA (Verge) specimen label (EPA 279-9552).' },
  { name: '46-0-0 Urea Professional Fertilizer', basis: 'per_1000_sqft', rate: 2.17, min: 1.09, max: 3.26, unit: 'lb',
    note: 'rate-render: 2.17 lb product/1,000 sq ft delivers 1 lb N (label table spans 0.5-1.5 lb N) from the Mears/Thrive 46-0-0 granular urea label (labelsds specimen).' },
  { name: 'LESCO 17-0-10 50% CRN Mini Granular', basis: 'per_1000_sqft', rate: 5.9, min: null, max: null, unit: 'lb',
    note: 'rate-render: 50 lb covers ~8,500 sq ft at 1 lb N (5.90 lb product) per 1,000 sq ft from the LESCO 17-0-10 Mini label (SiteOne item 511551).' },
  { name: 'The Andersons Humic DG', basis: 'per_1000_sqft', rate: 2, min: 1, max: 4, unit: 'lb',
    note: 'rate-render: 1-4 lb/1,000 sq ft (medium rate 2 lb; 4 lb for clay/compacted soils) from The Andersons Humic DG product directions.' },
  { name: 'LESCO Tracker Green Spray Indicator Dye', basis: 'per_1000_sqft', rate: null, min: 0.2, max: 0.4, unit: 'fl_oz',
    note: 'rate-render: add to the spray tank at 0.2-0.4 oz per 1,000 sq ft (8-16 oz/acre) from the LESCO Tracker Green label (SiteOne label PDF).' },
  { name: 'LESCO-Wet Plus Nonionic Wetting Agent', basis: 'per_1000_sqft', rate: 4, min: 1, max: 8, unit: 'fl_oz',
    note: 'rate-render: initial application 4-8 oz/1,000 sq ft; monthly maintenance 1-4 oz/1,000 sq ft, from the LESCO-Wet Plus label (SiteOne, Exacto #113575).' },
  { name: 'LESCO T-Storm 2G Fungicide', basis: 'per_1000_sqft', rate: null, min: 1.5, max: 3, unit: 'lb',
    note: 'rate-render: 1.5-6 lb/1,000 sq ft disease band, with the residential/public per-treatment cap at 131 lb/A (3 lb/1,000 sq ft), from the LESCO T-Storm 2G label (EPA 228-631-10404 / distributor 79676-18-10404).' },
  // LESCO Manicure 6FL is deliberately NOT seeded (codex P1, PR #3419): its
  // label prohibits home lawns, and a global per-1,000 catalog rate would
  // prefill as a normal broadcast application on residential lawn
  // closeouts. Needs a site restriction (owner ruling) before it can carry
  // a default rate.
  { name: 'Gravex 20 EW', basis: 'per_1000_sqft', rate: 1.2, min: 1.2, max: 1.2, unit: 'fl_oz',
    note: 'rate-render: residential turfgrass is a flat 1.2 fl oz/1,000 sq ft for all listed diseases (max 1.2/application, 13.8/year; non-residential turf allows 0.5-2.4) from the Atticus Gravex 20 EW specimen label (EPA 91234-283).' },
  // T-Nex max is the CONSERVATIVE St. Augustine ceiling (codex P1 r16):
  // the label allows zoysiagrass up to 0.25, but seeding that as the
  // catalog max would let 0.16-0.25 pass the high-rate check on the
  // dominant local turf as if label-compliant. Raising it for zoysia
  // belongs to the operating-layer grass-type gate (owner follow-up).
  { name: 'Quali-Pro T-Nex Plant Growth Regulator', basis: 'per_1000_sqft', rate: null, min: 0.1, max: 0.15, unit: 'fl_oz',
    note: 'rate-render: St. Augustinegrass 0.10-0.15 fl oz/1,000 sq ft — catalog max is the conservative St. Augustine ceiling; zoysiagrass alone permits 0.25 (annual max 7.0 fl oz/1,000 sq ft) per the Control Solutions T-Nex specimen label (EPA 53883-353).' },
  // Badge SC Bactericide/Fungicide is deliberately NOT seeded (codex P1,
  // PR #3419 r5): the catalog classifies it as an ornamental/tree-and-shrub
  // fungicide (server/data/pricing.csv), so a global per-1,000 default drawn
  // from the label's turfgrass-ALGAE table (1.47-2.2 fl oz/1,000 sq ft, EPA
  // 80289-3-10163) would prefill a turf-algae rate onto ornamental
  // applications. Needs a service/site gate (owner ruling) before it can
  // carry a default rate.
];

function emptyText(v) { return v == null || String(v).trim() === '' || String(v).trim().toUpperCase() === 'N/A'; }

// The appended provenance segment records EXACTLY which fields this
// migration filled on that row — "note text [wrote: default_rate,
// default_unit]" — so down() reverts only migration-owned fields. Without
// the marker, a preexisting value that merely equals the backfill value
// (up() skipped it as fill-only) would be deleted on rollback.
//
// default_unit is the one field up() may OVERWRITE rather than fill (a
// unit-only placeholder like the inventory form's 'oz'); its token then
// carries the replaced value — "default_unit(was=oz)" — so down() can
// RESTORE the pre-migration unit instead of clearing it (codex P2 r7).
function appendedNote(note, wroteFields, priorValues = {}) {
  const tokens = wroteFields.map((f) => {
    const prior = priorValues[f];
    // A prior value containing the token delimiters can't be encoded —
    // fall back to the plain token (down() then reverts to null, the
    // pre-annotation behavior). No real unit contains ',' or ')'.
    return prior != null && !/[,)\]]/.test(String(prior)) ? `${f}(was=${prior})` : f;
  });
  return `${note} [wrote: ${tokens.join(', ')}]`;
}

// Returns [{ field, was, token }] parsed from OUR provenance segment on
// this row, or null when the row carries no segment for this entry (up()
// wrote nothing here). The segment is only recognized in the positions
// up() leaves it: as the whole note, or as the final " | "-appended
// segment. `was` is the replaced pre-migration value when the token
// carries one, else null (the field was empty before up()).
function ownedFields(labelSourceNote, note) {
  const s = String(labelSourceNote || '');
  const m = s.match(/ \[wrote: ([^\]]*)\]$/);
  if (!m) return null;
  const segment = `${note} [wrote: ${m[1]}]`;
  if (s !== segment && !s.endsWith(` | ${segment}`)) return null;
  return m[1].split(',').map((t) => t.trim()).filter(Boolean).map((token) => {
    const annotated = token.match(/^([a-z0-9_]+)\(was=(.*)\)$/);
    return annotated
      ? { field: annotated[1], was: annotated[2], token }
      : { field: token, was: null, token };
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const hasMethodCol = await knex.schema.hasColumn('products_catalog', 'application_method');

  for (const d of DATA) {
    const row = await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [d.name])
      .first();
    if (!row) continue;
    const updates = {};
    // Pre-migration values of fields up() OVERWRITES (vs fills) — encoded
    // into the provenance token so down() restores them (codex P2 r7).
    const priorValues = {};
    if (d.basis === 'display') {
      // Atomic pair: write both only when the rate is empty; replace a
      // unit-only placeholder with the label unit; never touch a row that
      // already carries a rate (see header).
      if (emptyText(row.default_rate)) {
        updates.default_rate = d.rate;
        if (row.default_unit !== d.unit) {
          updates.default_unit = d.unit;
          if (!emptyText(row.default_unit)) priorValues.default_unit = row.default_unit;
        }
      }
    } else if (d.basis === 'per_1000_sqft') {
      const rate = d.rate != null ? d.rate : d.min;
      const max = d.max != null ? d.max : (d.rate != null && d.min == null ? d.rate : null);
      if (rate != null && row.default_rate_per_1000 == null) updates.default_rate_per_1000 = rate;
      if (d.min != null && row.min_label_rate_per_1000 == null) updates.min_label_rate_per_1000 = d.min;
      if (max != null && row.max_label_rate_per_1000 == null) updates.max_label_rate_per_1000 = max;
      if (d.unit && emptyText(row.rate_unit)) updates.rate_unit = d.unit;
      // A unit-only placeholder ('oz' from the inventory create form)
      // would caption the new per-1,000 rate in the wrong unit — the
      // completion prefill reads default_unit before rate_unit — so
      // replace it with the verified unit (codex P1 r4). Rows with a
      // preexisting default_rate keep their display pair untouched.
      if (d.unit && emptyText(row.default_rate) && !emptyText(row.default_unit) && row.default_unit !== d.unit) {
        updates.default_unit = d.unit;
        priorValues.default_unit = row.default_unit;
      }
    }
    if (d.method && hasMethodCol && emptyText(row.application_method)) {
      updates.application_method = d.method;
    }
    const wroteFields = Object.keys(updates);
    if (wroteFields.length && d.note && !String(row.label_source_note || '').includes(d.note)) {
      if (emptyText(row.label_source_note)) {
        updates.label_source_note = appendedNote(d.note, wroteFields, priorValues);
      } else {
        // The earlier batch's note (with its verbatim label quote) stays;
        // the values written above get their own appended provenance.
        updates.label_source_note = `${row.label_source_note} | ${appendedNote(d.note, wroteFields, priorValues)}`;
      }
    }
    // Stamp only rows this migration actually wrote to.
    if (wroteFields.length && row.label_verified_at == null) {
      updates.label_verified_at = new Date();
      updates.label_verified_by = VERIFIED_BY;
    }
    if (Object.keys(updates).length) {
      await knex('products_catalog')
        .where({ id: row.id })
        .update({ ...updates, updated_at: new Date() });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const d of DATA) {
    const row = await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [d.name])
      .first();
    if (!row) continue;
    // Only fields named in OUR provenance segment are candidates — a
    // preexisting value that merely equals the backfill value was never
    // written by up() and must survive rollback.
    const owned = ownedFields(row.label_source_note, d.note);
    if (!owned) continue;
    const rate = d.rate != null ? d.rate : d.min;
    const max = d.max != null ? d.max : (d.rate != null && d.min == null ? d.rate : null);
    const valueUnchanged = (field) => {
      if (field === 'default_rate') return row.default_rate === d.rate;
      if (field === 'default_unit') return row.default_unit === d.unit;
      if (field === 'default_rate_per_1000') return rate != null && Number(row.default_rate_per_1000) === Number(rate);
      if (field === 'min_label_rate_per_1000') return d.min != null && Number(row.min_label_rate_per_1000) === Number(d.min);
      if (field === 'max_label_rate_per_1000') return max != null && Number(row.max_label_rate_per_1000) === Number(max);
      if (field === 'rate_unit') return row.rate_unit === d.unit;
      if (field === 'application_method') return d.method != null && row.application_method === d.method;
      return false;
    };
    // The written fields are one label-verified group: a rate is only
    // meaningful in its unit and vice versa, so once an admin edits ANY
    // member the whole group becomes admin-owned and rollback leaves it
    // (and its provenance) standing — reverting just the untouched member
    // would orphan the edited one (codex P2 r4: an edited gel rate must
    // not lose its g/spot unit on rollback).
    if (!owned.every((o) => valueUnchanged(o.field))) continue;
    const reverts = {};
    // A field up() OVERWROTE (annotated token) reverts to the recorded
    // pre-migration value — clearing it would lose e.g. the inventory
    // form's 'oz' placeholder (codex P2 r7). Filled fields revert to null.
    for (const o of owned) reverts[o.field] = o.was;
    const segment = `${d.note} [wrote: ${owned.map((o) => o.token).join(', ')}]`;
    if (row.label_source_note === segment) {
      reverts.label_source_note = null;
    } else if (String(row.label_source_note || '').endsWith(` | ${segment}`)) {
      reverts.label_source_note = row.label_source_note.slice(0, -(` | ${segment}`.length));
    }
    if (row.label_verified_by === VERIFIED_BY) {
      reverts.label_verified_at = null;
      reverts.label_verified_by = null;
    }
    await knex('products_catalog')
      .where({ id: row.id })
      .update({ ...reverts, updated_at: new Date() });
  }
};

// Test-only exports (knex reads only up/down).
exports._test = { DATA, VERIFIED_BY, appendedNote, ownedFields, emptyText };
