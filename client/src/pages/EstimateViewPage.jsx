import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { COLORS as B, FONTS, BUTTON_BASE, HALFTONE_PATTERN, HALFTONE_SIZE } from '../theme';
import { calculateEstimate } from '../lib/estimateEngine';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const SAND = '#FDF6EC';
const SAND_DARK = '#F5EBD7';

// =========================================================================
// SERVICE DETAIL CONTENT — from Waves sales decks
// =========================================================================
const SERVICE_DETAILS = {
  lawn: {
    header: 'Full-Service Lawn Care, Defined.',
    subheader: 'WaveGuard Lawn Care — 6–12 Applications/Year',
    sections: [
      { title: 'Turf Monitoring & Diagnostics', text: "Each service visit includes detailed turf health assessments — visual inspections, root-zone checks, and, when needed, lab testing — to detect pests, diseases, and nutrient or stress issues early. Findings guide adjustments to fertility programs, fungicide use, and cultural practices to maintain optimal turf vigor and resilience." },
      { title: 'Fertilization Program', text: "A precise fertilization schedule, applied 4–6 times per year, delivers balanced, slow-release nutrients for steady growth. Controlled-release nitrogen minimizes leaching, while phosphorus and potassium levels are adjusted based on season and soil data. Chelated micronutrients and biostimulants enhance nutrient uptake and stress tolerance." },
      { title: 'Weed Management (Pre/Post-Emergent)', text: "An integrated weed management program applies selective pre-emergent herbicides to prevent annual weed germination, in addition to targeted post-emergent treatments for escapes or perennials. Herbicide choices and timing are adjusted seasonally based on turf type, climate, and resistance management practices." },
      { title: 'Soil Conditioning & pH Balancing', text: "Soil chemistry is annually tested to monitor CEC, pH, and nutrient levels. Based on results, pH is adjusted with lime, sulfur, or other amendments, and micronutrients like iron, manganese, and zinc are applied to maintain optimal root-zone conditions." },
      { title: 'Disease Prevention (Fungicides)', text: "Preventive fungicide applications are integrated into the management program based on disease forecasting models, environmental data (temperature, humidity, leaf wetness), and turf species susceptibility. These treatments protect against major turf pathogens such as Rhizoctonia, Pythium, and Dollar Spot, prioritizing proactive suppression rather than reactive control." },
      { title: 'Lawn Insect & Turf Pest Control', text: "Pest control applications are timed to pest life cycles and environmental cues, targeting chinch bugs, sod webworms, mole crickets, armyworms, and fire ants. An IPM approach blends biological, chemical, and cultural controls, with product rotation to prevent resistance." },
      { title: 'Core/Liquid Aeration/Dethatching', text: "Performed once annually — typically in spring or fall — using mechanical coring, liquid aeration technologies, or dethatching equipment to relieve soil compaction, remove thatch buildup, enhance oxygen exchange, and stimulate microbial activity. This improves root penetration, nutrient mobility, and water infiltration." },
      { title: 'Lawn Nutrition & Disease Control', text: "We deliver the right nutrients at the right time and treat fungal threats like brown patch and dollar spot before they spread. Preventive and curative applications are timed to seasonal disease pressure and turf health data." },
      { title: 'Weed-Free Landscape Bed Perimeter', text: "Selective spot applications of contact or systemic herbicides along turf and hardscape interfaces to maintain a clean, defined perimeter. Treatments are calibrated for ornamental safety." },
      { title: 'Iron / Greening Touch-Up', text: "Applied during nitrogen blackout or restriction periods, this chelated iron and micronutrient blend supports chlorophyll production, color uniformity, and turf vigor without promoting excessive top growth." },
      { title: 'Irrigation Maintenance & Watering Optimization', text: "Regular inspection and calibration of sprinkler systems to ensure even coverage and proper pressure. Seasonal adjustments align with ET rates, rainfall, and turf-specific needs." },
    ],
    extras: [
      { title: 'Shrub & Ornamental Plant Care', text: "We use proactive monitoring and treatment to control pests and diseases, keeping your shrubs healthy, strong, and well-shaped year-round." },
      { title: 'Palm Tree Care & Injections', text: "Targeted trunk injections and root-zone treatments to protect palms from lethal diseases like lethal bronzing and Ganoderma, while delivering essential nutrients for canopy health and vigor." },
      { title: 'Overseeding', text: "Strategic overseeding to fill in thin or bare areas, improve turf density, and establish a thicker, more resilient lawn. Seed selection is matched to your grass type and site conditions." },
    ],
  },
  pest: {
    header: 'Full-Service Pest Control, Defined.',
    subheader: 'WaveGuard Pest Control — 2–12 Treatments Per Year',
    intro: "Protect your home with a customizable pest control program built for consistent, year-round results. Our full-service pest protection plans combine interior and exterior treatments, advanced repellent and non-repellent formulas, and surfactant-enhanced applications to deliver broad, effective coverage against 75+ common pests.",
    sections: [
      { title: 'Comprehensive Property Inspection', text: "Every service begins with a careful inspection of your home and surrounding property. We identify pest activity, entry points, nesting areas, moisture issues, and other conditions that may be contributing to infestations. This allows us to tailor each treatment to your home's specific needs." },
      { title: 'Interior & Exterior Coverage Included', text: "Our pest control program includes treatment of both the interior and exterior of your home for complete protection. Exterior applications help establish a strong protective barrier around the structure, while interior treatments target active pest areas and problem zones where pests live and travel." },
      { title: 'Targets 75+ Common Household Pests', text: "Our treatments are designed to control a wide range of pests, including ants, roaches, spiders, silverfish, earwigs, crickets, centipedes, wasps, pill bugs, and many other crawling and flying insects. Whether you need preventive service or help with active pest issues, our program is built to deliver dependable results." },
      { title: 'Repellent & Non-Repellent Formulas', text: "We use a strategic combination of repellent and non-repellent products based on the pest problem, treatment area, and desired outcome. Repellent formulas help keep pests away from treated zones, while non-repellent solutions work more subtly, allowing pests to contact treated areas without detection for more effective control in certain situations." },
      { title: 'Surfactant-Enhanced Applications', text: "Selected applications include added surfactants to improve product spread, adhesion, and penetration on treated surfaces. This added performance helps treatments work more efficiently in challenging areas and supports more thorough coverage where pests hide and travel." },
      { title: 'Flexible Treatment Scheduling', text: "Programs are available from 2 to 12 treatments per year, depending on the level of pest activity, the type of pests being targeted, and the protection level you want for your home. From preventive care to higher-frequency service plans, each schedule is designed around your property's specific conditions." },
      { title: 'Seasonal Pest Protection', text: "Pest pressures change throughout the year, and so does our approach. We adjust service timing and treatment strategy based on seasonal activity patterns to help prevent infestations before they start and maintain stronger control throughout the year." },
      { title: 'Barrier Defense Around the Home', text: "Exterior treatments focus on high-risk areas such as foundation lines, doorways, windows, eaves, utility penetrations, and other common pest entry points. These applications help create a durable barrier that reduces pest access and strengthens your home's first line of defense." },
      { title: 'Targeted Interior Treatments', text: "When interior pest activity is present, treatments are applied with precision in key areas such as baseboards, cracks and crevices, garages, utility areas, and other active zones. This focused approach helps maximize results while avoiding unnecessary product use." },
      { title: 'Service Reporting & Recommendations', text: "Each visit concludes with a detailed digital service report documenting findings, products applied, target pests observed, and any structural or sanitation conditions contributing to pest pressure. Reports also include actionable recommendations for moisture management, vegetation trimming, screening repairs, and other exclusion improvements — turning every visit into a consultative service experience, not just an application." },
      { title: 'Long-Term Prevention & Peace of Mind', text: "Our goal is not just to treat pests, but to help prevent them from coming back. By combining effective products, customized scheduling, detailed reporting, and practical prevention strategies, we provide a smarter, more complete approach to protecting your home." },
    ],
  },
  treeShrub: {
    header: 'Full-Service Tree & Shrub Care, Defined.',
    subheader: 'WaveGuard Tree & Shrub — 6–8 Applications Per Year',
    intro: "Protect and strengthen your landscape investment with a year-round tree and shrub care program built for Southwest Florida. Through proactive monitoring, targeted nutrition, and precision pest and disease treatments, we keep ornamental plants, trees, and palms healthy, vibrant, and resilient — season after season.",
    sections: [
      { title: 'Plant Health Inspection & Monitoring', text: "Every service visit begins with a detailed visual assessment of trees, shrubs, palms, and ornamental plantings across the property. We evaluate foliage color and density, canopy structure, root zone conditions, and signs of pest activity, disease progression, or nutrient stress. Findings from each inspection guide treatment adjustments and are documented in your service report — allowing us to track trends, catch problems early, and refine the program over time.", tags: ['Canopy Assessment', 'Root Zone Check', 'Trend Tracking'] },
      { title: 'Root Zone Fertilization', text: "A scheduled fertilization program delivers balanced, slow-release nutrition directly to the root zone of trees, shrubs, and ornamental plantings. Controlled-release granular formulations provide steady macro- and micronutrient availability throughout the growing season, promoting strong root development, consistent foliage color, and improved stress tolerance. Application rates and timing are adjusted based on plant species, soil conditions, and seasonal demand.", tags: ['Slow-Release Nutrition', 'Root Development', 'Seasonal Adjustment'] },
      { title: 'Palm Nutrition Program', text: "Southwest Florida palms have specialized nutritional needs that standard landscape fertilizers don't address. Our palm-specific program uses formulations designed for Florida's sandy, alkaline soils — delivering potassium, magnesium, manganese, and other critical micronutrients in controlled-release form to prevent and correct common deficiency symptoms like frizzle top, yellowing fronds, and orange spotting. Supplemental foliar micronutrient applications support faster visual recovery when deficiencies are detected.", tags: ['Palm-Specific Formula', 'Micronutrient Correction', 'Frizzle Top Prevention'] },
      { title: 'Insect & Mite Control', text: "Year-round protection against the damaging insects and mites that target ornamental plants in our climate — including whiteflies, scale, aphids, mealybugs, spider mites, and thrips. Treatments combine systemic products applied as soil drenches with targeted foliar sprays for contact and residual control. Product selection follows a strict mode-of-action rotation schedule, alternating between chemical classes at each visit to prevent resistance buildup in persistent pest populations.", tags: ['Systemic + Foliar', 'MOA Rotation', 'Resistance Management'] },
      { title: 'Disease Prevention & Fungicide Program', text: "Fungal and bacterial diseases thrive in Southwest Florida's heat and humidity. Our program applies preventive and curative fungicide treatments based on seasonal risk windows, environmental conditions, and plant species susceptibility. We target common landscape pathogens including leaf spot, anthracnose, sooty mold, powdery mildew, and bud rot in palms. Fungicide selection follows FRAC group rotation protocols to maintain long-term product efficacy and prevent pathogen resistance.", tags: ['Preventive + Curative', 'FRAC Rotation', 'Bud Rot Protection'] },
      { title: 'Horticultural Oil Applications', text: "Horticultural oil treatments provide a low-toxicity, broad-spectrum option for controlling soft-bodied insects in their egg, larval, and overwintering stages. Applied as a foliar spray, these treatments suffocate scale crawlers, whitefly nymphs, mites, and mealybugs on contact while leaving minimal residue. Oil applications also help reduce sooty mold buildup on foliage by suppressing the honeydew-producing insects that cause it — resulting in cleaner, healthier-looking plants.", tags: ['Low-Toxicity', 'Scale & Whitefly', 'Sooty Mold Reduction'] },
      { title: 'Trunk Injection Services', text: "For high-value trees and palms requiring targeted treatment, we offer direct trunk injection using professional micro-infusion technology. This method delivers insecticides, fungicides, or nutrients directly into the vascular system of the tree — bypassing soil conditions and environmental losses for faster, more precise results. Trunk injection is especially effective for treating palm diseases like lethal bronzing, systemic insect infestations, and micronutrient deficiencies that respond poorly to soil or foliar applications alone.", tags: ['Micro-Infusion', 'Vascular Delivery', 'Lethal Bronzing'] },
      { title: 'Foliar Micronutrient & Biostimulant Applications', text: "Supplemental foliar sprays deliver chelated micronutrients — iron, manganese, zinc, and magnesium — directly through leaf tissue for faster correction of visible deficiency symptoms like chlorosis, interveinal yellowing, and reduced vigor. Biostimulant additives support improved nutrient uptake, root activity, and overall plant resilience. These applications complement the root zone fertilization program and are timed to seasonal growth phases for maximum benefit.", tags: ['Chelated Micros', 'Chlorosis Correction', 'Biostimulant'] },
      { title: 'Growth Regulation for Ornamentals', text: "Plant growth regulator applications help manage the size and shape of ornamental shrubs and hedges, reducing the frequency of mechanical pruning while promoting denser, more compact growth. PGR treatments redirect the plant's energy from excessive vertical growth toward root development and lateral branching — resulting in thicker canopies, improved stress tolerance, and a more manicured appearance with less maintenance.", tags: ['Growth Management', 'Denser Canopy', 'Reduced Pruning'] },
      { title: 'Seasonal Treatment Scheduling', text: "Pest pressures, disease risk, and nutritional demands change throughout the year, and our treatment schedule adapts accordingly. Service timing and product selection are aligned to Southwest Florida's seasonal cycles — heavier insect and fungicide coverage during the warm, humid months when pressure peaks, and nutrient-focused applications during cooler growth periods. Programs are available from 4 to 8 visits per year depending on landscape size, plant diversity, and the level of protection your property requires.", tags: ['Flexible Frequency', 'Seasonal Adaptation', '4–8 Visits/Year'] },
      { title: 'Service Reporting & Recommendations', text: "Each visit concludes with a detailed digital service report documenting inspection findings, products applied, target pests or diseases observed, and the current health status of key plants on the property. Reports include actionable recommendations for irrigation adjustments, mulch management, pruning needs, and other cultural practices that support long-term plant health — turning every visit into a consultative service experience, not just an application.", tags: ['Digital Reports', 'Cultural Recs', 'Plant Health Tracking'] },
    ],
  },
  palmInjection: {
    header: 'Professional Palm Injection Services.',
    subheader: 'Trunk Injection — Preventive & Curative Treatments',
    intro: "Protect your palms from the inside out. Our professional trunk injection service delivers insecticides, fungicides, antibiotics, and nutrients directly into the vascular system of the tree — bypassing soil conditions and environmental losses for faster, more precise results where it matters most.",
    sections: [
      { title: 'How Trunk Injection Works', text: "Using professional micro-infusion equipment, we inject treatment products directly into the trunk of the palm through small, precision-drilled ports. The product is drawn up through the tree's vascular system and distributed throughout the canopy, roots, and growing tissue. This delivers active ingredients exactly where they're needed — without relying on soil uptake, weather conditions, or surface applications that can drift or degrade. Injection ports seal naturally over time with minimal impact to the tree.", tags: ['Micro-Infusion', 'Vascular Delivery', 'Precision Dosing'] },
      { title: 'Lethal Bronzing Disease Prevention & Treatment', text: "Lethal bronzing is a fatal phytoplasma disease that kills palms from the inside — and it's spreading across Southwest Florida. There is no soil-applied cure. Trunk injection with antibiotic formulations is the only proven treatment method, and it is most effective when applied preventively before symptoms appear. For palms already showing early-stage symptoms — premature fruit drop, lower frond browning, or spear leaf collapse — injection can slow or halt progression if caught in time. We recommend preventive treatments every 4–6 months for high-value palms in affected areas.", tags: ['Phytoplasma', 'Preventive Protocol', 'Early Intervention'] },
      { title: 'Systemic Insect Protection', text: "Trunk-injected insecticides provide systemic, season-long protection against the most damaging palm pests in our region — including spiral whitefly, rugose spiraling whitefly, palm weevils, royal palm bugs, and scale insects. Because the product is distributed through the tree's internal tissue, it reaches pests feeding deep within the canopy that foliar sprays often miss. Systemic insecticide injections are especially effective for tall palms where spray coverage is impractical or incomplete.", tags: ['Spiral Whitefly', 'Palm Weevil', 'Season-Long Control'] },
      { title: 'Fungicide Injection for Disease Control', text: "Fungal pathogens like Phytophthora bud rot, Ganoderma butt rot, Thielaviopsis trunk rot, and Pestalotiopsis can devastate palms if left unchecked. Trunk-injected fungicides — including phosphorous acid and systemic triazole formulations — deliver curative and preventive protection directly into the tree's vascular system. This method is significantly more effective than soil drenches or foliar sprays for deep-seated fungal infections, particularly in palms where root access is limited or compromised.", tags: ['Bud Rot', 'Ganoderma', 'Systemic Fungicide'] },
      { title: 'Palm Nutritional Injection', text: "Nutrient deficiencies are among the most common health issues for palms in Southwest Florida's sandy, alkaline soils — especially potassium, manganese, magnesium, and iron. Trunk injection delivers chelated micronutrients and balanced nutritional formulations directly into the vascular system, producing faster, more visible results than soil-applied fertilizers. This is especially valuable for palms showing advanced deficiency symptoms like frizzle top, yellowing fronds, or stunted new growth that haven't responded to granular treatments alone.", tags: ['Chelated Micronutrients', 'Frizzle Top', 'Fast Visual Recovery'] },
      { title: 'Combination Treatments', text: "For palms facing multiple stressors — or for proactive owners who want comprehensive protection in a single visit — we offer combination injection treatments that pair insecticide, fungicide, and nutritional products in one service. Combo treatments are particularly effective for high-value specimen palms, newly transplanted palms under establishment stress, and properties in areas with active lethal bronzing or whitefly pressure. Dosing is calculated based on trunk diameter to ensure proper delivery for each individual tree.", tags: ['Multi-Product', 'DBH-Based Dosing', 'Single Visit'] },
      { title: 'Palm Health Assessment', text: "Before any injection, we perform a thorough visual health assessment of each palm — evaluating canopy fullness, frond color and condition, spear leaf integrity, trunk stability, and visible symptoms of disease, pest activity, or nutritional stress. This assessment determines which treatment products are appropriate, identifies palms that may need priority attention, and establishes a documented baseline for tracking improvement over time.", tags: ['Canopy Evaluation', 'Spear Leaf Check', 'Baseline Documentation'] },
      { title: 'Recommended Treatment Schedules', text: "Treatment frequency depends on the type of injection and the condition of the palm. Nutritional injections are typically recommended once or twice per year. Preventive insecticide treatments provide season-long systemic protection with a single annual injection. Lethal bronzing prevention requires treatments every 4–6 months for ongoing protection. Curative treatments for active infections may require an accelerated initial schedule followed by maintenance intervals. We build a treatment calendar specific to your palms and their needs.", tags: ['Annual to Biannual', 'Custom Calendar', 'Condition-Based'] },
      { title: 'Why Injection Over Spray or Soil Drench', text: "Trunk injection offers several advantages over traditional foliar sprays and soil-applied treatments for palms. There is no spray drift, no runoff, and no product lost to UV degradation or rainfall. Delivery is immediate and precise — the full dose reaches the target tissue. For tall palms, injection eliminates the coverage limitations of ground-based spray equipment. And for diseases like lethal bronzing, injection is not just the best option — it's the only viable treatment method available.", tags: ['Zero Drift', 'No Runoff', 'Full Dose Delivery'] },
      { title: 'Service Reporting & Follow-Up', text: "Every injection visit is documented with a digital service report that includes the palms treated, products and dosages applied, health assessment findings for each tree, and photos when relevant. Reports include follow-up recommendations — whether that's scheduling the next treatment window, monitoring a palm showing early symptoms, or flagging a tree that may need removal before it becomes a hazard. Our goal is to give you a clear, ongoing picture of your palm health, not just a one-time treatment.", tags: ['Digital Reports', 'Photo Documentation', 'Treatment Calendar'] },
    ],
  },
  mosquito: {
    header: 'Professional Mosquito Control, Defined.',
    subheader: 'WaveGuard Mosquito — Monthly Barrier Treatments',
    intro: "Take back your yard with a professional mosquito control program built for Southwest Florida's year-round mosquito pressure. Our barrier treatment program targets mosquitoes where they live, breed, and rest — reducing populations on your property and creating a protective perimeter so you can enjoy your outdoor spaces without the bites.",
    sections: [
      { title: 'Property Assessment & Breeding Site Survey', text: "Every mosquito program begins with a thorough inspection of your property to identify standing water sources, breeding sites, and harborage areas where adult mosquitoes rest during the day. We check gutters, plant saucers, bird baths, drainage features, low spots in the landscape, dense vegetation, and any other areas holding stagnant water. Findings guide both our treatment plan and your action items to reduce mosquito-friendly conditions between visits.", tags: ['Breeding Sites', 'Harborage Areas', 'Action Items'] },
      { title: 'Barrier Treatment Applications', text: "Our core mosquito treatment is a perimeter barrier spray applied to all vegetation, fence lines, under eaves, around patios and lanais, and in shaded resting areas where adult mosquitoes harbor during the day. The residual formulation adheres to leaf surfaces and structures, killing mosquitoes on contact for weeks after application. Treatments are applied monthly during peak season and adjusted based on seasonal pressure and rainfall patterns.", tags: ['Perimeter Spray', 'Residual Control', 'Monthly Visits'] },
      { title: 'Larvicide Applications', text: "Killing adult mosquitoes is only half the solution. We apply targeted larvicide treatments to standing water features, drainage areas, and any water-holding sites that cannot be eliminated — such as storm drains, decorative ponds, bromeliads, and low areas that collect rainwater. Larvicides prevent mosquito larvae from developing into biting adults, breaking the breeding cycle at the source and reducing the next generation of mosquitoes on your property.", tags: ['Breeding Cycle', 'Standing Water', 'Prevention'] },
      { title: 'Targeted Species Control', text: "Southwest Florida is home to over 30 mosquito species, but the ones that make outdoor living miserable are primarily Aedes aegypti (yellow fever mosquito), Aedes albopictus (Asian tiger mosquito), and various Culex species. Aedes mosquitoes are aggressive daytime biters that breed in tiny amounts of water — bottle caps, plant trays, and clogged gutters. Our treatment strategy targets these container-breeding species specifically, with product selection and application timing matched to their behavior patterns.", tags: ['Aedes Aegypti', 'Asian Tiger', 'Culex Species'] },
      { title: 'Event & Special Occasion Treatments', text: "Planning an outdoor event — a wedding, birthday party, graduation, or holiday gathering? We offer one-time or pre-event mosquito treatments timed 24–48 hours before your event to knock down mosquito populations and create a comfortable outdoor environment for your guests. Event treatments can be added to your regular program or booked as a standalone service.", tags: ['Pre-Event', '24–48 Hour Timing', 'Standalone Available'] },
      { title: 'Seasonal Program Design', text: "Mosquito pressure in Southwest Florida peaks from April through October but never fully disappears. Our program runs monthly during peak season with reduced frequency during cooler months when mosquito activity drops. Treatment timing and product rotation are adjusted throughout the year based on temperature, rainfall, and observed activity levels — ensuring you get the right level of protection when you need it most.", tags: ['April–October Peak', 'Year-Round Option', 'Adaptive Scheduling'] },
      { title: 'Integrated Pest Management Approach', text: "Effective mosquito control requires more than just spraying. Our program integrates chemical barrier treatments with habitat modification guidance, larviciding, and cultural recommendations to create a multi-layered defense. Each service report includes specific recommendations for reducing mosquito breeding and resting sites on your property — from adjusting irrigation schedules to removing hidden water-holding containers.", tags: ['Multi-Layered', 'Habitat Modification', 'Cultural Controls'] },
      { title: 'Service Reporting & Recommendations', text: "Each visit is documented with a digital service report that includes areas treated, products applied, breeding sites identified, and specific recommendations for reducing mosquito pressure between visits. Reports track conditions over time so we can measure the effectiveness of the program and make data-driven adjustments to maximize results.", tags: ['Digital Reports', 'Condition Tracking', 'Data-Driven'] },
    ],
  },
  termite: {
    header: 'Termite Bait Station Protection, Defined.',
    subheader: 'WaveGuard Termite — Monitoring & Baiting System',
    intro: "Stop termites before they reach your home. Our professional bait station system creates a continuous detection and elimination perimeter around your property — intercepting subterranean termite colonies underground before they can cause structural damage, backed by ongoing monitoring and warranty protection.",
    sections: [
      { title: 'Initial Termite Inspection', text: "Every bait station program begins with a comprehensive termite inspection of your home and property. We examine the full structure — interior and exterior — for signs of active termite activity, previous damage, conducive conditions, and entry points. This includes foundation walls, slab joints, expansion joints, plumbing penetrations, wood-to-soil contact areas, crawl spaces, attic framing, door frames, window sills, and landscape features. The inspection determines station placement strategy and identifies any conditions that need to be corrected to reduce termite risk.", tags: ['Full Structure Inspection', 'Conducive Conditions', 'Activity Assessment'] },
      { title: 'Professional Station Installation', text: "Bait stations are installed in the ground around the full perimeter of your home, spaced approximately every 10–15 feet — closer at high-risk areas such as bath traps, expansion joints, A/C units, and areas with known moisture. Each station is flush-mounted at ground level for a clean, unobtrusive appearance. Station placement follows a strategic layout designed to maximize the probability of interception by foraging termite workers before they reach the structure. The number of stations is determined by the size of your home and the specific conditions identified during the initial inspection.", tags: ['Full Perimeter', '10–15 ft Spacing', 'Flush Mount'] },
      { title: 'How the Bait System Works', text: "Subterranean termites forage continuously through the soil searching for cellulose food sources. When foraging workers encounter a bait station, they feed on the bait matrix and carry it back to the colony, sharing it with nestmates through their natural social feeding behavior. The active ingredient — an insect growth regulator — disrupts the molting process, preventing termites from developing and ultimately collapsing the colony from within. This transfer effect is what makes baiting so effective: a small number of foraging workers can deliver a lethal dose to an entire colony over time.", tags: ['Colony Elimination', 'Transfer Effect', 'Growth Regulator'] },
      { title: 'Quarterly Monitoring & Inspection', text: "Every station is inspected on a quarterly schedule by a licensed technician. During each monitoring visit, we open every station, check for termite activity, assess bait consumption levels, replace bait cartridges as needed, and document findings for each station in your service report. We also re-inspect the exterior of the structure for new signs of activity, mud tubes, or changes in conducive conditions. This ongoing monitoring ensures that if termites arrive on the property, they are detected and intercepted quickly — before they reach the home.", tags: ['Every Station Checked', 'Bait Replacement', 'Quarterly Visits'] },
      { title: 'RFID-Enabled Station Tracking', text: "Each bait station is equipped with built-in RFID identification, allowing us to digitally track and document every station on your property — its location, installation date, inspection history, bait condition, and activity status. This technology ensures that no station is missed during monitoring visits and provides a verifiable, time-stamped service record for every inspection. RFID tracking also supports faster, more efficient monitoring and gives you complete transparency into the status of your termite protection system.", tags: ['Digital Tracking', 'Station-Level Data', 'Verified Inspections'] },
      { title: 'Active Colony Response Protocol', text: "When termite activity is detected in one or more stations, we escalate immediately. Active stations receive increased bait load, and additional stations may be installed in the area of activity to maximize interception. If activity is found near or within the structure, targeted supplemental treatments — liquid spot treatments, foam applications, or direct wood treatments — can be deployed to address the immediate threat while the bait system works to eliminate the colony. You are notified at the first sign of activity so there are no surprises, and follow-up inspections are scheduled until activity is confirmed eliminated.", tags: ['Immediate Escalation', 'Supplemental Treatment', 'Confirmed Elimination'] },
      { title: 'Termite Damage Repair Warranty', text: "Our premium termite bait station plan includes a damage repair warranty covering up to $500,000 per occurrence for new termite damage to structural components or personal belongings that occurs while your system is actively monitored. The warranty includes unlimited retreatments at no additional cost if live termite activity is found at any time during your coverage period. Warranty plans are available in 1-, 5-, or 10-year terms, and coverage is transferable to a new homeowner for a nominal transfer fee — adding measurable value to your property at resale.", tags: ['$500K Repair Coverage', 'Unlimited Retreatments', 'Transferable'] },
      { title: 'Subterranean & Formosan Termite Coverage', text: "Southwest Florida is home to both Eastern subterranean termites and the more aggressive Formosan subterranean termite — a species capable of building massive colonies and causing severe structural damage in a short period. Formosan termites can also establish secondary aerial colonies above ground level, making them particularly difficult to detect and control. Our premier warranty tier covers both subterranean and Formosan species, as well as drywood termites, powderpost beetles, and old house borers — providing the most comprehensive wood-destroying organism protection available.", tags: ['Subterranean', 'Formosan', 'Drywood', 'WDO Coverage'] },
      { title: 'Conducive Conditions & Exclusion Guidance', text: "Termite protection is more than just bait in the ground. At every inspection, we evaluate and document conditions around your home that increase termite risk — wood-to-soil contact, excessive mulch against the foundation, moisture issues from irrigation or drainage, plumbing leaks, improper grading, and stored cellulose materials near the structure. Each service report includes specific, actionable recommendations to correct these conditions and reduce your home's overall vulnerability.", tags: ['Moisture Management', 'Wood-to-Soil Contact', 'Actionable Recs'] },
      { title: 'WDO Inspections for Real Estate', text: "Buying or selling a home in Florida requires a Wood-Destroying Organism inspection. We provide official WDO inspections (Florida Form 13645) for real estate transactions, documenting the presence or absence of subterranean termites, drywood termites, wood-decay fungi, and wood-boring beetles. For homes already on our bait station program, the existing station data and monitoring history provide valuable documentation of ongoing termite protection — which can be a strong selling point during a real estate transaction.", tags: ['FL Form 13645', 'Real Estate Compliance', 'Existing Station History'] },
      { title: 'Simple Monthly Billing & Long-Term Protection', text: "After initial installation, your bait station program is billed as a simple monthly fee that covers all quarterly monitoring visits, station maintenance, bait replacement, and warranty coverage. There are no surprise charges for routine service, and no per-visit fees. The system works continuously — stations are in the ground 24/7, intercepting termites whether you're home or not.", tags: ['Flat Monthly Fee', 'No Surprise Charges', '24/7 Protection'] },
    ],
  },
  rodent: {
    header: 'Professional Rodent Control, Defined.',
    subheader: 'WaveGuard Rodent — Exclusion, Trapping & Bait Station Monitoring',
    intro: "Eliminate rodent activity and keep it from coming back. Our rodent control program follows a three-phase approach — assessment and trapping, structural exclusion, and ongoing bait station monitoring — to deliver permanent results, not temporary fixes.",
    sections: [
      { title: 'Comprehensive Rodent Inspection', text: "Every rodent program begins with a thorough inspection of your home's interior and exterior to identify the species involved, the scope of activity, and every entry point being used. We inspect rooflines, soffit junctions, A/C line penetrations, plumbing roof vents, garage door margins, dryer vents, gable vents, weep holes, pipe and wire penetrations, and any gap larger than a quarter-inch — which is all a mouse needs to enter. We also assess harborage areas, food sources, droppings distribution, rub marks, and gnaw damage to build a complete picture of the infestation before recommending a treatment plan.", tags: ['Full Structure Audit', 'Entry Point Mapping', 'Species Identification'] },
      { title: 'Interior Trapping Program', text: "When rodents are active inside the home, we deploy professional snap traps in strategic locations based on activity patterns identified during inspection — along runways, near droppings concentrations, in attic spaces, behind appliances, inside wall voids, and in garages or utility areas. Traps are checked and reset on a regular schedule until interior activity is confirmed eliminated. We use mechanical traps rather than interior rodenticide to avoid the risk of rodents dying in inaccessible areas within the structure and causing odor issues.", tags: ['Strategic Placement', 'Attic & Wall Voids', 'No Interior Poison'], oneTime: true },
      { title: 'Structural Exclusion — Sealing Entry Points', text: "Exclusion is the most important step in permanent rodent control. After trapping reduces the active population, we seal every identified entry point using materials rodents cannot chew through — copper mesh packed into gaps before sealing with pest-block expanding foam, galvanized hardware cloth secured over larger openings like gable vents and soffit gaps, and sheet metal or steel plates for high-traffic entry zones. Every A/C line penetration, plumbing stack, roof-wall junction, garage door gap, and utility entry is addressed. Exclusion work is documented with photos so you can see exactly what was done and where.", tags: ['Copper Mesh', 'Hardware Cloth', 'Photo Documentation'], oneTime: true },
      { title: 'Exterior Tamper-Resistant Bait Stations', text: "Tamper-resistant bait stations are installed at strategic locations around the exterior perimeter of your home — near identified entry points, along foundation walls, beside garages, near A/C units, and in other areas where rodent activity has been observed or is likely. Each station is locked, weighted, and designed to prevent access by children, pets, and non-target wildlife while allowing rodents to enter and feed. Bait stations intercept rodents in the landscape before they attempt to enter the structure, serving as a continuous first line of defense around your home.", tags: ['Tamper-Resistant', 'Pet & Child Safe', 'Perimeter Defense'] },
      { title: 'Monthly Bait Station Monitoring', text: "Every exterior bait station is inspected monthly by a licensed technician. During each monitoring visit, we open every station, check bait consumption levels, replace or replenish bait as needed, look for signs of new rodent activity, and inspect the exterior of the structure for any evidence of re-entry attempts or new gaps. This ongoing monitoring catches changes in rodent pressure early — before a new population can establish — and ensures your exclusion work and bait stations remain intact and effective over time.", tags: ['Every Station Checked', 'Bait Replenishment', 'Re-Entry Detection'] },
      { title: 'Exclusion Integrity Checks', text: "Rodents are persistent. They will test sealed entry points, gnaw at exclusion materials, and exploit new gaps that develop from settling, weathering, or maintenance work on the home. At every monitoring visit, we re-inspect all sealed entry points and exclusion work to verify it remains intact. If any material has been compromised, we repair or reinforce it immediately. This ongoing exclusion maintenance is what separates a permanent solution from a temporary one — and it's included in the monthly monitoring program.", tags: ['Seal Verification', 'Damage Repair', 'Included in Monitoring'] },
      { title: 'Harborage & Habitat Reduction', text: "Rodent control doesn't stop at the structure. We evaluate and provide recommendations for landscape and property conditions that attract and harbor rodents — vegetation growing within three feet of the foundation, dense ground cover against walls, overgrown hedges that provide runway cover, fruit trees dropping unpicked fruit, woodpiles and debris stored against the home, bird feeders creating food sources, and pet food left outdoors. Each service report includes specific, actionable steps to reduce the property's attractiveness to rodents between visits.", tags: ['Vegetation Clearance', 'Food Source Removal', 'Property Recs'] },
      { title: 'Roof Rat & Norway Rat Strategies', text: "Southwest Florida deals primarily with roof rats — agile climbers that access structures from above through rooflines, soffits, palm trees touching the roof, and overhead utility lines. Norway rats, while less common locally, favor ground-level entry through foundation gaps and burrows. Our treatment strategy is adapted to the species identified during inspection. Roof rats require overhead exclusion work and attic-focused trapping, while Norway rats demand ground-level station placement and burrow treatment. Correct species identification drives every decision in the program.", tags: ['Roof Rat Focus', 'Species-Specific', 'Overhead Exclusion'] },
      { title: 'Sanitation & Contamination Guidance', text: "Rodent infestations leave behind droppings, urine, nesting material, and contamination that can pose health risks even after the animals are removed. We provide detailed guidance on safe cleanup procedures for attic insulation, storage areas, garages, and any interior spaces where rodent activity was present. For significant contamination in attic spaces, we can recommend professional insulation removal and replacement services.", tags: ['Cleanup Guidance', 'Attic Contamination', 'Health & Safety'], oneTime: true },
      { title: 'The Three-Phase Approach', text: "Our rodent program is structured in three clear phases, each designed to build on the last. Phase 1 — Assessment & Trapping: Inspection, species identification, interior trap deployment, and initial population reduction. Phase 2 — Exclusion: Sealing every entry point with rodent-proof materials, removing harborage, and installing exterior bait stations. Phase 3 — Ongoing Monitoring: Monthly bait station inspection, exclusion integrity checks, and re-entry surveillance to ensure permanent results. Most active infestations are resolved within Phases 1 and 2. Phase 3 keeps them from coming back.", tags: ['Phase 1: Trap', 'Phase 2: Seal', 'Phase 3: Monitor'] },
      { title: 'Service Reporting & Documentation', text: "Every visit — from the initial inspection through ongoing monitoring — is documented with a detailed digital service report. Reports include findings at each bait station, trap results, photos of exclusion work, new activity observations, and any recommendations for property improvements. This documentation creates a complete, trackable history of your rodent control program — showing what was done, what was found, and how the situation is improving over time.", tags: ['Digital Reports', 'Photo Documentation', 'Treatment Calendar'] },
    ],
  },
  lawnOneTime: {
    header: 'One-Time Lawn Services.',
    subheader: 'Restoration, Renovation & Single-Visit Treatments',
    intro: "Not every lawn needs a year-round program to get results. Our one-time services are designed for targeted restoration, seasonal renovation, or single-visit treatments — whether you're repairing damaged turf, preparing for sod or plugging, or addressing a specific weed, pest, or disease issue that needs immediate attention.",
    groups: [
      { groupTitle: 'Lawn Restoration & Renovation', sections: [
        { title: 'Lawn Plugging', text: "Repair thin, bare, or damaged areas of your lawn by installing fresh St. Augustine grass plugs into the existing turf. Plugs are planted at your choice of spacing density — from economy spacing for gradual fill-in to premium tight spacing for faster, fuller coverage. We use fresh-cut plugs installed with professional equipment for consistent depth and soil contact, giving each plug the best chance to root and spread. Plugging is ideal for shaded areas where sod struggles to establish, for repairing chinch bug or drought damage, or for thickening thin turf without the cost of full sod replacement.", tags: ['St. Augustine', 'Multiple Densities', 'Shade Repair', 'Chinch Bug Recovery'] },
        { title: 'Top Dressing', text: "A thin, uniform layer of clean sand is spread across the lawn surface to smooth out uneven terrain, improve soil structure, accelerate thatch decomposition, and promote healthier root development. Top dressing is applied at either a light maintenance depth or a heavier renovation depth depending on the condition of the turf. It's especially effective after dethatching or core aeration — filling in the voids left behind and creating a better growing environment at the soil surface. We use a professional top dresser for even, consistent distribution across the entire lawn.", tags: ['Sand Application', 'Level Correction', 'Thatch Reduction', 'Post-Dethatch'] },
        { title: 'Dethatching', text: "Excess thatch — the layer of dead stems, roots, and organic matter between the grass blades and the soil surface — blocks water, nutrients, and air from reaching the root zone when it builds up beyond a half-inch. Our mechanical dethatching service uses a professional power dethatcher to cut through and remove this buildup, restoring proper air and water movement into the soil. After dethatching, your lawn may look rough for a few weeks, but recovers stronger and denser as the turf fills back in with improved root-zone access. Best performed during the active growing season (spring through early fall in Southwest Florida) when the grass can recover quickly.", tags: ['Power Dethatcher', 'Root Zone Access', 'Spring/Summer Timing'] },
        { title: 'Overseeding', text: "For lawns with thin or patchy coverage where plugging isn't necessary, overseeding introduces new grass seed into the existing turf to improve density and fill in gaps. Seed is distributed evenly across the lawn and lightly worked into the soil surface for good seed-to-soil contact. Overseeding is most effective when combined with core aeration or dethatching — both of which create openings in the turf canopy and soil surface that give seed a better chance to germinate. We'll recommend the right seed variety based on your turf type, sun exposure, and the specific conditions of your lawn.", tags: ['Density Improvement', 'Seed-to-Soil Contact', 'Pairs With Aeration'] },
      ]},
      { groupTitle: 'Single-Visit Lawn Treatments', sections: [
        { title: 'One-Time Fertilization', text: "A single professional fertilizer application to boost color, density, and overall turf health — without committing to a full-year program. We select the right formulation based on your grass type, time of year, and what your lawn needs most: a balanced slow-release granular for general nutrition, a high-nitrogen blend for quick green-up, or a micronutrient and iron package for color correction during fertilizer restriction periods. Application rates are calibrated to your lawn's square footage and follow all local fertilizer ordinances, including Manatee, Sarasota, and Charlotte County seasonal blackout requirements.", tags: ['Slow-Release Granular', 'Blackout Compliant', 'No Annual Commitment'] },
        { title: 'One-Time Weed Control', text: "A targeted herbicide application to knock back weeds that have gotten ahead of your lawn. Pre-emergent treatments create a barrier in the top layer of soil that prevents weed seeds from germinating — ideal when applied ahead of the spring or fall weed flush. Post-emergent treatments use selective herbicides to kill active weeds without harming your turf, targeting broadleaf weeds, sedges, and grassy invaders based on what's growing in your lawn. Herbicide selection is matched to your grass type and the specific weed species present to ensure effective control and turf safety. Results are typically visible within 7–21 days depending on the weed type and product used.", tags: ['Pre-Emergent Barrier', 'Post-Emergent Spot Treat', 'Turf-Safe Selective'] },
        { title: 'One-Time Lawn Pest Control', text: "When you're dealing with an active lawn pest problem — chinch bugs, sod webworms, armyworms, mole crickets, grubs, or fire ants — a single targeted insecticide application can stop the damage and protect your turf from further loss. We identify the pest causing the damage, select the right chemistry for that species, and apply at the correct rate and timing to maximize effectiveness. For chinch bugs and sod webworms in St. Augustine lawns, early intervention is critical — a few weeks of unchecked feeding can destroy large areas of turf.", tags: ['Chinch Bug', 'Sod Webworm', 'Armyworm', 'Emergency Response'] },
        { title: 'One-Time Fungicide Treatment', text: "Fungal diseases like large patch, dollar spot, gray leaf spot, and Pythium can spread quickly in Southwest Florida's warm, humid conditions — especially during the fall transition and summer wet season. Our one-time fungicide treatment applies a curative or preventive fungicide matched to the disease identified in your lawn. For active large patch infections, we use a combination approach to address the disease on multiple fronts. Because fungal diseases are often linked to overwatering, we'll also evaluate your irrigation schedule and provide recommendations to reduce the conditions that caused the outbreak.", tags: ['Large Patch', 'Dollar Spot', 'Curative + Preventive', 'Irrigation Review'] },
      ]},
    ],
    footer: "One-time services are priced per visit based on lawn size and treatment type. Restoration services like plugging, top dressing, and dethatching are often most effective when combined — ask about package pricing. Customers on a WaveGuard recurring lawn care plan receive preferred pricing on all one-time services.",
  },
  termiteOneTime: {
    header: 'One-Time Termite Treatments.',
    subheader: 'Liquid Barrier, Attic Remediation, Pre-Slab & Foam Injection',
    intro: "When termite activity is confirmed or prevention is needed beyond a bait station system, we offer a full range of one-time treatment options — from perimeter liquid barriers and attic wood treatments to new construction pre-slab applications and precision foam injection into active galleries. Each method is selected based on the termite species, location of activity, and the construction type of your home.",
    groups: [
      { groupTitle: 'Liquid Barrier — Termite Trenching', sections: [
        { title: 'How Termite Trenching Works', text: "A shallow trench is excavated along the full foundation perimeter of your home, and a professional-grade, non-repellent liquid termiticide is applied directly into the soil at label rates. The trench is then backfilled, leaving a continuous chemical barrier in the soil surrounding your foundation. Subterranean termites foraging through the treated soil contact the product unknowingly — picking it up and transferring it to nestmates through normal colony interactions. This transfer effect doesn't just repel termites; it systematically eliminates the colony from within.", tags: ['Full Perimeter', 'Non-Repellent', 'Colony Transfer Effect'] },
        { title: 'Fast-Acting & Long-Lasting Protection', text: "Liquid barrier treatments begin killing termites within days of contact — significantly faster than bait station systems, which can take months to achieve colony reduction. A properly applied liquid treatment provides 5–10 years of continuous soil protection with a single application and no ongoing service contract. For homeowners dealing with an active subterranean infestation or looking for the fastest, most cost-effective treatment with the longest residual, liquid trenching is typically the strongest option.", tags: ['Days to Kill', '5–10 Year Residual', 'No Recurring Fee'] },
        { title: 'Dirt Trenching & Concrete Drilling', text: "Treatment is applied along the entire foundation perimeter — both soil sections and areas adjacent to concrete. In soil areas, a standard trench is dug, treated, and backfilled. Where the foundation meets concrete — garage slabs, driveways, patios, sidewalks, and pool decks — we drill through the concrete at regular intervals, inject termiticide into the soil beneath using a sub-slab injection rod, and patch each drill point. This ensures complete, unbroken barrier coverage around the entire structure, including the areas termites are most likely to exploit.", tags: ['Soil Trenching', 'Sub-Slab Injection', 'Drill & Patch'] },
      ]},
      { groupTitle: 'Attic Remediation — Borate Wood Treatment', sections: [
        { title: 'How Borate Wood Treatment Works', text: "A professional-grade borate solution is applied directly to exposed wood surfaces in your attic — trusses, rafters, sheathing, joists, and any accessible structural framing. The borate penetrates into the wood and remains there permanently, creating a protective barrier inside the wood itself. Any wood-destroying organism that feeds on treated wood — subterranean termites, drywood termites, carpenter ants, powderpost beetles, and wood-decay fungi — ingests the borate and is eliminated. Once applied, the treatment does not evaporate, break down, or lose effectiveness over time.", tags: ['Borate Penetration', 'Permanent Protection', 'Multi-Organism'] },
        { title: 'Lifetime Protection on Treated Wood', text: "Unlike liquid soil treatments that degrade over time or bait systems that require ongoing monitoring, borate wood treatment is a one-time application that provides permanent protection on every piece of wood it contacts. This makes it especially valuable for drywood termite prevention — the species that enters structures from the air and infests the wood directly, bypassing soil barriers entirely. In Southwest Florida, where both subterranean and drywood termite pressure is year-round, treating the attic with borate is one of the most effective long-term investments a homeowner can make in structural protection.", tags: ['One-Time Application', 'Drywood Prevention', 'No Recurring Cost'] },
        { title: 'What Gets Treated', text: "We treat all accessible wood surfaces in the attic space — roof trusses, top chord and bottom chord members, web bracing, ridge beams, hip and valley rafters, ceiling joists, plywood roof sheathing, collar ties, gable framing, and any exposed fascia or soffit framing accessible from inside the attic. Treatment is applied using a combination of spray and foam application methods to ensure complete coverage of all wood surfaces, including joints, overlaps, and hard-to-reach areas where drywood termites are most likely to establish colonies.", tags: ['Full Attic Coverage', 'Spray & Foam', 'Joints & Overlaps'] },
      ]},
      { groupTitle: 'Pre-Slab Treatment — New Construction', sections: [
        { title: 'Pre-Construction Soil Treatment', text: "Before the concrete slab is poured on new construction, we apply a non-repellent termiticide directly to the prepared soil surface at full label rates. This creates a continuous treated zone beneath the entire slab — the area most vulnerable to subterranean termite entry through expansion joints, plumbing penetrations, and cracks that may develop over time. Pre-slab treatment is the single most effective time to protect a structure from termites, because the soil is fully accessible before it's permanently sealed under concrete. Once the slab is poured, this level of coverage is no longer possible without drilling.", tags: ['Before Concrete Pour', 'Full Slab Coverage', 'Non-Repellent'] },
        { title: 'Builder Warranty & Homeowner Transfer', text: "Every pre-slab treatment includes a builder's warranty covering the initial protection period. This warranty is transferable to the homeowner at closing, providing documented termite protection from day one of occupancy. Extended warranty terms are available for homeowners who want longer coverage, and the pre-slab treatment ties naturally into an ongoing termite bait station monitoring program for continuous, layered protection over the life of the home. We coordinate directly with your builder's schedule to ensure treatment is completed on time and does not delay the construction timeline.", tags: ['Builder Warranty', 'Transferable', 'Builder Coordination'] },
      ]},
      { groupTitle: 'Foam Injection — Localized Treatment', sections: [
        { title: 'Precision Drill-and-Inject Treatment', text: "When termite activity is confirmed in a specific area of the structure — a wall void, door frame, window frame, sill plate, or structural joint — we use a precision drill-and-inject method to deliver expanding termiticide foam directly into the infested area. Small holes are drilled at strategic points, and a non-repellent foam formulation is injected that expands to fill galleries, voids, and hidden spaces where termites are actively feeding. The foam creates strong, long-lasting cell walls that maintain contact with surrounding wood surfaces, delivering sustained control in areas that liquid sprays and granular products cannot reach.", tags: ['Expanding Foam', 'Gallery Penetration', 'Wall Void Access'] },
        { title: 'When Foam Treatment Is the Right Choice', text: "Foam injection is the surgical option — used when termite activity is localized to a specific area rather than distributed across the entire structure. It's the right tool for drywood termite infestations caught early in a single wall or room, for subterranean activity found at a specific slab penetration or expansion joint, for door frames and window frames showing evidence of damage, and for areas inaccessible to standard liquid treatment. Foam treatment is a targeted, lower-cost alternative to full perimeter trenching or tent fumigation when the scope of the problem is contained.", tags: ['Localized Infestations', 'Drywood Spot Treatment', 'Cost-Effective'] },
        { title: 'Drill Points, Patching & Documentation', text: "Each drill point is carefully placed based on the location of confirmed activity and the construction details of the infested area. After foam injection is complete, all drill holes are sealed and patched to restore the finished surface. Every drill point location, product applied, and finding is documented in your service report with photos, giving you a clear record of exactly what was treated and where.", tags: ['Surface Patching', 'Scalable Scope', 'Photo Documentation'] },
      ]},
    ],
    footer: "All one-time termite treatments begin with a professional termite inspection to confirm the species, location, and scope of activity before recommending a treatment method. Treatments can be paired with a WaveGuard termite bait station program for ongoing monitoring and long-term warranty protection after the initial treatment is complete.",
  },
  pestOneTime: {
    header: 'One-Time Pest Treatments.',
    subheader: 'Single-Visit & Multi-Visit Specialty Protocols',
    intro: "Not every pest problem requires a recurring program. Our one-time treatments are designed for specific infestations, urgent situations, or customers who need a targeted solution without a long-term commitment. Every treatment is priced based on your home's size and the scope of the problem — and every one-time customer receives preferred pricing if they choose to transition to a recurring pest control plan.",
    groups: [
      { groupTitle: 'General Pest Treatment', sections: [
        { title: 'One-Time General Pest Treatment', text: "A single professional interior and exterior pest treatment covering 75+ common household pests — ants, roaches, spiders, silverfish, earwigs, crickets, centipedes, pill bugs, and other crawling and flying insects. The visit includes a full property inspection to identify activity and entry points, an exterior perimeter barrier spray, interior crack-and-crevice treatment in active areas, de-webbing of eaves and entryways, and a detailed service report with findings and recommendations. This is the same comprehensive treatment included in our quarterly program — delivered as a single visit for customers who need immediate help or want to try the service before committing to a recurring plan.", tags: ['75+ Pests', 'Interior & Exterior', 'Single Visit'] },
      ]},
      { groupTitle: 'Mosquito Event Spray', sections: [
        { title: 'One-Time Mosquito Barrier Treatment', text: "A full barrier spray treatment of your property for a single occasion — a wedding, graduation, holiday gathering, outdoor dinner, or any event where you want to reduce mosquito activity in your yard. We apply a residual barrier spray to all foliage, shrub beds, fence lines, lanai and screen perimeters, eave junctions, and shaded resting areas — the same professional-grade treatment used in our recurring mosquito programs. Standing water sources are inspected and treated with larvicide. Results typically last 3–4 weeks depending on weather conditions.", tags: ['Event Ready', '3–4 Week Results', 'Full Barrier + Larvicide'] },
      ]},
      { groupTitle: 'Flea & Tick Treatment', sections: [
        { title: 'Two-Visit Flea Treatment Protocol', text: "Flea infestations require more than a single spray — the flea life cycle includes eggs, larvae, and pupae stages that are resistant to most contact insecticides. Our two-visit protocol is designed to break that cycle completely. Visit 1 includes a thorough interior treatment of all carpeted areas, baseboards, upholstered furniture, pet resting areas, and cracks where flea larvae develop — combined with a full yard spray targeting flea larvae and adult fleas in shaded, moist areas of the landscape. Visit 2 is a follow-up treatment approximately two weeks later to catch the next generation of fleas emerging from protected pupal stages that survived the initial treatment.", tags: ['2-Visit Protocol', 'Interior + Yard', 'Life Cycle Disruption'] },
        { title: 'Customer Preparation & Pet Coordination', text: "Effective flea treatment requires coordination between our treatment and your household preparation. Before each visit, we provide detailed instructions for pre-treatment preparation — vacuuming all floors and upholstery, washing pet bedding, and ensuring pets are treated with a veterinarian-recommended flea preventive. Pet flea treatment is critical: without it, pets will reintroduce fleas into the home and the infestation will return regardless of how effective our treatment is. We'll walk you through the preparation steps and answer any questions before we arrive.", tags: ['Prep Instructions', 'Pet Vet Coordination', 'Reintroduction Prevention'] },
      ]},
      { groupTitle: 'German Cockroach Treatment', sections: [
        { title: 'Three-Visit German Cockroach Protocol', text: "German cockroaches are the most difficult household pest to eliminate — they reproduce rapidly, develop resistance to common products, and hide deep inside wall voids, appliance motors, and electrical chaseways where surface sprays can't reach. Our intensive three-visit protocol attacks the problem from multiple angles. Visit 1 is the full treatment: professional gel bait placed in all harborage zones, insect growth regulator (IGR) applied to disrupt the reproductive cycle, and a crack-and-crevice application targeting active hiding spots in kitchens, bathrooms, and utility areas. Visit 2 at two weeks reassesses activity levels, refreshes bait placements, and treats any new harborage areas discovered. Visit 3 at four weeks confirms elimination, replaces monitoring traps, and verifies the population is collapsing.", tags: ['3-Visit Protocol', 'Gel Bait + IGR', 'Crack & Crevice'] },
        { title: 'Monitoring & Bait Rotation', text: "Sticky monitoring traps are placed in key areas during the initial treatment to track population trends between visits. Trap counts give us an objective measure of progress — not just whether roaches are still visible, but whether the population is declining as expected. Bait formulations are rotated between visits using different active ingredients to prevent bait aversion — a well-documented behavior in German cockroach populations where the colony learns to avoid a bait product that has been effective. Product rotation ensures the treatment stays ahead of the pest's ability to adapt.", tags: ['Trap Monitoring', 'Population Tracking', 'Bait Aversion Prevention'] },
      ]},
      { groupTitle: 'Wasp, Bee & Stinging Insect Removal', sections: [
        { title: 'Stinging Insect Nest Removal', text: "We remove active nests of paper wasps, red wasps, yellow jackets, mud daubers, and other stinging insects from eaves, soffits, porch ceilings, shutters, mailboxes, play equipment, pool cages, and other areas around your home where nests pose a safety risk. Treatment includes a targeted application of a fast-acting contact insecticide to eliminate active adults, followed by physical removal of the nest structure and a residual treatment of the nesting site to discourage rebuilding. For customers on a recurring pest control program, wasp and stinging insect nest removal is included at no additional charge as part of your regular service visits.", tags: ['Nest Removal', 'Contact + Residual', 'Included on Program'] },
        { title: 'Bee & Honeybee Situations', text: "If the stinging insects on your property are honeybees, we take a different approach. Honeybees are critical pollinators and are protected in many contexts. Whenever possible, we coordinate with local beekeepers for safe relocation of honeybee colonies rather than extermination. If the colony is established inside a wall void, soffit, or other structural cavity, removal may require opening the structure to extract the hive, comb, and honey — which we can coordinate or refer to a specialist. We'll assess the situation on-site and recommend the safest, most responsible course of action for both you and the bees.", tags: ['Beekeeper Referral', 'Safe Relocation', 'Structural Hive Removal'] },
      ]},
      { groupTitle: 'Bed Bug Treatment', sections: [
        { title: 'Chemical Bed Bug Treatment — Two-Visit Protocol', text: "For light to moderate bed bug infestations, our two-visit chemical protocol delivers effective elimination using professional-grade residual insecticides that are not available in retail products. Visit 1 includes a thorough inspection to map the extent of the infestation, followed by treatment of mattresses, box springs, bed frames, headboards, baseboards, nightstands, and all cracks and crevices in the affected room. Visit 2 at approximately two weeks reapplies treatment to catch any bed bugs that have emerged from eggs since the initial visit — eggs are resistant to most contact insecticides and take 7–10 days to hatch. Pricing is per room, and additional rooms can be added based on the scope of the infestation.", tags: ['2-Visit Protocol', 'Per Room Pricing', 'Light to Moderate'] },
        { title: 'Heat Treatment — Single-Visit Elimination', text: "For heavier infestations or situations where chemical treatment alone may not be sufficient, heat treatment is the most effective single-visit option. Professional heating equipment raises the temperature of the affected room to a lethal threshold — sustained for several hours — killing bed bugs in all life stages including eggs, which are resistant to most chemical products. Heat penetrates mattresses, furniture, wall voids, and personal belongings that chemical treatments may not reach. No chemical residue is left behind, and the room can typically be reoccupied the same day after cool-down. Heat treatment is priced per room and is the preferred method when complete, single-visit elimination is the priority.", tags: ['All Life Stages', 'Single Visit', 'No Chemical Residue'] },
        { title: 'Inspection, Preparation & Follow-Up', text: "Every bed bug treatment begins with a detailed inspection to confirm the presence of bed bugs, identify the scope of the infestation across the home, and determine whether chemical or heat treatment — or a combination — is the right approach. We provide a pre-treatment preparation checklist covering laundering, decluttering, and mattress encasement recommendations. After treatment, a follow-up inspection is scheduled to verify elimination and check for any signs of re-emergence. If additional treatment is needed, it's addressed immediately. Our goal is complete elimination — confirmed, not assumed.", tags: ['Confirmed Elimination', 'Prep Checklist', 'Follow-Up Inspection'] },
      ]},
    ],
    footer: "All one-time pest treatments include a 30-day callback guarantee — if the problem returns within 30 days of treatment, we come back at no additional charge. Treatments are priced based on your home's size and the scope of the problem. Customers who transition to a recurring WaveGuard pest control plan after a one-time treatment receive preferred pricing and ongoing protection to prevent the problem from returning.",
  },
  rodentOneTime: {
    header: 'One-Time Rodent Services.',
    subheader: 'Trapping, Exclusion & Sanitation — Permanent Solutions',
    intro: "Solve your rodent problem the right way — with a structured approach that removes the animals, seals the entry points, and cleans up what they left behind. Each service can be performed individually or combined into a complete resolution package. After the initial work is done, ongoing bait station monitoring is available to keep your home protected long-term.",
    groups: [
      { groupTitle: 'Rodent Trapping', sections: [
        { title: 'Inspection & Activity Assessment', text: "Every rodent trapping service begins with a detailed inspection of your home — interior and exterior — to identify the species involved, the scope of activity, entry points being used, and the areas of heaviest concentration. We examine attic spaces, garages, utility areas, behind appliances, and under sinks for droppings, rub marks, gnaw damage, nesting material, and other evidence of rodent presence. This assessment determines how many traps are needed, where they should be placed, and how many service visits the situation requires. You receive a full inspection report documenting findings and our recommended treatment plan before any work begins.", tags: ['Species Identification', 'Activity Mapping', 'Treatment Plan'] },
        { title: 'Professional Trap Deployment', text: "Professional snap traps are deployed in strategic interior locations based on the activity patterns identified during inspection — along confirmed runways, near droppings concentrations, inside attic spaces, in garage and utility areas, behind appliances, and at entry points where rodents are entering the living space. Traps are placed in tamper-resistant stations or in areas inaccessible to children and pets. We use mechanical snap traps rather than interior rodenticide to eliminate the risk of rodents dying in wall voids, attic insulation, or other inaccessible areas and causing odor problems inside the home.", tags: ['Snap Traps', 'Strategic Placement', 'No Interior Poison'] },
        { title: 'Check & Reset Visits', text: "After the initial trap deployment, we return on a regular schedule — typically every 3–5 days during active trapping — to check all traps, remove any catches, reset and reposition traps as needed, and monitor activity levels. Each visit is documented with a service report showing which traps fired, locations of catches, and remaining activity indicators. The trapping program continues until interior activity is confirmed eliminated — meaning multiple consecutive check visits with no new catches and no fresh signs of activity. Most residential situations are resolved within 1–3 weeks of active trapping depending on the severity of the infestation.", tags: ['3–5 Day Checks', 'Documented Catches', 'Confirmed Elimination'] },
      ]},
      { groupTitle: 'Rodent Exclusion', sections: [
        { title: 'Entry Point Sealing', text: "Exclusion is the most critical step in permanent rodent control — without it, new rodents will simply re-enter through the same gaps and the problem returns. We seal every identified entry point using materials rodents cannot chew through: copper mesh packed into gaps before sealing with pest-block expanding foam, galvanized hardware cloth secured over larger openings like gable vents and soffit gaps, and sheet metal or steel plates for high-traffic entry zones. Common entry points in Southwest Florida homes include A/C line penetrations, plumbing roof vents, soffit-to-fascia junctions, garage door margins and weather stripping gaps, dryer vents, gable vents without proper screening, pipe and wire penetrations through exterior walls, and any gap larger than a quarter-inch.", tags: ['Copper Mesh', 'Hardware Cloth', 'Steel Plate', 'Quarter-Inch Standard'] },
        { title: 'Roof Rat–Specific Exclusion', text: "Southwest Florida's primary rodent threat is the roof rat — agile climbers that access structures from above through rooflines, soffit junctions, and overhanging tree branches. Roof rat exclusion requires more than ground-level sealing. We inspect and seal at the roofline level: soffit-to-wall transitions, ridge vent openings, plumbing stacks, attic fan housings, chimney gaps, and any point where the roof structure meets a vertical wall. Overhanging branches that provide aerial access to the roof are identified and documented for trimming. Every sealed point is photographed before and after so you have a clear record of the work performed.", tags: ['Roofline Access', 'Soffit Junctions', 'Before & After Photos'] },
        { title: 'Harborage Reduction Recommendations', text: "Sealing entry points is only part of the picture. The landscape and property conditions around your home directly influence how much rodent pressure your exclusion work will face over time. We evaluate and provide specific recommendations for reducing harborage and food sources — trimming vegetation at least three feet from the foundation and roofline, removing dense ground cover against walls, addressing fruit trees dropping unpicked fruit, relocating woodpiles and debris away from the structure, managing pet food storage, and adjusting bird feeder placement. These recommendations are included in your service report with clear, actionable steps.", tags: ['Vegetation Clearance', 'Food Source Control', 'Actionable Report'] },
      ]},
      { groupTitle: 'Rodent Sanitation', sections: [
        { title: 'Droppings & Contamination Cleanup', text: "Rodent infestations leave behind droppings, urine, nesting material, and food debris that pose real health risks — including exposure to hantavirus, salmonella, leptospirosis, and other pathogens. After trapping and exclusion are complete, we provide professional sanitation of affected areas. This includes removal of droppings and nesting material from accessible surfaces in attics, garages, utility closets, and storage areas, followed by treatment with professional-grade antimicrobial and deodorizing agents to neutralize contamination and eliminate lingering odors. All waste material is bagged and removed from the property.", tags: ['Droppings Removal', 'Antimicrobial Treatment', 'Odor Neutralization'] },
        { title: 'Attic Insulation Assessment', text: "In cases of prolonged or heavy rodent activity, attic insulation can become heavily contaminated with urine, droppings, and nesting material — compressed, soiled, and no longer performing its insulating function. We assess the condition of your attic insulation during the sanitation process and provide an honest evaluation of whether surface cleaning is sufficient or whether partial or full insulation removal and replacement is warranted. For significant contamination, we can coordinate professional insulation removal and blown-in replacement services to restore your attic to a clean, properly insulated state.", tags: ['Insulation Evaluation', 'Removal Coordination', 'Energy Efficiency'] },
        { title: 'Pheromone & Scent Trail Elimination', text: "Rodents leave behind pheromone and urine scent trails that serve as chemical highways — guiding other rodents directly to the same entry points, runways, and nesting sites that the previous population used. Even after trapping and exclusion, these invisible scent markers can attract new rodents from the surrounding area to test your sealed entry points. Our sanitation process includes treatment of confirmed runways, entry point interiors, and high-activity zones with products designed to neutralize these scent trails, reducing the chemical signals that draw new rodents to your home and making your exclusion work more durable over time.", tags: ['Pheromone Removal', 'Runway Treatment', 'Future Prevention'] },
      ]},
      { groupTitle: 'Ongoing Maintenance — Keep It Solved', sections: [
        { title: 'Monthly Bait Station Monitoring Program', text: "After the initial trapping, exclusion, and sanitation work is complete, the best way to ensure rodents don't return is ongoing bait station monitoring. Tamper-resistant exterior bait stations are installed at strategic points around your home's perimeter, and a licensed technician inspects every station monthly — checking bait consumption, replenishing as needed, inspecting exclusion work for any signs of compromise, and monitoring the exterior for new rodent activity. This recurring program catches changes in rodent pressure early, before a new population can re-establish, and keeps your exclusion work maintained and verified over time. Monthly monitoring is available as a standalone service or as an add-on to any WaveGuard pest control plan.", tags: ['Monthly Visits', 'Bait Replenishment', 'Exclusion Verification'] },
        { title: 'Why Ongoing Monitoring Matters', text: "Rodent exclusion is highly effective, but no home is permanently sealed. Settlement shifts, weather exposure, new utility work, roof repairs, and even normal aging can create new gaps over time. Neighboring properties, construction activity, and seasonal rodent migration patterns also change the pressure your home faces. Monthly monitoring ensures that if any new vulnerability develops — or if rodent pressure in your area increases — it's detected and addressed immediately rather than discovered after rodents have already re-entered the structure. The cost of preventing re-entry is a fraction of the cost of repeating a full trapping and exclusion service.", tags: ['Prevent Re-Entry', 'Seasonal Pressure Shifts', 'Lower Cost Than Repeating'] },
      ]},
    ],
    footer: "Rodent trapping, exclusion, and sanitation are each available as standalone one-time services or combined into a complete resolution package. Most active infestations benefit from all three — trapping removes the population, exclusion prevents re-entry, and sanitation eliminates the health hazards and scent trails left behind. After the initial work is done, our monthly bait station monitoring program provides ongoing protection.",
  },
};

const PERKS = [
  '10-30% Off Any Service',
  'Free Annual Termite Inspection',
  'Priority Scheduling',
  'Unlimited Callbacks',
  '24-Hour Response Time',
  '15% Off Any One-Time Treatment',
  'Waves Loyalty Access',
  'Digital Service Reports & Photos',
  'Waves App Access',
];

const REVIEWS = [
  {
    text: "We recently engaged Waves for our pest control needs. We had been using a well known competitor but their service was poor \u2014 many times we had to have them address shoddy work. Adam provided an extensive overview of his services and quoted a vastly more competitive rate.",
    name: 'Lakewood Ranch customer',
    location: 'Lakewood Ranch',
  },
  {
    text: "The Waves team was thorough, on-time and provided a great pest control service. I was using one of the big brands and was not satisfied. I will be using Waves for quarterly service from now on!",
    name: 'Jennifer',
    location: 'Bradenton',
  },
  {
    text: "My fiance and I live in Parrish, she and I along with two dogs were attacked by Africanized Killer bees. Waves responded quickly and handled the situation professionally.",
    name: 'Parrish customer',
    location: 'Parrish',
  },
];

const LOCATIONS = [
  { name: 'Lakewood Ranch', address: '13649 Luxe Ave #110, Bradenton, FL 34211', phone: '(941) 318-7612', tel: '+19413187612' },
  { name: 'Parrish', address: '5155 115th Dr E, Parrish, FL 34219', phone: '(941) 297-2817', tel: '+19412972817' },
  { name: 'Sarasota', address: '1450 Pine Warbler PL, Sarasota, FL 34240', phone: '(941) 297-2606', tel: '+19412972606' },
  { name: 'Venice', address: '1978 S Tamiami Trl #10, Venice, FL 34293', phone: '(941) 297-3337', tel: '+19412973337' },
];

const FAQ_CATEGORIES = [
  {
    category: 'Price & Value', questions: [
      { q: "Why is your price different from the big national brands?", a: "We're not a franchise charging you for a corporate office in Tennessee. Every dollar goes to better products, trained techs, and actual time on your property. The big brands rush through in 8 minutes — our techs spend 30-45 minutes on a standard visit because we're treating your specific lawn and pest issues, not running a conveyor belt." },
      { q: "Can I just do quarterly pest and skip the lawn/mosquito?", a: "Absolutely. But here's the thing — bundling saves you real money. Adding lawn care to your pest plan unlocks Silver (10% off everything). Add mosquito and you're at Gold (15% off). Most customers save $200-400/year by bundling vs. buying services separately." },
      { q: "Can you match my current provider's price?", a: "We don't price-match because we don't cut corners to hit a number. What we do is show you exactly what you're getting — every product, every visit, logged in your portal. Most customers who switch to us from a big brand were paying less but getting far less. One customer in Lakewood Ranch told us their old company didn't even spray inside." },
    ],
  },
  {
    category: 'Safety & Products', questions: [
      { q: "What chemicals do you use? Are they safe for my dog/kids?", a: "All products are EPA-registered and applied by licensed Florida technicians following exact label rates. For interior pest, we primarily use Alpine WSG (dinotefuran) and gel baits — very targeted, minimal exposure. Re-entry time is 30 minutes after it dries. We text you before and after every visit so you know exactly when it's safe to let pets out." },
      { q: "I have a koi pond / vegetable garden — will treatments affect it?", a: "Great question — we flag features like that in your property preferences. Our techs adjust application zones to avoid water features and edible gardens. We use targeted spot treatments near sensitive areas instead of broadcast sprays." },
      { q: "Do you use organic products?", a: "We use an IPM (Integrated Pest Management) approach — the minimum effective product for the situation. For lawn care, we incorporate biostimulants, humic acids, and micronutrients alongside conventional fertilizers. For pest control, we use baits and targeted applications rather than heavy broadcast sprays. If you have a strong preference for organic-only, let us know and we'll customize." },
    ],
  },
  {
    category: 'Scheduling & Service', questions: [
      { q: "Do I need to be home for every visit?", a: "Nope — about 80% of our services are exterior-only. For interior pest (typically quarterly), we coordinate access through your portal. You can leave a gate code, garage code, or lockbox info in your property preferences. You get a text when your tech is on the way and another when service is complete." },
      { q: "What if I need to skip a visit or go on vacation?", a: "Just let us know through the portal or text us. We'll reschedule around your travel. Your monthly rate stays the same since it's averaged over 12 months — skipping one visit doesn't change your billing." },
      { q: "How quickly can you start?", a: "Usually within 3-5 business days of accepting your estimate. For urgent pest issues (stinging insects, major infestations), we can often get a tech out same-day or next-day." },
      { q: "Do you service my gated community?", a: "Yes — we service every gated community in our coverage area. Just add your gate code in your portal preferences and your tech will have access." },
    ],
  },
  {
    category: 'Billing & Commitment', questions: [
      { q: "Is there a contract? What if I want to cancel?", a: "No long-term contracts. Your WaveGuard plan bills monthly and you can cancel anytime through your portal or by texting us. No cancellation fees — we earn your business every visit." },
      { q: "Why is there an initial pest control fee?", a: "The first visit is a full property inspection + heavy treatment — takes 45-60 minutes compared to a normal 25-30 minute quarterly. We're establishing a baseline, hitting every entry point, treating the full interior and exterior. After that, quarterly visits maintain what we set up." },
      { q: "How does billing work?", a: "Simple: your card is charged on the 1st of each month, automatically. You get a receipt in your portal. No surprises, no price increases without notice. If you ever have a billing question, text us at (941) 318-7612 and we'll sort it out same day." },
      { q: "What happens if I sell my house?", a: "Your service transfers to the new owner if they want it, or you can cancel with no penalty. We'll even help the new owner get set up." },
    ],
  },
  {
    category: 'Results & Guarantees', questions: [
      { q: "What if pests come back between visits?", a: "That's what WaveGuard is for. Unlimited callbacks between scheduled visits — no charge. If you see ants, roaches, or anything else between quarterly treatments, text us and we'll send a tech back out. Most callbacks are handled within 24-48 hours." },
      { q: "How long until I see results on my lawn?", a: "Most customers see noticeable improvement within 2-3 visits (6-8 weeks). Weed reduction is usually visible after the first application. Full turf density takes one growing season — about 6-8 months. We track your lawn health metrics in the portal so you can see the progress over time." },
      { q: "My last lawn company burned my grass.", a: "That's usually from over-application or wrong product for the turf type. We start every lawn program with a full assessment — grass type confirmation, soil pH test, thatch measurement, irrigation check. Every product application is logged in your portal with the tech's notes. If we ever cause damage, we fix it — that's part of the guarantee." },
      { q: "What if my neighbor doesn't treat and pests keep coming from their yard?", a: "Our perimeter barrier treatment creates a protective zone around YOUR property regardless of what your neighbors do. We can't control their yard, but we can make sure nothing crosses into yours." },
    ],
  },
  {
    category: 'SWFL-Specific', questions: [
      { q: "Do you treat for no-see-ums?", a: "Our mosquito barrier treatment significantly reduces no-see-um populations since they breed in similar areas. For heavy no-see-um pressure (especially near mangroves or tidal areas), we can add targeted treatments to your program." },
      { q: "What about during hurricane season?", a: "We monitor weather and proactively reschedule when tropical weather approaches. After a storm, we prioritize pest callbacks since flooding and debris cause pest surges. Your WaveGuard callbacks cover post-storm treatments at no extra charge." },
      { q: "My HOA requires a lawn care provider — do you work with HOAs?", a: "Yes. We provide your HOA with proof of service, licensed applicator info, and product safety data sheets. Many of our Lakewood Ranch customers are in HOA communities." },
    ],
  },
];

// Team section removed per owner request

const ALL_SERVICES = [
  { key: 'lawn', label: 'Lawn Care', emoji: '🌿' },
  { key: 'pest', label: 'Pest Control', emoji: '🐛' },
  { key: 'mosquito', label: 'Mosquito Control', emoji: '🦟' },
  { key: 'treeShrub', label: 'Tree & Shrub Care', emoji: '🌳' },
  { key: 'termite', label: 'Termite Protection', emoji: '🏠' },
  { key: 'rodent', label: 'Rodent Control', emoji: '🐀' },
];

// =========================================================================
// VALUE STACK — dollar-denominated value mapping
// =========================================================================
const VALUE_MAP = {
  'lawn9':      { label: '9 professional lawn treatments', value: 675 },
  'lawn6':      { label: '6 professional lawn treatments', value: 540 },
  'lawn4':      { label: '4 professional lawn treatments', value: 420 },
  'lawn':       { label: 'Professional lawn care program', value: 540 },
  'pest_q':     { label: '4 quarterly pest perimeter treatments', value: 528 },
  'pest_bm':    { label: '6 bi-monthly pest treatments', value: 672 },
  'pest':       { label: 'Year-round pest control program', value: 528 },
  'mosquito':   { label: 'Seasonal mosquito barrier program', value: 350 },
  'treeShrub':  { label: '6 tree & shrub care applications', value: 390 },
  'termite':    { label: 'Termite bait station monitoring', value: 600 },
  'rodent':     { label: 'Rodent exclusion, trapping & monitoring', value: 450 },
};
const ALWAYS_INCLUDED = [
  { label: 'Unlimited pest callbacks between visits', value: 200, suffix: '+' },
  { label: 'Priority scheduling & 24-hour response', value: 150 },
  { label: 'Dedicated technician', value: 100 },
  { label: 'Digital portal with service reports', value: 120 },
];

function buildValueStack(services, tier) {
  const items = [];
  services.forEach(s => {
    const n = s.name.toLowerCase();
    if (n.includes('lawn')) {
      const freq = s.frequency || s.visits || 0;
      if (freq >= 9) items.push(VALUE_MAP['lawn9']);
      else if (freq >= 6) items.push(VALUE_MAP['lawn6']);
      else if (freq >= 4) items.push(VALUE_MAP['lawn4']);
      else items.push(VALUE_MAP['lawn']);
    } else if (n.includes('pest')) {
      if (n.includes('bi-month') || n.includes('bimonth') || (s.frequency && s.frequency >= 6)) {
        items.push(VALUE_MAP['pest_bm']);
      } else {
        items.push(VALUE_MAP['pest']);
      }
    } else if (n.includes('mosquito')) {
      items.push(VALUE_MAP['mosquito']);
    } else if (n.includes('tree') || n.includes('shrub')) {
      items.push(VALUE_MAP['treeShrub']);
    } else if (n.includes('termite')) {
      items.push(VALUE_MAP['termite']);
    } else if (n.includes('rodent')) {
      items.push(VALUE_MAP['rodent']);
    }
  });
  // Core service deliverables based on included services
  const svcNames = services.map(s => s.name.toLowerCase());
  if (svcNames.some(n => n.includes('mosquito'))) {
    items.push({ label: 'Monthly mosquito barrier treatments (peak season)', value: 0, included: true });
  }
  if (svcNames.some(n => n.includes('tree') || n.includes('shrub'))) {
    items.push({ label: '6-8 tree & shrub care applications per year', value: 0, included: true });
  }
  if (svcNames.some(n => n.includes('termite'))) {
    items.push({ label: 'Quarterly termite bait station monitoring', value: 0, included: true });
  }
  // Always-included perks
  ALWAYS_INCLUDED.forEach(item => items.push(item));
  // Add tier membership line
  if (tier) items.push({ label: `WaveGuard ${tier} membership`, value: 0, included: true });
  // Guarantee as final item
  items.push({ label: '90-day money-back guarantee', value: 0, included: true, suffix: '', guarantee: true });
  return items;
}

// =========================================================================
// COMPONENTS
// =========================================================================
function ServiceDropdown({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderRadius: 16, overflow: 'hidden', border: `1px solid ${SAND_DARK}`, marginBottom: 10, background: '#fff' }}>
      <div onClick={() => setOpen(!open)} style={{
        padding: '14px 16px', cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: open ? B.blueSurface : '#fff',
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{title}</span>
        <span style={{ fontSize: 16, color: B.grayMid, transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▾</span>
      </div>
      {open && <div style={{ padding: '0 16px 16px' }}>{children}</div>}
    </div>
  );
}

function DetailSection({ title, sub, text }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: B.red, fontFamily: FONTS.heading }}>{title}</div>
      {sub && <div style={{ fontSize: 12, fontStyle: 'italic', color: B.grayDark, marginTop: 1 }}>{sub}</div>}
      <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginTop: 4, fontFamily: FONTS.body }}>{text}</div>
    </div>
  );
}

function PerksTable({ tier }) {
  return (
    <div style={{ borderRadius: 14, overflow: 'hidden', border: `2px solid ${B.wavesBlue}33` }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 70px 70px',
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`, color: '#fff',
        padding: '12px 14px', alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/waves-logo.png" alt="" style={{ height: 20 }} />
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: FONTS.heading }}>Perk</span>
        </div>
        <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, fontFamily: FONTS.heading }}>WaveGuard</div>
        <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, fontFamily: FONTS.heading, opacity: 0.7 }}>Non-Member</div>
      </div>
      {PERKS.map((perk, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: '1fr 70px 70px',
          padding: '10px 14px', alignItems: 'center',
          background: i % 2 === 0 ? '#fff' : B.blueSurface,
          borderTop: `1px solid ${SAND_DARK}`,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: B.navy, fontFamily: FONTS.heading }}>{perk}</span>
          <div style={{ textAlign: 'center', fontSize: 16, color: B.green }}>✅</div>
          <div style={{ textAlign: 'center', fontSize: 16, color: B.red }}>❌</div>
        </div>
      ))}
      <div style={{ padding: '12px 14px', background: B.blueSurface, borderTop: `1px solid ${SAND_DARK}` }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: B.wavesBlue, fontFamily: FONTS.heading, textAlign: 'center' }}>
          Your estimate includes WaveGuard {tier} — all perks included automatically.
        </div>
      </div>
    </div>
  );
}

function FAQCategory({ category, questions }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: B.wavesBlue, fontFamily: FONTS.ui, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>{category}</div>
      {questions.map((faq, i) => <FAQItem key={i} q={faq.q} a={faq.a} />)}
    </div>
  );
}

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${SAND_DARK}` }}>
      <div onClick={() => setOpen(!open)} style={{
        padding: '14px 0', cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, paddingRight: 12 }}>{q}</span>
        <span style={{ fontSize: 16, color: B.grayMid, transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s', flexShrink: 0 }}>▾</span>
      </div>
      {open && (
        <div style={{ paddingBottom: 14, fontSize: 14, color: B.grayDark, lineHeight: 1.65, fontFamily: FONTS.body }}>{a}</div>
      )}
    </div>
  );
}

// Pulse keyframes injected once
const pulseStyleId = 'waves-pulse-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(pulseStyleId)) {
  const style = document.createElement('style');
  style.id = pulseStyleId;
  style.textContent = `
    @keyframes wavesPulse {
      0%, 100% { box-shadow: 0 2px 8px rgba(168, 59, 52, 0.3); }
      50% { box-shadow: 0 2px 20px rgba(168, 59, 52, 0.55); }
    }
  `;
  document.head.appendChild(style);
}

// =========================================================================
// TIER COMPARISON — shows 2-3 WaveGuard tier options side-by-side
// =========================================================================
function TierComparisonCards({ options, onSelect, saving, selectedTier }) {
  return (
    <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginTop: 16, border: `1px solid ${SAND_DARK}` }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, textAlign: 'center', marginBottom: 4 }}>
        Choose Your WaveGuard Level
      </div>
      <div style={{ fontSize: 13, color: B.grayDark, textAlign: 'center', marginBottom: 16, fontFamily: FONTS.body }}>
        More services = bigger savings on every line item
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(options.length, 3)}, 1fr)`, gap: 10 }}>
        {options.map((opt, i) => {
          const isSelected = selectedTier === opt.tier && !opt.isCurrent;
          return (
            <div key={i} style={{
              borderRadius: 14, padding: 16, textAlign: 'center',
              border: opt.isRecommended ? `2px solid ${B.wavesBlue}` : isSelected ? `2px solid ${B.green}` : `1px solid ${SAND_DARK}`,
              background: opt.isCurrent ? B.blueSurface : '#fff',
              position: 'relative',
              transition: 'transform 0.15s, box-shadow 0.15s',
            }}>
              {opt.isRecommended && (
                <div style={{
                  position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                  background: B.wavesBlue, color: '#fff', padding: '3px 12px', borderRadius: 10,
                  fontSize: 10, fontWeight: 700, fontFamily: FONTS.heading, whiteSpace: 'nowrap',
                }}>
                  BEST VALUE
                </div>
              )}

              <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginTop: opt.isRecommended ? 4 : 0 }}>
                {opt.tier}
              </div>
              <div style={{ fontSize: 12, color: B.grayMid, fontWeight: 600, marginTop: 2 }}>
                {opt.discount > 0 ? `${Math.round(opt.discount * 100)}% off all services` : 'Base pricing'}
              </div>

              <div style={{ fontSize: 28, fontWeight: 800, color: B.navy, fontFamily: FONTS.ui, marginTop: 10 }}>
                ${Number(opt.monthly).toFixed(0)}<span style={{ fontSize: 13, fontWeight: 400 }}>/mo</span>
              </div>

              <div style={{ margin: '12px 0', borderTop: `1px solid ${SAND_DARK}`, paddingTop: 10 }}>
                {opt.services.map((svc, j) => (
                  <div key={j} style={{
                    fontSize: 13, color: B.navy, fontWeight: 600, marginBottom: 3, fontFamily: FONTS.body,
                  }}>
                    {svc.name || svc}
                  </div>
                ))}
                {opt.additionalService && (
                  <div style={{ fontSize: 13, color: B.green, fontWeight: 700, marginTop: 6, fontFamily: FONTS.body }}>
                    + {opt.additionalService}
                  </div>
                )}
              </div>

              {opt.savings > 0 && (
                <div style={{ fontSize: 13, fontWeight: 700, color: B.green, marginBottom: 10, fontFamily: FONTS.body }}>
                  Save ${Math.round(opt.savings)}/yr
                </div>
              )}

              {opt.isCurrent ? (
                <div style={{
                  ...BUTTON_BASE, width: '100%', padding: '10px 12px', fontSize: 13,
                  background: SAND, color: B.navy, border: `1px solid ${SAND_DARK}`,
                  fontWeight: 700,
                }}>
                  Current Plan
                </div>
              ) : isSelected ? (
                <div style={{
                  ...BUTTON_BASE, width: '100%', padding: '10px 12px', fontSize: 13,
                  background: B.green, color: '#fff', fontWeight: 700,
                }}>
                  Selected
                </div>
              ) : (
                <button onClick={() => onSelect(opt)} disabled={saving} style={{
                  ...BUTTON_BASE, width: '100%', padding: '10px 12px', fontSize: 13,
                  background: opt.isRecommended ? B.wavesBlue : B.navy,
                  color: '#fff', opacity: saving ? 0.7 : 1,
                  cursor: saving ? 'wait' : 'pointer',
                }}>
                  {saving ? 'Updating...' : 'Select This Plan'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: B.grayMid, textAlign: 'center', marginTop: 14, fontFamily: FONTS.body, lineHeight: 1.6 }}>
        All plans include: priority scheduling, unlimited callbacks, 24-hour response, transferable warranty
      </div>
    </div>
  );
}

// =========================================================================
// UPSELL NUDGE — for single-service estimates
// =========================================================================
function UpsellNudge({ currentService, suggestedService, onInquiry, sent }) {
  if (sent) {
    return (
      <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginTop: 12, border: `1px solid ${B.green}33`, textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.green, fontFamily: FONTS.heading }}>
          Got it! We'll reach out shortly with a bundled quote.
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginTop: 12, border: `1px solid ${SAND_DARK}`, borderLeft: `4px solid ${B.wavesBlue}` }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 6 }}>
        Did you know?
      </div>
      <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.65, fontFamily: FONTS.body }}>
        Add <strong style={{ color: B.navy }}>{suggestedService}</strong> to your {currentService} and unlock{' '}
        <strong style={{ color: B.wavesBlue }}>WaveGuard Silver</strong> — saving 10% on both services.
      </div>
      <button onClick={onInquiry} style={{
        ...BUTTON_BASE, marginTop: 12, padding: '10px 20px', fontSize: 14,
        background: B.wavesBlue, color: '#fff', cursor: 'pointer',
      }}>
        Ask About Bundling
      </button>
    </div>
  );
}

// =========================================================================
// MAIN PAGE
// =========================================================================
export default function EstimateViewPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [tierSaving, setTierSaving] = useState(false);
  const [selectedTier, setSelectedTier] = useState(null);
  const [bundleInquirySent, setBundleInquirySent] = useState(false);
  const reviewsRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/estimates/${token}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  const handleAccept = async () => {
    setAccepting(true);
    try {
      const res = await fetch(`${API_BASE}/estimates/${token}/accept`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
      const result = await res.json();
      if (result.onboardingToken) navigate(`/onboard/${result.onboardingToken}`, { replace: true });
    } catch (e) { console.error(e); }
    setAccepting(false);
  };

  const handleDecline = async () => {
    await fetch(`${API_BASE}/estimates/${token}/decline`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    setDeclined(true);
  };

  // ── Tier comparison logic ──────────────────────────────────
  // Store original tier options so they don't recalculate after tier selection
  const tierOptionsRef = useRef(null);

  const tierOptions = useMemo(() => {
    // Once a tier has been selected, stop recalculating
    if (selectedTier) return tierOptionsRef.current;

    if (!data?.estimate?.data) return null;
    const rawData = typeof data.estimate.data === 'string' ? JSON.parse(data.estimate.data) : data.estimate.data;
    const inputs = rawData.inputs;
    if (!inputs || !inputs.homeSqFt) return null;

    const yesNo = v => v === 'YES' || v === true;
    const baseInputs = {
      ...inputs,
      hasPool: yesNo(inputs.hasPool),
      hasPoolCage: yesNo(inputs.hasPoolCage),
      hasLargeDriveway: yesNo(inputs.hasLargeDriveway),
      nearWater: yesNo(inputs.nearWater),
      isAfterHours: yesNo(inputs.isAfterHours),
      isRecurringCustomer: yesNo(inputs.isRecurringCustomer),
      exclWaive: yesNo(inputs.exclWaive),
    };

    // Suggestable services for tier upgrades (in priority order)
    const TIER_SVCS = [
      { key: 'svcPest', label: 'Pest Control' },
      { key: 'svcLawn', label: 'Lawn Care' },
      { key: 'svcMosquito', label: 'Mosquito Control' },
      { key: 'svcTs', label: 'Tree & Shrub Care' },
    ];

    const missing = TIER_SVCS.filter(s => !baseInputs[s.key]);

    try {
      // Calculate current tier from the engine (accounts for ALL services)
      const currentResult = calculateEstimate(baseInputs);
      if (currentResult.error) return null;

      const currentTier = currentResult.recurring.waveGuardTier;
      const currentServiceCount = currentResult.recurring.serviceCount;

      // Already Platinum or no room to upgrade — don't show comparison
      if (currentTier === 'Platinum' || currentServiceCount >= 4 || missing.length === 0) return null;
      // Only show for multi-service estimates (2+ services from engine)
      if (currentServiceCount < 2) return null;

      const options = [];

      options.push({
        tier: currentTier,
        discount: currentResult.recurring.discount,
        monthly: currentResult.recurring.monthlyTotal || currentResult.recurring.grandTotal,
        annual: currentResult.recurring.annualAfterDiscount,
        savings: currentResult.recurring.savings,
        services: currentResult.recurring.services,
        inputs: baseInputs,
        result: currentResult,
        isCurrent: true,
      });

      // Next tier up (add first missing suggestable service)
      const nextInputs = { ...baseInputs, [missing[0].key]: true };
      const nextResult = calculateEstimate(nextInputs);
      if (!nextResult.error && nextResult.recurring.waveGuardTier !== currentTier) {
        options.push({
          tier: nextResult.recurring.waveGuardTier,
          discount: nextResult.recurring.discount,
          monthly: nextResult.recurring.monthlyTotal || nextResult.recurring.grandTotal,
          annual: nextResult.recurring.annualAfterDiscount,
          savings: nextResult.recurring.savings,
          services: nextResult.recurring.services,
          additionalService: missing[0].label,
          inputs: nextInputs,
          result: nextResult,
          isCurrent: false,
          isRecommended: true,
        });
      }

      // Platinum (if 2+ suggestable services still missing and next tier isn't already Platinum)
      if (missing.length > 1 && nextResult.recurring?.waveGuardTier !== 'Platinum') {
        const platInputs = { ...baseInputs };
        missing.forEach(s => platInputs[s.key] = true);
        const platResult = calculateEstimate(platInputs);
        if (!platResult.error && platResult.recurring.waveGuardTier === 'Platinum') {
          options.push({
            tier: 'Platinum',
            discount: platResult.recurring.discount,
            monthly: platResult.recurring.monthlyTotal || platResult.recurring.grandTotal,
            annual: platResult.recurring.annualAfterDiscount,
            savings: platResult.recurring.savings,
            services: platResult.recurring.services,
            additionalService: missing.map(s => s.label).join(' + '),
            inputs: platInputs,
            result: platResult,
            isCurrent: false,
          });
        }
      }

      const result = options.length > 1 ? options : null;
      tierOptionsRef.current = result;
      return result;
    } catch (e) {
      console.error('[tier-comparison] Calculation failed:', e);
      return null;
    }
  }, [data, selectedTier]);

  const handleSelectTier = async (option) => {
    if (option.isCurrent || tierSaving) return;
    setTierSaving(true);
    try {
      const mo = option.monthly;
      const ann = option.annual;
      const res = await fetch(`${API_BASE}/estimates/${token}/select-tier`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedTier: option.tier,
          estimateData: { inputs: option.inputs, result: option.result },
          monthlyTotal: mo,
          annualTotal: ann,
        }),
      });
      if (res.ok) {
        setSelectedTier(option.tier);
        // Update displayed data with new pricing
        setData(prev => ({
          ...prev,
          estimate: {
            ...prev.estimate,
            monthlyTotal: mo,
            annualTotal: ann,
            tier: option.tier,
            data: { inputs: option.inputs, result: option.result },
          },
        }));
      }
    } catch (e) {
      console.error('Tier selection failed:', e);
    }
    setTierSaving(false);
  };

  // ── Upsell nudge for single-service estimates ──────────────
  const upsellInfo = useMemo(() => {
    if (!data?.estimate?.data) return null;
    const rawData = typeof data.estimate.data === 'string' ? JSON.parse(data.estimate.data) : data.estimate.data;
    const ed = rawData.result || rawData;
    const svcs = ed.recurring?.services || [];
    if (svcs.length !== 1) return null;

    const name = (svcs[0]?.name || '').toLowerCase();
    if (name.includes('pest')) return { current: 'Pest Control', suggest: 'Lawn Care' };
    if (name.includes('lawn')) return { current: 'Lawn Care', suggest: 'Pest Control' };
    if (name.includes('mosquito')) return { current: 'Mosquito Control', suggest: 'Pest Control' };
    if (name.includes('tree') || name.includes('shrub')) return { current: 'Tree & Shrub', suggest: 'Pest Control' };
    return { current: svcs[0]?.name || 'your service', suggest: 'Lawn Care' };
  }, [data]);

  const handleBundleInquiry = async () => {
    if (bundleInquirySent) return;
    try {
      await fetch(`${API_BASE}/estimates/${token}/bundle-inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestedService: upsellInfo?.suggest }),
      });
      setBundleInquirySent(true);
    } catch (e) {
      console.error('Bundle inquiry failed:', e);
    }
  };

  // Loading state
  if (loading) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#fff', fontSize: 16, fontFamily: FONTS.body }}>Loading your estimate...</div>
    </div>
  );

  // Error state
  if (!data || !data.estimate) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>😕</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: B.navy, marginTop: 8 }}>Estimate not found</div>
        <a href="tel:+19413187612" style={{ ...BUTTON_BASE, marginTop: 16, padding: '10px 20px', background: B.red, color: '#fff', textDecoration: 'none', display: 'inline-flex' }}>Call (941) 318-7612</a>
      </div>
    </div>
  );

  // Expired state
  if (data.expired) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONTS.body }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>⏰</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: B.navy, marginTop: 8 }}>This estimate has expired</div>
        <div style={{ fontSize: 14, color: B.grayDark, marginTop: 6 }}>Contact us for a fresh quote.</div>
        <a href="tel:+19413187612" style={{ ...BUTTON_BASE, marginTop: 16, padding: '10px 20px', background: B.red, color: '#fff', textDecoration: 'none', display: 'inline-flex' }}>Call (941) 318-7612</a>
      </div>
    </div>
  );

  // Declined state
  if (declined) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONTS.body }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>👋</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: B.navy, marginTop: 8 }}>Sorry to see you go</div>
        <div style={{ fontSize: 14, color: B.grayDark, marginTop: 6, lineHeight: 1.6 }}>If you change your mind, we're always here. No pressure.</div>
        <a href="tel:+19413187612" style={{ ...BUTTON_BASE, marginTop: 16, padding: '10px 20px', background: B.wavesBlue, color: '#fff', textDecoration: 'none', display: 'inline-flex' }}>Changed your mind? Call us</a>
      </div>
    </div>
  );

  // ---- Main estimate view ----
  const e = data.estimate;
  const rawData = e.data || {};
  // estimateData is stored as { inputs, result } — the pricing result is in .result
  const ed = rawData.result || rawData;
  const recurring = ed.recurring || {};
  const oneTime = ed.oneTime || {};
  const totals = ed.totals || {};
  const property = ed.property || rawData.inputs || {};
  const services = recurring.services || [];
  const otItems = [...(oneTime.items || []), ...(oneTime.specItems || [])];
  const fmt = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Detect which services are included
  const svcNames = services.map(s => s.name.toLowerCase());
  const hasLawn = svcNames.some(n => n.includes('lawn'));
  const hasPest = svcNames.some(n => n.includes('pest'));
  const hasMosquito = svcNames.some(n => n.includes('mosquito'));
  const hasTS = svcNames.some(n => n.includes('tree') || n.includes('shrub'));
  const hasTermite = svcNames.some(n => n.includes('termite'));
  const hasRodent = svcNames.some(n => n.includes('rodent'));

  const hasOneTimeLawn = (oneTime.items || []).length > 0;
  const hasOneTimePest = (oneTime.specItems || []).length > 0;

  const includedKeys = [];
  if (hasLawn) includedKeys.push('lawn');
  if (hasPest) includedKeys.push('pest');
  if (hasMosquito) includedKeys.push('mosquito');
  if (hasTS) includedKeys.push('treeShrub');
  if (hasTermite) includedKeys.push('termite');
  if (hasRodent) includedKeys.push('rodent');

  const missingServices = ALL_SERVICES.filter(svc => {
    if (includedKeys.includes(svc.key)) return false;
    // Double-check against actual service names for edge cases
    return !svcNames.some(n => {
      if (svc.key === 'lawn') return n.includes('lawn');
      if (svc.key === 'pest') return n.includes('pest') && !n.includes('termite');
      if (svc.key === 'mosquito') return n.includes('mosquito');
      if (svc.key === 'treeShrub') return n.includes('tree') || n.includes('shrub');
      if (svc.key === 'termite') return n.includes('termite');
      return false;
    });
  });

  // Determine which service dropdown opens first
  const firstOpenService = hasLawn ? 'lawn' : hasPest ? 'pest' : hasMosquito ? 'mosquito' : hasTS ? 'treeShrub' : hasTermite ? 'termite' : null;

  const firstName = (e.customerName || '').split(' ')[0] || 'there';
  const monthlyTotal = Number(e.monthlyTotal) || 0;
  const preDiscountMonthly = recurring.savings > 0 ? monthlyTotal + (recurring.savings / 12) : 0;
  const dailyCost = (monthlyTotal / 30).toFixed(2);

  return (
    <div style={{ minHeight: '100vh', background: SAND, fontFamily: FONTS.body, paddingBottom: 80 }}>

      {/* ============================================================= */}
      {/* 1. HERO SECTION                                                */}
      {/* ============================================================= */}
      <div style={{
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        padding: '28px 20px 48px', textAlign: 'center', color: '#fff',
        position: 'relative',
      }}>
        <img src="/waves-logo.png" alt="Waves" style={{ height: 44, marginBottom: 12 }} />

        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FONTS.heading, lineHeight: 1.3, maxWidth: 380, margin: '0 auto' }}>
          Hey {firstName}, here's your custom plan.
        </div>

        <div style={{ fontSize: 14, color: B.blueLight, marginTop: 8, fontWeight: 600 }}>{(e.address || '').replace(/, USA$/i, '')}</div>

        {(property.homeSqFt || property.lotSqFt) && (
          <div style={{ fontSize: 13, color: B.blueLight, marginTop: 4 }}>
            {property.homeSqFt ? `${Number(property.homeSqFt).toLocaleString()} sq ft home` : ''}
            {property.homeSqFt && property.lotSqFt ? ' · ' : ''}
            {property.lotSqFt ? `${Number(property.lotSqFt).toLocaleString()} sq ft lot` : ''}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          {recurring.savings > 0 && preDiscountMonthly > 0 && (
            <div style={{ fontSize: 16, color: '#ffffff88', textDecoration: 'line-through', fontFamily: FONTS.ui }}>
              {fmt(preDiscountMonthly)}/mo
            </div>
          )}
          <div style={{ fontSize: 42, fontWeight: 800, fontFamily: FONTS.ui, lineHeight: 1.1 }}>
            {fmt(monthlyTotal)}<span style={{ fontSize: 16, fontWeight: 400, opacity: 0.8 }}>/mo</span>
          </div>
        </div>

        {recurring.savings > 0 && e.tier && (
          <div style={{ fontSize: 14, color: B.green, fontWeight: 700, marginTop: 6 }}>
            You save {fmt(recurring.savings / 12)}/mo with {e.tier}
          </div>
        )}

        <div style={{ fontSize: 13, color: '#ffffffcc', marginTop: 6 }}>
          That's just ${dailyCost}/day for complete home protection
        </div>

        <div style={{ fontSize: 12, color: '#ffffffaa', marginTop: 8, fontStyle: 'italic', fontFamily: FONTS.body }}>
          Try us risk-free — 90-day money-back guarantee
        </div>

        {e.tier && (
          <div style={{
            display: 'inline-block', marginTop: 12, padding: '6px 16px', borderRadius: 20,
            background: `${B.yellow}25`, color: B.yellow, fontSize: 13, fontWeight: 700,
            fontFamily: FONTS.heading,
          }}>
            WaveGuard {e.tier}
          </div>
        )}

        {/* Wave SVG bottom edge */}
        <div style={{
          position: 'absolute', bottom: -1, left: 0, right: 0, height: 24,
          background: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 60'%3E%3Cpath d='M0,20 C200,50 400,0 600,30 C800,55 1000,5 1200,20 L1200,60 L0,60Z' fill='%23FDF6EC'/%3E%3C/svg%3E") no-repeat bottom`,
          backgroundSize: '100% 100%',
        }} />
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '0 16px 40px' }}>

        {/* ============================================================= */}
        {/* TIER COMPARISON (2-3 service estimates)                         */}
        {/* ============================================================= */}
        {tierOptions && e.status !== 'accepted' && (
          <TierComparisonCards
            options={tierOptions}
            onSelect={handleSelectTier}
            saving={tierSaving}
            selectedTier={selectedTier}
          />
        )}

        {/* Already Platinum badge */}
        {!tierOptions && e.tier === 'Platinum' && e.status !== 'accepted' && (
          <div style={{
            background: '#fff', borderRadius: 16, padding: 16, marginTop: 16,
            border: `1px solid ${SAND_DARK}`, textAlign: 'center',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
              You're getting our best rate — Platinum 18% off all services
            </div>
          </div>
        )}

        {/* ============================================================= */}
        {/* DREAM OUTCOME                                                  */}
        {/* ============================================================= */}
        <div style={{ textAlign: 'center', marginTop: 20, marginBottom: 4, padding: '0 16px' }}>
          <div style={{
            fontSize: 14, fontStyle: 'italic', color: B.grayDark, lineHeight: 1.7,
            fontFamily: FONTS.body, maxWidth: 440, margin: '0 auto',
          }}>
            Imagine walking barefoot in your yard without worrying about fire ants. Leaving your patio lights on without a mosquito cloud. Opening your door to a green, thick lawn that makes your neighbors jealous. That's what WaveGuard delivers.
          </div>
        </div>

        {/* ============================================================= */}
        {/* VALUE STACK — Hormozi Grand Slam Offer                         */}
        {/* ============================================================= */}
        {(() => {
          const stackItems = buildValueStack(services, e.tier);
          const totalValue = stackItems.reduce((sum, it) => sum + (it.value || 0), 0);
          const annualRate = monthlyTotal * 12;
          const savings = totalValue - annualRate;
          return (
            <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginTop: 16, border: `1px solid ${SAND_DARK}` }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>
                What You're Getting
              </div>
              <div style={{ height: 2, background: `linear-gradient(90deg, ${B.green}, ${B.wavesBlue})`, borderRadius: 1, marginBottom: 16 }} />

              {stackItems.map((item, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '7px 0',
                  borderBottom: i < stackItems.length - 1 ? `1px solid ${SAND_DARK}` : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                    <span style={{ color: B.green, fontSize: 16, flexShrink: 0 }}>✓</span>
                    <span style={{ fontSize: 14, color: B.navy, fontWeight: item.guarantee ? 700 : 600, fontFamily: FONTS.body }}>{item.label}</span>
                  </div>
                  <span style={{
                    fontSize: 14, fontWeight: 700, fontFamily: FONTS.ui, color: item.guarantee ? B.green : B.grayMid,
                    whiteSpace: 'nowrap', marginLeft: 8,
                  }}>
                    {item.guarantee ? 'Peace of mind' : item.included ? 'Included' : `$${item.value}${item.suffix || ''} value`}
                  </span>
                </div>
              ))}

              <div style={{ height: 2, background: `linear-gradient(90deg, ${B.green}, ${B.wavesBlue})`, borderRadius: 1, marginTop: 16, marginBottom: 14 }} />

              {savings > 0 && (
                <div style={{
                  background: `${B.green}15`, borderRadius: 10, padding: '10px 14px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: B.green, fontFamily: FONTS.heading }}>You save:</span>
                  <span style={{ fontSize: 18, fontWeight: 800, color: B.green, fontFamily: FONTS.ui }}>${savings.toLocaleString()}+ per year</span>
                </div>
              )}
            </div>
          );
        })()}

        {/* ============================================================= */}
        {/* GUARANTEE BLOCK                                                */}
        {/* ============================================================= */}
        <div style={{
          background: '#fff', borderRadius: 16, padding: 20, marginTop: 12,
          border: `1px solid ${SAND_DARK}`, borderLeft: `4px solid ${B.green}`,
        }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>
            Our Promise to You
          </div>
          <div style={{ fontSize: 14, color: B.navy, lineHeight: 1.7, fontFamily: FONTS.body }}>
            <span role="img" aria-label="shield" style={{ fontSize: 20, marginRight: 6 }}>🛡️</span>
            If pests return between treatments, we come back free — within 24 hours. If your lawn isn't showing measurable progress, we come back between treatments at no extra charge.
          </div>
          <div style={{ fontSize: 14, color: B.navy, lineHeight: 1.7, fontFamily: FONTS.body, marginTop: 8 }}>
            If you're not satisfied after 90 days, we'll refund every penny. No questions, no hassle, no fine print.
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, lineHeight: 1.7, fontFamily: FONTS.body, marginTop: 10 }}>
            That's the Waves guarantee. We earn your trust every visit.
          </div>
        </div>


        {/* UPSELL NUDGE — single-service estimates */}
        {upsellInfo && !tierOptions && e.status !== 'accepted' && (
          <UpsellNudge
            currentService={upsellInfo.current}
            suggestedService={upsellInfo.suggest}
            onInquiry={handleBundleInquiry}
            sent={bundleInquirySent}
          />
        )}

        {/* Accept CTA — below Monthly Total */}
        {e.status !== 'accepted' && (
          <div style={{ marginTop: 12 }}>
            <button onClick={handleAccept} disabled={accepting} style={{
              ...BUTTON_BASE, width: '100%', padding: 18, fontSize: 17,
              background: B.red, color: '#fff', opacity: accepting ? 0.7 : 1,
              boxShadow: `0 4px 15px ${B.red}40`,
              animation: 'wavesPulse 2s ease-in-out infinite',
            }}>
              {accepting ? 'Processing...' : 'Accept Estimate'}
            </button>
          </div>
        )}

        {/* One-time services — value framed */}
        {otItems.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginTop: 12, border: `1px solid ${SAND_DARK}` }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>
              Your Initial Service Visit
            </div>
            {otItems.map((item, i) => {
              const price = Math.round(item.price);
              const retailValue = Math.round(price * 1.57);
              return (
                <div key={i} style={{ padding: '10px 0', borderBottom: i < otItems.length - 1 ? `1px solid ${SAND_DARK}` : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{item.name}</span>
                    <span style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.ui }}>${price}</span>
                  </div>
                  <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.6, marginTop: 4, fontFamily: FONTS.body }}>
                    Includes: comprehensive property assessment, full interior + exterior treatment, granular lawn application, and baseline pest monitoring setup.
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: B.green, marginTop: 4, fontFamily: FONTS.body }}>
                    A ${retailValue} value — yours for ${price}.
                  </div>
                </div>
              );
            })}

            {/* Incentive offers */}
            <div style={{ marginTop: 16, padding: 14, borderRadius: 12, background: `linear-gradient(135deg, ${B.green}08, ${B.green}15)`, border: `1.5px solid ${B.green}33` }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: B.green, fontFamily: FONTS.heading, marginBottom: 8 }}>
                Save on your initial service:
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 20, flexShrink: 0 }}>🎉</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                      Accept today — <span style={{ color: B.green }}>Initial service FREE</span>
                    </div>
                    <div style={{ fontSize: 12, color: B.grayDark }}>Pay in full for your first year and the ${Math.round(otItems.reduce((s, i) => s + (i.price || 0), 0))} initial visit is waived completely.</div>
                  </div>
                </div>
                <div style={{ height: 1, background: `${B.green}22` }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 20, flexShrink: 0 }}>⚡</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                      Accept within 24 hours — <span style={{ color: B.green }}>50% off initial service</span>
                    </div>
                    <div style={{ fontSize: 12, color: B.grayDark }}>Sign up within 24 hours and pay just ${Math.round(otItems.reduce((s, i) => s + (i.price || 0), 0) / 2)} instead of ${Math.round(otItems.reduce((s, i) => s + (i.price || 0), 0))}.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================= */}
        {/* 3. HOW IT WORKS — 3 steps                                      */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, textAlign: 'center', marginBottom: 16 }}>
            How It Works
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[
              { emoji: '📋', num: '1', title: 'Accept Your Estimate', desc: 'Tap the button below. Takes 10 seconds.' },
              { emoji: '🏡', num: '2', title: 'Quick Setup', desc: 'Add your card, set property preferences, confirm your first visit. 2 minutes.' },
              { emoji: '🌊', num: '3', title: 'Wave Goodbye to Pests', desc: 'Your dedicated tech handles the rest. Track everything in your portal.' },
            ].map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                {/* Step number column with dotted connector */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 44 }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%', background: '#fff',
                    border: `2px solid ${B.wavesBlue}33`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 22, fontWeight: 800, color: B.wavesBlue, fontFamily: FONTS.ui,
                  }}>
                    {step.num}
                  </div>
                  {i < 2 && (
                    <div style={{
                      width: 2, height: 32, borderLeft: `2px dotted ${B.wavesBlue}44`,
                    }} />
                  )}
                </div>
                {/* Content card */}
                <div style={{
                  background: '#fff', borderRadius: 16, padding: '14px 16px', flex: 1,
                  border: `1px solid ${SAND_DARK}`, marginBottom: i < 2 ? 0 : 0,
                }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                    {step.emoji} {step.title}
                  </div>
                  <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.65, marginTop: 4, fontFamily: FONTS.body }}>
                    {step.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ============================================================= */}
        {/* 4. WHAT'S INCLUDED — expandable dropdowns                      */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 6 }}>What's Included</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.grayMid, marginBottom: 10, fontFamily: FONTS.heading }}>Service Details</div>

          {hasLawn && (
            <ServiceDropdown title="🌿 Lawn Care Program" defaultOpen={firstOpenService === 'lawn'}>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 14 }}>{SERVICE_DETAILS.lawn.subheader}</div>
              {SERVICE_DETAILS.lawn.sections.map((s, i) => <DetailSection key={i} title={s.title} text={s.text} />)}
              <div style={{ borderTop: `1px solid ${SAND_DARK}`, marginTop: 10, paddingTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Additional Services</div>
                {SERVICE_DETAILS.lawn.extras.map((s, i) => <DetailSection key={i} title={s.title} text={s.text} />)}
              </div>
            </ServiceDropdown>
          )}

          {hasPest && (
            <ServiceDropdown title="🐛 Pest Control" defaultOpen={firstOpenService === 'pest'}>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.pest.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.pest.intro}</div>
              {SERVICE_DETAILS.pest.sections.map((s, i) => <DetailSection key={i} title={s.title} text={s.text} />)}
            </ServiceDropdown>
          )}

          {hasMosquito && (
            <ServiceDropdown title="🦟 Mosquito Control" defaultOpen={firstOpenService === 'mosquito'}>
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.mosquito.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.mosquito.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.mosquito.intro}</div>
              {SERVICE_DETAILS.mosquito.sections.map((s, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <DetailSection title={s.title} text={s.text} />
                  {s.tags && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                      {s.tags.map((tag, ti) => (
                        <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </ServiceDropdown>
          )}

          {hasTS && (
            <ServiceDropdown title="🌳 Tree & Shrub Care" defaultOpen={firstOpenService === 'treeShrub'}>
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.treeShrub.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.treeShrub.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.treeShrub.intro}</div>
              {SERVICE_DETAILS.treeShrub.sections.map((s, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <DetailSection title={s.title} text={s.text} />
                  {s.tags && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                      {s.tags.map((tag, ti) => (
                        <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </ServiceDropdown>
          )}

          {hasTS && (
            <ServiceDropdown title="🌴 Palm Injection Services">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.palmInjection.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.palmInjection.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.palmInjection.intro}</div>
              {SERVICE_DETAILS.palmInjection.sections.map((s, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <DetailSection title={s.title} text={s.text} />
                  {s.tags && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                      {s.tags.map((tag, ti) => (
                        <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </ServiceDropdown>
          )}

          {hasTermite && (
            <ServiceDropdown title="🏠 Termite Bait Station Protection" defaultOpen={firstOpenService === 'termite'}>
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.termite.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.termite.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.termite.intro}</div>
              {SERVICE_DETAILS.termite.sections.map((s, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <DetailSection title={s.title} text={s.text} />
                  {s.tags && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                      {s.tags.map((tag, ti) => (
                        <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </ServiceDropdown>
          )}

          {hasRodent && (
            <ServiceDropdown title="🐀 Rodent Control">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.rodent.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.rodent.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.rodent.intro}</div>
              {SERVICE_DETAILS.rodent.sections.map((s, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  {s.oneTime && (
                    <div style={{ fontSize: 9, fontWeight: 700, color: B.wavesBlue, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 }}>One-Time Service</div>
                  )}
                  <DetailSection title={s.title} text={s.text} />
                  {s.tags && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                      {s.tags.map((tag, ti) => (
                        <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </ServiceDropdown>
          )}

          {hasOneTimeLawn && (
            <ServiceDropdown title="🌱 One-Time Lawn Services">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.lawnOneTime.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.lawnOneTime.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.lawnOneTime.intro}</div>
              {SERVICE_DETAILS.lawnOneTime.groups.map((g, gi) => (
                <div key={gi}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: gi > 0 ? 16 : 0, marginBottom: 10, paddingBottom: 4, borderBottom: `1px solid ${SAND_DARK}` }}>{g.groupTitle}</div>
                  {g.sections.map((s, i) => (
                    <div key={i} style={{ marginBottom: 14 }}>
                      <DetailSection title={s.title} text={s.text} />
                      {s.tags && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                          {s.tags.map((tag, ti) => (
                            <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ fontSize: 12, color: B.grayMid, fontStyle: 'italic', marginTop: 12, lineHeight: 1.6, borderTop: `1px solid ${SAND_DARK}`, paddingTop: 10 }}>{SERVICE_DETAILS.lawnOneTime.footer}</div>
            </ServiceDropdown>
          )}

          {hasTermite && (
            <ServiceDropdown title="🔨 One-Time Termite Treatments">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.termiteOneTime.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.termiteOneTime.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.termiteOneTime.intro}</div>
              {SERVICE_DETAILS.termiteOneTime.groups.map((g, gi) => (
                <div key={gi}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: gi > 0 ? 16 : 0, marginBottom: 10, paddingBottom: 4, borderBottom: `1px solid ${SAND_DARK}` }}>{g.groupTitle}</div>
                  {g.sections.map((s, i) => (
                    <div key={i} style={{ marginBottom: 14 }}>
                      <DetailSection title={s.title} text={s.text} />
                      {s.tags && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                          {s.tags.map((tag, ti) => (
                            <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ fontSize: 12, color: B.grayMid, fontStyle: 'italic', marginTop: 12, lineHeight: 1.6, borderTop: `1px solid ${SAND_DARK}`, paddingTop: 10 }}>{SERVICE_DETAILS.termiteOneTime.footer}</div>
            </ServiceDropdown>
          )}

          {hasOneTimePest && (
            <ServiceDropdown title="🐛 One-Time Pest Treatments">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.pestOneTime.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.pestOneTime.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.pestOneTime.intro}</div>
              {SERVICE_DETAILS.pestOneTime.groups.map((g, gi) => (
                <div key={gi}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: gi > 0 ? 16 : 0, marginBottom: 10, paddingBottom: 4, borderBottom: `1px solid ${SAND_DARK}` }}>{g.groupTitle}</div>
                  {g.sections.map((s, i) => (
                    <div key={i} style={{ marginBottom: 14 }}>
                      <DetailSection title={s.title} text={s.text} />
                      {s.tags && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                          {s.tags.map((tag, ti) => (
                            <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ fontSize: 12, color: B.grayMid, fontStyle: 'italic', marginTop: 12, lineHeight: 1.6, borderTop: `1px solid ${SAND_DARK}`, paddingTop: 10 }}>{SERVICE_DETAILS.pestOneTime.footer}</div>
            </ServiceDropdown>
          )}

          {hasRodent && (
            <ServiceDropdown title="🐀 One-Time Rodent Services">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.rodentOneTime.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 10 }}>{SERVICE_DETAILS.rodentOneTime.subheader}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.rodentOneTime.intro}</div>
              {SERVICE_DETAILS.rodentOneTime.groups.map((g, gi) => (
                <div key={gi}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: gi > 0 ? 16 : 0, marginBottom: 10, paddingBottom: 4, borderBottom: `1px solid ${SAND_DARK}` }}>{g.groupTitle}</div>
                  {g.sections.map((s, i) => (
                    <div key={i} style={{ marginBottom: 14 }}>
                      <DetailSection title={s.title} text={s.text} />
                      {s.tags && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 2 }}>
                          {s.tags.map((tag, ti) => (
                            <span key={ti} style={{ fontSize: 10, fontWeight: 600, color: B.wavesBlue, background: `${B.wavesBlue}12`, padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ fontSize: 12, color: B.grayMid, fontStyle: 'italic', marginTop: 12, lineHeight: 1.6, borderTop: `1px solid ${SAND_DARK}`, paddingTop: 10 }}>{SERVICE_DETAILS.rodentOneTime.footer}</div>
            </ServiceDropdown>
          )}
        </div>

        {/* Enhance Your Plan — removed */}

        {/* ============================================================= */}
        {/* 6. PERKS THAT ACTUALLY MATTER — comparison table               */}
        {/* ============================================================= */}
        {e.tier && (
          <div style={{ marginTop: 32 }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4, textAlign: 'center' }}>
              Perks That Actually Matter.
            </div>
            <div style={{ fontSize: 13, color: '#455A64', textAlign: 'center', marginBottom: 14, lineHeight: 1.5, fontFamily: FONTS.body }}>
              {hasLawn
                ? 'When turf issues arise, WaveGuard delivers prompt, data-driven diagnostics and precise treatment applications — ensuring efficient, stress-free restoration and long-term lawn health.'
                : 'When pest activity occurs, WaveGuard ensures rapid, efficient response and resolution — minimizing disruption and maintaining control with simplicity and precision.'}
            </div>
            <PerksTable tier={e.tier} />
          </div>
        )}

        {/* ============================================================= */}
        {/* 7. REVIEWS CAROUSEL                                            */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          {(() => {
            // Sort reviews so location-relevant ones appear first
            const addr = (e.address || '').toLowerCase();
            const sortedReviews = [...REVIEWS].sort((a, b) => {
              const aMatch = addr.includes(a.location.toLowerCase()) ? 1 : 0;
              const bMatch = addr.includes(b.location.toLowerCase()) ? 1 : 0;
              return bMatch - aMatch;
            });
            // Detect city for neighbor note
            const knownCities = ['Bradenton', 'Lakewood Ranch', 'Parrish', 'Sarasota', 'Venice', 'Palmetto', 'Ellenton', 'Anna Maria'];
            const matchedCity = knownCities.find(c => addr.includes(c.toLowerCase()));
            return (
              <>
                <div style={{ textAlign: 'center', marginBottom: 14 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
                    Don't just take our word for it
                  </div>
                  <div style={{ fontSize: 14, color: B.yellow, marginTop: 4 }}>
                    5.0 ★★★★★
                  </div>
                </div>
                <div
                  ref={reviewsRef}
                  style={{
                    display: 'flex', gap: 14, overflowX: 'auto', scrollSnapType: 'x mandatory',
                    WebkitOverflowScrolling: 'touch', paddingBottom: 8,
                    msOverflowStyle: 'none', scrollbarWidth: 'none',
                  }}
                >
                  {sortedReviews.map((r, i) => (
              <div key={i} style={{
                minWidth: 280, maxWidth: 320, flexShrink: 0, scrollSnapAlign: 'start',
                background: '#fff', borderRadius: 16, padding: 18,
                border: `1px solid ${SAND_DARK}`,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
              }}>
                <div style={{ fontSize: 16, color: B.yellow, marginBottom: 8 }}>★★★★★</div>
                <div style={{
                  fontSize: 13, color: B.grayDark, lineHeight: 1.65, fontFamily: FONTS.body,
                  display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  "{r.text}"
                </div>
                <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                  — {r.name}
                </div>
                <div style={{ fontSize: 12, color: B.grayMid }}>{r.location}</div>
              </div>
            ))}
                </div>
                {matchedCity && (
                  <div style={{
                    textAlign: 'center', marginTop: 12, fontSize: 13, color: B.grayDark,
                    fontFamily: FONTS.body, lineHeight: 1.5,
                  }}>
                    Your neighbors trust Waves — join 200+ homeowners in {matchedCity} protected by WaveGuard.
                  </div>
                )}
              </>
            );
          })()}
        </div>

        {/* Accept CTA — after reviews */}
        {e.status !== 'accepted' && (
          <div style={{ marginTop: 24 }}>
            <button onClick={handleAccept} disabled={accepting} style={{
              ...BUTTON_BASE, width: '100%', padding: 18, fontSize: 17,
              background: B.red, color: '#fff', opacity: accepting ? 0.7 : 1,
              boxShadow: `0 4px 15px ${B.red}40`,
              animation: 'wavesPulse 2s ease-in-out infinite',
            }}>
              {accepting ? 'Processing...' : 'Accept Estimate'}
            </button>
          </div>
        )}

        {/* ============================================================= */}
        {/* 8. LOCAL EXPERTISE                                             */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 8 }}>
            Local Expertise. Real People.
          </div>
          <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.65, marginTop: 6, fontFamily: FONTS.body, maxWidth: 420, margin: '6px auto 0' }}>
            Waves is a family-owned lawn and pest company serving Southwest Florida. We combine modern technology with old-school accountability — every customer gets a dedicated tech, transparent pricing, and real results.
          </div>
        </div>

        {/* ============================================================= */}
        {/* 9. LOCATIONS GRID                                              */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, textAlign: 'center', marginBottom: 14 }}>
            Fast, Local Service Near You
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {LOCATIONS.map((loc, i) => (
              <div key={i} style={{
                background: '#fff', borderRadius: 16, padding: 14,
                border: `1px solid ${SAND_DARK}`,
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>
                  {loc.name}
                </div>
                <div style={{ fontSize: 11, color: B.grayDark, lineHeight: 1.5, marginBottom: 6, fontFamily: FONTS.body }}>
                  {loc.address}
                </div>
                <a href={`tel:${loc.tel}`} style={{
                  fontSize: 12, fontWeight: 700, color: B.wavesBlue, textDecoration: 'none', fontFamily: FONTS.heading,
                }}>
                  {loc.phone}
                </a>
              </div>
            ))}
          </div>
        </div>

        {/* ============================================================= */}
        {/* 10. FAQ ACCORDION                                              */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, textAlign: 'center', marginBottom: 4 }}>
            Questions? We've Got Answers.
          </div>
          <div style={{ fontSize: 13, color: B.grayDark, textAlign: 'center', marginBottom: 16, lineHeight: 1.5 }}>
            Real questions from SWFL homeowners — answered by your Waves team.
          </div>
          <div style={{ background: '#fff', borderRadius: 16, padding: '12px 18px', border: `1px solid ${SAND_DARK}` }}>
            {FAQ_CATEGORIES.map((cat, i) => <FAQCategory key={i} category={cat.category} questions={cat.questions} />)}
          </div>
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <div style={{ fontSize: 13, color: B.grayDark }}>Still have a question?</div>
            <a href="sms:+19413187612?body=Hi%2C%20I%20have%20a%20question%20about%20my%20Waves%20estimate" style={{
              ...BUTTON_BASE, padding: '10px 20px', fontSize: 13, marginTop: 6,
              background: B.red, color: '#fff', textDecoration: 'none', display: 'inline-flex',
            }}>💬 Text Us — (941) 318-7612</a>
          </div>
        </div>

        {/* ============================================================= */}
        {/* 11. FINAL CTA                                                  */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 16 }}>
            Ready to protect your home?
          </div>

          {e.status !== 'accepted' ? (
            <>
              <button onClick={handleAccept} disabled={accepting} style={{
                ...BUTTON_BASE, width: '100%', padding: 18, fontSize: 17,
                background: B.red, color: '#fff', opacity: accepting ? 0.7 : 1,
                boxShadow: `0 4px 15px ${B.red}40`,
              }}>
                {accepting ? 'Processing...' : 'Accept Estimate'}
              </button>

              <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12, color: B.grayMid, lineHeight: 1.5, fontFamily: FONTS.body }}>
                First month charged on signup. Auto-pay via card on file. Cancel anytime — no fees.
              </div>

              <a href={`sms:+19413187612?body=${encodeURIComponent(`Hi, I have a question about my Waves estimate for ${e.address}`)}`} style={{
                ...BUTTON_BASE, width: '100%', padding: 14, fontSize: 14, marginTop: 10,
                background: 'transparent', color: B.wavesBlue, border: `1.5px solid ${B.wavesBlue}`,
                textDecoration: 'none', display: 'flex',
              }}>
                I Have Questions
              </a>

              <div onClick={handleDecline} style={{
                textAlign: 'center', marginTop: 14, fontSize: 12, color: B.grayMid, cursor: 'pointer',
              }}>
                No thanks, decline this estimate
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: 24, background: '#E8F5E9', borderRadius: 14 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: B.green, marginBottom: 8 }}>{'✅'} Estimate Accepted!</div>
              <div style={{ fontSize: 14, color: B.grayDark, marginBottom: 8 }}>Welcome to Waves! Check your texts for the setup link.</div>
              <div style={{ fontSize: 13, color: B.grayMid, lineHeight: 1.6 }}>We'll walk you through payment setup, property preferences, and scheduling your first service — all in under 2 minutes.</div>
            </div>
          )}

          {e.expiresAt && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: B.red, fontFamily: FONTS.heading, marginBottom: 4 }}>
                Pre-summer pricing — lock in {fmt(monthlyTotal)}/mo before peak pest season rates.
              </div>
              <div style={{ fontSize: 11, color: B.grayMid }}>
                Estimate valid until {new Date(e.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
          )}
        </div>

        {/* ============================================================= */}
        {/* 12. FOOTER                                                     */}
        {/* ============================================================= */}
        <div style={{ textAlign: 'center', marginTop: 32, paddingTop: 20, borderTop: `1px solid ${SAND_DARK}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 6 }}>🌊 Stay in the loop</div>
          <div style={{ fontSize: 15, color: B.wavesBlue, fontWeight: 700, fontFamily: FONTS.heading, marginBottom: 10 }}>Wave Goodbye to Pests! 🌊</div>
          <img src="/waves-logo.png" alt="" style={{ height: 28, opacity: 0.6, marginBottom: 6 }} />
          <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Waves Pest Control, LLC</div>
          <div style={{ fontSize: 12, color: B.grayDark, marginTop: 4, lineHeight: 1.6 }}>Family-owned pest control &amp; lawn care · Southwest Florida</div>
          <div style={{ fontSize: 12, color: B.grayDark, marginTop: 6, lineHeight: 1.6 }}>Lakewood Ranch · Parrish · Sarasota · Venice</div>
          <div style={{ fontSize: 11, color: B.grayMid, marginTop: 10 }}>© {new Date().getFullYear()} Waves Pest Control, LLC · All rights reserved</div>
        </div>
      </div>

      {/* ============================================================= */}
      {/* 13. STICKY BOTTOM BAR                                          */}
      {/* ============================================================= */}
      {e.status !== 'accepted' && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 1000,
          background: `${B.blueDeeper}ee`,
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          padding: '10px 16px', paddingBottom: 'max(10px, env(safe-area-inset-bottom))',
        }}>
          <div style={{
            maxWidth: 560, margin: '0 auto',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 20, fontWeight: 800, color: '#fff', fontFamily: FONTS.ui }}>
                  {fmt(monthlyTotal)}<span style={{ fontSize: 12, fontWeight: 400, opacity: 0.7 }}>/mo</span>
                </span>
                {e.tier && (
                  <span style={{
                    padding: '3px 10px', borderRadius: 12,
                    background: `${B.yellow}25`, color: B.yellow,
                    fontSize: 10, fontWeight: 700, fontFamily: FONTS.heading,
                  }}>
                    {e.tier}
                  </span>
                )}
              </div>
              <div style={{ display: 'none' }}>
                {/* Show on mobile via media query alternative: inline for small screens */}
              </div>
            </div>
            <button onClick={handleAccept} disabled={accepting} style={{
              ...BUTTON_BASE, padding: '12px 24px', fontSize: 14,
              background: B.red, color: '#fff', opacity: accepting ? 0.7 : 1,
              animation: 'wavesPulse 2s ease-in-out infinite',
              whiteSpace: 'nowrap',
            }}>
              {accepting ? 'Processing...' : 'Accept Estimate'}
            </button>
          </div>
          <div style={{
            textAlign: 'center', marginTop: 4, fontSize: 11, color: '#ffffff88',
          }}>
            or text us: <a href="sms:+19413187612" style={{ color: B.blueLight, textDecoration: 'none', fontWeight: 600 }}>(941) 318-7612</a>
          </div>
        </div>
      )}
    </div>
  );
}
