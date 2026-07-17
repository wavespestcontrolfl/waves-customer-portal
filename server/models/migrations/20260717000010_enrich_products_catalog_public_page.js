/**
 * Enrich the customer-facing products_catalog rows for the /products-and-safety
 * transparency page (astro hub). Fills label-derived fields that were NULL on
 * the SiteOne-imported and portal-only rows: signal_word, formulation,
 * reentry_text, target_pests, application_zones, public_summary,
 * pet_kid_guidance_text, label_url, sds_url. Values are from the current
 * EPA-registered product labels + SDS (verified 2026-07-17).
 *
 * SAFE BY CONSTRUCTION:
 *  - Every column uses COALESCE(<col>, :value) so admin-entered values are
 *    preserved and only NULLs are populated (waves-db read-modify-write rule).
 *    jsonb columns use COALESCE(<col>, :value::jsonb) so an existing [] is kept.
 *  - It NEVER touches an already-fully-public row: every update carries a
 *    'NOT (content_status = approved_for_public AND customer_visibility = public)'
 *    guard (IS DISTINCT FROM, NULL-safe), so nothing already live on the page can
 *    change here. Demand CS (already public) is left exactly as-is; the owner
 *    enriches it during the approval pass. Publishing the rest is the owner's
 *    one-step flip to approved_for_public + public.
 * Rows match by exact name. down() is a non-destructive no-op (additive seed;
 * prior NULLs are not restorable; provenance tagged via label_source_note).
 */
const SEED_NOTE = 'products-safety-enrichment 2026-07-17 (label-verified)';

const PRODUCTS = [
  {
    "name": "Demand CS",
    "signal_word": "CAUTION",
    "formulation": "Microencapsulated (CS)",
    "reentry_text": "Let treated surfaces dry before people or pets contact them; for lawn applications, keep children and pets off treated areas until the spray has dried.",
    "target_pests": [
      "Ants",
      "Cockroaches",
      "Spiders",
      "Fleas",
      "Ticks",
      "Wasps",
      "Scorpions"
    ],
    "application_zones": [
      "Exterior foundation perimeter",
      "Eaves & entry points",
      "Targeted cracks & crevices"
    ],
    "public_summary": "A long-standing professional perimeter insecticide. The microcapsule formulation releases slowly, so a small amount of active ingredient keeps working along entry points rather than being broadcast across open surfaces.",
    "pet_kid_guidance_text": "Kept to the exterior perimeter and targeted interior cracks, not open floors. People and pets stay off treated surfaces until they have dried. Like most pyrethroids it is toxic to fish, so it is kept away from aquariums and ponds.",
    "label_url": "https://assets.syngentapmp.com/pdf/labels/SCP-1066AL1P11142.pdf",
    "sds_url": "https://assets.syngentapmp.com/pdf/msds/Demand%20CS.pdf"
  },
  {
    "name": "Advion Cockroach Gel Bait",
    "signal_word": "CAUTION",
    "formulation": "Gel bait",
    "reentry_text": "A bait placed in cracks and voids, not a spray; placements go only where children and pets cannot reach.",
    "target_pests": [
      "German cockroach",
      "American cockroach",
      "Brown-banded cockroach",
      "Oriental cockroach"
    ],
    "application_zones": [
      "Cracks & crevices",
      "Concealed voids",
      "Out of reach of children & pets"
    ],
    "public_summary": "A targeted cockroach gel placed as small dots inside cracks and voids where roaches travel. Because it is a bait, there is no treated surface your family contacts.",
    "pet_kid_guidance_text": "Placed only in cracks and voids inaccessible to children and pets, never on open or food-contact surfaces.",
    "label_url": "https://assets.syngentapmp.com/pdf/labels/SCP%201484A-L1D%200724.pdf",
    "sds_url": "https://assets.syngentapmp.com/pdf/msds/03_30828%2005192017.pdf"
  },
  {
    "name": "Advion WDG Granular",
    "signal_word": "CAUTION",
    "formulation": "Granular bait",
    "reentry_text": "A dry granular bait; not watered in, and not applied indoors where children or pets have access.",
    "target_pests": [
      "Ants",
      "Mole crickets",
      "Crickets",
      "Cockroaches",
      "Earwigs",
      "Silverfish"
    ],
    "application_zones": [
      "Exterior lawn & landscape beds",
      "Perimeter band"
    ],
    "public_summary": "A granular bait broadcast in lawns and landscape beds or banded along the perimeter. Insects carry it back to the nest, so very little active ingredient does the work.",
    "pet_kid_guidance_text": "Applied outdoors; granules that land on hard surfaces are swept back into the treatment area. Not applied indoors where children or pets have access.",
    "label_url": "https://assets.syngentapmp.com/pdf/labels/SCP1483AL1E1219.pdf",
    "sds_url": "https://assets.syngentapmp.com/pdf/msds/ADVION%20INSECT%2004022015.pdf"
  },
  {
    "name": "Alpine WSG",
    "signal_word": "CAUTION",
    "formulation": "Water-soluble granule (WSG)",
    "reentry_text": "Children and pets are kept off treated surfaces until the spray has dried.",
    "target_pests": [
      "Ants",
      "Cockroaches",
      "Fleas",
      "Crickets",
      "Silverfish",
      "Wasps"
    ],
    "application_zones": [
      "Exterior perimeter",
      "Cracks & crevices",
      "Voids"
    ],
    "public_summary": "A low-dose perimeter and crack-and-crevice insecticide with a non-repellent active ingredient that insects carry back to the colony.",
    "pet_kid_guidance_text": "Children and pets stay off treated surfaces until dry; not applied to pets, and fish tanks are covered before any nearby interior application.",
    "label_url": "https://www.domyown.com/msds/Alpine_WSG_Label_2020.pdf",
    "sds_url": "https://www.domyown.com/msds/Alpine_WSG_SDS_2025.pdf"
  },
  {
    "name": "Bifen I/T",
    "signal_word": "CAUTION",
    "formulation": "Flowable concentrate",
    "reentry_text": "People and pets are kept off treated surfaces until the spray has dried.",
    "target_pests": [
      "Ants",
      "Spiders",
      "Mosquitoes",
      "Fleas",
      "Ticks",
      "Scorpions"
    ],
    "application_zones": [
      "Exterior perimeter",
      "Landscape & harborage",
      "Mosquito resting foliage"
    ],
    "public_summary": "A widely used professional insecticide applied around the exterior and to the shaded foliage where mosquitoes rest.",
    "pet_kid_guidance_text": "People and pets stay off treated surfaces until dry. Toxic to fish, so it is kept away from water, storm drains, and runoff paths.",
    "label_url": "https://www.controlsolutionsinc.com/hubfs/Specimen%20Labels/Specimen-BifenIT-53883-118.pdf",
    "sds_url": "https://www.agrian.com/pdfs/Bifen_IT_MSDS1i.pdf"
  },
  {
    "name": "Cyzmic CS",
    "signal_word": "CAUTION",
    "formulation": "Microencapsulated (CS)",
    "reentry_text": "Children and pets are kept off treated surfaces until the spray has dried.",
    "target_pests": [
      "Ants",
      "Cockroaches",
      "Spiders",
      "Fleas",
      "Ticks",
      "Scorpions"
    ],
    "application_zones": [
      "Exterior foundation perimeter",
      "Eaves & entry points",
      "Targeted cracks & crevices"
    ],
    "public_summary": "A microencapsulated perimeter insecticide used in rotation with other modes of action to prevent resistance.",
    "pet_kid_guidance_text": "Children and pets stay off treated surfaces until dry. Toxic to fish, so it is kept away from water and storm drains.",
    "label_url": "https://www.controlsolutionsinc.com/hubfs/Specimen%20Labels/Specimen-Cyzmic%20CS-53883-389.pdf",
    "sds_url": "https://www.agrian.com/pdfs/CYZMIC_CS_MSDS1.pdf"
  },
  {
    "name": "Atticus Talak",
    "signal_word": "CAUTION",
    "formulation": "Flowable concentrate",
    "reentry_text": "People and pets are kept off treated surfaces until the spray has dried.",
    "target_pests": [
      "Ants",
      "Spiders",
      "Mosquitoes",
      "Fleas",
      "Ticks",
      "Scorpions"
    ],
    "application_zones": [
      "Exterior perimeter",
      "Landscape & harborage"
    ],
    "public_summary": "A professional bifenthrin insecticide used for perimeter and harborage treatments, rotated with other products.",
    "pet_kid_guidance_text": "People and pets stay off treated surfaces until dry; aquariums are covered before any interior spraying. Toxic to fish.",
    "label_url": "https://atticusllc.com/wp-content/uploads/2020/08/Talak-7.9-F-Specimen.pdf",
    "sds_url": "https://atticusllc.com/wp-content/uploads/2023/04/Talak-7.9-F-SDS_20250908.pdf"
  },
  {
    "name": "Scion Insecticide",
    "signal_word": "CAUTION",
    "formulation": "Liquid concentrate (UVX)",
    "reentry_text": "Let treated surfaces dry before people or pets contact them; keep children and pets off treated areas until the spray has dried.",
    "target_pests": [
      "Mosquitoes",
      "Ants",
      "Spiders",
      "Fleas",
      "Ticks",
      "Scorpions"
    ],
    "application_zones": [
      "Mosquito resting foliage",
      "Shrubs & harborage",
      "Exterior perimeter"
    ],
    "public_summary": "A barrier insecticide with a UV-stable formulation, applied to the shaded foliage and harborage where mosquitoes rest between feedings.",
    "pet_kid_guidance_text": "Treated foliage and surfaces are dry before people or pets contact them. Toxic to fish and aquatic life, so it is kept 25 ft from water bodies.",
    "label_url": "https://bynder.envu.com/asset/26d0a78e-4acd-469c-a189-cc799ef09929/Digital_PPM_Scion_UVX_Technology_Label_NA_US_EN.pdf",
    "sds_url": "https://bynder.envu.com/asset/89098673-a78a-4945-a780-c8f5ac14bd78/Digital_PPM_Scion_SDS_NA_US_EN.pdf"
  },
  {
    "name": "Tekko Pro IGR",
    "signal_word": "CAUTION",
    "formulation": "Insect growth regulator (IGR)",
    "reentry_text": "Pets are removed before application; children and pets stay off treated areas until the spray has dried.",
    "target_pests": [
      "Fleas",
      "Ticks",
      "Mosquito larvae",
      "Cockroaches",
      "Flies"
    ],
    "application_zones": [
      "Mosquito & flea breeding sites",
      "Standing water",
      "Harborage"
    ],
    "public_summary": "A growth regulator rather than a nerve toxin: it interrupts the insect life cycle so eggs and larvae never develop into biting adults. Used in the mosquito and flea programs.",
    "pet_kid_guidance_text": "A growth regulator that targets insect development. Pets are out during application and off surfaces until dry; it is labeled for use in pet resting areas as part of a flea program.",
    "label_url": "https://www.controlsolutionsinc.com/hubfs/Specimen%20Labels/Specimen-TekkoPro-53883-335.pdf",
    "sds_url": "https://www.agrian.com/pdfs/Tekko_Pro1_MSDS.pdf"
  },
  {
    "name": "Vendetta Plus",
    "signal_word": "CAUTION",
    "formulation": "Gel bait with IGR",
    "reentry_text": "A bait placed in cracks and crevices, not a spray; placements go only where children and pets cannot reach.",
    "target_pests": [
      "German cockroach"
    ],
    "application_zones": [
      "Cracks & crevices",
      "Concealed voids",
      "Out of reach of children & pets"
    ],
    "public_summary": "A cockroach gel bait that pairs a fast active ingredient with a growth regulator, effective even on bait-averse German cockroach populations.",
    "pet_kid_guidance_text": "Placed only where children and pets cannot reach, never on food-contact surfaces.",
    "label_url": "https://mgk.com/product_docs/14976/ldDP2003.pdf",
    "sds_url": "https://www.mgk.com/product_docs/14976/mpDP2000.pdf"
  },
  {
    "name": "Termidor SC",
    "signal_word": "CAUTION",
    "formulation": "Suspension concentrate (SC)",
    "reentry_text": "Residents, children, and pets are kept out of the immediate area during application and until sprays have dried.",
    "target_pests": [
      "Subterranean termites",
      "Carpenter ants",
      "Ants"
    ],
    "application_zones": [
      "Soil trench around foundation",
      "Under-slab injection"
    ],
    "public_summary": "The professional standard for liquid termite treatment. Applied into the soil around and beneath the foundation to create a treated zone termites cannot detect.",
    "pet_kid_guidance_text": "Applied into soil and beneath slabs, not to living-space surfaces. Not applied to playground equipment or pet quarters, and not used in bee hives.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/007969-00210-20240430.pdf",
    "sds_url": "https://download.basf.com/p1/000000000030357978_SDS_CPA_US/en_US/Termidor_SC_TermiticideInsecticide_30357978_SDS_CPA_US_en_11-0.pdf"
  },
  {
    "name": "Termidor Foam",
    "signal_word": "CAUTION",
    "formulation": "Aerosol dry foam",
    "reentry_text": "Injected into termite galleries and wall voids; any product on an exposed surface is wiped up immediately.",
    "target_pests": [
      "Subterranean termites",
      "Drywood termites",
      "Carpenter ants"
    ],
    "application_zones": [
      "Wall voids & galleries"
    ],
    "public_summary": "An expanding foam injected directly into wall voids and termite galleries, filling spaces a liquid cannot reach.",
    "pet_kid_guidance_text": "Delivered into voids and galleries, not onto open surfaces; anything on an exposed surface is wiped up before the technician leaves.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/000499-00563-20130912.pdf",
    "sds_url": "https://download.basf.com/p1/000000000030644389_SDS_CPA_US/en_US/Termidor_Foam_000000000030644389_SDS_CPA_US_en_9-0.pdf"
  },
  {
    "name": "Trelona ATBS Bait Station",
    "signal_word": "CAUTION",
    "formulation": "In-ground bait station",
    "reentry_text": "Bait is sealed inside in-ground stations set flush with the soil and inspected on a schedule; never applied as a spray.",
    "target_pests": [
      "Subterranean termites"
    ],
    "application_zones": [
      "In-ground stations around structure"
    ],
    "public_summary": "A termite baiting system. Stations are installed in the soil around the home; when termites feed, a growth regulator is carried back to eliminate the colony.",
    "pet_kid_guidance_text": "A growth regulator sealed inside a buried station, with no treated surface in your living space.",
    "label_url": "https://www.domyown.com/msds/Trelona_Compressed_Termite_Bait_Label_2020.pdf",
    "sds_url": "https://www.domyown.com/msds/Trelona_Compressed_Termite_Bait_SDS_2025.pdf"
  },
  {
    "name": "Advance Termite Bait Station",
    "signal_word": "CAUTION",
    "formulation": "In-ground bait station",
    "reentry_text": "Bait is sealed inside in-ground stations installed around the structure and inspected on a schedule; never applied as a spray.",
    "target_pests": [
      "Subterranean termites"
    ],
    "application_zones": [
      "In-ground stations around structure"
    ],
    "public_summary": "An in-ground termite monitoring and baiting system installed around the home and checked on a schedule for activity.",
    "pet_kid_guidance_text": "A growth regulator sealed inside a buried station, with no treated surface in your living space.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/000499-00500-20220221.pdf",
    "sds_url": "https://www.domyown.com/msds/Termite%20MSDS%2003202012.pdf"
  },
  {
    "name": "HexPro Termite Monitoring Baiting System",
    "signal_word": null,
    "formulation": "In-ground monitoring station",
    "reentry_text": "A sealed in-ground monitoring station; during monitoring there is no pesticide present.",
    "target_pests": [
      "Subterranean termites"
    ],
    "application_zones": [
      "In-ground stations around structure"
    ],
    "public_summary": "In-ground stations installed around the home and checked for termite activity. During the monitoring phase there is no pesticide in the ground — bait is added only if activity is found.",
    "pet_kid_guidance_text": "A sealed in-ground station; no pesticide is present during monitoring.",
    "label_url": null,
    "sds_url": null
  },
  {
    "name": "Bora-Care",
    "signal_word": "CAUTION",
    "formulation": "Borate wood treatment",
    "reentry_text": "Treated areas are not occupied until the solution has absorbed into the wood.",
    "target_pests": [
      "Subterranean termites",
      "Drywood termites",
      "Carpenter ants",
      "Wood-destroying beetles",
      "Wood decay fungi"
    ],
    "application_zones": [
      "Bare wood / structural framing"
    ],
    "public_summary": "A naturally derived borate applied to bare structural wood during construction or repair. It soaks into the wood to protect it against termites, beetles, and decay fungi.",
    "pet_kid_guidance_text": "A borate applied to wood, not to living or contact surfaces; areas are not occupied during application.",
    "label_url": "https://nisuscorp.com/wp-content/uploads/download-manager-files/Bora-Care_Label.pdf",
    "sds_url": "https://nisuscorp.com/wp-content/uploads/download-manager-files/Bora-Care_SDS.pdf"
  },
  {
    "name": "Contrac Blox",
    "signal_word": "CAUTION",
    "formulation": "Anticoagulant bait block",
    "reentry_text": "Always secured inside tamper-resistant stations wherever children, pets, or wildlife could reach it.",
    "target_pests": [
      "Norway rats",
      "Roof rats",
      "House mice"
    ],
    "application_zones": [
      "Inside tamper-resistant stations"
    ],
    "public_summary": "A rodent bait used only inside locked, tamper-resistant stations. It contains a bittering agent to deter accidental contact.",
    "pet_kid_guidance_text": "Always sealed inside a locked, tamper-resistant station, never loose. If a pet ever reaches bait, call a veterinarian at once — the antidote is vitamin K1.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/012455-00079-20200213.pdf",
    "sds_url": "https://www.belllabs.com/wp-content/uploads/2023/10/Contrac-All-Weather-Blox_12455-79_USA-US_English_0124-1.pdf"
  },
  {
    "name": "Trapper T-Rex Rat Snap Trap",
    "signal_word": null,
    "formulation": "Mechanical snap trap",
    "reentry_text": "A mechanical trap with no pesticide; enclosed in a tamper-resistant station where children or pets could reach it.",
    "target_pests": [
      "Norway rats",
      "Roof rats"
    ],
    "application_zones": [
      "Inside tamper-resistant stations",
      "Attic & concealed runs"
    ],
    "public_summary": "A mechanical snap trap — no chemicals — used where a non-toxic option is preferred. Enclosed in a tamper-resistant station in accessible areas.",
    "pet_kid_guidance_text": "No pesticide at all; a mechanical trap enclosed in a tamper-resistant station where children or pets could reach it.",
    "label_url": null,
    "sds_url": null
  },
  {
    "name": "In2Care Mosquito Station",
    "signal_word": "CAUTION",
    "formulation": "Mosquito station",
    "reentry_text": "An outdoor, professionally serviced water station; people and pets are kept from contacting the mix.",
    "target_pests": [
      "Aedes mosquitoes",
      "Culex mosquitoes"
    ],
    "application_zones": [
      "Mosquito breeding sites",
      "Shaded outdoor areas"
    ],
    "public_summary": "A water station that recruits mosquitoes, then uses them to spread a growth regulator to other breeding sites they visit — attacking larvae you cannot see.",
    "pet_kid_guidance_text": "An outdoor, professionally serviced station; people and pets are kept from contacting the mix. Its label notes it is toxic to bees on direct treatment of blooms and to fish — it is not a bee- or fish-safe claim.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/091720-00001-20220630.pdf",
    "sds_url": "https://bynder.envu.com/m/484233d9b92f7d39/original/Digital_PPM_In2Care_SDS_NA_US_EN.pdf"
  },
  {
    "name": "Summit Mosquito Dunk Tablets",
    "signal_word": "CAUTION",
    "formulation": "Bti larvicide briquet",
    "reentry_text": "A biological larvicide placed in standing water; the label permits use in animal watering troughs, bird baths, and fish habitats.",
    "target_pests": [
      "Mosquito larvae"
    ],
    "application_zones": [
      "Standing water sources",
      "Mosquito breeding sites"
    ],
    "public_summary": "A slow-release briquet of Bti, a naturally occurring soil bacterium that targets mosquito larvae in standing water and is selective to them.",
    "pet_kid_guidance_text": "A selective biological larvicide. Its label expressly allows use in animal watering troughs and fish habitats; only finished human drinking water is off-limits.",
    "label_url": "https://summitchemical.com/wp-content/uploads/2021/01/110-12-SPECIMEN_DUNKS.pdf",
    "sds_url": "https://cdn.shopify.com/s/files/1/0123/3082/7840/files/Summit_Mosquito_Dunks_BTI_Briquets_SDS_6218-73.pdf"
  },
  {
    "name": "Acelepryn Xtra",
    "signal_word": "CAUTION",
    "formulation": "Suspension concentrate (SC)",
    "reentry_text": "People and pets are kept off the treated lawn until it has dried.",
    "target_pests": [
      "White grubs",
      "Chinch bugs",
      "Armyworms",
      "Sod webworms",
      "Fire ants",
      "Billbugs"
    ],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A low-toxicity lawn insecticide targeting grubs and turf-damaging insects, applied and watered into the soil.",
    "pet_kid_guidance_text": "People and pets stay off the treated lawn until it has dried. Not applied to flowering plants, and not while bees are foraging.",
    "label_url": "https://assets.greencastonline.com/pdf/labels/SCP%201680A-L1%200623.pdf",
    "sds_url": "https://assets.greencastonline.com/pdf/msds/100-1680_AceleprynXtra_SDS.pdf"
  },
  {
    "name": "Celsius WG",
    "signal_word": "CAUTION",
    "formulation": "Water-dispersible granule (WG)",
    "reentry_text": "People and pets are kept off treated areas until the sprays have dried.",
    "target_pests": [
      "Doveweed",
      "Dollarweed",
      "Florida pusley",
      "Virginia buttonweed",
      "Chamberbitter",
      "Clover"
    ],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A selective weed control tolerated by Florida's warm-season lawns, including St. Augustine, so weeds can be treated without harming the turf.",
    "pet_kid_guidance_text": "People and pets stay off treated areas until sprays have dried.",
    "label_url": "https://bynder.envu.com/m/65d25e1e68990f59/original/Digital_TO_Celsius-WG_label_NA_US_EN.pdf",
    "sds_url": "https://bynder.envu.com/m/3237e534a3bade42/original/Digital_TO_Celsius-WG_SDS_NA_US_EN.pdf"
  },
  {
    "name": "LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide",
    "signal_word": "CAUTION",
    "formulation": "Flowable liquid (4FL)",
    "reentry_text": "No re-entry until the dust has settled and the turf or soil is dry.",
    "target_pests": [
      "Crabgrass (pre-emergent)",
      "Poa annua",
      "Goosegrass",
      "Chickweed",
      "Spurge"
    ],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A pre-emergent applied before weed seeds sprout, forming a barrier in the top layer of soil that stops crabgrass and other annual weeds from establishing.",
    "pet_kid_guidance_text": "People and pets stay off until the dust has settled and the turf is dry.",
    "label_url": "https://www.siteone.com/en/pdf/sdsPDF?resourceId=33935",
    "sds_url": "https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-hybris-delta-sds_or_label_33946-965038/rb-hybris-delta-sds-or-label-33946-965038.pdf"
  },
  {
    "name": "LESCO Stonewall 0-0-7",
    "signal_word": "CAUTION",
    "formulation": "Granular pre-emergent on fertilizer",
    "reentry_text": "A granular pre-emergent watered into the soil by rain or irrigation within 14 days.",
    "target_pests": [
      "Crabgrass (pre-emergent)",
      "Poa annua",
      "Goosegrass",
      "Chickweed",
      "Florida pusley"
    ],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A granular pre-emergent on a light fertilizer carrier, spread on the lawn to stop annual weeds before they germinate.",
    "pet_kid_guidance_text": "A granule worked into the soil by irrigation; livestock forage is not cut from treated areas.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/010404-00089-20151124.pdf",
    "sds_url": "https://hillsidelawn.com/wp-content/uploads/2024/04/702728-sds-1.pdf"
  },
  {
    "name": "Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide",
    "signal_word": "CAUTION",
    "formulation": "Water-dispersible granule (WDG)",
    "reentry_text": "People are kept off treated areas until the spray solution has dried.",
    "target_pests": [
      "Purple nutsedge",
      "Yellow nutsedge",
      "Kyllinga",
      "Rice flatsedge"
    ],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A selective control for nutsedge — the fast-growing grassy weed most lawn products miss — with a built-in surfactant.",
    "pet_kid_guidance_text": "People stay off treated turf until the spray has dried.",
    "label_url": "https://www.gowanco.com/sites/default/files/2022-09/Sedgehammer%20Plus%2081880-24-10163%20(02-R0220).pdf",
    "sds_url": "https://labelsds.com/document.php?file=SedgeHammer+Plus+SDS+8-14-25.pdf&product=1460"
  },
  {
    "name": "Drive XLR8 Post Emergent Liquid Herbicide",
    "signal_word": "CAUTION",
    "formulation": "Water-based liquid",
    "reentry_text": "No re-entry to treated turf until the sprays have dried.",
    "target_pests": [
      "Crabgrass",
      "Torpedograss",
      "Dollarweed",
      "Clover",
      "Foxtail"
    ],
    "application_zones": [
      "Turf / lawn (bermuda, zoysia)"
    ],
    "public_summary": "A post-emergent that controls crabgrass and torpedograss after they have sprouted. Used on bermuda and zoysia lawns; its label does not allow use on St. Augustine.",
    "pet_kid_guidance_text": "People and pets stay off treated turf until the sprays have dried.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/007969-00272-20191101.pdf",
    "sds_url": "https://download.basf.com/p1/000000000030396621_SDS_CPA_US/en_US/Drive_XLR8_000000000030396621_SDS_CPA_US_en_7-0.pdf"
  },
  {
    "name": "Armada 50 WDG",
    "signal_word": "CAUTION",
    "formulation": "Water-dispersible granule (WDG)",
    "reentry_text": "No entry into treated turf until sprays have dried.",
    "target_pests": [
      "Dollar spot",
      "Brown patch",
      "Large patch",
      "Leaf spot",
      "Anthracnose",
      "Fairy ring"
    ],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A two-mode-of-action turf fungicide for the lawn and turf-disease pressures common in Florida's heat and humidity.",
    "pet_kid_guidance_text": "People and pets stay off treated turf until sprays have dried.",
    "label_url": "https://bynder.envu.com/m/2d49a63992836ad4/original/Digital_TO_Armada-50-WDG_label_NA_US_EN.pdf",
    "sds_url": "https://bynder.envu.com/m/51dda106a601c13f/original/Digital_TO_Armada-50-WDG_SDS_NA_US_EN.pdf"
  },
  {
    "name": "Medallion SC",
    "signal_word": "CAUTION",
    "formulation": "Suspension concentrate (SC)",
    "reentry_text": "No entry into treated turf without protective clothing until the sprays have dried.",
    "target_pests": [
      "Brown patch",
      "Leaf spot",
      "Gray leaf spot",
      "Anthracnose",
      "Summer patch"
    ],
    "application_zones": [
      "Turf / ornamental beds"
    ],
    "public_summary": "A turf and ornamental fungicide used against the fungal diseases that thrive in Southwest Florida's warm, wet conditions.",
    "pet_kid_guidance_text": "People and pets stay off treated turf until sprays have dried.",
    "label_url": "https://assets.greencastonline.com/pdf/labels/SCP%201448A-L1B%200222.pdf",
    "sds_url": "https://assets.greencastonline.com/pdf/msds/MEDALLION%20SC%20A17856B%2002172015.pdf"
  },
  {
    "name": "Headway G",
    "signal_word": "CAUTION",
    "formulation": "Granule (G)",
    "reentry_text": "Applied with people and pets out of the work area; a granular product with no spray to wait on.",
    "target_pests": [
      "Brown patch",
      "Large patch",
      "Gray leaf spot",
      "Dollar spot",
      "Anthracnose",
      "Fairy ring"
    ],
    "application_zones": [
      "Turf / ornamental beds"
    ],
    "public_summary": "A granular two-mode-of-action fungicide for turf and landscape disease, spread with a calibrated spreader.",
    "pet_kid_guidance_text": "A granular product; people and pets stay off until it is watered in and the lawn is dry.",
    "label_url": "https://assets.greencastonline.com/pdf/labels/SCP%201378A-L1B%200819.pdf",
    "sds_url": "https://assets.greencastonline.com/pdf/msds/hEADWAY%20g.pdf"
  },
  {
    "name": "Heritage G",
    "signal_word": "CAUTION",
    "formulation": "Granule (G)",
    "reentry_text": "Home-lawn label allows people and pets to re-enter after application; some uses direct light irrigation afterward.",
    "target_pests": [
      "Brown patch",
      "Large patch",
      "Gray leaf spot",
      "Anthracnose",
      "Pythium blight",
      "Fairy ring"
    ],
    "application_zones": [
      "Turf / ornamental beds"
    ],
    "public_summary": "A granular systemic fungicide that moves into the plant to protect turf and ornamentals from a broad range of diseases.",
    "pet_kid_guidance_text": "A granular product; the home-lawn label allows people and pets to re-enter after application.",
    "label_url": "https://assets.greencastonline.com/pdf/labels/SCP1323AL1D1115.pdf",
    "sds_url": "https://assets.greencastonline.com/pdf/msds/Heritage%20G-250910.pdf"
  },
  {
    "name": "Pillar G Intrinsic",
    "signal_word": "CAUTION",
    "formulation": "Granule (G)",
    "reentry_text": "A granular turf fungicide; no entry until the dust has settled, and root-zone diseases are watered in.",
    "target_pests": [
      "Brown patch",
      "Large patch",
      "Dollar spot",
      "Gray leaf spot",
      "Anthracnose",
      "Fairy ring"
    ],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A granular two-mode-of-action fungicide for turf disease that also supports overall plant health.",
    "pet_kid_guidance_text": "A granular product; people and pets stay off until the dust has settled and, where watered in, the lawn is dry.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/007969-00304-20240424.pdf",
    "sds_url": "https://www.domyown.com/msds/Pillar_G_Intrinsic_Granular_Fungicide_SDS_2020.pdf"
  },
  {
    "name": "Topchoice Granular Insecticide",
    "signal_word": "CAUTION",
    "formulation": "Granule (restricted-use)",
    "reentry_text": "A granular product watered into the soil; applied only by licensed technicians.",
    "target_pests": [
      "Fire ants",
      "Mole crickets",
      "Nuisance ants",
      "Fleas",
      "Ticks"
    ],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A granular lawn insecticide providing about a year of fire-ant control from a single application, watered into the soil.",
    "pet_kid_guidance_text": "A granular product watered into the soil; a restricted-use product applied only by licensed technicians. Not applied to grazing areas.",
    "label_url": "https://bynder.envu.com/m/3ffbf0b3b1f69998/original/Digital_TO_Topchoice_Label_NA_US_EN.pdf",
    "sds_url": "https://bynder.envu.com/m/274281e26bf3d59d/original/Digital_TO_Topchoice_SDS_NA_US_EN.pdf"
  },
  {
    "name": "LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer",
    "signal_word": null,
    "formulation": "Liquid micronutrient fertilizer",
    "reentry_text": "A fertilizer, not a pesticide; applied only to the lawn, away from water and storm drains.",
    "target_pests": [],
    "application_zones": [
      "Turf / lawn"
    ],
    "public_summary": "A micronutrient fertilizer, not a pesticide. It corrects manganese and iron deficiencies that leave Florida lawns pale or yellow.",
    "pet_kid_guidance_text": "A micronutrient fertilizer that greens up the lawn — not a pesticide.",
    "label_url": "https://www.siteone.com/en/pdf/sdsPDF?resourceId=10646",
    "sds_url": null
  },
  {
    "name": "Dispatch Sprayable Wetting Agent",
    "signal_word": null,
    "formulation": "Soil surfactant",
    "reentry_text": "A soil wetting agent, not a pesticide; does not need to be watered in.",
    "target_pests": [],
    "application_zones": [
      "Turf / soil"
    ],
    "public_summary": "A soil wetting agent, not a pesticide. It helps water and nutrients soak evenly into the soil instead of running off — useful on Florida's sandy, water-repellent soils.",
    "pet_kid_guidance_text": "A soil wetting agent that helps water soak in — not a pesticide.",
    "label_url": "https://aquatrolscompany.com/wp-content/uploads/2025/08/Dispatch-Sprayable-US-Label-1.pdf",
    "sds_url": "https://aquatrolscompany.com/wp-content/uploads/2025/08/Dispatch-Sprayable-US-SDS-1.pdf"
  },
  {
    "name": "Torque SC",
    "signal_word": "CAUTION",
    "formulation": "Suspension concentrate (SC)",
    "reentry_text": "Children and pets are kept out of treated areas until sprays have dried. Label is golf-course-only; not for home lawns.",
    "target_pests": [
      "Dollar spot",
      "Brown patch",
      "Large patch",
      "Anthracnose"
    ],
    "application_zones": [
      "Golf-course turf only"
    ],
    "public_summary": "A turf fungicide whose label restricts it to golf-course turf; it is not labeled for home lawns.",
    "pet_kid_guidance_text": "Label restricts this product to golf-course turf; it is not for homeowner use.",
    "label_url": "https://www3.epa.gov/pesticides/chem_search/ppls/001001-00087-20131115.pdf",
    "sds_url": "https://www.domyown.com/msds/torque_sds.pdf"
  }
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const p of PRODUCTS) {
    await knex('products_catalog')
      .where({ name: p.name })
      // Never modify a row that is already live on the public page.
      .whereRaw("(content_status IS DISTINCT FROM 'approved_for_public' OR customer_visibility IS DISTINCT FROM 'public')")
      .update({
      signal_word: knex.raw('COALESCE(signal_word, ?)', [p.signal_word]),
      formulation: knex.raw('COALESCE(formulation, ?)', [p.formulation]),
      reentry_text: knex.raw('COALESCE(reentry_text, ?)', [p.reentry_text]),
      public_summary: knex.raw('COALESCE(public_summary, ?)', [p.public_summary]),
      pet_kid_guidance_text: knex.raw('COALESCE(pet_kid_guidance_text, ?)', [p.pet_kid_guidance_text]),
      target_pests: knex.raw('COALESCE(target_pests, ?::jsonb)', [JSON.stringify(p.target_pests || [])]),
      application_zones: knex.raw('COALESCE(application_zones, ?::jsonb)', [JSON.stringify(p.application_zones || [])]),
      label_url: knex.raw('COALESCE(label_url, ?)', [p.label_url]),
      sds_url: knex.raw('COALESCE(sds_url, ?)', [p.sds_url]),
      label_source_note: knex.raw('COALESCE(label_source_note, ?)', [SEED_NOTE]),
      updated_at: knex.fn.now(),
    });
  }
};

exports.down = async function down(knex) {
  // Non-destructive: additive data-enrichment seed. Prior NULLs are not
  // restorable; seeded rows remain identifiable via label_source_note.
};
