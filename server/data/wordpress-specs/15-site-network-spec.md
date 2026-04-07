# Waves Network — Complete 15-Site Build Spec
## Every Site. Every Page. Every Backlink. Everything.

---

# TABLE OF CONTENTS

1. Network Overview & Status
2. HUB: wavespestcontrol.com — What to Add
3. HUB: waveslawncare.com — Full Expansion Spec
4. PEST CONTROL SPOKES (5 sites) — What to Add
5. EXTERMINATOR SPOKES (4 sites) — What to Add
6. LAWN CARE SPOKES (4 sites) — Full Rebuild Spec
7. Blog & Backlink Strategy — Network-Wide
8. Schema Deployment — All 15 Sites
9. llms.txt Deployment — All 15 Sites
10. Content Uniqueness Protocol
11. Cross-Link Map — The Full Network
12. Master Implementation Timeline

---

# 1. NETWORK OVERVIEW & STATUS

| # | Site | Type | Vertical | Status | What's Needed |
|---|------|------|----------|--------|---------------|
| 1 | wavespestcontrol.com | Hub | Pest | BUILT ✅ | Blog backlinks from spokes, schema audit, llms.txt |
| 2 | waveslawncare.com | Hub | Lawn | PARTIAL ⚠️ | Needs service sub-pages, service areas, lawn library, blog, full build-out |
| 3 | bradentonflpestcontrol.com | Spoke | Pest | BUILT ✅ | Blog posts w/ backlinks, schema, llms.txt |
| 4 | palmettoflpestcontrol.com | Spoke | Pest | BUILT ✅ | Blog posts w/ backlinks, schema, llms.txt |
| 5 | parrishpestcontrol.com | Spoke | Pest | BUILT ✅ | Blog posts w/ backlinks, schema, llms.txt |
| 6 | sarasotaflpestcontrol.com | Spoke | Pest | BUILT ✅ | Blog posts w/ backlinks, schema, llms.txt |
| 7 | veniceflpestcontrol.com | Spoke | Pest | BUILT ✅ | Blog posts w/ backlinks, schema, llms.txt |
| 8 | bradentonflexterminator.com | Spoke | Exterminator | BUILT ✅ | Blog posts w/ backlinks, schema, llms.txt |
| 9 | palmettoexterminator.com | Spoke | Exterminator | LIKELY BUILT ✅ | Verify build, blog posts, schema, llms.txt |
| 10 | parrishexterminator.com | Spoke | Exterminator | LIKELY BUILT ✅ | Verify build, blog posts, schema, llms.txt |
| 11 | sarasotaflexterminator.com | Spoke | Exterminator | LIKELY BUILT ✅ | Verify build, blog posts, schema, llms.txt |
| 12 | bradentonfllawncare.com | Spoke | Lawn | CLONE ❌ | Full rebuild — pest content on lawn domain |
| 13 | parrishfllawncare.com | Spoke | Lawn | CLONE ❌ | Full rebuild — pest content on lawn domain |
| 14 | sarasotafllawncare.com | Spoke | Lawn | CLONE ❌ | Full rebuild — pest content on lawn domain |
| 15 | venicelawncare.com | Spoke | Lawn | CLONE ❌ | Full rebuild — pest content on lawn domain |

---

# 2. HUB: wavespestcontrol.com — WHAT TO ADD

### Current State
Fully built. 30+ pages including homepage, service pages, 7 service area city pages, about, blog, careers, contact, deals, FAQs, guarantee, quote, inspections (pest + termite), marketing, WaveGuard memberships, newsletter, pest library, referral, reviews, videos, account/portal link.

### What's Missing

**A. Receive backlinks from all spoke sites**
The spoke sites should be linking TO these deep pages on wavespestcontrol.com:

| Target Page | URL | Spoke Sites That Should Link Here |
|------------|-----|-----------------------------------|
| Pest Control Services | /pest-control-services/ | All 5 pest spokes, all 4 exterminator spokes |
| WaveGuard Memberships | /waveguard-memberships/ | All 14 spoke sites (pest, ext, lawn) |
| Bradenton Service Area | /pest-control-bradenton-fl/ | bradentonflpestcontrol.com, bradentonflexterminator.com, bradentonfllawncare.com |
| Sarasota Service Area | /pest-control-sarasota-fl/ | sarasotaflpestcontrol.com, sarasotaflexterminator.com, sarasotafllawncare.com |
| Venice Service Area | /pest-control-venice-fl/ | veniceflpestcontrol.com, venicelawncare.com |
| Parrish Service Area | /pest-control-parrish-fl/ | parrishpestcontrol.com, parrishexterminator.com, parrishfllawncare.com |
| Pest Library | /pest-library/ | All pest + exterminator spokes |
| Blog Posts (individual) | /blog/[slug]/ | Relevant spoke blog posts |
| Pest Inspection | /pest-inspection/ | All pest + exterminator spokes |
| Termite Inspection | /termite-inspection/ | All pest + exterminator spokes |
| About Us | /about-us/ | All spoke "About" pages |
| FAQs | /faqs/ | All spoke FAQ pages |
| Free Quote | /pest-control-quote/ | All pest + exterminator spokes |
| Deals | /pest-control-deals/ | All spoke sites |

**B. Schema audit**
- Verify LocalBusiness schema exists and is accurate
- Add/update AggregateRating with current review counts
- Verify Service schema on all service pages
- Add FAQ schema to /faqs/ page
- Add Organization schema with sameAs links to all spoke domains

**C. llms.txt**
- Deploy /llms.txt with full site map, services, service areas, and all deep page URLs

**D. Cross-link TO spoke sites**
Add a "City-Specific Resources" or "Local Pages" section on each service area page that links to the corresponding spoke site:
- /pest-control-bradenton-fl/ → links to bradentonflpestcontrol.com
- /pest-control-sarasota-fl/ → links to sarasotaflpestcontrol.com
- etc.

This creates bidirectional linking between hub and spokes.

---

# 3. HUB: waveslawncare.com — FULL EXPANSION SPEC

### Current State
Homepage only. Lawn care branded content with WaveGuard tiers. Nav links point BACK to wavespestcontrol.com for services and service areas (wrong — should have its own). Has a /lawn-care-quote/ page. Reviews section pulls from pest control GBP (not ideal). No service sub-pages, no service area pages, no blog, no lawn library.

### Target Architecture

```
Homepage (/)
│
├── /lawn-care-services/ .......................... Services overview
│   ├── /lawn-care-services/fertilization/
│   ├── /lawn-care-services/weed-control/
│   ├── /lawn-care-services/fungicide-treatment/
│   ├── /lawn-care-services/insect-control/
│   ├── /lawn-care-services/dethatching/
│   ├── /lawn-care-services/top-dressing/
│   └── /lawn-care-services/tree-shrub-care/
│
├── /service-areas/ ............................... Service area overview
│   ├── /service-areas/lawn-care-bradenton-fl/
│   ├── /service-areas/lawn-care-lakewood-ranch-fl/
│   ├── /service-areas/lawn-care-parrish-fl/
│   ├── /service-areas/lawn-care-sarasota-fl/
│   ├── /service-areas/lawn-care-venice-fl/
│   ├── /service-areas/lawn-care-north-port-fl/
│   └── /service-areas/lawn-care-port-charlotte-fl/
│
├── /about/ .......................................
│   ├── /blog/ .................................... Blog
│   ├── /careers/ .................................
│   ├── /contact/ .................................
│   ├── /faqs/ ....................................
│   ├── /lawn-care-quote/ ........................ (exists)
│   ├── /lawn-inspection/ ........................
│   ├── /newsletter/ .............................
│   ├── /lawn-library/ ...........................
│   │   ├── /lawn-library/chinch-bugs/
│   │   ├── /lawn-library/sod-webworms/
│   │   ├── /lawn-library/dollar-weed/
│   │   ├── /lawn-library/crabgrass/
│   │   ├── /lawn-library/brown-patch/
│   │   ├── /lawn-library/gray-leaf-spot/
│   │   ├── /lawn-library/take-all-root-rot/
│   │   ├── /lawn-library/fire-ants/
│   │   ├── /lawn-library/mole-crickets/
│   │   ├── /lawn-library/armyworms/
│   │   ├── /lawn-library/sedge-weeds/
│   │   └── /lawn-library/grubs/
│   ├── /reviews/ .................................
│   ├── /referral/ ................................
│   └── /waveguard-memberships/ .................. (lawn-focused tiers)
│
└── /privacy-policy/
```

**Total new pages needed: ~35-40**

### Service Sub-Page Specs (7 pages)

These are the AUTHORITATIVE pages that spoke sites link back to. They should be the most comprehensive lawn care content on your network.

| Page | URL | Word Count | Content Focus |
|------|-----|-----------|---------------|
| Fertilization | /lawn-care-services/fertilization/ | 2,000-2,500 | Complete fertilization guide for SWFL. All grass tracks (A/B/C1/C2/D). Nitrogen blackout rules. Seasonal calendar. Product rotation philosophy. Your loaded labor rate economics (without showing the actual rate). |
| Weed Control | /lawn-care-services/weed-control/ | 2,000-2,500 | Every weed you treat in SWFL. Pre-emergent timing. Post-emergent product rotation. Celsius WG 3-app cap explained. Fusilade II for Bermuda/Bahia eradication. Dollar weed, crabgrass, torpedo grass, chamberbitter, sedge. |
| Fungicide | /lawn-care-services/fungicide-treatment/ | 1,500-2,000 | Brown patch, gray leaf spot, take-all root rot, fairy ring. Preventive vs. curative. Seasonal timing. How irrigation affects fungal pressure. |
| Insect Control | /lawn-care-services/insect-control/ | 1,500-2,000 | Chinch bugs, sod webworms, armyworms, grubs, mole crickets. Damage identification vs. fungus vs. drought. Treatment approach. Seasonal calendar. |
| Dethatching | /lawn-care-services/dethatching/ | 1,200-1,500 | What thatch is. Why St. Augustine builds it. Classen TR-20H process. Best timing. Recovery expectations. Dethatching vs. scalping vs. verticutting. |
| Top Dressing | /lawn-care-services/top-dressing/ | 1,200-1,500 | EcoLawn ECO 250S process. Sand/soil blend specs. Pairing with dethatching. When and why. Coverage expectations. |
| Tree & Shrub | /lawn-care-services/tree-shrub-care/ | 1,500-2,000 | 4x and 6x programs. What's included. Arborjet palm injection ($35/palm, $75 min). Common issues: whitefly, sooty mold, scale, palm nutrient deficiency. |

### Service Area Pages (7 city pages)

Same 7 cities as wavespestcontrol.com but lawn-focused:
- Each 1,000-1,500 words
- City-specific lawn challenges (soil, water restrictions, grass types, common issues)
- Links to service sub-pages
- Links to corresponding lawn care spoke site for that city
- Embedded Google Map
- CTA to /lawn-care-quote/

### Lawn Library (12 pages)

Same topics and structure as defined in the lawn care spoke spec. These are the DEFINITIVE hub versions that spoke lawn library pages reference.

### Blog

Launch with 10 posts. This is the content engine that all 4 lawn care spoke sites link back to.

| Post | Backlink Sources (spoke sites that will link here) |
|------|----------------------------------------------------|
| "The Complete SWFL Lawn Care Calendar" | All 4 lawn spokes |
| "St. Augustine vs. Zoysia: Which Is Right for Your SWFL Lawn?" | All 4 lawn spokes |
| "Understanding the Nitrogen Blackout in Manatee & Sarasota Counties" | Bradenton, Parrish, Sarasota spokes |
| "5 Signs Your Lawn Needs Professional Help" | All 4 lawn spokes |
| "WaveGuard Lawn + Pest Bundles: How They Save You Money" | All 14 spoke sites |
| "What's Killing My St. Augustine? A Diagnostic Guide" | All 4 lawn spokes |
| "How to Water Your SWFL Lawn Without Wasting Money" | All 4 lawn spokes |
| "The Truth About DIY Lawn Care in Florida" | All 4 lawn spokes |
| "Why Your New Construction Lawn Is Struggling" | Parrish, Sarasota (LWR) spokes |
| "Chinch Bugs vs. Drought Stress: How to Tell the Difference" | All 4 lawn spokes, pest spokes |

### Nav Update

The current nav links to wavespestcontrol.com for services and service areas. This needs to change:

```
Our Services → /lawn-care-services/ (on waveslawncare.com)
Service Areas → /service-areas/ (on waveslawncare.com)
About Us → /about/ (on waveslawncare.com)
Free Quote → /lawn-care-quote/ (on waveslawncare.com, already exists)
```

---

# 4. PEST CONTROL SPOKES (5 sites) — WHAT TO ADD

### Sites
- bradentonflpestcontrol.com (Bradenton)
- palmettoflpestcontrol.com (Palmetto)
- parrishpestcontrol.com (Parrish)
- sarasotaflpestcontrol.com (Sarasota)
- veniceflpestcontrol.com (Venice)

### Current State (confirmed for Bradenton, Palmetto, Parrish; inferred for Sarasota, Venice)

All have:
- ✅ Homepage with full brand content
- ✅ Service sub-pages: Ant Control, Bed Bug Treatment, Cockroach Control, Lawn Care (cross-sell), Mosquito Control, Rodent Control, Termite Treatment
- ✅ 5-15 neighborhood service area pages
- ✅ Pest Library with 6-12 "Get Rid Of" pages
- ✅ FAQs, About, Contact, Quote, Inspections (Pest + Termite), Newsletter, Reviews, Careers, Blog section
- ✅ Privacy Policy

### What's Missing on ALL 5 Pest Control Spokes

**A. Blog posts with backlinks to hub**

Each pest control spoke needs 5 initial blog posts at launch, then 2-3/month ongoing.

| Post Template | Backlink Target on wavespestcontrol.com |
|--------------|-----------------------------------------|
| "The Top 5 Pests in [City] This [Season]" | /pest-control-services/ |
| "When to Call a Pest Control Company in [City]" | /pest-inspection/ |
| "How WaveGuard Saves [City] Homeowners Money on Pest Control" | /waveguard-memberships/ |
| "Termite Season in [City]: What Homeowners Need to Know" | /termite-inspection/ |
| "[City] Rodent Prevention: Why Exclusion Beats Trapping" | /pest-library/ or blog post on WPC |

Additional post ideas (rotating monthly):
- "[Neighborhood]-specific pest content" → /pest-control-[city]-fl/ on WPC
- "Pest Control vs. Exterminator: What's the Difference?" → bradentonflexterminator.com (cross-spoke link)
- "Protect Your Lawn AND Your Home in [City]" → waveslawncare.com (cross-vertical link)
- Seasonal companion pieces to hub blog posts

**B. Schema deployment**

Each pest control spoke needs:

```json
{
  "@context": "https://schema.org",
  "@type": "PestControlService",
  "name": "Waves Pest Control — [City]",
  "url": "https://[domain]/",
  "telephone": "+1-941-XXX-XXXX",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "[City]",
    "addressRegion": "FL",
    "postalCode": "[ZIP]",
    "addressCountry": "US"
  },
  "geo": { "@type": "GeoCoordinates", "latitude": "[LAT]", "longitude": "[LNG]" },
  "areaServed": ["[City]", "[Neighborhood 1]", "[Neighborhood 2]", "..."],
  "priceRange": "$$",
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "[RATING]", "reviewCount": "[COUNT]" },
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Pest Control Services",
    "itemListElement": [
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "General Pest Control" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Termite Control" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Rodent Control" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Mosquito Control" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Bed Bug Treatment" } }
    ]
  },
  "sameAs": ["https://wavespestcontrol.com", "[GBP URL]"]
}
```

Plus FAQ schema on /faqs/ page.

**C. llms.txt deployment**

Each site gets /llms.txt listing all pages, services, service areas, and contact info.

**D. Cross-links to sister spokes**

On the lawn care cross-sell service page (e.g., /services/bradenton-lawn-care/), add a link to the corresponding lawn care spoke site:
- bradentonflpestcontrol.com/services/bradenton-lawn-care/ → links to bradentonfllawncare.com

On the "Service Areas" page, add "Also serving [adjacent city]" links to sister pest spokes:
- bradentonflpestcontrol.com → mentions parrishpestcontrol.com, palmettoflpestcontrol.com

---

# 5. EXTERMINATOR SPOKES (4 sites) — WHAT TO ADD

### Sites
- bradentonflexterminator.com (Bradenton)
- palmettoexterminator.com (Palmetto)
- parrishexterminator.com (Parrish)
- sarasotaflexterminator.com (Sarasota)

### Current State (confirmed for Bradenton; inferred for others)

Architecture matches pest control spokes but with exterminator-branded language:
- ✅ Service sub-pages use "Extermination" language: Ant Extermination, Bed Bug Extermination, Cockroach Extermination, Lawn Care, Mosquito Extermination, Rat Extermination, Termite Extermination
- ✅ Service area pages
- ✅ Pest Library, FAQs, About, Contact, Blog, etc.

### What's Missing on ALL 4 Exterminator Spokes

**A. Blog posts with backlinks to hub**

Exterminator blog posts should have a MORE URGENT tone than pest control posts. People searching "exterminator" have active infestations.

| Post Template | Backlink Target |
|--------------|-----------------------------------------|
| "Need an Exterminator in [City] Today? Here's What to Expect" | wavespestcontrol.com/pest-inspection/ |
| "Emergency Pest Situations: When Every Hour Counts in [City]" | wavespestcontrol.com/pest-control-services/ |
| "Exterminator vs. Pest Control: Which Service Do You Actually Need?" | wavespestcontrol.com (general) + [city] pest spoke |
| "What to Do While Waiting for the Exterminator in [City]" | wavespestcontrol.com/pest-library/ |
| "How [City] Homeowners Can Prevent Repeat Infestations After Extermination" | wavespestcontrol.com/waveguard-memberships/ |

**B. Schema deployment**

Same PestControlService schema as pest spokes. The `@type` stays PestControlService — there's no "Exterminator" schema type. Differentiate via `name` field: "Waves Exterminator Services — [City]".

**C. llms.txt deployment**

Same pattern as pest spokes.

**D. Cross-links**

Each exterminator site should link to:
- The corresponding pest control spoke (for ongoing recurring service after emergency extermination)
- wavespestcontrol.com (hub backlinks)
- The corresponding lawn care spoke (cross-vertical)

---

# 6. LAWN CARE SPOKES (4 sites) — FULL REBUILD SPEC

### Sites
- bradentonfllawncare.com
- parrishfllawncare.com
- sarasotafllawncare.com
- venicelawncare.com

### Current State: ALL FOUR ARE PEST CONTROL CLONES — FULL REBUILD REQUIRED

(See the separate lawn-care-spoke-rebuild-spec.md for complete page-by-page details. Summary below.)

### Architecture Per Site (30-40 pages)

```
/ ........................... Homepage (2,000-2,500 words)
/lawn-care-services/ ........ Services overview
  /[city]-fertilization/ .... 1,200-1,500 words
  /[city]-weed-control/ ..... 1,200-1,500 words
  /[city]-fungicide/ ........ 1,200-1,500 words
  /[city]-insect-control/ ... 1,200-1,500 words
  /[city]-dethatching/ ...... 1,200-1,500 words
  /[city]-top-dressing/ ..... 1,200-1,500 words
  /[city]-tree-shrub/ ....... 1,200-1,500 words
  /[city]-pest-control/ ..... Cross-sell page → pest spoke
/service-areas/ ............. Overview + 5-15 neighborhood pages (800-1,200 each)
/about/ ..................... About
/blog/ ...................... 5 posts at launch
/faqs/ ...................... 15-20 questions
/lawn-care-quote/ ........... Quote form
/lawn-inspection/ ........... Inspection page
/lawn-library/ .............. 12 pages (1,000-1,500 each)
/lawn-care-reviews/ ......... Reviews
/waveguard-memberships/ ..... WaveGuard lawn tiers
/contact/ ................... Contact + map
/careers/ ................... Careers + sales rep
/newsletter/ ................ Newsletter signup
/privacy-policy/ ............ Legal
```

### Service Area Neighborhoods Per Lawn Spoke

**bradentonfllawncare.com:** Anna Maria, Bayshore Gardens, Bradenton Beach, Cortez, Holmes Beach, Longboat Key, Oneco, Palma Sola, South Bradenton, West Bradenton, Whitfield, University Park (12 pages)

**parrishfllawncare.com:** Parrish Village, Fort Hamer, Gamble Creek, North River, Upper Manatee, Duette, Erie (7 pages)

**sarasotafllawncare.com:** Bee Ridge, Fruitville, Gulf Gate, Lakewood Ranch, Palmer Ranch, Siesta Key, Southgate, Vamo, The Meadows (9 pages)

**venicelawncare.com:** South Venice, Venice Gardens, Nokomis, Osprey, Laurel, North Port, Englewood (7 pages)

### Schema Type
Use `LandscapingBusiness` (not PestControlService) for lawn care sites.

---

# 7. BLOG & BACKLINK STRATEGY — NETWORK-WIDE

### The Architecture

```
wavespestcontrol.com (hub) ←——— backlinks from 9 pest/ext spokes + 4 lawn spokes
waveslawncare.com (hub) ←——————— backlinks from 4 lawn spokes + 5 pest spokes
pest spokes ←→ exterminator spokes (cross-links between same-city sites)
pest spokes ←→ lawn spokes (cross-vertical links between same-city sites)
```

### Blog Post Volume

| Site Type | Launch Posts | Monthly Ongoing | Backlinks Per Post |
|-----------|-------------|----------------|-------------------|
| wavespestcontrol.com (hub) | Already has blog | Continue 4-6/month | N/A (receives links) |
| waveslawncare.com (hub) | 10 posts | 4-6/month | N/A (receives links) |
| Each pest spoke (5 sites) | 5 posts | 2-3/month | 1-2 to WPC, 0-1 to WLC |
| Each exterminator spoke (4 sites) | 5 posts | 2-3/month | 1-2 to WPC |
| Each lawn spoke (4 sites) | 5 posts | 2-3/month | 1-2 to WLC, 0-1 to WPC |

**Total launch blog posts needed: 10 (WLC hub) + 25 (pest spokes) + 20 (ext spokes) + 20 (lawn spokes) = 75 posts**

**Total monthly ongoing: ~26-39 posts/month across the network** (this is manageable with Claude Code generating local companion pieces from hub content)

### The Companion Post System

For every post published on a hub site, Claude Code generates 2-4 localized companion posts for relevant spoke sites. Same topic, completely different articles, each with local city specificity and a backlink to the original hub post.

**Example:**

Hub publishes: "The Complete Guide to Termite Prevention in SWFL" on wavespestcontrol.com

Claude Code generates:
1. "Why Bradenton Homes Near the Manatee River Are at Higher Risk for Termites" → bradentonflpestcontrol.com/blog/ (links back to hub termite guide)
2. "Termite Season in Parrish's New Construction Corridor" → parrishpestcontrol.com/blog/ (links back to hub)
3. "Sarasota Termite Inspection: What Gulf Gate Homeowners Should Know" → sarasotaflpestcontrol.com/blog/ (links back to hub)
4. "Emergency Termite Extermination in Bradenton — What to Do First" → bradentonflexterminator.com/blog/ (links back to hub)

### Backlink Anchor Text Rules

NEVER use the same anchor text across multiple spoke sites linking to the same hub page. Vary anchor text naturally:

| Spoke | Anchor to WPC /waveguard-memberships/ |
|-------|---------------------------------------|
| Bradenton Pest | "our WaveGuard pest protection plans" |
| Palmetto Pest | "save with a WaveGuard membership" |
| Parrish Pest | "learn about WaveGuard bundles" |
| Sarasota Pest | "WaveGuard recurring protection" |
| Venice Pest | "membership options from Waves" |

---

# 8. SCHEMA DEPLOYMENT — ALL 15 SITES

### Schema Types Per Vertical

| Vertical | Schema @type | Sites |
|----------|-------------|-------|
| Pest Control | PestControlService | wavespestcontrol.com + 5 pest spokes |
| Exterminator | PestControlService | 4 exterminator spokes |
| Lawn Care | LandscapingBusiness | waveslawncare.com + 4 lawn spokes |

### Per-Site Schema Checklist

Every site gets:
- [ ] LocalBusiness schema (PestControlService or LandscapingBusiness) with correct NAP
- [ ] GeoCoordinates matching the target city
- [ ] areaServed listing all neighborhoods served
- [ ] hasOfferCatalog listing all services
- [ ] aggregateRating from nearest GBP
- [ ] openingHoursSpecification
- [ ] sameAs links to hub site + GBP
- [ ] FAQ schema on /faqs/ page
- [ ] Service schema on each service sub-page

### GBP-to-Site Mapping for Schema

| GBP Listing | Sites Using This GBP's Data |
|-------------|----------------------------|
| Waves Pest Control — Lakewood Ranch | wavespestcontrol.com, waveslawncare.com |
| Waves Pest Control — Bradenton | bradentonflpestcontrol.com, bradentonflexterminator.com, bradentonfllawncare.com, palmettoflpestcontrol.com, palmettoexterminator.com |
| Waves Pest Control — Sarasota | sarasotaflpestcontrol.com, sarasotaflexterminator.com, sarasotafllawncare.com |
| Waves Pest Control — Venice | veniceflpestcontrol.com, venicelawncare.com |
| (Parrish — if no dedicated GBP, use Bradenton) | parrishpestcontrol.com, parrishexterminator.com, parrishfllawncare.com |

---

# 9. llms.txt DEPLOYMENT — ALL 15 SITES

### Template (adapt per site)

```markdown
# [Site Name]

> [One-line description of what this site is]

## About
[2-3 sentences about Waves and this specific service/location]

## Service Area
[Comma-separated list of cities/neighborhoods served]

## Services
- [Service 1]
- [Service 2]
- [...]

## Contact
- Phone: (941) XXX-XXXX
- Website: https://[domain]
- Parent Company: https://wavespestcontrol.com

## Pages
- [Page name](URL)
- [Page name](URL)
- [...]
```

List EVERY published page under the Pages section. This is what AI crawlers use to discover your content.

---

# 10. CONTENT UNIQUENESS PROTOCOL

### The Rules

1. **No two sites may share more than 25% content similarity** on any matching page type (homepage vs. homepage, ant control vs. ant control, etc.)
2. **Every page must contain at least 2 references specific to THAT city** that could not apply to any other city in the network
3. **Pest library pages across sites on the SAME topic** (e.g., "Get Rid of Ants" on 5 different pest spokes) must approach the topic from different local angles

### Per-City Uniqueness Angles

| City | Pest Angle | Lawn Angle | Exterminator Angle |
|------|-----------|-----------|-------------------|
| **Bradenton** | River corridor moisture, older block homes, ghost ant capital | Mature oaks creating shade, established St. Augustine needing renovation | "I need help NOW" — Bradenton's older housing stock means more entry points |
| **Palmetto** | Agricultural adjacency, field pest migration | Former agricultural land with variable soil quality | Proximity to farms = more rodent/pest pressure |
| **Parrish** | New construction boom, fresh landscaping no barriers | Builder-grade sod, establishing from scratch, well water | New homes, new bugs — construction disturbance drives pests |
| **Sarasota** | Coastal + urban mix, diverse housing stock | Coastal salt air, LWR vs. Gulf Gate age difference | High-density areas + tourism = faster pest spread |
| **Venice** | Southern county warmer microclimate, sandier soils | Sandy fast-draining soil, earlier spring green-up | Retirement community focus — health-conscious, pet-safe emphasis |

### Verification Process

After content generation for each batch of sites:
```
1. Extract text from all matching page types across the network
2. Run pairwise cosine similarity (or Jaccard) comparison
3. Flag any pair > 25% similarity
4. Rewrite flagged content with more local specificity
5. Re-run until all pairs pass
```

---

# 11. CROSS-LINK MAP — THE FULL NETWORK

### Same-City Cross-Links

For each city that has multiple spoke sites, the sites should cross-link naturally:

**Bradenton cluster:**
```
bradentonflpestcontrol.com ←→ bradentonflexterminator.com
bradentonflpestcontrol.com ←→ bradentonfllawncare.com
bradentonflexterminator.com ←→ bradentonfllawncare.com
All three → wavespestcontrol.com (hub)
All three → waveslawncare.com (hub)
```

**Palmetto cluster:**
```
palmettoflpestcontrol.com ←→ palmettoexterminator.com
Both → wavespestcontrol.com (hub)
```

**Parrish cluster:**
```
parrishpestcontrol.com ←→ parrishexterminator.com
parrishpestcontrol.com ←→ parrishfllawncare.com
parrishexterminator.com ←→ parrishfllawncare.com
All three → both hubs
```

**Sarasota cluster:**
```
sarasotaflpestcontrol.com ←→ sarasotaflexterminator.com
sarasotaflpestcontrol.com ←→ sarasotafllawncare.com
sarasotaflexterminator.com ←→ sarasotafllawncare.com
All three → both hubs
```

**Venice cluster:**
```
veniceflpestcontrol.com ←→ venicelawncare.com
Both → both hubs
```

### Where Cross-Links Go

| Link Location | From → To |
|--------------|-----------|
| Lawn Care service sub-page on pest spoke | pest spoke → lawn spoke same city |
| Pest Control cross-sell page on lawn spoke | lawn spoke → pest spoke same city |
| "Also serving [city]" on service areas page | any spoke → adjacent city spoke same vertical |
| Blog posts (naturally) | any spoke → relevant pages on hubs or sister spokes |
| About page "Part of the Waves family" | any spoke → wavespestcontrol.com/about-us/ |

### Adjacent City Links

Pest spokes can reference neighboring cities:
- bradentonflpestcontrol.com mentions "Also serving Palmetto" → links to palmettoflpestcontrol.com
- parrishpestcontrol.com mentions "Also serving Bradenton" → links to bradentonflpestcontrol.com
- sarasotaflpestcontrol.com mentions "Also serving Venice" → links to veniceflpestcontrol.com

Same pattern for lawn and exterminator spokes.

---

# 12. MASTER IMPLEMENTATION TIMELINE

### Phase 1: Quick Wins — All Built Sites (Weeks 1-2)

**Week 1:**
- [ ] Deploy LocalBusiness schema to all 11 built sites (pest + ext + WPC + WLC)
- [ ] Deploy FAQ schema to all /faqs/ pages
- [ ] Deploy llms.txt to all 11 built sites
- [ ] Verify robots.txt on all 15 domains allows AI crawlers
- [ ] Audit all 11 built sites for any broken internal links

**Week 2:**
- [ ] Write 5 blog posts for bradentonflpestcontrol.com with hub backlinks
- [ ] Write 5 blog posts for palmettoflpestcontrol.com with hub backlinks
- [ ] Write 5 blog posts for parrishpestcontrol.com with hub backlinks
- [ ] Write 5 blog posts for sarasotaflpestcontrol.com with hub backlinks
- [ ] Write 5 blog posts for veniceflpestcontrol.com with hub backlinks
- [ ] Write 5 blog posts for bradentonflexterminator.com with hub backlinks
- [ ] Write 5 blog posts for palmettoexterminator.com with hub backlinks
- [ ] Write 5 blog posts for parrishexterminator.com with hub backlinks
- [ ] Write 5 blog posts for sarasotaflexterminator.com with hub backlinks
**(45 blog posts total this week — Claude Code generates from hub content)**

### Phase 2: waveslawncare.com Hub Expansion (Weeks 3-4)

**Week 3:**
- [ ] Update nav to point to own service/area pages (not WPC)
- [ ] Build /lawn-care-services/ overview page
- [ ] Build 7 service sub-pages (fertilization through tree & shrub)
- [ ] Build /service-areas/ overview page
- [ ] Build 7 city service area pages

**Week 4:**
- [ ] Build 12 lawn library pages
- [ ] Build FAQ, About, Contact, Inspection, Newsletter, Reviews, Referral, Careers pages
- [ ] Build WaveGuard memberships page (lawn-focused)
- [ ] Write 10 launch blog posts
- [ ] Deploy schema (LandscapingBusiness) + llms.txt

### Phase 3: Lawn Care Spoke Rebuilds (Weeks 5-8)

**Week 5-6: bradentonfllawncare.com**
- [ ] Strip pest control clone content
- [ ] Build full site per lawn spoke spec (homepage + 7 services + 12 neighborhoods + 12 library + supporting pages)
- [ ] Write 5 launch blog posts with hub backlinks
- [ ] Deploy schema + llms.txt
- [ ] Validate uniqueness vs. waveslawncare.com

**Week 6-7: sarasotafllawncare.com**
- [ ] Clone Elementor templates from Bradenton lawn spoke
- [ ] Replace ALL content with Sarasota-specific copy
- [ ] Build 9 Sarasota neighborhood pages
- [ ] Write 5 unique launch blog posts
- [ ] Deploy schema + llms.txt

**Week 7: venicelawncare.com**
- [ ] Clone templates, replace with Venice copy
- [ ] Build 7 Venice neighborhood pages
- [ ] Write 5 unique launch blog posts
- [ ] Deploy schema + llms.txt

**Week 8: parrishfllawncare.com**
- [ ] Clone templates, replace with Parrish copy
- [ ] Build 7 Parrish neighborhood pages
- [ ] Write 5 unique launch blog posts
- [ ] Deploy schema + llms.txt

### Phase 4: Cross-Validation & Cross-Linking (Week 9)

- [ ] Run uniqueness check across ALL matching pages network-wide
- [ ] Add cross-links between same-city spokes (pest ↔ ext ↔ lawn)
- [ ] Add adjacent-city links on service area pages
- [ ] Add bidirectional hub ↔ spoke links on service area pages
- [ ] Verify all schema is valid (Google Rich Results Test on every site)
- [ ] Verify all llms.txt files are accessible
- [ ] Run PageSpeed on all 15 sites, flag any under 70 mobile
- [ ] Request indexing for all new pages via Search Console

### Phase 5: Ongoing Operations (Week 10+)

- [ ] Publish 2-3 blog posts per spoke site per month (26-39 posts/month network-wide)
- [ ] Generate companion posts from hub content using Claude Code
- [ ] Update AggregateRating in schema quarterly (pull from GBP review data)
- [ ] Quarterly content freshness pass on all spoke site homepages and service pages
- [ ] Monthly AI visibility check (ask ChatGPT/Perplexity about pest control + lawn care in each city)
- [ ] Rotate application passwords every 90 days

---

# APPENDIX: TOTAL PAGE COUNT

| Site | Existing Pages | New Pages Needed | Total |
|------|---------------|-----------------|-------|
| wavespestcontrol.com | ~35 | 0 (add blog posts, schema, llms.txt) | ~35 |
| waveslawncare.com | ~3 | ~37 | ~40 |
| bradentonflpestcontrol.com | ~45 | 5 blog posts + schema + llms.txt | ~50 |
| palmettoflpestcontrol.com | ~30 | 5 blog posts + schema + llms.txt | ~35 |
| parrishpestcontrol.com | ~30 | 5 blog posts + schema + llms.txt | ~35 |
| sarasotaflpestcontrol.com | ~30 | 5 blog posts + schema + llms.txt | ~35 |
| veniceflpestcontrol.com | ~30 | 5 blog posts + schema + llms.txt | ~35 |
| bradentonflexterminator.com | ~30 | 5 blog posts + schema + llms.txt | ~35 |
| palmettoexterminator.com | ~25 | 5 blog posts + schema + llms.txt | ~30 |
| parrishexterminator.com | ~25 | 5 blog posts + schema + llms.txt | ~30 |
| sarasotaflexterminator.com | ~25 | 5 blog posts + schema + llms.txt | ~30 |
| bradentonfllawncare.com | 0 (clone) | ~40 full build | ~40 |
| parrishfllawncare.com | 0 (clone) | ~30 full build | ~30 |
| sarasotafllawncare.com | 0 (clone) | ~35 full build | ~35 |
| venicelawncare.com | 0 (clone) | ~30 full build | ~30 |
| **TOTAL** | **~343** | **~252** | **~595** |

**Your network will have approximately 595 pages across 15 domains when complete.**
