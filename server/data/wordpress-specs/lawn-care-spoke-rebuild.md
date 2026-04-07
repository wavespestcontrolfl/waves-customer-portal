# Lawn Care Spoke Site Rebuild Spec
## bradentonfllawncare.com · parrishfllawncare.com · sarasotafllawncare.com · venicelawncare.com

---

## Current State

All 4 lawn care spoke sites are serving an exact clone of the wavespestcontrol.com homepage. The content talks about cockroaches, pest control tiers, and links to wavespestcontrol.com services. Zero lawn care content exists on any of them. They need to be completely rebuilt from scratch while keeping the Elementor + EasyWP infrastructure.

## Target State

Match the depth and architecture of the built pest control spokes (bradentonflpestcontrol.com pattern) but for lawn care. Each site gets 25-35 pages of unique, city-specific lawn care content with contextual backlinks to waveslawncare.com and wavespestcontrol.com.

---

## Site Architecture (Per Lawn Care Spoke)

```
Homepage (/)
│
├── /lawn-care-services/ ........................ Services overview
│   ├── /lawn-care-services/[city]-fertilization/ 
│   ├── /lawn-care-services/[city]-weed-control/
│   ├── /lawn-care-services/[city]-fungicide-treatment/
│   ├── /lawn-care-services/[city]-insect-control/
│   ├── /lawn-care-services/[city]-dethatching/
│   ├── /lawn-care-services/[city]-top-dressing/
│   ├── /lawn-care-services/[city]-tree-shrub-care/
│   └── /lawn-care-services/[city]-pest-control/ (→ cross-sell link to pest spoke)
│
├── /service-areas/ .............................. Service area overview
│   ├── /service-areas/lawn-care-[neighborhood-1]-fl/
│   ├── /service-areas/lawn-care-[neighborhood-2]-fl/
│   ├── /service-areas/lawn-care-[neighborhood-3]-fl/
│   ├── ... (5-15 neighborhoods per city)
│   └── /service-areas/lawn-care-[neighborhood-N]-fl/
│
├── /about/ ...................................... About Waves
│   ├── /blog/ ................................... Blog (backlink engine)
│   ├── /careers/ ................................ Careers
│   │   └── /careers/sales-representative/
│   ├── /contact/ ................................ Contact form + map
│   ├── /faqs/ ................................... FAQ page (generates schema)
│   ├── /lawn-care-quote/ ....................... Quote request form
│   ├── /lawn-inspection/ ....................... Free inspection page
│   ├── /newsletter/ ............................ Newsletter signup
│   ├── /lawn-library/ .......................... Lawn problem library
│   │   ├── /get-rid-of-chinch-bugs/
│   │   ├── /get-rid-of-sod-webworms/
│   │   ├── /get-rid-of-grubs/
│   │   ├── /get-rid-of-dollar-weed/
│   │   ├── /get-rid-of-crabgrass/
│   │   ├── /get-rid-of-brown-patch/
│   │   ├── /get-rid-of-gray-leaf-spot/
│   │   ├── /get-rid-of-fire-ants-in-lawn/
│   │   ├── /get-rid-of-mole-crickets/
│   │   ├── /get-rid-of-sedge-weeds/
│   │   ├── /get-rid-of-armyworms/
│   │   └── /get-rid-of-take-all-root-rot/
│   ├── /lawn-care-reviews/ ..................... Reviews page
│   └── /waveguard-memberships/ ................. WaveGuard lawn tiers
│
└── /privacy-policy/
```

**Total pages per site: ~30-40** depending on number of neighborhoods

---

## Navigation Structure (Elementor Header)

```
[Logo: city lawn care branded]

Our Services ▾                    Service Areas ▾              About Us ▾              Free Quote
├─ Fertilization                  ├─ [Neighborhood 1], FL      ├─ Blog
├─ Weed Control                   ├─ [Neighborhood 2], FL      ├─ Careers
├─ Fungicide Treatment            ├─ [Neighborhood 3], FL      │  └─ Sales Rep
├─ Insect Control                 ├─ [Neighborhood 4], FL      ├─ Contact Us
├─ Dethatching                    ├─ ...                        ├─ FAQs
├─ Top Dressing                   └─ [Neighborhood N], FL      ├─ Lawn Inspection
├─ Tree & Shrub Care                                           ├─ Newsletter
└─ Pest Control (cross-link)                                   ├─ Lawn Library ▾
                                                               │  ├─ Chinch Bugs
                                                               │  ├─ Sod Webworms
                                                               │  ├─ Dollar Weed
                                                               │  ├─ Crabgrass
                                                               │  ├─ Brown Patch
                                                               │  ├─ Gray Leaf Spot
                                                               │  ├─ Fire Ants
                                                               │  ├─ Mole Crickets
                                                               │  ├─ Sedge
                                                               │  ├─ Armyworms
                                                               │  └─ Take-All Root Rot
                                                               ├─ Quote
                                                               ├─ Reviews
                                                               └─ Memberships

Phone: (941) XXX-XXXX
```

---

## Service Area Pages Per City

### bradentonfllawncare.com
- Anna Maria, FL
- Bayshore Gardens, FL
- Bradenton Beach, FL
- Cortez, FL
- Holmes Beach, FL
- Longboat Key, FL
- Oneco, FL
- Palma Sola, FL
- South Bradenton, FL
- West Bradenton, FL
- Whitfield, FL
- University Park, FL

### parrishfllawncare.com
- Parrish Village, FL
- Fort Hamer, FL
- Gamble Creek, FL
- North River, FL
- Upper Manatee, FL
- Duette, FL
- Erie, FL

### sarasotafllawncare.com
- Bee Ridge, FL
- Fruitville, FL
- Gulf Gate, FL
- Lakewood Ranch, FL
- Palmer Ranch, FL
- Siesta Key, FL
- Southgate, FL
- Vamo, FL
- The Meadows, FL

### venicelawncare.com
- South Venice, FL
- Venice Gardens, FL
- Nokomis, FL
- Osprey, FL
- Laurel, FL
- North Port, FL
- Englewood, FL

---

## Page Content Specs

### HOMEPAGE (/)

**Target: 2,000-2,500 words | Primary keyword: "[City] lawn care"**

**Elementor Layout (match pest control spoke pattern):**

#### Section 1: Hero (Full-width, background image of green SWFL lawn)
- H1: `[City] Lawn Care — Professional Turf Treatment & Maintenance`
- Subheadline: `Expert lawn care for [City]'s St. Augustine, Zoysia & warm-season turf`
- Phone number (click-to-call)
- CTA button: "Get A Free Quote" → /lawn-care-quote/
- Trust row: Licensed | Insured | Locally Owned | 5-Star Rated

#### Section 2: Intro Copy (2-column: text left, image right)
- H2: `Local Lawn Care That Doesn't Suck (Or Spray Randomly)!`
- 250-300 words of brand-voice lawn care intro
- Adapted from waveslawncare.com homepage voice but UNIQUE to this city
- Must reference specific neighborhoods in this city
- Link to waveslawncare.com for "learn more about our approach" → backlink #1

#### Section 3: The Local Lawn Challenge (text section)
- H2: `Why [City] Lawns Need a Professional Game Plan`
- 300-400 words on LOCAL factors:
  - Dominant grass types in this city
  - Soil conditions (sandy coastal vs. inland clay)
  - Local irrigation restrictions (county-specific)
  - Seasonal stress calendar for this microclimate
  - Specific neighborhoods with unique challenges
- Link to wavespestcontrol.com lawn care service page → backlink #2

#### Section 4: Services Grid (Elementor icon boxes or image cards)
- H2: `Lawn Care Services in [City]`
- 7 service cards linking to individual service sub-pages:
  - Fertilization → /lawn-care-services/[city]-fertilization/
  - Weed Control → /lawn-care-services/[city]-weed-control/
  - Fungicide Treatment → /lawn-care-services/[city]-fungicide-treatment/
  - Insect Control → /lawn-care-services/[city]-insect-control/
  - Dethatching → /lawn-care-services/[city]-dethatching/
  - Top Dressing → /lawn-care-services/[city]-top-dressing/
  - Tree & Shrub Care → /lawn-care-services/[city]-tree-shrub-care/
- Each card: icon/image + service name + 2-sentence description + "Learn More"

#### Section 5: WaveGuard Tiers (match waveslawncare.com tier layout)
- H2: `Tailored to Your Turf. Brutal on Your Weeds!`
- 4-tier WaveGuard display: Bronze / Silver / Gold / Platinum
- Bronze = Lawn Care Service base
- Silver = Bronze + 1 (Mosquito, Pest, Rodent, Termite, or T&S)
- Gold = Bronze + 2 (15% discount)
- Platinum = Bronze + 3 (20% discount)
- CTA: "Book Your Service Today" → /lawn-care-quote/
- Link to waveslawncare.com/waveguard-memberships for full details → backlink #3

#### Section 6: Reviews (Trustindex widget or manual review cards)
- H2: `What [City] Homeowners Say About Their Lawns`
- Pull reviews that mention lawn care, turf, or grass from nearest GBP
- If not enough lawn-specific reviews, use general Waves reviews

#### Section 7: Service Area + Map
- H2: `Lawn Care Service Areas in [City]`
- Embedded Google Map centered on target city
- List of neighborhoods with links to individual service area pages
- "We also serve:" row linking to adjacent city spoke sites

#### Section 8: FAQ (generates FAQ schema)
- H2: `Frequently Asked Questions About Lawn Care in [City]`
- 8-10 questions (ALL unique answers per city):

1. "How much does lawn care cost in [City]?"
2. "What type of grass is most common in [City]?"
3. "When should I fertilize my lawn in [City]?"
4. "Why does my [City] lawn have brown patches?"
5. "Is your lawn care safe for pets and children?"
6. "How often should my lawn be treated in [City]?"
7. "What is the WaveGuard lawn care membership?"
8. "Do you offer weed control for St. Augustine grass in [City]?"
9. "Can I combine lawn care and pest control?"
10. "What's the nitrogen blackout period in [County] County?"

#### Section 9: CTA Footer
- Large phone number (click-to-call)
- "Schedule Your Free Lawn Inspection"
- Business hours
- CTA button → /lawn-care-quote/

#### Section 10: Standard Footer
- Logo
- Nav links
- Service area list
- Phone + email
- Social links
- Privacy Policy link
- © Waves Lawn Care [Year]

---

### SERVICE SUB-PAGES (7 pages per site)

**Target: 1,200-1,500 words each | One primary keyword per page**

All 7 follow the same Elementor layout pattern:

#### /lawn-care-services/[city]-fertilization/
- H1: `[City] Lawn Fertilization — Feed Your Turf the Right Way`
- Primary keyword: "[city] lawn fertilization"
- Content sections:
  - Why fertilization matters in SWFL (soil depletion, sandy soils, nutrient leaching)
  - Our fertilization program (what we apply, frequency, grass-track approach)
  - **Nitrogen blackout: June 1 – September 30 in Manatee/Sarasota counties** — explain what this means and how we work around it
  - Seasonal fertilization calendar for [City]
  - What to expect after your first application
  - FAQ (3-4 questions)
- Backlink: "Learn about our full lawn care program" → waveslawncare.com
- Backlink: "Bundle with pest control for WaveGuard savings" → wavespestcontrol.com/waveguard-memberships/

#### /lawn-care-services/[city]-weed-control/
- H1: `[City] Weed Control — Eliminate Dollar Weed, Crabgrass & More`
- Primary keyword: "[city] weed control"
- Content sections:
  - Top weeds in [City]: dollar weed, crabgrass, torpedo grass, chamberbitter, spurge, sedge (Kyllinga/nutsedge)
  - Pre-emergent vs. post-emergent strategy
  - Celsius WG usage (capped at 3 apps/property/year) — explain why rotating products matters
  - Bermuda/Bahia invasion in St. Augustine lawns (Fusilade II approach)
  - How our weed program integrates with fertilization
  - FAQ (3-4 questions)
- Backlink: "Read our full guide on getting rid of dollar weed" → lawn library page on this site
- Backlink: "Common lawn pests that look like weed damage" → wavespestcontrol.com pest library

#### /lawn-care-services/[city]-fungicide-treatment/
- H1: `[City] Lawn Fungicide Treatment — Stop Brown Patch & Gray Leaf Spot`
- Primary keyword: "[city] lawn fungus treatment"
- Content sections:
  - Why SWFL lawns are fungus magnets (humidity, rain, warm nights)
  - Top fungal diseases: brown patch, gray leaf spot, take-all root rot, fairy ring, dollar spot
  - Our fungicide rotation approach
  - Preventive vs. curative applications
  - When to expect results
  - How irrigation timing affects fungal pressure
  - FAQ (3-4 questions)
- Backlink: "Full brown patch guide" → /get-rid-of-brown-patch/ on this site
- Backlink: "Lawn care programs that include fungicide" → waveslawncare.com

#### /lawn-care-services/[city]-insect-control/
- H1: `[City] Lawn Insect Control — Chinch Bugs, Sod Webworms & More`
- Primary keyword: "[city] lawn insect control"
- Content sections:
  - Top lawn insects in [City]: chinch bugs, sod webworms, armyworms, grubs, mole crickets
  - How to tell insect damage from fungus or drought stress
  - Our treatment approach (granular + liquid, preventive + curative)
  - Seasonal insect calendar for [City]
  - How lawn insect control differs from home pest control
  - FAQ (3-4 questions)
- Backlink: "Already seeing bugs inside your home?" → [city] pest control spoke site
- Backlink: "Full chinch bug guide" → /get-rid-of-chinch-bugs/ on this site

#### /lawn-care-services/[city]-dethatching/
- H1: `[City] Lawn Dethatching — Remove the Dead Layer Choking Your Grass`
- Primary keyword: "[city] dethatching service"
- Content sections:
  - What thatch is and why St. Augustine builds it up fast in SWFL
  - Signs your lawn needs dethatching (spongy feel, water runoff, thin spots)
  - Our process (Classen TR-20H mechanical dethatcher)
  - Best timing for dethatching in [City] (spring, after last frost risk)
  - What to expect after dethatching (it looks rough, then recovers)
  - Dethatching vs. scalping vs. verticutting
  - FAQ (3-4 questions)
- Backlink: "Pair dethatching with top dressing for faster recovery" → /[city]-top-dressing/ on this site
- Backlink: "Full lawn renovation services" → waveslawncare.com

#### /lawn-care-services/[city]-top-dressing/
- H1: `[City] Lawn Top Dressing — Build Better Soil Under Your Turf`
- Primary keyword: "[city] top dressing service"
- Content sections:
  - What top dressing does (improves soil structure, fills low spots, promotes root growth)
  - Our process (EcoLawn ECO 250S spreader, clean sand/soil blend)
  - When to top dress in [City] (pair with dethatching in spring)
  - How top dressing helps St. Augustine recover from stress
  - Amount and coverage expectations
  - FAQ (3-4 questions)
- Backlink: "Combine with our fertilization program" → /[city]-fertilization/ on this site

#### /lawn-care-services/[city]-tree-shrub-care/
- H1: `[City] Tree & Shrub Care — Fertilization, Pest Treatment & Palm Injection`
- Primary keyword: "[city] tree and shrub care"
- Content sections:
  - Our 4x/year and 6x/year programs
  - What's included: fertilization, insecticide, fungicide, horticultural oil
  - Arborjet palm injection as separate add-on ($35/palm, $75/visit minimum)
  - Common tree/shrub issues in [City]: whitefly, sooty mold, scale, palm nutrient deficiency
  - Ornamental vs. turf treatment differences
  - FAQ (3-4 questions)
- Backlink: "Protect your palms and your lawn together" → waveslawncare.com
- Backlink: "Pest problems in your trees spreading to your home?" → wavespestcontrol.com

#### /lawn-care-services/[city]-pest-control/ (CROSS-SELL PAGE)
- H1: `[City] Pest Control — Bundle With Your Lawn Care & Save`
- Primary keyword: "[city] pest control"
- Content: 
  - Short explanation that Waves does both lawn care AND pest control
  - WaveGuard bundle savings (Silver, Gold, Platinum)
  - Link to [city] pest control spoke site for full pest services
  - This page exists primarily to cross-link the two spoke sites

---

### SERVICE AREA PAGES (5-15 per site)

**Target: 800-1,200 words each | Primary keyword: "lawn care [neighborhood] FL"**

Follow exact pattern of pest control spoke service area pages but for lawn care.

Each service area page:
- H1: `Lawn Care in [Neighborhood], FL — Professional Turf Treatment`
- Paragraph about that specific neighborhood's lawn characteristics
- What common lawn issues affect homes in this neighborhood
- Services available
- Embedded map or directions reference
- CTA to /lawn-care-quote/
- Links to service sub-pages
- Link to parent city homepage

**Unique content hooks per neighborhood type:**
- Coastal neighborhoods (Anna Maria, Siesta Key, Longboat Key): salt air, sandy soil, wind stress, drought tolerance
- New construction (Fort Hamer, parts of Lakewood Ranch): builder sod establishment, irrigation setup, first-year care programs
- Older established (Bayshore Gardens, Gulf Gate): mature tree shade, root competition, renovation needs
- HOA communities (Palmer Ranch, The Meadows, University Park): HOA lawn standards, curb appeal pressure, consistent maintenance requirements

---

### LAWN LIBRARY PAGES (12 pages per site)

**Target: 1,000-1,500 words each | Informational intent keywords**

Same pattern as the pest library on pest control spokes. Each page is a deep-dive guide on a specific lawn problem.

#### Page Template:
- H1: `How to Get Rid of [Problem] in [City] Lawns`
- What it is (identification with description)
- What causes it in SWFL specifically
- Signs and symptoms
- Our treatment approach
- Prevention tips for [City] homeowners
- When to call a professional
- FAQ (3-5 questions)
- CTA: "Seeing [problem] in your lawn? Call us today"

#### The 12 Library Pages:

| Page | Primary Keyword | Unique SWFL Angle |
|------|----------------|-------------------|
| Get Rid of Chinch Bugs | [city] chinch bugs lawn | Peak June-Sept, worst in full-sun Floratam St. Augustine |
| Get Rid of Sod Webworms | [city] sod webworms | Tropical sod webworm vs. regular, night feeding patterns |
| Get Rid of Grubs | [city] grubs in lawn | White grub lifecycle in SWFL, mole attraction link |
| Get Rid of Dollar Weed | [city] dollar weed | Thrives in overwatered lawns, irrigation adjustment needed |
| Get Rid of Crabgrass | [city] crabgrass | Year-round pressure in SWFL unlike northern seasonal |
| Get Rid of Brown Patch | [city] brown patch lawn | Winter disease in SWFL (opposite of northern timing) |
| Get Rid of Gray Leaf Spot | [city] gray leaf spot | Summer disease, devastating to St. Augustine |
| Get Rid of Fire Ants in Lawn | [city] fire ants lawn | Year-round in SWFL, mound treatment + broadcast |
| Get Rid of Mole Crickets | [city] mole crickets | Underground tunneling damage, spring adults vs. fall nymphs |
| Get Rid of Sedge Weeds | [city] nutsedge | Purple/yellow nutsedge and Kyllinga, tuber system makes it persistent |
| Get Rid of Armyworms | [city] armyworms lawn | Fall armyworm outbreaks, rapid overnight damage |
| Get Rid of Take-All Root Rot | [city] take all root rot | Spring/fall in St. Augustine, often misdiagnosed as chinch bugs |

Each library page should include:
- Backlink to relevant service sub-page on this site (e.g., chinch bugs → /[city]-insect-control/)
- Backlink to waveslawncare.com treatment program page
- Backlink to wavespestcontrol.com if the pest crosses over (fire ants → pest control)

---

### FAQ PAGE (/faqs/)

**Target: 1,500-2,000 words | 15-20 questions**

Comprehensive FAQ covering:
- Pricing questions ("How much does lawn care cost in [City]?")
- Service questions ("How often do you treat my lawn?")
- Grass type questions ("What type of grass do I have?")
- Seasonal questions ("When should I start lawn care in [City]?")
- Product safety questions ("Is your lawn treatment safe for pets?")
- WaveGuard questions ("What is the WaveGuard membership?")
- Bundle questions ("Can I get lawn care and pest control together?")
- Local regulation questions ("What is the fertilizer blackout period?")
- Process questions ("What happens during my first visit?")
- Result questions ("How long until I see results?")

Full FAQ schema markup on this page.

---

### BLOG (/blog/)

The blog is the backlink engine. Each post has 1-2 contextual links back to wavespestcontrol.com or waveslawncare.com deep pages.

**Initial seed: 5 posts per spoke site at launch**

| Post Title | Backlink Target |
|-----------|----------------|
| "The [City] Homeowner's Seasonal Lawn Care Calendar" | waveslawncare.com (main lawn program page) |
| "Why Your [City] St. Augustine Lawn Has Yellow Patches" | wavespestcontrol.com/pest-library/ (chinch bug overlap) |
| "Nitrogen Blackout in [County] County: What You Need to Know" | waveslawncare.com (fertilization details) |
| "Chinch Bugs vs. Brown Patch: How to Tell the Difference in [City]" | wavespestcontrol.com/services/ (pest + lawn bundle) |
| "Is Your [City] Lawn Ready for Summer? 5 Things to Check" | waveslawncare.com/waveguard-memberships/ (upsell) |

**Ongoing cadence: 2-3 posts per month per site**, generated as local companion pieces to hub site content.

---

## Backlink Map Summary

Each lawn care spoke site should link to the hub in these natural locations:

| From (Spoke Page) | To (Hub Page) | Anchor Context |
|-------------------|---------------|----------------|
| Homepage intro | waveslawncare.com | "learn more about our approach" |
| Homepage services | wavespestcontrol.com/waveguard-memberships/ | "bundle and save" |
| Service sub-pages | waveslawncare.com (relevant service page) | "full program details" |
| Service sub-pages | wavespestcontrol.com (relevant pest page) | "seeing bugs too?" |
| Lawn library | waveslawncare.com (treatment page) | "professional treatment options" |
| Lawn library | wavespestcontrol.com/pest-library/ | cross-pest references |
| Blog posts (each) | 1-2 deep pages on either hub | natural editorial links |
| Pest control cross-sell page | [city] pest control spoke | "full pest control services" |
| WaveGuard memberships page | waveslawncare.com/waveguard | "see all membership details" |

**Target: 15-25 unique backlinks to hub sites per spoke site**, spread across the full page structure. No single page should have more than 2-3 outbound links to hub sites.

---

## Content Uniqueness Requirements

### Per-City Differentiation

| City | Grass Emphasis | Soil Angle | Water Angle | Unique Challenge |
|------|---------------|-----------|-------------|-----------------|
| **Bradenton** | Established St. Augustine under mature oaks, shade competition | Sandy loam near coast, more clay east of 41 | Manatee County 2-day watering | Older '60s-'70s lawns need renovation, root competition from established trees |
| **Parrish** | New-construction Floratam, builder-grade sod | Variable — new fill dirt on former ag land | Well water common in newer developments | Establishing lawns from scratch, irrigation system setup and calibration |
| **Sarasota** | Mix of mature neighborhoods and new LWR developments | Sandy coastal to inland clay | Sarasota County 2-day watering | Salt air on barrier island/key properties, extreme variety in lawn age and condition |
| **Venice** | Sandy coastal turf, slightly warmer microclimate | Sandier soils, faster drainage | Sarasota County restrictions, sandier soil drains fast | Earlier spring green-up, longer growing season, more irrigation needed due to sand |

### Content Verification

After generating all 4 sites:
1. Run pairwise similarity check on all homepage content
2. Run pairwise similarity check on matching service sub-pages across cities
3. Run pairwise similarity check on matching lawn library pages across cities
4. **Target: < 25% similarity between any two matching pages across the 4 sites**
5. Every service sub-page must contain at least 2 references that are specific to THAT city and could not apply to any other

---

## Build Order

### Phase 1: bradentonfllawncare.com (Week 1-2)
Build this one first as the template. Bradenton has the most neighborhoods and the most content to work with. Once this site is complete and validated, use its Elementor templates as the base for the other 3.

1. Strip existing pest control clone content
2. Install new lawn care branded header/logo
3. Build homepage in Elementor (all 10 sections)
4. Build 7 service sub-pages
5. Build 12 lawn library pages
6. Build 12 service area pages (Bradenton neighborhoods)
7. Build FAQ, About, Contact, Quote, Inspection, Reviews, Newsletter, Careers pages
8. Build WaveGuard memberships page (lawn-focused)
9. Write and publish 5 initial blog posts
10. Deploy LocalBusiness + FAQ schema
11. Deploy llms.txt
12. Verify all backlinks to hub sites are working

### Phase 2: sarasotafllawncare.com (Week 2-3)
Clone Elementor templates from Bradenton. Replace all content with Sarasota-specific copy. Build 9 Sarasota neighborhood service area pages.

### Phase 3: venicelawncare.com (Week 3-4)
Clone templates. Replace with Venice-specific copy. Build 7 Venice neighborhood service area pages.

### Phase 4: parrishfllawncare.com (Week 4-5)
Clone templates. Replace with Parrish-specific copy. Build 7 Parrish neighborhood service area pages.

### Phase 5: Cross-Validation (Week 5)
- Run uniqueness checks across all 4 sites
- Verify all backlinks functional
- Verify schema on all pages
- Verify all sites in Search Console
- Run PageSpeed on all pages
- Request indexing for all new pages

---

## Schema Per Lawn Care Spoke

```json
{
  "@context": "https://schema.org",
  "@type": "LandscapingBusiness",
  "name": "Waves Lawn Care — [City]",
  "image": "https://[domain]/logo.png",
  "url": "https://[domain]/",
  "telephone": "+1-941-XXX-XXXX",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "[City]",
    "addressRegion": "FL",
    "postalCode": "[Primary ZIP]",
    "addressCountry": "US"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": "[LAT]",
    "longitude": "[LNG]"
  },
  "areaServed": ["[City]", "[Neighborhood 1]", "[Neighborhood 2]"],
  "openingHoursSpecification": [
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"],
      "opens": "07:00",
      "closes": "18:00"
    },
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": "Saturday",
      "opens": "08:00",
      "closes": "14:00"
    }
  ],
  "priceRange": "$$",
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Lawn Care Services",
    "itemListElement": [
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "Lawn Fertilization",
          "description": "Seasonal fertilization program for [City] lawns"
        }
      },
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "Weed Control",
          "description": "Pre-emergent and post-emergent weed treatment"
        }
      },
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "Fungicide Treatment",
          "description": "Brown patch, gray leaf spot, and take-all root rot treatment"
        }
      },
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "Lawn Insect Control",
          "description": "Chinch bug, sod webworm, and grub treatment"
        }
      },
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "Tree & Shrub Care",
          "description": "Fertilization, pest treatment, and Arborjet palm injection"
        }
      }
    ]
  },
  "sameAs": [
    "https://waveslawncare.com",
    "https://wavespestcontrol.com"
  ]
}
```

**Note:** Use `LandscapingBusiness` as the schema type for lawn care sites, not `PestControlService`. This is a different business vertical and Google should see them as distinct.
