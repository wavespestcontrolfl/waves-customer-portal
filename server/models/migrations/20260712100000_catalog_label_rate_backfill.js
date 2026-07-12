// Label-rate backfill for the full products catalog (owner ask 2026-07-12:
// "do the label rates, make sure they are 100% accurate").
//
// Provenance: every entry below was extracted from the actual product label
// (manufacturer PDF, EPA PPLS stamped label, or SiteOne bag label for LESCO
// fertilizers) by a research pass, then independently re-verified by a
// second adversarial pass that re-opened the cited document and checked the
// quote, numbers, basis, unit, and EPA registration. 141 targets → 136
// verified entries; 5 skipped (2 discontinued LESCO SKUs with no
// authoritative label anywhere, 3 mechanical devices with no label rate).
// Zero entries are from memory or marketing copy. Each `note` carries the
// source URL and a verbatim label quote and is written to label_source_note.
//
// Write semantics (all fill-only-if-empty; admin edits always win):
// - basis "per_1000_sqft" → default_rate_per_1000 (label's named rate, else
//   the label's LOW rate), min/max_label_rate_per_1000, rate_unit.
// - basis "per_gallon" → legacy display fields default_rate ("X" or "X-Y")
//   + default_unit ("<unit>/gal"). NOT forced into per-1,000 semantics.
// - basis "other" (per acre / per 100 gal / per station / per inch DBH /
//   per bait point) → no rate fields; the label statement lives in
//   label_source_note. Fabricating a per-1,000 conversion would be wrong.
// - epa_reg_number filled where the DB had NULL/'N/A'.
// - label_verified_at/by stamped only where NULL. label_source_note written
//   where NULL; where an earlier batch's note exists and this migration adds
//   new data fields, our citation is APPENDED (" | ...") so the new values
//   carry provenance without erasing the earlier batch's.
//
// Six DB EPA registration numbers were proven WRONG against PPLS by both
// passes and are corrected explicitly (guarded on the old wrong value):
//   Bifen XTS 53883-219→53883-189 (219 = CSI IMI 0.3G, different product)
//   Scion 279-3624→279-3612 · Heritage G 100-1093→100-1323 (liquid Heritage)
//   Pillar G Intrinsic 7969-295→7969-304 · Vendetta Plus 1021-1828→1021-2593
//   LESCO Stonewall 0-0-7 10404-117→10404-89 (117 = Prosecutor Pro glyphosate)
//
// down() clears only values this migration wrote (exact-value match under
// its own label_verified_by stamp). Never reverted: the EPA and legacy-
// dilution CORRECTIONS (restoring a proven-wrong value is not a rollback)
// and ALL epa_reg_number fills (indistinguishable from pre-existing data,
// and 'N/A' is strictly less information than a verified registration).

const VERIFIED_BY = 'label-rate-backfill-2026-07-12';

const EPA_CORRECTIONS = [
  ['Bifen XTS', '53883-219', '53883-189'],
  ['Scion Insecticide', '279-3624', '279-3612'],
  ['Heritage G', '100-1093', '100-1323'],
  ['Pillar G Intrinsic', '7969-295', '7969-304'],
  ['Vendetta Plus', '1021-1828', '1021-2593'],
  ['LESCO Stonewall 0-0-7', '10404-117', '10404-89'],
];
// Rows whose reg number actually changes also get their audit note/stamps
// REPLACED (not fill-if-empty) — an older seed's note citing the wrong reg
// number must not survive next to the corrected value. up() tracks the
// applied set at runtime (epaApplied).

// Known-wrong legacy dilution defaults, replaced (guarded on the exact old
// seeded value): the 20260401000017 seed gave Alpine WSG "0.5 oz/gal", but
// the label states its rates in grams only (10-30 g per gallon); the same
// seed gave Demand CS a per-1k display default ("0.8 oz/1000sf") that
// contradicts its label's perimeter dilution table (0.2-0.8 fl oz per
// 1-5 gal of mix — see its DATA entry below).
const LEGACY_CORRECTIONS = [
  ['Alpine WSG', { default_rate: '0.5', default_unit: 'oz/gal' }, { default_rate: '10-30', default_unit: 'g/gal' }],
  ['Demand CS', { default_rate: '0.8', default_unit: 'oz/1000sf' }, { default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' }],
];

const DATA = [
  { name: "ADORN Fungicide", basis: "other", rate: null, min: 1, max: 4, unit: "fl_oz", epa: "59639-141",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/Adorn%20Label%201-25-22.pdf — \"Table 2. DIRECTIONS FOR USE ON ORNAMENTAL PLANTS ... Product Rates 1 to 4 fl oz per 100 gallons ... Foliar Application: Use between 2 to 4 fl oz/100 gallons for foliar applications ... Drench Application: Use between 1 t\"" },
  { name: "Acelepryn Insecticide", basis: "per_1000_sqft", rate: null, min: 0.05, max: 0.37, unit: "fl_oz", epa: "100-1489",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000100-01489-20240111.pdf — \"White Grubs, including Aphodius spp., Asiatic garden beetle, black turfgrass ataenius, European chafer, green June beetle, Japanese beetle, May/June beetles (Phyllophaga spp.), northern masked chafer, oriental beetle and\"" },
  { name: "Advance Termite Bait Station", basis: "other", rate: null, min: null, max: 20, unit: null, epa: "499-488",
    note: "distributor_label_pdf: https://waverlypc.com/wp-content/uploads/2025/06/Advance-Compressed-Termite-Bait.pdf — \"Install stations around a structure such that, except where sufficient access to the ground is not available, the maximum interval between any two stations does not exceed twenty feet. ... Install stations at, or prefera\"" },
  { name: "Advion Ant Bait Gel", basis: "other", rate: null, min: 0.1, max: 1.0, unit: "g", epa: "100-1498",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000100-01498-20200417.pdf — \"Apply Advion Ant Gel as spots of gel or small lines of gel. Placements of spots or lines of Advion Ant Gel should be to active foraging trails, nest sites, or to areas known to be active. Apply 0.1 to 1.0 gram spots of A\"" },
  { name: "Advion Cockroach Gel Bait", basis: "other", rate: 0.5, min: null, max: null, unit: "g", epa: "100-1484",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000100-01484-20200626.pdf — \"For heavy infestations of cockroaches, apply 3 to 5 spots of Advion Cockroach Gel Bait per 10 linear feet. For light to moderate infestations of cockroaches, apply 1-3 spots of Advion Cockroach Gel Bait per 10 linear fee\"" },
  { name: "Advion Evolution Cockroach Gel Bait", basis: "other", rate: 0.5, min: null, max: null, unit: "g", epa: "100-1484",
    note: "distributor_label_pdf: https://www.homeparamount.com/pdf/doc-advion-evolution-roach-gel-bait-label-1547736060.pdf — \"For heavy infestations of cockroaches, apply 3 to 5 spots of Advion Evolution Cockroach Gel Bait per 10 linear feet. For light to moderate infestations of cockroaches, apply 1-3 spots of Advion Evolution Cockroach Gel Ba\"" },
  { name: "Advion WDG Granular", basis: "per_1000_sqft", rate: null, min: 0.38, max: 4.6, unit: "lb", epa: "100-1483",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000100-01483-20191219.pdf — \"Apply Advion Insect Granular Bait at a rate of 0.38 to 4.6 lb product per 1000 sq ft. as a limited area treatment. Repeat application after 7 days, if necessary.\" | NOTE: NAME DISCREPANCY: the EPA-stamped master label (accepted 12/19/2019) calls itself 'ADVION INSECT GRANULE' with alternate brand names 'ADVION INSECT GRANULAR BAIT' and 'ADVION MOLE CRICKET BAIT' - it i" },
  { name: "Alpine WSG", basis: "per_gallon", rate: null, min: 10, max: 30, unit: "g", epa: "499-561",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000499-00561-20140812.pdf — \"Add 10 g to 30 g of product to water per 1,000 ft2 area being treated (1 T = 10 g), then complete the filling of the spray tank. ... One gallon of finished dilution treats 1,000 ft2. ... Exterior Structural and Surroundi\" | NOTE: EPA-stamped label (accepted 08/12/2014) for product 'TC-315' with Alpine WSG as accepted alternate brand name; Dinotefuran 40.0% confirmed. LABEL RATES ARE IN GRAMS PER GAL" },
  { name: "Altosid 30 Day Briquets", basis: "other", rate: 1, min: null, max: null, unit: null, epa: "2724-375",
    note: "distributor_label_pdf: https://agriculture.vermont.gov/sites/agriculture/files/doc_library/Mosquito%20Permits/OCW%20Mosquito%20Larvicide/2724-375-Altosid%20Briquets.pdf — \"In non- (or low-) flow shallow depressions (up to 2 ft in depth), treat on the basis of surface area placing 1 ALTOSID Briquet per 100 sq ft. ... Place 1 ALTOSID Briquet per 100 sq ft of surface area up to 2 feet deep fo\"" },
  { name: "Aprehend", basis: "other", rate: null, min: null, max: null, unit: "fl_oz", epa: "89186-1",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/089186-00001-20180620.pdf — \"Hold the applicator close to the surface to be treated and apply at a speed of approximately 1 foot per second making a continuous 2\" wide swath (barrier) of Aprehend. Resulting volume application will be approximately 0\"" },
  { name: "ArborJet Mn-Jet Fe Micros", basis: "other", rate: 5, min: 5, max: 15, unit: "ml", epa: null,
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/10/Mn-Jet-Fe_Insert-rev-8.2017_web.pdf — \"Multiply rate (for example, the early summer rate) of 5 mL / inch DBH by the inch DBH of the tree. If the tree is 10” in diameter, then the dose per tree is 5 mL x 10” or 50 mLs. ... MIXING AND DOSING RATES FOR TREE INJE\"" },
  { name: "ArborJet Tree-Age R10 Insecticide", basis: "other", rate: null, min: null, max: null, unit: "ml", epa: "74578-12",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/Tree-age%20R10%20Label%209-1-20.pdf — \"Dosages are based on the Diameter (in inches) of the tree at Breast Height (DBH\"). ... USE RATE TABLE (ml product/tree): 4-5\" DBH = Low 6, Medium 12, High 24; 10-11\" = Low 10, Medium 20, High 40; 20-21\" = Low 20, Medium \" | NOTE: RESTRICTED USE PESTICIDE. Label EPA Reg No. 74578-12. Emamectin benzoate 9.7% (0.791 lb/gal) — the concentrated 'reduced-dose' Tree-age. Per-tree TABLE keyed" },
  { name: "Arborjet Arbor OTC Fungicide 1 oz", basis: "other", rate: null, min: 16, max: 35, unit: "ml", epa: "74578-7",
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/05/Arbor-OTC_Website_Label.pdf — \"Add 250 milliliters of purified water into the 28g container of Arbor-OTC and use to treat 100 DBH inches of trees. ... [Palms] Small Palm <6' Clear Trunk = 16 mL of Solution; Average Palm 6'-15' Clear Trunk = ~26 mL of \" | NOTE: Label EPA Reg No. 74578-7 (input listed EPA as N/A, so no true mismatch). This is an oxytetracycline HCl 39.60% (=36.7% oxytetracycline) injectable ANTIBIOTIC, not a f" },
  { name: "Arborjet Arbor OTC Fungicide 5 oz", basis: "other", rate: null, min: 16, max: 35, unit: "ml", epa: "74578-7",
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/05/Arbor-OTC_Website_Label.pdf — \"Add 250 milliliters of purified water into the 28g container of Arbor-OTC and use to treat 100 DBH inches of trees. ... [Palms] Small Palm <6' Clear Trunk = 16 mL of Solution; Average Palm 6'-15' Clear Trunk = ~26 mL of \" | NOTE: Same product/label as Arbor OTC 1 oz; only the container size differs. Label EPA Reg No. 74578-7. Oxytetracycline HCl 39.60% injectable antibiotic (not a fungicide). 2" },
  { name: "Arborjet Ima-Jet 10", basis: "other", rate: null, min: 1.0, max: 6.0, unit: "ml", epa: "74578-6",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/IMA-Jet%2010%20Label%209-1-19.pdf — \"[Adelgids, Aphids, Gall Wasps, Lacebugs, Leafhoppers, Leaf miners, Mealybugs, Psyllids, Soft scales, Thrips, Whiteflies] Low Rate: For trees <12\" DBH apply 1.0 - 2.0 mL per inch trunk diameter; For trees 12-23\" DBH apply\"" },
  { name: "Arborjet Ima-Jet Systemic Insecticide", basis: "other", rate: null, min: 2.0, max: 8.0, unit: "ml", epa: "74578-1",
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/10/IMA-jet_WebsiteLabel_2020-1.pdf — \"[Adelgids, Aphids, Gall Wasps, Lacebugs, Leafhoppers, Leaf miners, Mealybugs, Psyllids, Soft scales, Thrips, Whiteflies] 2.0 – 4.0 mL IMA-jet Systemic Insecticide per inch of cumulative trunk diameter at breast height (5\"" },
  { name: "Arborjet NUTRIROOT 1 gal", basis: "per_gallon", rate: null, min: 1.25, max: 1.5, unit: "fl_oz", epa: null,
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/09/NutriRoot_websitelabel_8.5x11_2025.pdf — \"Dilute 1.25 - 1.5 fl. oz. NutriRoot in 1-gallon of water or 1-gallon of NutriRoot in 70-100 gallons of water. ... 1-gallon of NutriRoot in 70-100 gallons of water will treat up to 3,000 sq. ft. of landscape.\"" },
  { name: "Arborjet NUTRIROOT 1 qt", basis: "per_gallon", rate: null, min: 1.25, max: 1.5, unit: "fl_oz", epa: null,
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/09/NutriRoot_websitelabel_8.5x11_2025.pdf — \"Dilute 1.25 - 1.5 fl. oz. NutriRoot in 1-gallon of water or 1-gallon of NutriRoot in 70-100 gallons of water. ... 1-gallon of NutriRoot in 70-100 gallons of water will treat up to 3,000 sq. ft. of landscape.\"" },
  { name: "Arborjet NUTRIROOT 2.5 gal", basis: "per_gallon", rate: null, min: 1.25, max: 1.5, unit: "fl_oz", epa: null,
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/09/NutriRoot_websitelabel_8.5x11_2025.pdf — \"Dilute 1.25 - 1.5 fl. oz. NutriRoot in 1-gallon of water or 1-gallon of NutriRoot in 70-100 gallons of water. ... 1-gallon of NutriRoot in 70-100 gallons of water will treat up to 3,000 sq. ft. of landscape.\"" },
  { name: "Arborjet PHOSPHO-Jet Systemic Fungicide", basis: "other", rate: null, min: 3.5, max: 7.0, unit: "ml", epa: "74578-3",
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/10/PHOSPHO-jet_websitelabel_8.5x11_1072020.pdf — \"PHOSPHO-jet may be applied undiluted by micro-injection. The PHOSPHO-jet dose rates are 3.5 to 7.0 milliliters (mLs) per inch DBH. Use the 3.5 mL rate in trees less than 12\" in diameter. For trees 12 to 24\" in diameter, \"" },
  { name: "Arborjet Palm-Jet Palm Nutrition", basis: "other", rate: null, min: 5, max: 30, unit: "ml", epa: null,
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/05/PALM-jet-Mg_Website_Label.pdf — \"Palm Rates: Small 6-12' spread / 5-19' trunk = 5-10 mLs/Palm; Medium 12-24' / 20-39' = 10-20 mLs/Palm; Large 24-48' / 40-100' = 20-30 mLs/Palm. Use: Inject as formulated or dilute with 1-3 volumes of water. Summer Use: a\"" },
  { name: "Arborjet Propizol Injectable Fungicide", basis: "other", rate: null, min: 10, max: 20, unit: "ml", epa: "74578-8",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/Propizol%20Label%202-1-22.pdf — \"USE RATE TABLE FOR MICRO-INJECTION AND MICRO-INFUSION®: Low Rate — Amount of Propizol per inch DBH (mls) 10, Amount of Water to Add per inch DBH (mls) 10; High Rate — Amount of Propizol per inch DBH (mls) 20, Amount of W\"" },
  { name: "Arborjet Tree-Age G-4 Injectable Insecticide", basis: "other", rate: null, min: null, max: null, unit: "ml", epa: "74578-10",
    note: "manufacturer: https://arborjet.com/wp-content/uploads/2024/05/TREE-age-G4_Website_Label.pdf — \"Dosages are based on the Diameter (in inches) of the tree at Breast Height (DBH). ... USE RATE TABLE (ml. product/tree): 4 to 6\" DBH = Low 10-20, Medium 20-45, High 45-60; 10 to 12\" = Low 25-35, Medium 35-90, High 90-120\"" },
  { name: "Artavia 2 SC (Azoxy)", basis: "per_1000_sqft", rate: null, min: 0.38, max: 0.77, unit: "fl_oz", epa: "91234-74",
    note: "manufacturer: https://atticusllc.com/wp-content/uploads/2020/07/Atticus-Artavia-2-SC-Specimen.pdf — \"Directions for Application for Turf Diseases ... Use Rate (fl. oz. product per 1,000 sq. ft.) 0.38 - 0.77 ... Mix Atticus Artavia 2 SC with the required amount of water and apply as a dilute spray application in 2 - 4 ga\"" },
  { name: "Atticus Gunner", basis: "per_1000_sqft", rate: null, min: 1, max: 2, unit: "fl_oz", epa: "91234-262",
    note: "manufacturer: https://atticusllc.com/wp-content/uploads/2020/08/Gunner-14.3-MEC-Fungicide-Specimen.pdf — \"1 - 2 [Fl. Oz. per 1,000 sq. ft.] ... If using the 1 - 2 fl. oz./1,000 sq. ft. rate without tank mixing, make no more than 3 consecutive applications for dollar spot control before rotating to an alternate EPA-registered\"" },
  { name: "Atticus Talak", basis: "per_gallon", rate: null, min: 0.33, max: 1.0, unit: "fl_oz", epa: "91234-145",
    note: "manufacturer: https://atticusllc.com/wp-content/uploads/2020/08/Talak-7.9-F-Specimen.pdf — \"Use a 0.02 to 0.06% dilution to spray outside surfaces of buildings. Use a spray volume of up to 10 gallons of dilution per 1,000 square feet. ... Mixing Directions: For 0.02% suspension, mix 0.33 fluid oz. of Talak 7.9%\"" },
  { name: "Avid Insecticide", basis: "other", rate: 4, min: null, max: null, unit: "fl_oz", epa: "100-896",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000100-00896-20111220.pdf — \"Mites (Carmine Spider Mite, Eriophyid Mites, European Red Mite, Southern Red Mite, Spruce Spider Mite, Twospotted Spider Mite) ... 4 [fl. OZ./100 gal.]\"" },
  { name: "BASF Pillar SC Intrinsic Brand Fungicide", basis: "per_1000_sqft", rate: 1.0, min: null, max: null, unit: "fl_oz", epa: "7969-480",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/007969-00480-20210927.pdf — \"DO NOT apply more than 43.6 fl ozs (0.57 lb triticonazole, 0.50 lb pyraclostrobin) per application per acre (1.0 fl oz per 1000 sq ft). ... DO NOT apply more than 218 fl ozs (2.843 lbs triticonazole, 2.502 lbs pyraclostr\"" },
  { name: "BRANDT Agra Sol Micro Mix", basis: "other", rate: null, min: 3, max: 9, unit: "lb", epa: null,
    note: "manufacturer: https://brandt.co/media/16544/brandt-agra-sol-micro-mix-label.pdf — \"Fairways, Sports Turf and Lawns - Maintenance: 3-9 lbs. per acre. Apply in a minimum of 88 gallons of water or irrigate with 0.25 inches of water after application. ... Ornamental Plants - Tree and shrub maintenance: For\"" },
  { name: "BRANDT Indicate 5", basis: "per_gallon", rate: null, min: 0.05, max: 0.3, unit: "fl_oz", epa: null,
    note: "manufacturer: https://brandt.co/media/6781/brandt-indicate-5-label.pdf — \"RECOMMENDATIONS: The correct volume of BRANDT INDICATE 5 to be added to the spray water is indicated by the color: pink at pH between 4.5 to 5.5. ... The following table serves as a guide to the volume required for diffe\"" },
  { name: "Badge SC Bactericide/Fungicide", basis: "other", rate: null, min: 1.5, max: 2, unit: null, epa: "80289-3-10163",
    note: "manufacturer: https://www.gowanco.com/sites/default/files/gowanco_com/_attachments/product/resource/label/badge_sc_80289-3-10163_01-r0116.pdf — \"For ornamental crops in dormancy, apply as a thorough cover spray at rates ranging from 1.5 to 6 pts/A of BADGE SC. When new growth is present, apply as a thorough cover spray at rates ranging from 1.5 to 2 pts/A of BADG\"" },
  { name: "Banol Fungicide", basis: "per_1000_sqft", rate: null, min: 1.33, max: 4, unit: "fl_oz", epa: "101563-21",
    note: "manufacturer: https://bynder.envu.com/m/1c708e6275cb8fec/original/Digital_TO_Banol_label_NA_US_EN.pdf — \"Preventative Treatment* 1-1/3 - 2 fl oz in 2 - 5 gallons of water ... Curative Treatment* 3 - 4 fl oz in 2 - 5 gallons of water ... Do not apply more than a total of 12.25 fl oz (0.57 lb ai) of BANOL FUNGICIDE per 1,000 sq ft of turfgrass per year\" | NOTE: max 4 = curative ceiling; preventative band is 1.33-2." },
  { name: "Barricade 4FL", basis: "per_1000_sqft", rate: null, min: 0.5, max: 1.1, unit: "fl_oz", epa: "100-1139",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000100-01139-20240221.pdf — \"Maximum Application Rate of Barricade 4FL Per Calendar Year by Turf Species: Bermudagrass / Bahiagrass / Centipedegrass / Kikuyugrass / Seashore Paspalum / St. Augustinegrass / Tall Fescue (including turf-type) / Zoysiag\"" },
  { name: "Barricade 65WG", basis: "per_1000_sqft", rate: null, min: 0.36, max: 0.83, unit: "oz", epa: "100-834",
    note: "distributor_label_pdf: https://www.davey.com/media/r4nfmj2x/barricade-65wg_label.pdf — \"Table 1: Maximum Application Rate of Barricade 65WG per Calendar Year for Turfgrass Species: Bermudagrass / Bahiagrass / Centipedegrass / Kikuyugrass / Seashore Paspalum / St. Augustinegrass / Tall Fescue (including turf\"" },
  { name: "Bifen I/T", basis: "per_gallon", rate: null, min: 0.33, max: 1.0, unit: "fl_oz", epa: "53883-118",
    note: "manufacturer: https://www.controlsolutionsinc.com/hubfs/Specimen%20Labels/Specimen-BifenIT-53883-118.pdf — \"Use a 0.02 to 0.06% dilution to spray the outside surfaces of buildings such as private homes, duplexes, townhouses, condominiums, house trailers, apartment complexes, carports, garages, fence lines, storage sheds, barns\"" },
  { name: "Bifen XTS", basis: "per_1000_sqft", rate: null, min: 0.07, max: 0.3, unit: "fl_oz", epa: "53883-189",
    note: "manufacturer: https://www.controlsolutionsinc.com/hubfs/Specimen%20Labels/Specimen-BifenXTS-53883-189.pdf — \"Bifen XTS may be used as a broadcast treatment. [Table:] Ants, Armyworms, Billbugs, Chinch Bugs...\" General lawn band 0.07-0.15 fl oz/1,000 sq ft; label table allows up to 0.30 fl oz/1,000 sq ft for listed pests (e.g. fire ants, Japanese beetle larvae)." },
  { name: "Blindside Herbicide", basis: "per_1000_sqft", rate: null, min: 0.149, max: 0.23, unit: "oz", epa: "279-3411",
    note: "distributor_label_pdf: https://homeparamount.com/pdf/doc-blindside-label-1608311602.pdf — \"Table 1. Tolerant grasses. Warm Season Grasses: Bermudagrass (Cynodon dactylon) & hybrids / Centipedegrass (Eremochloa ophuiroides) / St.Augustine grass (Stenotaphrum secundatum) / Zoysiagrass (Zoysia japonica): Recommen\"" },
  { name: "Bora-Care", basis: "other", rate: null, min: null, max: null, unit: null, epa: "64405-1",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/064405-00001-20210518.pdf — \"For remedial and preventative treatments apply a 1:1 dilution for all treatments by spray, injection, brush or roller. ... One gallon of Bora-Care concentrate (2 gallons of solution) will treat 800 sq. ft. of 1\" thick wo\"" },
  { name: "Certainty Turf Herbicide", basis: "other", rate: null, min: 1.25, max: 2.0, unit: "oz", epa: "524-534",
    note: "distributor_label_pdf: https://www.irrigationoutlet.com/wp-content/themes/splashomnimediatheme/assets/Literature/Certainty_Herbicide_Label.pdf — \"8.1 Sedge Control: For the selective control of the weeds listed in this section, apply this product at 1.25 ounces per acre after weeds have reached the 3- to 8-leaf stage of growth. A sequential application of 1.25 oun\"" },
  { name: "Chipco Signature", basis: "per_1000_sqft", rate: null, min: 4, max: 8, unit: "oz", epa: "432-890",
    note: "distributor_label_pdf: https://www.domyown.com/msds/Chipco_Signature_Fungicide_Label_2022.pdf — \"DISEASE: Pythium diseases, yellow tuft | INTERVAL OF APPLICATIONS: 14 days / 21 days | RATE OZ. PRODUCT/1000 SQ. FT.: 4.0 / 8.0 ... Apply as a foliar spray using 1 to 5 gallons of water per 1000 sq. ft. as indicated in t\"" },
  { name: "Compass Fungicide", basis: "per_1000_sqft", rate: null, min: 0.1, max: 0.25, unit: "oz", epa: "432-1371",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000432-01371-20160315.pdf — \"TURFGRASS DISEASES CONTROLLED WITH COMPASS FUNGICIDE — RATE OF PRODUCT/1,000 SQ FT: Brown Patch: Compass Fungicide 0.1 - 0.2 oz, 14 days; Compass Fungicide 0.15 - 0.25 oz, 21 days. Gray Leaf Spot, Rapid Blight: Compass F\"" },
  { name: "Conserve SC", basis: "per_1000_sqft", rate: 1.2, min: null, max: 1.2, unit: "fl_oz", epa: "62719-291",
    note: "distributor_label_pdf: https://assets.greenbook.net/23-33-44-05-01-2023-Conserve_SC_-_label.pdf — \"Application Rate: Conserve SC may be used up to a maximum labeled rate of 1.2 fl oz per 1000 sq ft (52 fl oz per acre) per application on turfgrass as a general treatment regardless of the target insect pest.\"" },
  { name: "Contrac Blox", basis: "other", rate: null, min: 3, max: 16, unit: null, epa: "12455-79",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/012455-00079-20200213.pdf — \"Application Directions for 1 ounce (28 g) size blocks: Rats: Apply 3 to 16 blocks per placement, usually spaced 15- to 30- feet apart. ... Mice and Meadow Voles: Apply 1 block per placement, usually spaced 8- to 12-feet \"" },
  { name: "Cytogro Liquid Biostimulant", basis: "per_1000_sqft", rate: 0.4, min: 0.2, max: 0.8, unit: "fl_oz", epa: "90022-1",
    note: "distributor_label_pdf: https://arborjet.com/wp-content/uploads/2024/03/CytoGro_Label.pdf — \"Lawns, Playgrounds, Parks, Recreational Areas, Landscaped Roadways and Cemeteries: Apply 2 fl. oz. per 2500 square feet at the beginning of spring growth to promote a deep root system and tillering to fill sparse areas. \"" },
  { name: "Cyzmic CS", basis: "per_gallon", rate: null, min: 0.2, max: 0.8, unit: "fl_oz", epa: "53883-389",
    note: "manufacturer: https://www.controlsolutionsinc.com/hubfs/Specimen%20Labels/Specimen-Cyzmic%20CS-53883-389.pdf — \"0.2 fl. oz. (6 mL) to 0.4 fl. oz. (12 mL) per gallon of water (0.015-0.03% AI) ... 0.8 fl. oz. (24 mL) per gallon of water (0.06% AI) | Rate Table for Perimeter Barrier Applications: Fl. oz. (mL) of CYZMIC CS / Gals. of \"" },
  { name: "Delta Dust", basis: "per_1000_sqft", rate: 0.5, min: null, max: null, unit: "lb", epa: "432-772",
    note: "distributor_label_pdf: https://www.pestkil.com/documents/Delta-dust-label-20200817020017.pdf — \"The amount to be applied will vary with the site but should usually be in the range of 2-3 grams of DeltaDust per square yard (or 0.5 lbs per 1000 square feet).\"" },
  { name: "Demand CS", basis: "per_gallon", rate: null, min: 0.2, max: 0.8, unit: "fl_oz", epa: "100-1066",
    note: "manufacturer: https://assets.syngentapmp.com/pdf/labels/SCP-1066AL1P11142.pdf — \"Rate Table for Structural Perimeter Barrier Applications: Application Rate of Demand CS Insecticide / Gallons of Water / Area of Coverage (sq ft): 0.2 fl oz (6 mL) 1-5 800-1,600; 0.4 fl oz (12 mL) 1-5 800-1,600; 0.8 fl o\" | NOTE: per_gallon ON PURPOSE: the quoted perimeter table is a dilution (fl oz of concentrate per 1-5 gal of mix), not a broadcast per-1k rate — a default_rate_per_1000 here would silently replace the pest closeout's 4 oz perimeter-spray prefill with a mix-concentration number." },
  { name: "Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide", basis: "per_1000_sqft", rate: null, min: 0.37, max: 0.73, unit: "fl_oz", epa: "62719-542",
    note: "distributor_label_pdf: https://newsomseed.com/resources/Label%20Dimension%202EW.pdf — \"Use Rate Table (Cont.): Coastal South: HI, FL, southern coastal areas of AL, GA, LA, MS, NC, SC, TX: Program 1: 1 + 1 pt/acre, 0.37 + 0.37 oz /1000 sq ft; Program 2: 1.25 + 1.25 pt/acre, 0.46 + 0.46 oz/1000 sq ft; Progra\"" },
  { name: "Dismiss 64 oz", basis: "per_1000_sqft", rate: null, min: 0.18, max: 0.275, unit: "fl_oz", epa: "279-3295",
    note: "distributor_label_pdf: https://www.trianglecc.com/wp-content/uploads/2022/08/FMC-Dismiss-Label.pdf — \"Table 1. Tolerant grasses. Warm Season Grasses: Bahiagrass / Bermudagrass & hybrids / Buffalograss / Carpetgrass / Centipedegrass / Kikuyugrass / Seashore Paspalum / St.Augustinegrass / Zoysiagrass: Maximum Use Rate, Sin\"" },
  { name: "Distance IGR", basis: "per_gallon", rate: null, min: 0.06, max: 0.12, unit: "fl_oz", epa: "59639-96",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/059639-00096-20210426.pdf — \"Table 1. Directions for Use on Shrubs, Ornamentals, Flowering Plants, Foliage Plants, Ground Covers, Ornamental Trees, Non-Bearing Fruit, Nut Trees and Vines: Aphids (suppression), Western Flower Thrips (suppression), Wh\"" },
  { name: "Dominion 2L 1 gal", basis: "per_gallon", rate: null, min: 0.3, max: 0.6, unit: "fl_oz", epa: "53883-229",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/053883-00229-20140108.pdf — \"Use a 0.05% to 0.1% dilution based on current practices. For a typical control situation, a 0.05% dilution is used. A 0.1% dilution may be used when a severe or persistent infestation exists. ... 0.3 fl oz/gal = 0.05%; 0\"" },
  { name: "Dominion 2L 27.5 oz", basis: "per_gallon", rate: null, min: 0.3, max: 0.6, unit: "fl_oz", epa: "53883-229",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/053883-00229-20140108.pdf — \"Use a 0.05% to 0.1% dilution based on current practices. For a typical control situation, a 0.05% dilution is used. A 0.1% dilution may be used when a severe or persistent infestation exists. ... 0.3 fl oz/gal = 0.05%; 0\"" },
  { name: "Drive XLR8 Post Emergent Liquid Herbicide", basis: "per_1000_sqft", rate: 1.45, min: null, max: null, unit: "fl_oz", epa: "7969-272",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/007969-00272-20190607.pdf — \"Table 3. Application Rates and Timing for Postemergence Weed Control in Turfgrass: Broadcast Application: 64 fl ozs of product per acre or 1.45 fl ozs per 1000 sq ft (0.75 lb ae/A). ... DO NOT apply to Bahiagrass, carpetgrass, centipedegrass, colonial and seaside bentgrass, dichondra, St. Augustinegrass, or lawns or turfgrass where desirable clovers are present\" | NOTE: EPA reg matches DB (7969-272, BASF). CRITICAL FOR THIS OPERATOR: label Table 1 lists Bahiagrass, Carpetgrass, Centipedegrass, and St. Augustinegrass as Susceptible — OFF-LABEL on most FL home lawns; tolerant turf = bermuda (common), Ky bluegrass, tall fescue, zoysia." },
  { name: "Dylox 420 SL T&O Insecticide", basis: "per_1000_sqft", rate: 6.9, min: null, max: null, unit: "fl_oz", epa: "5481-643-432",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/Dylox%20420%20Label%205-9-16%20AV2.pdf — \"APPLICATIONS: Landscape Ornamentals (including flowers, shrubs, and trees) and Recreational Lawns & Turf - Annual bluegrass weevil (adults) / Billbug larvae / Mole crickets / Chinch bugs / White grubs (including larvae o\"" },
  { name: "Eagle 20EW Fungicide", basis: "per_1000_sqft", rate: 1.2, min: null, max: null, unit: "fl_oz", epa: "62719-463",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/062719-00463-20241113.pdf — \"In residential turfgrass, optimum disease control is achieved when Eagle 20EW is applied in a preventative disease control program at a rate of 1.2 fl oz per 1000 sq ft. ... Do not apply more than 13.8 fl oz of Eagle 20EW per 1000 sq ft per year\" | NOTE: non-residential turf allows 1-2.4 fl oz/1,000 sq ft; the residential table is a flat 1.2 for every listed disease, so 1.2 is both default and per-application max." },
  { name: "Elector PSP", basis: "per_gallon", rate: null, min: 0.2, max: 0.4, unit: "fl_oz", epa: "72642-2",
    note: "distributor_label_pdf: https://library.leedstone.com/docs/Elector-PSP-Product-Label.pdf — \"House flies (adults and larvae), Stable flies, Little house flies: 2 fl. oz. (60 mL) Elector PSP in 10 gallons of water will treat 5,000 - 10,000 ft². Darkling beetles, Hide beetles: 2 fl. oz. (60mL) of product treats 5,\" | NOTE: Agricultural ANIMAL-PREMISE product (poultry houses, barns, feedlots, corrals), not a turf/structural product — rates are pest-specific dilutions tied to area, so no sin" },
  { name: "Envu Specticle Flo Pre-Emergent Liquid Herbicide", basis: "other", rate: 6, min: null, max: null, unit: "fl_oz", epa: "101563-207",
    note: "manufacturer: https://bynder.envu.com/m/274eb1a770bb3059/original/Digital_TO_Specticle-FLO_label_NA_US_EN.pdf — \"Maximum Single Application Rates for SPECTICLE FLO HERBICIDE on Warm Season Grasses: ... St. Augustinegrass: 6 [Fluid Ounces of Product per Acre]; Centipedegrass: 6; Bermudagrass: 10; Zoysiagrass: 10. ... The maximum sin\"" },
  { name: "Floramite Miticide 1 qt", basis: "other", rate: 4, min: 4, max: 8, unit: "fl_oz", epa: "70506-537",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/070506-00537-20240208.pdf — \"Mix 4 to 8 fl oz FLORAMITE SC in 100 gal of water ... Use 4 fl oz per 100 gal of water for preventative applications or where mite infestations are light. Up to 8 fl oz per 100 gal of water [may be required for heavy inf\"" },
  { name: "Floramite SC/LS 8 oz", basis: "other", rate: 4, min: 4, max: 8, unit: "fl_oz", epa: "70506-537",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/070506-00537-20240208.pdf — \"Mix 4 to 8 fl oz FLORAMITE SC in 100 gal of water ... Use 4 fl oz per 100 gal of water for preventative applications or where mite infestations are light. Up to 8 fl oz per 100 gal of water [may be required for heavy inf\"" },
  { name: "Forbid 4F", basis: "other", rate: null, min: 1, max: 4, unit: "fl_oz", epa: "432-1279",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000432-01279-20070504.pdf — \"Spider mites (including twospotted spider mite, spruce spider mite, honeylocust spider mite, Euonymus mite, boxwood spider mite, tumid mite and Lewis mite) ... 1 to 4 fl. oz. (30-120 mL)/100 gallons of spray solution or \"" },
  { name: "Fusilade II Post Emergent Liquid Herbicide", basis: "other", rate: null, min: null, max: null, unit: "fl_oz", epa: "100-1084",
    note: "manufacturer: https://assets.syngenta-us.com/pdf/labels/SCP1084AL1F0616.pdf — \"APPLICATION RATES - LANDSCAPE AND ORNAMENTALS: Apply 16-24 fl oz/A (0.4 - 0.6 fl oz/1,000 sq ft) ... GRASS WEED CONTROL IN DESIRABLE TURFGRASS: For the suppression and/or control of Common Bermudagrass, Hybrid Bermudagrass and other grass weeds in Zoysia, Fine Fescue and Tall Fescue turfgrass ... Apply 3-6 fl oz/A\" | NOTE: DB had no EPA reg (N/A); label reg is 100-1084 (Syngenta). basis=other ON PURPOSE: 0.4-0.6 fl oz/1,000 sq ft is the landscape/ornamental-BED rate; over-the-top turf use is Zoysia/Fine Fescue/Tall Fescue ONLY at 3-6 fl oz/A (~0.07-0.14 fl oz/1,000 sq ft) — storing the bed rate in the per-1k turf fields would prefill lawn completions at 4-8x the labeled turf rate, and St. Augustine/bahia lawns are not labeled turf at all." },
  { name: "Gentrol IGR", basis: "per_gallon", rate: 1, min: null, max: null, unit: "oz", epa: "2724-351",
    note: "manufacturer: https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/specimen/gentrol-igr-concentrate-specimen-label.pdf — \"DILUTION PREPARATION FOR SURFACE SPRAY/PAINT BRUSH, SPOT AND CRACK AND CREVICE PREPARATIONS: Use 1 ounce of GENTROL to 1 gallon of diluent. Partially fill the mixing container with diluent, add the GENTROL, shake or stir\"" },
  { name: "Headway Fungicide", basis: "per_1000_sqft", rate: null, min: 1.5, max: 3, unit: "fl_oz", epa: "100-1216",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/headway-fungicide-label.pdf — \"Apply Headway at 1.5-3 fl oz per 1,000 sq ft. Spray carrier volume should fall within 30-150 gallons of water per 1,000 sq ft.\"" },
  { name: "Heritage Action Fungicide", basis: "per_1000_sqft", rate: null, min: 0.2, max: 0.4, unit: "oz", epa: "100-1550",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000100-01550-20141223.pdf — \"Apply Heritage Action at 0.2 to 0.4 oz per 1,000 sq ft. Spray carrier volume should fall within 30-150 gallons of water per 1,000 sq ft.\" | NOTE: Azoxystrobin + acibenzolar-S-methyl (SAR activator), Group 11, EPA Reg 100-1550 (WG dry formulation, so unit is dry oz not fl oz). Broadcast/foliar band 0.2-0.4 oz/1000; band only so rate=null. IMPORTANT — label restriction: 'DO NOT apply to residential lawns.' (also max 3.7 oz/1,000 sq ft/yr). OFF-LABEL for residential lawn work; commercial/golf turf only." },
  { name: "Heritage G", basis: "per_1000_sqft", rate: null, min: 2, max: 4, unit: "lb", epa: "100-1323",
    note: "manufacturer: https://assets.syngenta-us.com/pdf/labels/SCP1323AL1D1115.pdf — \"DIRECTIONS FOR APPLICATION FOR TURF DISEASES ... Use Rate (lb product/1,000 sq ft) ... Brown Patch (Rhizoctonia solani) 2-4 [Application Interval] 14-28 Apply when conditions are favorable for disease development.\"" },
  { name: "Heritage TL", basis: "per_1000_sqft", rate: null, min: 1, max: 2, unit: "fl_oz", epa: "100-1191",
    note: "distributor_label_pdf: http://www.cdms.net/ldat/ld6NG002.pdf — \"Apply Heritage TL at 1-2 fl oz per 1,000 sq ft. Spray carrier volume should fall within 30-150 gallons of water per 1,000 sq ft.\"" },
  { name: "Hexygon IQ Miticide", basis: "other", rate: null, min: 4, max: 8, unit: "fl_oz", epa: "10163-365",
    note: "manufacturer: https://www.gowanco.com/sites/default/files/gowanco_com/_media/content/hexygon_iq_spec_label_11-2018.pdf — \"ORNAMENTAL PLANTS AND VINES ... Arborvitae Spider Mite, Honeylocust Spider Mite, Pacific Spider Mite, Strawberry Spider Mite, Two-spotted Spider Mite ... 12 - 24 ozs/acre OR 4 - 8 ozs / 100 gal.\"" },
  { name: "In2Care Mosquito Station", basis: "other", rate: 10, min: 10, max: 15, unit: null, epa: "91720-1",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/091720-00001-20220630.pdf — \"For optimal coverage, place at least 1 In2Care Mosquito Station every 4,300 sq. feet (400 sq. meters), or at least 10 stations per acre in areas where Aedes and/or Culex spp. Mosquitoes breeding can be expected. Do not e\"" },
  { name: "KPHITE 7LP Systemic Fungicide", basis: "per_1000_sqft", rate: null, min: 3, max: 6, unit: "fl_oz", epa: "73806-1",
    note: "manufacturer: https://plantfoodsystems.com/wp-content/uploads/2024/03/KPhite-Booklet-7LP-TO_0224.pdf — \"3-6 fluid ounces/1000 square feet (Fairways: 2-6 fluid ounces/1000 square feet.) OR 3-6 quarts/100 gallons of water/acre.\"" },
  { name: "Kontos Insecticide/Miticide", basis: "other", rate: null, min: 1.7, max: 3.4, unit: "fl_oz", epa: "432-1471-59807",
    note: "manufacturer: https://www.ohp.com/Labels_MSDS/PDF/kontos_label.pdf — \"Flowers, Ornamentals in flats and containers ... Aphids, Adelgids, Mealybugs, Scales (crawlers), Spider Mites ... 1.7 fl oz - 3.4 fl oz / 100 gallons of water. ... Make applications preventatively, or when populations ar\"" },
  { name: "LESCO 0-0-62 AM MOP Turfgrass Soluble Fertilize", basis: "per_1000_sqft", rate: 1.6, min: 1.6, max: 3.0, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/en/098661-lesco-0-0-62-am-mop-granular-fertilizer-50-lb-bag/p/337984 — \"COVERAGE: 50 pounds of LESCO 0-0-62 Fertilizer covers approximately 31,000 sq ft at the application rate of one pound of potash (1.6 pounds of fertilizer) per 1,000 sq ft. ... Recommended applications are at the rate of \"" },
  { name: "LESCO 13-24-6 Landscape Starter", basis: "other", rate: null, min: null, max: null, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/en/510018-lesco-lo-13-24-6-granular-fertilizer-40-lb-bag/p/337795 — \"Apply LESCO 13-24-6 Landscape and Ornamental Fertilizer at the rate of 1 pound of fertilizer per 100 sq ft of ornamental bed area, flower beds and planting areas. ... Apply 2 to 4 times per year or as needed to maintain \"" },
  { name: "LESCO 15-0-15 30% PolyPlus 1% Fe", basis: "per_1000_sqft", rate: 6.7, min: 6.7, max: 6.7, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/en/098586-lesco-fertilizer-15-0-15-30-polyplus-opti45-30-as-1fe-04mn-5/p/336165 — \"COVERAGE: 50 pounds of LESCO 15-0-15 Fertilizer covers approximately 7,500 sq ft at the application rate of one pound of nitrogen (6.70 pounds of fertilizer) per 1,000 sq ft. ... Recommended applications are at the rate \"" },
  { name: "LESCO 16-4-8 50% PolyPlus OPTI 0.05%Cu 1%Fe 0.4%Mn 0.15%Zn MOP Turfgrass Granular", basis: "per_1000_sqft", rate: 6.25, min: 6.25, max: 10.0, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/en/098573-lesco-16-4-8-50-polyplus-opti-005cu-1fe-04mn-015zn-mop-turfgrass-granular-fertilizer-50-lb-bag/p/334665 — \"COVERAGE: 50 pounds of LESCO 16-4-8 Fertilizer covers approximately 8,000 sq ft at the application rate of one pound of nitrogen (6.25 pounds of fertilizer) per 1,000 sq ft. ... Recommended applications are at the rate o\"" },
  { name: "LESCO 20-0-0 60% CRN Plus Micros Turfgrass Liquid Fertilizer", basis: "per_1000_sqft", rate: null, min: 6.5, max: 31.5, unit: "fl_oz", epa: null,
    note: "siteone: https://www.siteone.com/en/098163r-lesco-florida-friendly-fertilizer-20-0-0-60-crn-25-mg-1-fe-25-mn-turfgrass-liquid-fertilizer-1-gal-250-gal-minimum-container/p/343467 — \"Gallon/Acre | N lbs/Acre | Liquid oz/1000sqft | N lbs/1000sqft: 2.2 gal | 4.5 | = 6.5 oz | .1 ; 5.3 | 11 | = 15.6 oz | .25 ; 10.7 | 22 | = 31.5 oz | .5\"" },
  { name: "LESCO 20-2-10 30% PolyPlus", basis: "per_1000_sqft", rate: 5.0, min: 5.0, max: 5.0, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/en/098602-lesco-20-2-10-30-polyplus-opti45-40-as-4-fe-1-mn-pc-urea-urea-as-dap-mop-is-ms-turfgrass-granular-fertilizer-50-lb-bag/p/336784 — \"COVERAGE: 50 pounds of LESCO 20-2-10 Fertilizer covers approximately 10,000 sq ft at the application rate of one pound of nitrogen (5.00 pounds of fertilizer) per 1,000 sq ft. ... Recommended applications are at the rate\"" },
  { name: "LESCO 20-20-20 Soluble", basis: "per_1000_sqft", rate: null, min: 0.5, max: 1.0, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/en/202020-lesco-20-20-20-am-ornamental-and-turfgrass-soluble-fertilizer-25-lb-pail/p/4556 — \"Apply 0.5-1.0 lb per 1,000 sq. ft. every 7-14 days during active growth. (see product label for full directions)\"" },
  { name: "LESCO 24-0-10 75% PolyPlus OPTI45 Spar-TECH 10% Cl MOP Turfgrass Granular Fertilizer 50 lb. Bag", basis: "per_1000_sqft", rate: 4.2, min: null, max: null, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/511673-label/511673-label.pdf — \"COVERAGE: 50 pounds of LESCO 24-0-10 Fertilizer covers approximately 12,000 sq ft at the application rate of one pound of nitrogen (4.2 pounds of fertilizer) per 1,000 sq ft.\"" },
  { name: "LESCO 24-0-11 with PolyPlus OPTI", basis: "per_1000_sqft", rate: 4.2, min: 4.2, max: 8.4, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/en/098631-lesco-24-0-11-50-polyplus-opti-2fe-1mn-mop-turfgrass-granular-fertilizer-50-lb-bag/p/336709 — \"COVERAGE: 50 pounds of LESCO 24-0-11 Fertilizer covers approximately 12,000 sq ft at the application rate of one pound of nitrogen (4.2 pounds of fertilizer) per 1,000 sq ft. ... Recommended applications are at the rate \"" },
  { name: "LESCO 24-2-11 50% NOS Plus BIO 6% Fe", basis: "per_1000_sqft", rate: 4.2, min: null, max: null, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/550010088301_label/550010088301-label.pdf — \"COVERAGE: 50 pounds of LESCO 24-2-11 Fertilizer covers approximately 12,000 sq ft at the application rate of one pound of nitrogen (4.2 pounds of fertilizer) per 1,000 sq ft.\"" },
  { name: "LESCO 6-0-0 Liquid", basis: "other", rate: null, min: null, max: null, unit: null, epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/550010087800_label/550010087800-label.pdf — \"LIGHT OR SANDY SOILS: Recommended application rate is 1 gallon per acre in 4 to 6 applications at 8 to 12 week intervals. Irrigate or water in to ensure maximum soil contact. HEAVY OR COMPACTED SOILS: Initial application\"" },
  { name: "LESCO 7-1-7 40% PolyPlus", basis: "per_1000_sqft", rate: 14.29, min: null, max: null, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-16101_336923_label_098646-label-780107/rb-ue-labels-16101-336923-label-098646-label-780107.pdf — \"COVERAGE: 50 pounds of LESCO 7-1-7 Fertilizer covers approximately 3,500 sq ft at the application rate of one pound of nitrogen and potash (14.29 pounds of fertilizer) per 1,000 sq ft.\"" },
  { name: "LESCO 8-0-10 100% PolyPlus Landscape", basis: "other", rate: null, min: 1, max: 1.5, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-16321_337982_label_098659-label-386878/rb-ue-labels-16321-337982-label-098659-label-386878.pdf — \"Apply LESCO 8-0-10 Palm and Tropical Ornamental Fertilizer at the rate of 1 to 1 1/2 pounds per 100 sq ft to flower beds and planting areas. ... For trees and larger shrubs, apply 1/2 to 1 pound of this fertilizer per in\"" },
  { name: "LESCO 8-0-10 50% PolyPlus OPTI45 Spar-TECH 1% Fe 1% Mg 1% Mn 0.1% B KMAG Palm & Tropical Ornamental Granular Fertilizer", basis: "other", rate: null, min: 1, max: 1.5, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/556996587978_label/556996587978-label.pdf — \"Apply LESCO 8-0-10 Palm and Tropical Ornamental Fertilizer at the rate of 1 to 1 1/2 pounds per 100 sq ft to flower beds and planting areas. ... For trees and larger shrubs, apply 1/2 to 1 pound of this fertilizer per in\"" },
  { name: "LESCO 8-0-10 Palm & Tropical", basis: "other", rate: null, min: 1, max: 1.5, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/556996587978_label/556996587978-label.pdf — \"Apply LESCO 8-0-10 Palm and Tropical Ornamental Fertilizer at the rate of 1 to 1 1/2 pounds per 100 sq ft to flower beds and planting areas. ... For trees and larger shrubs, apply 1/2 to 1 pound of this fertilizer per in\"" },
  { name: "LESCO 8-2-12 100% Poly Plus OPTI Kieserite 4% Mg 9.26% S 0.15% B 0.05% Cu 0.15% Fe 2% Mn 0.15% Zn Palm & Tropical Ornamental Granular Fertilizer", basis: "other", rate: null, min: 1, max: 1.5, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-20525_358551_label_510268-opti-label-823033/rb-ue-labels-20525-358551-label-510268-opti-label-823033.pdf — \"Apply LESCO 8-2-12 Palm and Tropical Ornamental Fertilizer at the rate of 1 to 1 1/2 pounds per 100 sq ft to flower beds and planting areas. ... For trees and larger shrubs, apply 1/2 to 1 pound of this fertilizer per in\"" },
  { name: "LESCO 9-0-24 56% PolyPlus", basis: "per_1000_sqft", rate: 4.16, min: null, max: null, unit: "lb", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-16620_339280_label_510068-label-218128/rb-ue-labels-16620-339280-label-510068-label-218128.pdf — \"COVERAGE: 50 pounds of LESCO 9-0-24 Fertilizer covers approximately 12,000 sq ft at the application rate of one pound of potash (4.16 pounds of fertilizer) per 1,000 sq ft.\"" },
  { name: "LESCO 90/10 Nonionic Surfactant", basis: "per_gallon", rate: 0.2, min: 0.03, max: 0.64, unit: "fl_oz", epa: null,
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/550010085798_label/550010085798-label.pdf — \"USE RATES [LESCO 90/10 per 100 Gallons]: Insecticides 3 to 8 fl. oz.; Fungicides 3 to 8 fl. oz; Herbicides 1 to 4 pt.; Acaricides 3 to 8 fl. oz; Defoliants 1 to 2 pt.; Desiccants 1 to 2 pt.; Wettable powders 1 to 2 pt. F\"" },
  { name: "LESCO Crosscheck Plus", basis: "per_1000_sqft", rate: null, min: 0.18, max: 1.0, unit: "fl_oz", epa: "279-3206-10404",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/Lesco%20Crosscheck%20Plus%20Label%203-24-17.pdf — \"Armyworms, Cutworms, Sod Webworm ... 0.18 - 0.25 fluid oz. per 1000 sq. ft. Annual Bluegrass Weevil, Billbugs (Adult), Black Turfgrass Ataenius ... 0.25 - 0.5. Ants, Chinch Bugs, Imported Fire Ants, Mole Cricket, Ticks .\"" },
  { name: "LESCO Manicure 6FL Contact Fungicide", basis: "other", rate: null, min: null, max: null, unit: "fl_oz", epa: "60063-7-10404",
    note: "siteone: https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-11204_13299_label_84901-578400/rb-ue-labels-11204-13299-label-84901-578400.pdf — \"Apply this product at a rate of 1-3/8 pints per 100 gallons of water unless other directions are given in the tables below. Apply enough diluted spray per acre to provide thorough coverage of all plant parts that are int\" | NOTE: CRITICAL for FL residential lawn operator: label states 'DO NOT use on home lawns and turf sites associated with apartment buildings, daycare centers, playgrounds, recreational park athletic fields, athletic fields located on or next to schools (ie., elementary, middle and high schools), campgrounds, churches, and theme parks.' OFF-LABEL for residential lawn work." },
  { name: "LESCO Stonewall 0-0-7", basis: "per_1000_sqft", rate: null, min: 4.02, max: 5.34, unit: "lb", epa: "10404-89",
    note: "distributor_label_pdf: https://trimlinelandscape.com/hubfs/Fertilizer%20with%20Stonewall%20LABEL.pdf — \"Use at an initial rate of 175 to 233 lb/acre per application followed by sequential applications at doses that would not exceed the maximum annual application rate of 349 lb/acre/year. ... Bermudagrass / Bahiagrass / Cen\"" },
  { name: "LESCO Stonewall 0.37% 18-0-10", basis: "per_1000_sqft", rate: null, min: 3.1, max: 9.3, unit: "lb", epa: "10404-114",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/010404-00114-20150617.pdf — \"MAXIMUM ANNUAL RATES ... Bermudagrass / Bahiagrass / Centipedegrass / Seashore Paspalum / St. Augustinegrass / Tall Fescue (including turf-type) / Zoysia: 405 [lb Plus Fertilizer / Acre], 9.3 [lb/1,000 sq ft], 1.5 [lb a.\"" },
  { name: "LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide", basis: "per_1000_sqft", rate: null, min: 0.5, max: 1.1, unit: "fl_oz", epa: "100-1139-10404",
    note: "siteone: https://www.siteone.com/en/pdf/sdsPDF?resourceId=33935 — \"MAXIMUM APPLICATION RATE OF LESCO STONEWALL 4FL HERBICIDE PER CALENDAR YEAR BY TURF SPECIES: Bermudagrass / Bahiagrass / Centipedegrass / Kikuyugrass / Seashore Paspalum / St. Augustinegrass / Tall Fescue (including turf\"" },
  { name: "LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide", basis: "per_1000_sqft", rate: null, min: 1.75, max: 1.75, unit: "fl_oz", epa: "228-626",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/Lesco%20T-Storm%20Label%2010-21-11.pdf — \"Use Sites and Maximum Application Rates ... Residential and Public Areas (home lawns, parks, athletic fields, schools, day care centers): Maximum Single Application Rate 1.75 fl. oz./1,000 sq. ft; Maximum Seasonal Application Rate 7 fl. oz./1,000 sq. ft\" | NOTE: DB listed EPA N/A; label prints EPA Reg. No. 228-626. Disease table runs 1.75-5.33 fl oz/1,000 sq ft but rates above 1.75 are golf-course-only; residential/public turf is capped at 1.75 per single application." },
  { name: "Mainspring GNL Insecticide", basis: "per_1000_sqft", rate: null, min: 0.046, max: 0.459, unit: "fl_oz", epa: "100-1543",
    note: "manufacturer: https://assets.syngenta-us.com/pdf/labels/SCP%201543A-L1A_0923.pdf — \"Turf caterpillars (including armyworms, cutworms, and sod webworms) 2 - 16 fl oz [per Acre] 0.046 - 0.367 fl oz [per 1,000 sq ft] ... White grubs ... 8 - 16 fl oz 0.184 - 0.367 fl oz ... Annual bluegrass weevil 12 - 20 f\"" },
  { name: "Manor", basis: "other", rate: null, min: 0.25, max: 1.0, unit: "oz", epa: "228-373",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000228-00373-20101118.pdf — \"USE ON ST. AUGUSTINEGRASS, BERMUDAGRASS, BUFFALOGRASS AND ZOYSIAGRASS (MEYERS AND EMERALD): Apply 0.25 to 1.0 ounce of this product per acre for weed control. Some chlorosis or stunting of the turfgrass may occur followi\" | NOTE: PER-ACRE product (dry oz/acre of 60% metsulfuron-methyl WSG; typical rates are fractions of an ounce per acre - do not confuse with per-1,000 products). Nufarm Manor Select" },
  { name: "Merit 2F", basis: "per_1000_sqft", rate: null, min: 0.46, max: 0.6, unit: "fl_oz", epa: "432-1312",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000432-01312-20161024.pdf — \"TURFGRASSES (Residential home lawns, business and office complexes...) LARVAE OF: Annual bluegrass weevil ... Japanese beetle ... 1.25 to 1.6 pt/A or 0.46 to 0.6 fl oz (14 to 17 mL) per 1,000 sq ft ... Chinch bugs (suppr\"" },
  { name: "Monument 75WG", basis: "other", rate: null, min: 0.35, max: 0.53, unit: "oz", epa: "100-1134",
    note: "manufacturer: https://assets.syngenta-us.com/pdf/labels/SCP1134AL1E0621.pdf — \"Apply Monument 75WG in 1 to 2 gallons water per 1000 sq ft. Use rates of 0.35 to 0.53 oz/A (10-15 grams or 2-3 packets) to control**\"" },
  { name: "Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide", basis: "per_1000_sqft", rate: null, min: 1.84, max: 3.67, unit: "lb", epa: "66330-70-59639",
    note: "distributor_label_pdf: https://www.conncoll.edu/media/website-media/offices/ehs/envhealthdocs/Arena_.25G_Label.pdf — \"TURFGRASS ... APPLICATION RATE 1.84-3.67 lbs per 1,000 sq ft / 80-160 lbs per acre (0.2-0.4 lbs ai/A) ... Arena 0.25 G can be applied to turf at 80-160 lbs per acre. The rate is dependent on the target pest(s), their sta\"" },
  { name: "Nufarm Cleary 3336F Fungicide", basis: "per_1000_sqft", rate: null, min: 2, max: 2, unit: "fl_oz", epa: "1001-69",
    note: "distributor_label_pdf: http://www.cdms.net/ldat/ld3N2001.pdf — \"Table 1 Residential or Public Areas: Maximum Application Rate of 3336 F = 0.68 Gallon/Acre (2 fl oz / 1,000 sq ft); Minimum Retreatment Interval 14 days\" | NOTE: Table 3 disease rates run 2-6 fl oz/1,000 sq ft but rates above 2 are golf tees/greens/fairways-only; residential/public turf is capped at 2 per application (Table 1)." },
  { name: "Onslaught Fastcap", basis: "per_gallon", rate: null, min: 0.5, max: 1.0, unit: "fl_oz", epa: "1021-2574",
    note: "distributor_label_pdf: https://indfumco.com/wp-content/uploads/2020/10/Onslaught-Fastcap-Spider-Scorpion-Insecticide-Label-EPA-1021-2574-8.27.20.pdf — \"Use 0.5 fl. oz. of Onslaught FastCap Spider & Scorpion Insecticide in 1 gallon of water for light infestations or as a maintenance control rate. Use 1.0 fl. oz. per gallon of water for heavy infestations or as an initial\"" },
  { name: "PGF Complete 16-4-8", basis: "per_1000_sqft", rate: 3.6, min: 1.8, max: 3.6, unit: "lb", epa: null,
    note: "manufacturer: https://assets.theandersons.com/asset/06649983-6b6d-4df9-b13c-ab3f8cc09458/pgf-complete-16-4-8-fertilizer-label-pdf.pdf — \"SPREADER SETTINGS: This bag is designed to deliver 3.6 lbs. of product per 1,000 sq. ft., for a total coverage of 5,000 sq. ft. [Spreader table columns:] LOW RATE 1.8 lbs/1,000 sq. ft. — HIGH RATE 3.6 lbs/1,000 sq. ft.\"" },
  { name: "Permethrin SFR", basis: "per_gallon", rate: 1.67, min: 1.67, max: 3.33, unit: "fl_oz", epa: "53883-90",
    note: "manufacturer: https://www.controlsolutionsinc.com/hubfs/Specimen%20Labels/Specimen-PermethrinSFR-53883-90.pdf?hsLang=en — \"Broadcast Treatment for Control of Nuisance Pests: Apply using a 0.5% emulsion as a residual spray to outside surfaces of buildings... [Rate/Volume Conversion Chart] Desired Gallons of Finished Emulsion: 1 -- 0.5%: 1 2/3\"" },
  { name: "Pillar G Intrinsic", basis: "per_1000_sqft", rate: 3.0, min: null, max: null, unit: "lb", epa: "7969-304",
    note: "distributor_label_pdf: https://www.domyown.com/msds/Pillar_G_Intrinsic_Label.pdf — \"Apply Pillar G Intrinsic at a use rate of 3.0 lbs product/1000 sq ft (131 lbs product/A) on a 14-day to 28-day interval for the following diseases.\"" },
  { name: "QP MSM 60DF Turf Herbicide", basis: "other", rate: null, min: 0.25, max: 1.0, unit: "oz", epa: "66222-146-73220",
    note: "distributor_label_pdf: https://docs.diypestcontrol.com/SPEC/LABELS/msm_turf_herbicide_label.pdf — \"St. Augustinegrass, Bermudagrass and Zoysiagrass (Meyers and Emerald): Apply 0.25 to 1.0 oz. of Quali-Pro MSM Turf Herbicide per acre for weed control. Some chlorosis or stunting of the turfgrass may occur following appl\"" },
  { name: "Quali-Pro", basis: "per_1000_sqft", rate: null, min: 0.46, max: 0.6, unit: "fl_oz", epa: "66222-203",
    note: "distributor_label_pdf: https://www.domyown.com/msds/Quali_Pro_Imidacloprid_2F_Label_2022.pdf — \"TURF GRASSES ... Larvae of: Annual bluegrass weevil ... Japanese beetle ... 1.25 to 1.6 pt/A or 0.46 to 0.6 fl. oz. (14 to 17 mL) per 1000 sq. ft. ... Chinch bugs (suppression) Mole crickets 1.6 pt /A or 0.6 fl. oz. (17 \"" },
  { name: "Quali-Pro PPZ 14.3 Propiconazole", basis: "per_1000_sqft", rate: null, min: 1, max: 2, unit: "fl_oz", epa: "53883-363",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/Quali-Pro%20Propiconazole%2014.3%20Label%208-22-23.pdf — \"Brown Patch (Rhizoctonia solani): 1-2 fl. oz. per 1000 sq. ft. (0.01-0.02 lbs. A.I./1000 Sq. Ft.), 44-88 fl oz/acre, 14-21 days. Dollar Spot: 0.5-1 fl oz/1000 sq ft with tank mix, or 1-2 fl. oz. per 1000 sq. ft. without \"" },
  { name: "Recognition Post Emergent Herbicide", basis: "per_1000_sqft", rate: null, min: 0.03, max: 0.045, unit: "oz", epa: "100-1658",
    note: "manufacturer: https://assets.syngenta-us.com/pdf/labels/SCP%201658B-L1C%200224.pdf — \"Broadleaves, sedges, and grass weeds listed in Section 6.1 — Use Rate: 1.29 – 1.95 oz/A; 0.030 – 0.045 oz/1,000 sq feet (0.260 - 0.398 oz trifloxysulfuron-sodium) — Apply postemergence when weeds are actively growing. A \"" },
  { name: "Roundup QuikPro SC", basis: "per_1000_sqft", rate: 16, min: null, max: null, unit: "fl_oz", epa: "432-1532",
    note: "distributor_label_pdf: https://www.arborchem.com/Images/Label-SDS/Roundup%20QuickPro%20SC%20Total%20Label.pdf — \"Add 16 oz of product per 1 gallon of water. ... Rate: 16 fl oz Product — Add To: 1 gal of water — Covers: 1000 sq ft. Note: Do Not Apply more than a maximum of 32 fl oz/ 1000 sq ft per year.\"" },
  { name: "Safari 20 SG", basis: "per_1000_sqft", rate: null, min: 0.2, max: 0.4, unit: "oz", epa: "86203-11-59639",
    note: "distributor_label_pdf: https://www.cdms.net/ldat/ldAC2000.pdf — \"Foliar Spray 1/4 to 1/2 lb per 100 gallons (4 to 8 oz per 100 gallons) ... 8-16 oz per Acre ... 0.2-0.4 oz per 1,000 sq ft ... For treatment of small areas: 1/2-1.0 tsp per gallon. One (1) level teaspoon contains 2.4 gra\"" },
  { name: "Scion Insecticide", basis: "per_gallon", rate: null, min: 0.16, max: 0.65, unit: "fl_oz", epa: "279-3612",
    note: "distributor_label_pdf: https://labelsds.com/images/user_uploads/Scion%20Label%206-3-22.pdf — \"Rate range: 0.0075% ai 0.16 fl oz (5 mL)/gal water ... Up to 0.015% ai 0.33 fl oz (10 mL)/gal water | 0.03% ai 0.65 fl oz (20 mL)/gal water 2.0 fl oz (60 mL)/3 gal water | Rate Table For Perimeter Barrier Applications: A\"" },
  { name: "Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide", basis: "per_1000_sqft", rate: 0.9, min: null, max: null, unit: "g", epa: "81880-1-10163",
    note: "manufacturer: https://www.gowanco.com/sites/default/files/gowanco_com/_media/content/sedgehammer_1.33_spec_label_11-2018.pdf — \"Spot Treatments: Mix 0.9 g of this product in 1 or 2 gal of water to treat 1000 sq ft. Add 2 tsp (1/3 fl oz) of nonionic surfactant per gallon of water. | Broadcast Applications: Apply SEDGEHAMMER as a postemergence spra\"" },
  { name: "Segment II Herbicide", basis: "per_1000_sqft", rate: null, min: 0.6, max: 0.9, unit: "fl_oz", epa: "7969-398",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/007969-00398-20170530.pdf — \"Table 1. Application Rates for Annual Grass Control — Maximum Rate per Application: Grasses up to 6 inch height: 1.5 pints per acre or 0.6 fluid ounce per 1,000 square feet; Grasses up to 12 inch height: 2.5 pints per ac\"" },
  { name: "Shortstop 2SC Plant Growth Regulator for Trees & Shrubs", basis: "other", rate: null, min: 0.75, max: 4, unit: "g", epa: "62097-34",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/062097-00034-20220106.pdf — \"Applications are made with a diluted mixture composed of one part Shortstop 2SC to 11 parts water. Mix 10.7 fl oz (317 mL) of Shortstop 2SC with water to make one gallon of diluted mixture. ... Table 1: Application Rate \"" },
  { name: "Snapshot 2.5TG", basis: "per_1000_sqft", rate: null, min: 2.3, max: 4.6, unit: "lb", epa: "62719-175",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/062719-00175-20230811.pdf — \"Broadcast Rates — Rate lb/Acre 100: Amount/1000 sq ft 2.30 lb (1.75 quarts); 150: 3.45 lb (2.60 quarts); 200: 4.60 lb (3.50 quarts). | Weeds controlled when applied at 100 lb per acre (2.3 lb per 1000 sq ft)\"" },
  { name: "Specticle Flo", basis: "other", rate: null, min: 6, max: 10, unit: "fl_oz", epa: "101563-207",
    note: "manufacturer: https://bynder.envu.com/m/274eb1a770bb3059/original/Digital_TO_Specticle-FLO_label_NA_US_EN.pdf — \"Apply SPECTICLE FLO HERBICIDE in a single or split application program. The maximum single application rate of SPECTICLE FLO HERBICIDE is 10 fl oz per acre. The total amount of SPECTICLE FLO HERBICIDE applied in a 12-mon\"" },
  { name: "Subdue Maxx Fungicide", basis: "per_1000_sqft", rate: null, min: 0.5, max: 1.0, unit: "fl_oz", epa: "100-796",
    note: "manufacturer: https://assets.syngenta-us.com/pdf/labels/SCP%20796B-L2P%200724.pdf — \"Pythium blight / Pythium damping-off / Yellow tuft (downy mildew): 0.50 - 1.0 fl oz (0.0078 - 0.0156 lb ai) per 1,000 sq ft. Within the rate range given for turf, use the lowest listed rate for the shortest listed interv\"" },
  { name: "SuffOil-X Spray Oil Emulsion", basis: "other", rate: null, min: 1.0, max: 2.0, unit: null, epa: "48813-1-68539",
    note: "manufacturer: https://bioworksinc.com/wp-content/uploads/products/suffoil-x/suffoil-x-label.pdf — \"SHADE TREES, SHRUBS, ORNAMENTALS, FLOWER AND FOLIAGE PLANTS, CHRISTMAS TREES ... APPLICATION RATE Gallons of SuffOil-X Per 100 Gallons of Water: Conifers, Flower, Foliage and Bedding Plants, Ornamentals*, Shade Trees, Sh\"" },
  { name: "Summit Mosquito Dunk Tablets", basis: "other", rate: 1, min: null, max: null, unit: null, epa: "6218-47",
    note: "manufacturer: https://summitchemical.com/wp-content/uploads/2021/01/110-12-SPECIMEN_DUNKS.pdf — \"Use one (1) MOSQUITO DUNK for up to 100 square feet of water surface, regardless of depth. ... [dosage table] 1 to 5 square ft.: 1/4 DUNK; 5 to 25 square ft.: 1/2 DUNK; 25 to 100 square ft.: 1 DUNK; Above 100 square ft.:\"" },
  { name: "SureGuard SC", basis: "per_gallon", rate: null, min: 0.18, max: 0.27, unit: "fl_oz", epa: "71368-114",
    note: "distributor_label_pdf: https://theturftrade.com/wp-content/uploads/2019/07/Sureguard-SC.pdf — \"PREEMERGENCE APPLICATION (NO WEEDS ARE PRESENT): Mix 0.18 to 0.27 fl oz (5.3 to 8.1 mls) of this product per gallon of spray solution, and apply 1 gallon of spray solution to 1,000 square feet (8 to 12 fl oz/A) prior to \" | NOTE: Nufarm SureGuard SC, flumioxazin 41.4% (4 lb/gal), EPA 71368-114. Dilution 0.18-0.27 fl oz/gal applied at 1 gal/1000 sq ft = broadcast equivalent 8-12 fl oz/A; same " },
  { name: "Suspend Polyzone", basis: "per_gallon", rate: null, min: 0.25, max: 1.5, unit: "fl_oz", epa: "432-1514",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000432-01514-20160920.pdf — \"When 1.5 fl oz (45.4 ml) is diluted in one gal of water, the active ingredient concentration is equivalent to 0.06% Deltamethrin. Use of the 1.5 fl oz (0.06%) rate is recommended for severe pest infestations or when long\"" },
  { name: "Suspend SC", basis: "per_gallon", rate: null, min: 0.25, max: 1.5, unit: "fl_oz", epa: "101563-4",
    note: "manufacturer: https://bynder.envu.com/m/3188c640dbe60647/original/Digital_PPM_Suspend-SC_label_NA_US_EN.pdf — \"1. When 1.5 fl oz (45.4 ml) is diluted in one gal of water, the active ingredient concentration is equivalent to 0.06% Deltamethrin. Use of the 1.5 fl oz (0.06%) rate is recommended for severe pest infestations or when l\"" },
  { name: "T-Zone SE", basis: "per_1000_sqft", rate: null, min: 0.75, max: 0.83, unit: "fl_oz", epa: "2217-976",
    note: "distributor_label_pdf: https://www.cdms.telusagcg.com/ldat/ldBUF011.pdf — \"Table 1. Use Rates For Ornamental Turfgrass, Sod Farms, and Non-Cropland — Warm-season Turf (Dormant Turf): Hybrid Bermudagrass, common Bermudagrass, zoysiagrass, and bahiagrass — 2 to 2.25 Pints/Acre (0.75 to 0.83 fl.oz\"" },
  { name: "Talus 70 DF IGR", basis: "other", rate: null, min: 6, max: 14, unit: "oz", epa: "71711-21-67690",
    note: "distributor_label_pdf: https://greenhouse.ucdavis.edu/pest/labels/talus70df.pdf — \"APPLICATION RATE CHART FOR TALUS 70DF INSECT GROWTH REGULATOR - Ornamental Plants in greenhouses; lath and shadehouses; nurseries; landscape ornamentals; ground covers; field-and container-grown ornamentals; non-bearing \"" },
  { name: "Taurus SC", basis: "per_gallon", rate: 0.8, min: 0.8, max: 1.6, unit: "fl_oz", epa: "53883-279",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/053883-00279-20191126.pdf — \"To mix a 0.06% dilution, add 0.8 fluid ounces of Taurus SC per gallon of finished dilution. To mix a 0.09% dilution, add 1.2 fluid ounces of Taurus SC per gallon of finished dilution. To mix a 0.125% dilution, add 1.6 fl\"" },
  { name: "Tekko Pro IGR", basis: "per_gallon", rate: 1, min: 1, max: 2, unit: "fl_oz", epa: "53883-335",
    note: "manufacturer: https://www.controlsolutionsinc.com/hubfs/Specimen%20Labels/Specimen-TekkoPro-53883-335.pdf — \"Spray Mixing: Prepare a diluted spray solution by adding 1 fluid ounce Tekko Pro per gallon of water. Partially fill the mixing container with water, add Tekko Pro, agitate and fill to final volume. ... [Animal Runs, Law\"" },
  { name: "Temprid FX", basis: "per_gallon", rate: null, min: 0.27, max: 0.54, unit: "fl_oz", epa: "101563-165",
    note: "manufacturer: https://bynder.envu.com/m/779dbe7a72baeff8/original/Digital_PPM_Temprid-FX_label_NA_US_EN.pdf — \"Use Rate: 0.075% - - 0.27 fl oz (8 milliliters) per gallon of water. 0.15% - - 0.54 fl oz (16 milliliters) per gallon of water, or 0.27 fl oz (8 ml) per half gallon of water.\"" },
  { name: "Tenacity Herbicide", basis: "other", rate: null, min: 4, max: 8, unit: "fl_oz", epa: "100-1267",
    note: "manufacturer: https://assets.syngenta-us.com/pdf/labels/SCP%201267A-L1D%200922.pdf — \"Postemergence Application – Apply Tenacity at 4-8 fl oz per acre (0.125-0.25 lb ai/A) in at least 30 gallons of water per acre. Apply with a NIS type surfactant. ... DO NOT exceed 4 fl oz per acre (0.125 lb ai/A) to St. Augustinegrass sod. ... St. Augustinegrass (sod uses only)\" | NOTE: Rate basis is per ACRE; label's own conversion = 0.092-0.184 fl oz/1000 sq ft. Spot: 1 tsp Tenacity + 3 tsp NIS per 2 gal, applied at 1 gal/1000 sq ft. Max 16 fl oz/A/yr. CRITICAL: the label's turf table lists St. Augustinegrass as 'grown for sod' / 'sod uses only' — OFF-LABEL on established residential St. Augustine lawns." },
  { name: "Termidor Foam", basis: "other", rate: null, min: null, max: null, unit: null, epa: "499-563",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000499-00563-20130912.pdf — \"This product is a ready-to-use insecticide formulation. When dispensed, the formulation rapidly expands generating a dry foam with an expansion ratio of approximately 30:1, with 1 oz (weight) of product being dispensed i\"" },
  { name: "Termidor SC", basis: "per_gallon", rate: 0.8, min: 0.8, max: 1.6, unit: "fl_oz", epa: "7969-210",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/007969-00210-20230815.pdf — \"(Table 2.) 0.06% Termidor SC Finished Dilution -- 1 gal finished dilution : 1.0 gal water : 0.8 fl oz Termidor SC (100 gal : 99.25 gal water : 78.0 fl oz). Termidor SC is labeled for use at 0.06%, 0.09%, or 0.125% finish\"" },
  { name: "Tetrino Insecticide", basis: "per_1000_sqft", rate: null, min: 0.367, max: 0.735, unit: "fl_oz", epa: "432-1591",
    note: "distributor_label_pdf: https://spsonline.com/wp-content/uploads/2024/10/Tetrino-Label.pdf — \"Table 1: TURF APPLICATION RATES ... White Grubs ... Japanese beetle ... 0.367 - 0.735 [FLUID OUNCES PRODUCT/1,000 SQ. FT.] 16 - 32 [FLUID OUNCES PRODUCT/ACRE] ... Caterpillars Armyworm, cutworms, and sod webworms 0.367 -\"" },
  { name: "Trelona ATBS Bait Station", basis: "other", rate: null, min: null, max: 20, unit: null, epa: "499-557",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000499-00557-20190909.pdf — \"Install stations around a structure such that, except where sufficient access to the ground is not available, the maximum interval between any two stations does not exceed 20 feet.\"" },
  { name: "Trelona Compressed Termite Bait Cartridges", basis: "other", rate: null, min: null, max: 20, unit: null, epa: "499-557",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/000499-00557-20190909.pdf — \"Install stations around a structure such that, except where sufficient access to the ground is not available, the maximum interval between any two stations does not exceed 20 feet. ... In Florida, ... use two 124 gram ca\"" },
  { name: "Tribute Total WDG", basis: "per_1000_sqft", rate: null, min: 0.023, max: 0.073, unit: "oz", epa: "101563-147",
    note: "manufacturer: https://bynder.envu.com/m/3c398f693da5477b/original/Digital_TO_Tribute-Total_label_NA_US_EN.pdf — \"PRODUCT USE RATES — BROADCAST APPLICATIONS: To Treat 1 Acre oz/Acre 1 / 2 / 3.2 — To Treat 1,000 Square Feet oz/1,000 sq ft 0.023 / 0.046 / 0.073 — Maximum single application rate is 3.2 oz/acre. ... Removal of Overseeded Ryegrass in Bermudagrass and Zoysiagrass of Commercial and Residential Sites ... Do not use Tribute Total on pure stands or mixtures of turfgrasses not listed on this label without first testing for adequate turf tolerance\" | NOTE: CRITICAL: labeled turf = well-established BERMUDAGRASS and ZOYSIAGRASS cultivars only — OFF-LABEL on St. Augustine/bahia/centipede lawns (it controls cool-season and non-listed grasses)." },
  { name: "Vendetta Plus", basis: "other", rate: 0.5, min: 0.25, max: 0.5, unit: "g", epa: "1021-2593",
    note: "epa_ppls: https://www3.epa.gov/pesticides/chem_search/ppls/001021-02593-20200319.pdf — \"For light infestations of German roaches, 4 - 6 bait points are recommended per 100 sq. ft. (9.3 m2) of treatment area. For heavy infestations of German roaches, 12 - 24 bait points are recommended per 100 sq. ft. (9.3 m\"" },
  { name: "Zylam Insecticide", basis: "other", rate: null, min: null, max: null, unit: "fl_oz", epa: "2217-937",
    note: "distributor_label_pdf: https://www.domyown.com/msds/Zylam_Liquid_Systemic_Insecticide_Label_2022.pdf — \"Foliar Applications to Landscape Ornamental Plants ... Product Rate: 7.25 fl.oz. to 16 fl.oz. per 100 gallons of water. Apply in sufficient water to ensure thorough coverage of target area. Use a minimum of 50 gallons fi\"" },];

function emptyText(v) { return v == null || String(v).trim() === '' || String(v).trim().toUpperCase() === 'N/A'; }

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  // Track which corrections actually fired: a row that already carries the
  // corrected registration (dev/preview DB, prior admin fix) must NOT have
  // its note/stamps force-replaced — admin edits win when we changed nothing.
  const epaApplied = new Set();
  for (const [name, wrong, right] of EPA_CORRECTIONS) {
    const n = await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .where('epa_reg_number', wrong)
      .update({ epa_reg_number: right, updated_at: new Date() });
    if (n) epaApplied.add(name.toLowerCase());
  }

  // Track which legacy corrections actually fired so the DATA loop below can
  // append provenance for the corrected value even when it has nothing else
  // to write (a corrected row's rate fields are no longer empty by the time
  // the loop inspects them).
  const legacyApplied = new Set();
  for (const [name, oldVals, newVals] of LEGACY_CORRECTIONS) {
    const n = await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .where(oldVals)
      .update({ ...newVals, updated_at: new Date() });
    if (n) legacyApplied.add(name.toLowerCase());
  }

  for (const d of DATA) {
    const row = await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [d.name])
      .first();
    if (!row) continue;
    const isEpaCorrection = epaApplied.has(d.name.toLowerCase());
    const updates = {};
    if (d.basis === 'per_1000_sqft') {
      const rate = d.rate != null ? d.rate : d.min;
      // A label that names a single rate with no band IS its own ceiling —
      // applying above the only labeled rate is off-label, and the
      // over-label warning needs max_label_rate_per_1000 to catch it.
      const max = d.max != null ? d.max : (d.rate != null && d.min == null ? d.rate : null);
      if (rate != null && row.default_rate_per_1000 == null) updates.default_rate_per_1000 = rate;
      if (d.min != null && row.min_label_rate_per_1000 == null) updates.min_label_rate_per_1000 = d.min;
      if (max != null && row.max_label_rate_per_1000 == null) updates.max_label_rate_per_1000 = max;
      if (d.unit && emptyText(row.rate_unit)) updates.rate_unit = d.unit;
    } else if (d.basis === 'per_gallon') {
      const display = d.rate != null
        ? String(d.rate)
        : (d.min != null && d.max != null ? `${d.min}-${d.max}` : null);
      if (display != null && emptyText(row.default_rate)) updates.default_rate = display;
      if (d.unit && emptyText(row.default_unit)) updates.default_unit = `${d.unit}/gal`;
    }
    if (d.epa && emptyText(row.epa_reg_number)) updates.epa_reg_number = d.epa;
    // EPA-corrected rows REPLACE their audit note/stamps — an older seed's
    // note citing the superseded reg number must not outlive the correction.
    if (d.note && (emptyText(row.label_source_note) || isEpaCorrection)) {
      updates.label_source_note = d.note;
    } else if (d.note
        // basis "other" rows carry their verified rate ONLY in the note, so
        // the append must fire even when there are no field updates.
        && (Object.keys(updates).length || d.basis === 'other' || legacyApplied.has(d.name.toLowerCase()))
        && !row.label_source_note.endsWith(d.note)) {
      // A row verified by an earlier batch keeps its note, but the rate
      // fields written above need provenance too — append, never replace.
      updates.label_source_note = `${row.label_source_note} | ${d.note}`;
    }
    // Stamp only rows this migration actually wrote to: stamping an untouched
    // row would claim its (possibly admin-entered) values as label-verified
    // AND hand down() ownership to null fields we explicitly skipped.
    if ((Object.keys(updates).length && row.label_verified_at == null) || isEpaCorrection) {
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

  // EPA_CORRECTIONS and LEGACY_CORRECTIONS are intentionally NOT reverted:
  // rolling back to a registration number or dilution display proven wrong
  // against the label would corrupt current catalog data, and a row corrected
  // before/after this migration is indistinguishable from one it corrected.

  for (const d of DATA) {
    const row = await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [d.name])
      .first();
    if (!row) continue;
    // Only rows we stamped are candidates; a row verified by someone else
    // (earlier batch or admin) was not written by up() beyond fill-if-empty
    // fields we can't distinguish — leave those standing.
    if (row.label_verified_by !== VERIFIED_BY) continue;
    const reverts = {
      label_verified_at: null,
      label_verified_by: null,
    };
    if (d.basis === 'per_1000_sqft') {
      const rate = d.rate != null ? d.rate : d.min;
      const max = d.max != null ? d.max : (d.rate != null && d.min == null ? d.rate : null);
      // eslint-disable-next-line eqeqeq
      if (rate != null && row.default_rate_per_1000 == rate) reverts.default_rate_per_1000 = null;
      // eslint-disable-next-line eqeqeq
      if (d.min != null && row.min_label_rate_per_1000 == d.min) reverts.min_label_rate_per_1000 = null;
      // eslint-disable-next-line eqeqeq
      if (max != null && row.max_label_rate_per_1000 == max) reverts.max_label_rate_per_1000 = null;
      if (d.unit && row.rate_unit === d.unit) reverts.rate_unit = null;
    } else if (d.basis === 'per_gallon') {
      const display = d.rate != null
        ? String(d.rate)
        : (d.min != null && d.max != null ? `${d.min}-${d.max}` : null);
      if (display != null && row.default_rate === display) reverts.default_rate = null;
      if (d.unit && row.default_unit === `${d.unit}/gal`) reverts.default_unit = null;
    }
    // epa_reg_number is NEVER reverted: a value equal to ours may have been
    // present before up() ran (fill-if-empty can't be distinguished from
    // pre-existing data on rollback), and replacing a label-verified
    // registration with the 'N/A' sentinel destroys information either way.
    // Corrected registrations stay corrected for the same reason.
    if (d.note && row.label_source_note === d.note) {
      reverts.label_source_note = null;
    } else if (d.note && row.label_source_note && row.label_source_note.endsWith(` | ${d.note}`)) {
      // Strip only our appended provenance; the earlier batch's note stays.
      reverts.label_source_note = row.label_source_note.slice(0, -(` | ${d.note}`.length));
    }
    await knex('products_catalog')
      .where({ id: row.id })
      .update({ ...reverts, updated_at: new Date() });
  }
};
