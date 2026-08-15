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
//   "ml/inch dbh", "oz/acre", "lb/100sf", "each/20ft").
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
// reverts only the fields named there, and only while their value is still
// exactly what up() wrote — preexisting equal values and later admin edits
// both survive rollback.

const VERIFIED_BY = 'rate-render-backfill-2026-08-14';

const DATA = [
  // ── Gel baits: grams per spot placement ─────────────────────────────
  { name: 'Advion Ant Bait Gel', basis: 'display', rate: '0.1-1', unit: 'g/spot',
    note: 'rate-render: 0.1-1 g per spot from the Syngenta label (EPA 100-1498, EPA PPLS 000100-01498-20200417.pdf): "Apply 0.1 to 1.0 gram spots" to active trails/nest sites.' },
  { name: 'Advion Cockroach Gel Bait', basis: 'display', rate: '0.5', unit: 'g/spot',
    note: 'rate-render: ~0.5 g per spot from the Syngenta label (EPA 100-1484, EPA PPLS 000100-01484-20200626.pdf): spots of about 0.5 g, 1-3 spots/10 linear ft light-moderate, 3-5 heavy.' },
  { name: 'Advion Evolution Cockroach Gel Bait', basis: 'display', rate: '0.5', unit: 'g/spot',
    note: 'rate-render: ~0.5 g per spot from the Syngenta Advion Evolution specimen label (EPA 100-1484): spots of about 0.5 g, 1-3 spots/10 linear ft light-moderate, 3-5 heavy.' },
  { name: 'Vendetta Plus', basis: 'display', rate: '0.25-0.5', unit: 'g/spot',
    note: 'rate-render: 0.25-0.5 g per bait point from the MGK label (EPA 1021-2593, EPA PPLS 001021-02593-20200319.pdf): 4-6 points/100 sq ft light, 12-24 heavy.' },

  // ── Structural dilutions: per gallon of finished mix ────────────────
  { name: 'Adjourn SC', basis: 'display', rate: '0.25-1.5', unit: 'fl_oz/gal',
    note: 'rate-render: 0.25-1.5 fl oz per gallon of water from the Atticus Adjourn SC specimen label (EPA 91234-243): 0.25 fl oz/gal (0.01%) maintenance up to 1.5 fl oz/gal (0.06%).' },
  { name: 'Tekko Trio', basis: 'display', rate: '0.5-1', unit: 'fl_oz/gal',
    note: 'rate-render: 0.5-1 fl oz per gallon of water from the Control Solutions Tekko Trio concentrate specimen label (EPA 53883-444), applied at 1 gal finished spray per 1,000-1,500 sq ft.' },
  { name: 'Tim-bor Professional Insecticide and Fungicide', basis: 'display', rate: '1-1.5', unit: 'lb/gal',
    note: 'rate-render: 1 lb per gallon of water (10% solution, two coats) or 1.5 lb/gal (15%, one coat) from the Nisus Tim-bor Professional specimen label (EPA 64405-8).' },
  { name: 'Bora-Care', basis: 'display', rate: '1', unit: 'gal/gal',
    note: 'rate-render: 1:1 dilution — 1 gal Bora-Care per 1 gal water for remedial/preventative termite treatments per the Nisus label (EPA 64405-1, EPA PPLS 064405-00001-20210518.pdf).' },

  // ── Ornamental sprays: per 100 gallons of spray dilution ────────────
  { name: 'Avid Insecticide', basis: 'display', rate: '4-8', unit: 'fl_oz/100gal',
    note: 'rate-render: 4 fl oz/100 gal for mites, up to 8 fl oz/100 gal for leafminers per the label (EPA 100-896, EPA PPLS 000100-00896-20111220.pdf).' },
  { name: 'Floramite Miticide 1 qt', basis: 'display', rate: '4-8', unit: 'fl_oz/100gal',
    note: 'rate-render: 4-8 fl oz/100 gal of water from the Floramite SC label (EPA 70506-537, EPA PPLS 070506-00537-20240208.pdf): 4 preventative/light, up to 8 heavy.' },
  { name: 'Floramite SC/LS 8 oz', basis: 'display', rate: '4-8', unit: 'fl_oz/100gal',
    note: 'rate-render: 4-8 fl oz/100 gal of water from the Floramite SC label (EPA 70506-537, EPA PPLS 070506-00537-20240208.pdf): 4 preventative/light, up to 8 heavy.' },
  { name: 'Forbid 4F', basis: 'display', rate: '1-4', unit: 'fl_oz/100gal',
    note: 'rate-render: 1-4 fl oz/100 gal spray solution for spider mites from the label (EPA 432-1279, EPA PPLS 000432-01279-20070504.pdf).' },
  { name: 'Hexygon IQ Miticide', basis: 'display', rate: '4-8', unit: 'oz/100gal',
    note: 'rate-render: 4-8 oz/100 gal (or 12-24 oz/acre) for ornamental mites from the Gowan Hexygon label (EPA 10163-365).' },
  { name: 'Kontos Insecticide/Miticide', basis: 'display', rate: '1.7-3.4', unit: 'fl_oz/100gal',
    note: 'rate-render: 1.7-3.4 fl oz (50-100 mL) per 100 gal of water for ornamental foliar applications from the OHP Kontos specimen label (EPA 432-1471-59807).' },
  { name: 'Zylam Insecticide', basis: 'display', rate: '7.25-16', unit: 'fl_oz/100gal',
    note: 'rate-render: 7.25-16 fl oz/100 gal of water for foliar applications to landscape ornamentals from the PBI-Gordon Zylam Liquid specimen label (EPA 2217-937).' },
  { name: 'ADORN Fungicide', basis: 'display', rate: '1-4', unit: 'fl_oz/100gal',
    note: 'rate-render: 1-4 fl oz/100 gal on ornamental plants (foliar 2-4, drench 1-4; 100 gal treats ~20,000 sq ft) from the Adorn label (EPA 59639-141). Label lists ORNAMENTAL sites only — no turfgrass use directions.' },
  // ── Trunk injections: per inch DBH / per palm ───────────────────────
  { name: 'Arborjet Ima-Jet 10', basis: 'display', rate: '1-6', unit: 'ml/inch dbh',
    note: 'rate-render: 1.0-2.0 mL/inch DBH low rate up to 3.0-6.0 mL/inch for larger trees or heavier pressure from the IMA-jet 10 label (EPA 74578-6).' },
  { name: 'Arborjet Ima-Jet Systemic Insecticide', basis: 'display', rate: '2-8', unit: 'ml/inch dbh',
    note: 'rate-render: 2.0-4.0 mL/inch DBH (aphids/scales) up to 4.0-8.0 mL/inch (borers/EAB) from the IMA-jet label (EPA 74578-1).' },
  { name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', basis: 'display', rate: '3.5-7', unit: 'ml/inch dbh',
    note: 'rate-render: 3.5-7.0 mL per inch DBH from the PHOSPHO-jet label (EPA 74578-3): 3.5 for trees <12" DBH, up to 7.0 for larger trees.' },
  { name: 'Arborjet Propizol Injectable Fungicide', basis: 'display', rate: '10-20', unit: 'ml/inch dbh',
    note: 'rate-render: 10 mL/inch DBH low rate to 20 mL/inch high rate from the Propizol micro-injection use rate table (EPA 74578-8).' },
  { name: 'ArborJet Mn-Jet Fe Micros', basis: 'display', rate: '5-15', unit: 'ml/inch dbh',
    note: 'rate-render: 5 mL/inch DBH low rate; 10-15 mL/inch high rate (late summer/fall) from the Arborjet Mn-jet Fe label insert.' },
  { name: 'Arborjet Palm-Jet Palm Nutrition', basis: 'display', rate: '5-30', unit: 'ml/palm',
    note: 'rate-render: 5-10 mL small palms, 10-20 mL medium, 20-30 mL large from the PALM-jet Mg palm rates table (arborjet.com label).' },
  { name: 'Arborjet Arbor OTC Fungicide 1 oz', basis: 'display', rate: '0.28', unit: 'g/inch dbh',
    note: 'rate-render: 0.28 g product per inch DBH — the label mixing table dissolves 2.8 g (0.1 oz) in 25 mL water to treat 10 DBH inches (Arbor-OTC label, EPA 74578-7).' },
  { name: 'Arborjet Arbor OTC Fungicide 5 oz', basis: 'display', rate: '0.28', unit: 'g/inch dbh',
    note: 'rate-render: 0.28 g product per inch DBH — the label mixing table dissolves 2.8 g (0.1 oz) in 25 mL water to treat 10 DBH inches (Arbor-OTC label, EPA 74578-7).' },
  { name: 'Shortstop 2SC Plant Growth Regulator for Trees & Shrubs', basis: 'display', rate: '0.75-4', unit: 'g/inch dbh',
    note: 'rate-render: 0.75-4 g a.i. per inch trunk DBH (species-dependent tier; applied as a 1:11 diluted basal drench/soil injection; do not treat trees under 1.5 in DBH) from the Shortstop 2SC label (EPA 62097-34).' },

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
  { name: 'Tenacity Herbicide', basis: 'display', rate: '4-8', unit: 'fl_oz/acre',
    note: 'rate-render: 4-8 fl oz/acre postemergence from the Syngenta label (EPA 100-1267). The prior note\'s caution stands: St. Augustinegrass is sod-farm use only on this label.' },
  { name: 'Fusilade II Post Emergent Liquid Herbicide', basis: 'display', rate: '16-24', unit: 'fl_oz/acre',
    note: 'rate-render: 16-24 fl oz/acre is the LANDSCAPE/ORNAMENTAL-BED rate from the Syngenta label (EPA 100-1084); over-the-top turf use is Zoysia/fescue only at 3-6 fl oz/acre per the prior note.' },
  { name: 'Talus 70 DF IGR', basis: 'display', rate: '6-14', unit: 'oz/acre',
    note: 'rate-render: 6-14 oz/acre foliar on ornamentals, max 18 oz/acre per growing cycle, from the Talus 70DF specimen label (EPA 71711-21-67690).' },
  { name: 'BRANDT Agra Sol Micro Mix', basis: 'display', rate: '3-9', unit: 'lb/acre',
    note: 'rate-render: 3-9 lb/acre turf maintenance in minimum 88 gal water/acre (or watered in) from the BRANDT Agra Sol Micro Mix specimen label.' },
  { name: 'LESCO 6-0-0 Liquid', basis: 'display', rate: '1', unit: 'gal/acre',
    note: 'rate-render: 1 gal/acre per application (light/sandy soils, 4-6 applications at 8-12 week intervals) from the SiteOne label PDF cited in the prior note.' },

  // ── Ornamental-bed fertilizers: pounds per 100 sq ft of bed ─────────
  { name: 'LESCO 13-24-6 Landscape Starter', basis: 'display', rate: '1', unit: 'lb/100sf',
    note: 'rate-render: 1 lb per 100 sq ft of ornamental bed/flower bed/planting area, 2-4x per year, from the SiteOne label (item 510018).' },
  { name: 'LESCO 13-0-13 60% PolyPlus Landscape', basis: 'display', rate: '1-1.5', unit: 'lb/100sf',
    note: 'rate-render: 1-1.5 lb per 100 sq ft of bed area, 2x per year, from the LESCO Palm & Tropical Ornamental 13-0-13 label (SiteOne item 510245WB).' },
  { name: 'LESCO 8-0-10 100% PolyPlus Landscape', basis: 'display', rate: '1-1.5', unit: 'lb/100sf',
    note: 'rate-render: 1-1.5 lb per 100 sq ft to flower beds and planting areas (trees/large shrubs 0.5-1 lb per inch trunk diameter) from the LESCO 8-0-10 Palm & Tropical label cited in the prior note.' },
  { name: 'LESCO 8-0-10 50% PolyPlus OPTI45 Spar-TECH 1% Fe 1% Mg 1% Mn 0.1% B KMAG Palm & Tropical Ornamental Granular Fertilizer', basis: 'display', rate: '1-1.5', unit: 'lb/100sf',
    note: 'rate-render: 1-1.5 lb per 100 sq ft to flower beds and planting areas from the LESCO 8-0-10 Palm & Tropical label cited in the prior note.' },
  { name: 'LESCO 8-0-10 Palm & Tropical', basis: 'display', rate: '1-1.5', unit: 'lb/100sf',
    note: 'rate-render: 1-1.5 lb per 100 sq ft to flower beds and planting areas from the LESCO 8-0-10 Palm & Tropical label cited in the prior note.' },
  { name: 'LESCO 8-2-12 100% Poly Plus OPTI Kieserite 4% Mg 9.26% S 0.15% B 0.05% Cu 0.15% Fe 2% Mn 0.15% Zn Palm & Tropical Ornamental Granular Fertilizer', basis: 'display', rate: '1-1.5', unit: 'lb/100sf',
    note: 'rate-render: 1-1.5 lb per 100 sq ft to flower beds and planting areas from the LESCO 8-2-12 Palm & Tropical label cited in the prior note.' },
  { name: 'Espoma Organic Alfalfa Meal 2-0-2', basis: 'display', rate: '5', unit: 'lb/100sf',
    note: 'rate-render: 5 lb per 100 sq ft worked into the top 4 inches of soil (new beds; established plants 1/2-1 cup per plant) from the Espoma Alfalfa Meal label directions (espoma.com).' },

  // ── Diluted supplements: per gallon of water ────────────────────────
  { name: 'SUPERthrive Foliage-Pro 9-3-6', basis: 'display', rate: '1.25-5', unit: 'ml/gal',
    note: 'rate-render: 1/4 tsp (1.25 mL)/gal maintenance with each watering up to 1 tsp (5 mL)/gal weekly production feeding from the Dyna-Gro Foliage-Pro 9-3-6 product data sheet.' },
  { name: 'Bloom City Clean Kelp', basis: 'display', rate: '5-10', unit: 'ml/gal',
    note: 'rate-render: 5-10 mL/gal grow phase, 5 mL/gal bloom, from the Bloom City Clean Kelp instructions (bloom.city).' },
  { name: 'Endurant PR Turf Colorant', basis: 'display', rate: '8', unit: 'fl_oz/gal',
    note: 'rate-render: 8 fl oz (236 mL) per gallon of water (15:1, do not dilute beyond) from the Geoponics Endurant PR directions.' },

  // ── Water-surface larvicides and stations ───────────────────────────
  { name: 'Altosid 30 Day Briquets', basis: 'display', rate: '1', unit: 'each/100sf',
    note: 'rate-render: 1 briquet per 100 sq ft of standing-water surface (up to 2 ft deep; add 1 per additional 2 ft depth) from the Altosid Briquets label (EPA 2724-375).' },
  { name: 'Summit Mosquito Dunk Tablets', basis: 'display', rate: '1', unit: 'each/100sf',
    note: 'rate-render: 1 dunk per up to 100 sq ft of water surface regardless of depth (fractional dunks for smaller sites) from the Summit Mosquito Dunks label (EPA 6218-47).' },
  { name: 'In2Care Mosquito Station', basis: 'display', rate: '10-15', unit: 'each/acre',
    note: 'rate-render: at least 1 station per 4,300 sq ft — at least 10 and not more than 15 stations per acre — from the In2Care label (EPA 91720-1, EPA PPLS 091720-00001-20220630.pdf).' },
  { name: 'Advance Termite Bait Station', basis: 'display', rate: '1', unit: 'each/20ft',
    note: 'rate-render: stations installed so the interval between any two does not exceed 20 ft (10-20 ft practice) per the Advance Termite Bait System label cited in the prior note.' },
  { name: 'Trelona ATBS Bait Station', basis: 'display', rate: '1', unit: 'each/20ft',
    note: 'rate-render: stations installed so the maximum interval between any two does not exceed 20 ft per the Trelona ATBS label (EPA 499-557, EPA PPLS 000499-00557-20190909.pdf).' },
  { name: 'Trelona Compressed Termite Bait Cartridges', basis: 'display', rate: '1-2', unit: 'each/station',
    note: 'rate-render: 1 cartridge per station for 90/120-day service intervals; 2 cartridges (two 124 g, required in Florida for annual service) per the Trelona label (EPA 499-557).' },
  { name: 'Contrac Blox', basis: 'display', rate: '3-16', unit: 'each/placement',
    note: 'rate-render: rats 3-16 blox per placement spaced 15-30 ft apart (mice 1 per placement, 8-12 ft) from the Contrac Blox label (EPA 12455-79, EPA PPLS 012455-00079-20200213.pdf).' },

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
  { name: 'LESCO Manicure 6FL Contact Fungicide', basis: 'per_1000_sqft', rate: null, min: 2, max: 5.5, unit: 'fl_oz',
    note: 'rate-render: turf broadcast 5.5-9.75 pints/A (2-3.6 fl oz/1,000 sq ft) for dollar spot/brown patch/leaf spot, up to 15 pints/A (5.5 fl oz/1,000 sq ft) for red thread/anthracnose, from the Manicure 6FL turf label (EPA 60063-7-10404). The prior note\'s home-lawn prohibition stands — commercial/permitted turf sites only.' },
  { name: 'Gravex 20 EW', basis: 'per_1000_sqft', rate: 1.2, min: 1.2, max: 1.2, unit: 'fl_oz',
    note: 'rate-render: residential turfgrass is a flat 1.2 fl oz/1,000 sq ft for all listed diseases (max 1.2/application, 13.8/year; non-residential turf allows 0.5-2.4) from the Atticus Gravex 20 EW specimen label (EPA 91234-283).' },
  { name: 'Quali-Pro T-Nex Plant Growth Regulator', basis: 'per_1000_sqft', rate: null, min: 0.1, max: 0.25, unit: 'fl_oz',
    note: 'rate-render: St. Augustinegrass 0.10-0.15 fl oz/1,000 sq ft (zoysiagrass 0.25; annual max 7.0 fl oz/1,000 sq ft) from the Control Solutions T-Nex specimen label (EPA 53883-353).' },
  { name: 'Badge SC Bactericide/Fungicide', basis: 'per_1000_sqft', rate: null, min: 1.47, max: 2.2, unit: 'fl_oz',
    note: 'rate-render: turfgrass ALGAE control 4-6 pints/A (1.47-2.2 fl oz/1,000 sq ft, minimum 100 gal water/A) from the Gowan Badge SC turfgrass table (EPA 80289-3-10163) — algae is the label\'s only turf claim.' },
];

function emptyText(v) { return v == null || String(v).trim() === '' || String(v).trim().toUpperCase() === 'N/A'; }

// The appended provenance segment records EXACTLY which fields this
// migration filled on that row — "note text [wrote: default_rate,
// default_unit]" — so down() reverts only migration-owned fields. Without
// the marker, a preexisting value that merely equals the backfill value
// (up() skipped it as fill-only) would be deleted on rollback.
function appendedNote(note, wroteFields) {
  return `${note} [wrote: ${wroteFields.join(', ')}]`;
}

// Returns the field list from OUR provenance segment on this row, or null
// when the row carries no segment for this entry (up() wrote nothing here).
// The segment is only recognized in the positions up() leaves it: as the
// whole note, or as the final " | "-appended segment.
function ownedFields(labelSourceNote, note) {
  const s = String(labelSourceNote || '');
  const m = s.match(/ \[wrote: ([^\]]*)\]$/);
  if (!m) return null;
  const segment = `${note} [wrote: ${m[1]}]`;
  if (s !== segment && !s.endsWith(` | ${segment}`)) return null;
  return m[1].split(',').map((f) => f.trim()).filter(Boolean);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const d of DATA) {
    const row = await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [d.name])
      .first();
    if (!row) continue;
    const updates = {};
    if (d.basis === 'display') {
      if (emptyText(row.default_rate)) updates.default_rate = d.rate;
      if (emptyText(row.default_unit)) updates.default_unit = d.unit;
    } else if (d.basis === 'per_1000_sqft') {
      const rate = d.rate != null ? d.rate : d.min;
      const max = d.max != null ? d.max : (d.rate != null && d.min == null ? d.rate : null);
      if (rate != null && row.default_rate_per_1000 == null) updates.default_rate_per_1000 = rate;
      if (d.min != null && row.min_label_rate_per_1000 == null) updates.min_label_rate_per_1000 = d.min;
      if (max != null && row.max_label_rate_per_1000 == null) updates.max_label_rate_per_1000 = max;
      if (d.unit && emptyText(row.rate_unit)) updates.rate_unit = d.unit;
    }
    const wroteFields = Object.keys(updates);
    if (wroteFields.length && d.note && !String(row.label_source_note || '').includes(d.note)) {
      if (emptyText(row.label_source_note)) {
        updates.label_source_note = appendedNote(d.note, wroteFields);
      } else {
        // The earlier batch's note (with its verbatim label quote) stays;
        // the values written above get their own appended provenance.
        updates.label_source_note = `${row.label_source_note} | ${appendedNote(d.note, wroteFields)}`;
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
    const reverts = {};
    const rate = d.rate != null ? d.rate : d.min;
    const max = d.max != null ? d.max : (d.rate != null && d.min == null ? d.rate : null);
    for (const field of owned) {
      // Revert only if the value is still exactly what we wrote — an admin
      // edit since up() wins and stays.
      if (field === 'default_rate' && row.default_rate === d.rate) reverts.default_rate = null;
      if (field === 'default_unit' && row.default_unit === d.unit) reverts.default_unit = null;
       
      if (field === 'default_rate_per_1000' && rate != null && row.default_rate_per_1000 == rate) reverts.default_rate_per_1000 = null;
       
      if (field === 'min_label_rate_per_1000' && d.min != null && row.min_label_rate_per_1000 == d.min) reverts.min_label_rate_per_1000 = null;
       
      if (field === 'max_label_rate_per_1000' && max != null && row.max_label_rate_per_1000 == max) reverts.max_label_rate_per_1000 = null;
      if (field === 'rate_unit' && row.rate_unit === d.unit) reverts.rate_unit = null;
    }
    const segment = appendedNote(d.note, owned);
    if (row.label_source_note === segment) {
      reverts.label_source_note = null;
    } else if (String(row.label_source_note || '').endsWith(` | ${segment}`)) {
      reverts.label_source_note = row.label_source_note.slice(0, -(` | ${segment}`.length));
    }
    if (row.label_verified_by === VERIFIED_BY) {
      reverts.label_verified_at = null;
      reverts.label_verified_by = null;
    }
    if (Object.keys(reverts).length) {
      await knex('products_catalog')
        .where({ id: row.id })
        .update({ ...reverts, updated_at: new Date() });
    }
  }
};

// Test-only exports (knex reads only up/down).
exports._test = { DATA, VERIFIED_BY, appendedNote, ownedFields, emptyText };
