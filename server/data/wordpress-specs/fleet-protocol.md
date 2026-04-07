# Waves WordPress Fleet Protocol
## 15-Site Network Management, Spoke Site Templates, and Full Automation System

---

## Table of Contents

1. Network Architecture — Hub & Spoke Model
2. Site Registry — The Control Plane
3. Day 1: Analytics & Search Console Across All 15
4. Day 2–3: Application Passwords & REST API Access
5. Spoke Site Template — Pest Control
6. Spoke Site Template — Lawn Care
7. Spoke Site Template — Exterminators
8. Content Generation System — Unique Content at Scale
9. Schema Deployment — Per-Site LocalBusiness + Service
10. Fleet Health Monitoring Dashboard
11. llms.txt & AI Visibility — Network-Wide
12. Cross-Domain Attribution & Phone Tracking
13. Portal Integration — The Sites Admin Module
14. Plugin Strategy — Hub vs. Spoke
15. Security & Maintenance Protocol
16. Full Implementation Timeline

---

## 1. Network Architecture — Hub & Spoke Model

### The Principle

You cannot maintain 15 full WordPress websites. You don't need to. You need two hub sites and 13 high-performance spoke sites.

### Hub Sites (Full WordPress Stack)

| Site | URL | Role |
|------|-----|------|
| Waves Pest Control | wavespestcontrol.com | Primary pest control + exterminator hub. Blog, estimator, WaveGuard info, full service pages, customer portal link |
| Waves Lawn Care | waveslawncare.com | Primary lawn care hub. Blog, service tiers, grass track info, seasonal programs |

Hub sites get the full plugin stack (Elementor Pro, Rank Math Pro, NitroPack, MonsterInsights, Akismet, CookieYes, Image Optimizer, Chaty, Widgets for Google Reviews). Hub sites publish blog content. Hub sites have the estimator embedded. Hub sites are where SEO authority concentrates.

### Spoke Sites (Lean Landing Machines)

| # | Site | Vertical | Target City |
|---|------|----------|-------------|
| 1 | bradentonflpestcontrol.com | Pest Control | Bradenton |
| 2 | palmettoflpestcontrol.com | Pest Control | Palmetto |
| 3 | parrishpestcontrol.com | Pest Control | Parrish |
| 4 | sarasotaflpestcontrol.com | Pest Control | Sarasota |
| 5 | veniceflpestcontrol.com | Pest Control | Venice |
| 6 | bradentonfllawncare.com | Lawn Care | Bradenton |
| 7 | parrishfllawncare.com | Lawn Care | Parrish |
| 8 | sarasotafllawncare.com | Lawn Care | Sarasota |
| 9 | venicelawncare.com | Lawn Care | Venice |
| 10 | bradentonflexterminator.com | Exterminator | Bradenton |
| 11 | palmettoexterminator.com | Exterminator | Palmetto |
| 12 | parrishexterminator.com | Exterminator | Parrish |
| 13 | sarasotaflexterminator.com | Exterminator | Sarasota |

Each spoke site exists for one purpose: **rank for "[city] [service]" and capture the lead.** That's it. No blog. No 20 plugins. No ongoing content calendar. One killer landing page, a few supporting pages, LocalBusiness schema, a contact form, and a phone number that routes to your operation.

### Why This Works

- The domain itself carries keyword weight: `bradentonflpestcontrol.com` ranking for "Bradenton FL pest control" has a natural advantage
- Each site has its own Search Console property, building individual domain authority
- Google sees 15 independent sites serving 15 different local markets, not one company with 15 thin clones
- You maintain 2 sites actively (the hubs) and 13 sites passively (spoke sites need updates maybe quarterly)

---

## 2. Site Registry — The Control Plane

This lives in your monorepo as a JSON config file and as a database table in your portal.

### wordpress-sites.json

```json
{
  "sites": [
    {
      "id": "waves-pest",
      "name": "Waves Pest Control",
      "type": "hub",
      "vertical": "pest_control",
      "url": "https://wavespestcontrol.com",
      "api_url": "https://wavespestcontrol.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Lakewood Ranch",
      "service_area": ["Bradenton", "Parrish", "Sarasota", "Lakewood Ranch", "Venice", "North Port", "Port Charlotte", "Palmetto"],
      "gbp_listing": "Waves Pest Control — Lakewood Ranch",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "active"
    },
    {
      "id": "waves-lawn",
      "name": "Waves Lawn Care",
      "type": "hub",
      "vertical": "lawn_care",
      "url": "https://waveslawncare.com",
      "api_url": "https://waveslawncare.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Lakewood Ranch",
      "service_area": ["Bradenton", "Parrish", "Sarasota", "Lakewood Ranch", "Venice"],
      "gbp_listing": "Waves Lawn Care — Lakewood Ranch",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "active"
    },
    {
      "id": "bradenton-pest",
      "name": "Bradenton Pest Control",
      "type": "spoke",
      "vertical": "pest_control",
      "url": "https://bradentonflpestcontrol.com",
      "api_url": "https://bradentonflpestcontrol.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Bradenton",
      "service_area": ["Bradenton", "West Bradenton", "Northwest Bradenton", "Palma Sola", "Bayshore Gardens"],
      "gbp_listing": "Waves Pest Control — Bradenton",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "palmetto-pest",
      "name": "Palmetto Pest Control",
      "type": "spoke",
      "vertical": "pest_control",
      "url": "https://palmettoflpestcontrol.com",
      "api_url": "https://palmettoflpestcontrol.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Palmetto",
      "service_area": ["Palmetto", "Terra Ceia", "Rubonia", "Gillette"],
      "gbp_listing": "Waves Pest Control — Bradenton",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "parrish-pest",
      "name": "Parrish Pest Control",
      "type": "spoke",
      "vertical": "pest_control",
      "url": "https://parrishpestcontrol.com",
      "api_url": "https://parrishpestcontrol.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Parrish",
      "service_area": ["Parrish", "Parrish Village", "Fort Hamer", "Gamble Creek"],
      "gbp_listing": "Waves Pest Control — Bradenton",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "sarasota-pest",
      "name": "Sarasota Pest Control",
      "type": "spoke",
      "vertical": "pest_control",
      "url": "https://sarasotaflpestcontrol.com",
      "api_url": "https://sarasotaflpestcontrol.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Sarasota",
      "service_area": ["Sarasota", "Gulf Gate", "Bee Ridge", "Fruitville", "Siesta Key"],
      "gbp_listing": "Waves Pest Control — Sarasota",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "venice-pest",
      "name": "Venice Pest Control",
      "type": "spoke",
      "vertical": "pest_control",
      "url": "https://veniceflpestcontrol.com",
      "api_url": "https://veniceflpestcontrol.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Venice",
      "service_area": ["Venice", "South Venice", "Venice Gardens", "Nokomis", "North Port"],
      "gbp_listing": "Waves Pest Control — Venice",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "bradenton-lawn",
      "name": "Bradenton Lawn Care",
      "type": "spoke",
      "vertical": "lawn_care",
      "url": "https://bradentonfllawncare.com",
      "api_url": "https://bradentonfllawncare.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Bradenton",
      "service_area": ["Bradenton", "West Bradenton", "Northwest Bradenton", "Palma Sola"],
      "gbp_listing": "Waves Lawn Care — Bradenton",
      "nearest_hub": "waves-lawn",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "parrish-lawn",
      "name": "Parrish Lawn Care",
      "type": "spoke",
      "vertical": "lawn_care",
      "url": "https://parrishfllawncare.com",
      "api_url": "https://parrishfllawncare.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Parrish",
      "service_area": ["Parrish", "Parrish Village", "Fort Hamer"],
      "gbp_listing": "Waves Lawn Care — Bradenton",
      "nearest_hub": "waves-lawn",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "sarasota-lawn",
      "name": "Sarasota Lawn Care",
      "type": "spoke",
      "vertical": "lawn_care",
      "url": "https://sarasotafllawncare.com",
      "api_url": "https://sarasotafllawncare.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Sarasota",
      "service_area": ["Sarasota", "Lakewood Ranch", "Palmer Ranch", "Bee Ridge"],
      "gbp_listing": "Waves Lawn Care — Sarasota",
      "nearest_hub": "waves-lawn",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "venice-lawn",
      "name": "Venice Lawn Care",
      "type": "spoke",
      "vertical": "lawn_care",
      "url": "https://venicelawncare.com",
      "api_url": "https://venicelawncare.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Venice",
      "service_area": ["Venice", "South Venice", "Nokomis", "Osprey"],
      "gbp_listing": "Waves Lawn Care — Venice",
      "nearest_hub": "waves-lawn",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "bradenton-ext",
      "name": "Bradenton Exterminators",
      "type": "spoke",
      "vertical": "exterminator",
      "url": "https://bradentonflexterminator.com",
      "api_url": "https://bradentonflexterminator.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Bradenton",
      "service_area": ["Bradenton", "West Bradenton", "Palma Sola"],
      "gbp_listing": "Waves Pest Control — Bradenton",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "palmetto-ext",
      "name": "Palmetto Exterminators",
      "type": "spoke",
      "vertical": "exterminator",
      "url": "https://palmettoexterminator.com",
      "api_url": "https://palmettoexterminator.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Palmetto",
      "service_area": ["Palmetto", "Terra Ceia"],
      "gbp_listing": "Waves Pest Control — Bradenton",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "parrish-ext",
      "name": "Parrish Exterminators",
      "type": "spoke",
      "vertical": "exterminator",
      "url": "https://parrishexterminator.com",
      "api_url": "https://parrishexterminator.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Parrish",
      "service_area": ["Parrish", "Parrish Village"],
      "gbp_listing": "Waves Pest Control — Bradenton",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    },
    {
      "id": "sarasota-ext",
      "name": "Sarasota Exterminators",
      "type": "spoke",
      "vertical": "exterminator",
      "url": "https://sarasotaflexterminator.com",
      "api_url": "https://sarasotaflexterminator.com/wp-json",
      "username": "wavespestcontrol",
      "app_password": null,
      "target_city": "Sarasota",
      "service_area": ["Sarasota", "Gulf Gate", "Bee Ridge"],
      "gbp_listing": "Waves Pest Control — Sarasota",
      "nearest_hub": "waves-pest",
      "ga4_measurement_id": null,
      "search_console_verified": false,
      "schema_deployed": false,
      "llms_txt_deployed": false,
      "tracking_phone": null,
      "status": "needs_content"
    }
  ]
}
```

---

## 3. Day 1: Analytics & Search Console Across All 15

### GA4 Strategy: One Property, One Data Stream, Cross-Domain

Do NOT create 15 separate GA4 properties. Create one GA4 property called "Waves Network" with a single web data stream. Use the same Measurement ID (G-XXXXXXXXXX) across all 15 sites. Then configure cross-domain measurement so GA4 recognizes a user across all your domains.

**Why one property:** You want to see total lead volume, compare city performance, and track the full user journey if someone visits multiple domains. Separate properties fragment your data.

**Setup Steps:**

1. Create GA4 property "Waves Network" at analytics.google.com
2. Add web data stream → get Measurement ID (G-XXXXXXXXXX)
3. In data stream settings → Configure tag settings → Configure your domains
4. Add all 15 domains with "Contains" match type
5. Add all 15 domains to the referral exclusion list (prevents self-referral inflation)

### Installing GA4 on All 15 Sites

For EasyWP installs, the lightest approach is a custom mu-plugin. Claude Code can deploy this to each site via the REST API.

**The mu-plugin (drop into wp-content/mu-plugins/):**

```php
<?php
/**
 * Plugin Name: Waves GA4 Tracker
 * Description: Lightweight GA4 tracking for Waves network
 */
add_action('wp_head', function() {
    $measurement_id = 'G-XXXXXXXXXX'; // Same ID for all sites
    echo "<!-- Google Analytics 4 -->
    <script async src='https://www.googletagmanager.com/gtag/js?id={$measurement_id}'></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', '{$measurement_id}');
    </script>";
}, 1);
```

**Deploying via REST API:** You can't directly create mu-plugins via the standard REST API, but you can:
- Use a lightweight custom plugin instead (installable via REST)
- Or SSH/SFTP into each EasyWP instance and place the file
- Or use the Code Snippets plugin temporarily just for this tracker on spoke sites (only plugin they need)

### Google Search Console

Each domain needs its own Search Console property. This is a manual step, but it's fast:

1. Go to search.google.com/search-console
2. Add property → Domain property → enter each domain
3. Verify via DNS (add TXT record in Namecheap DNS for each domain)
4. Submit sitemap: `https://[domain]/sitemap.xml` (WordPress generates this by default)

Do all 15 in one sitting. Takes about 45 minutes.

**Track verification status in your site registry** — update `search_console_verified: true` as each one completes.

---

## 4. Day 2–3: Application Passwords & REST API Access

### Generating Application Passwords

For each site, log into wp-admin → Users → Your Profile → Application Passwords.

Name each password descriptively: "Waves Portal API" or "Claude Code Access"

Store each password in your site registry (the `app_password` field). Keep this file encrypted or in a secrets manager — never commit plaintext passwords to git.

### Testing REST API Access

For each site, verify access works:

```bash
# Test read access
curl -s https://bradentonflpestcontrol.com/wp-json/wp/v2/posts | head -c 200

# Test authenticated access
curl -s --user "wavespestcontrol:xxxx xxxx xxxx xxxx" \
  https://bradentonflpestcontrol.com/wp-json/wp/v2/posts \
  -H "Content-Type: application/json" \
  -d '{"title":"API Test","status":"draft"}' | jq .id

# If successful, delete the test post
curl -s --user "wavespestcontrol:xxxx xxxx xxxx xxxx" \
  -X DELETE "https://bradentonflpestcontrol.com/wp-json/wp/v2/posts/[ID]?force=true"
```

Run this test against all 15 sites. Claude Code can automate this: loop through the site registry, test each endpoint, flag any failures.

### Express Endpoint for Fleet Operations

Add to your Railway server:

```javascript
// routes/wordpress.js
const axios = require('axios');
const sites = require('../config/wordpress-sites.json');

// Generic WordPress REST API caller
async function wpApiCall(siteId, endpoint, method = 'GET', data = null) {
  const site = sites.sites.find(s => s.id === siteId);
  if (!site) throw new Error(`Site not found: ${siteId}`);
  
  const auth = Buffer.from(`${site.username}:${site.app_password}`).toString('base64');
  
  const response = await axios({
    method,
    url: `${site.api_url}/${endpoint}`,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    data
  });
  
  return response.data;
}

// Health check all sites
router.get('/api/wordpress/health', async (req, res) => {
  const results = [];
  for (const site of sites.sites) {
    try {
      const info = await wpApiCall(site.id, 'wp/v2/settings');
      results.push({ id: site.id, status: 'connected', title: info.title });
    } catch (err) {
      results.push({ id: site.id, status: 'error', error: err.message });
    }
  }
  res.json(results);
});
```

---

## 5. Spoke Site Template — Pest Control

Each pest control spoke site needs exactly these pages:

### Page Structure

```
Homepage (/) — The main landing page (2,000+ words)
├── /services/ — Service overview with all pest types
├── /about/ — About Waves, team, credentials
├── /contact/ — Contact form + embedded map
└── /privacy-policy/ — Legal compliance
```

### Homepage Content Framework

The homepage is the money page. It needs to rank for "[city] pest control" and convert visitors into calls. Here's the section-by-section framework:

**SECTION 1: Hero**
- H1: "[City] Pest Control — Professional Extermination & Prevention"
- Subheadline: "Serving [neighborhoods] and surrounding areas"
- Phone number (click-to-call, tracking number via JS swap)
- "Get a Free Estimate" CTA button
- Trust badges: Licensed, Insured, Locally Owned, 5-Star Rated

**SECTION 2: The Local Problem (300–400 words)**
- H2: "Why [City] Homes Face Unique Pest Challenges"
- Discuss specific local factors: subtropical humidity, proximity to [local waterway/mangrove], construction styles common in [city], seasonal patterns
- Name specific neighborhoods: "Whether you're in [Neighborhood 1], [Neighborhood 2], or [Neighborhood 3]..."
- This section MUST be unique per site — no copy-paste with city name swaps

**SECTION 3: Services Grid (400–500 words)**
- H2: "Pest Control Services in [City]"
- Each pest type gets a mini-section (H3):
  - General Pest Control (roaches, ants, spiders, silverfish)
  - Termite Control (subterranean, drywood — mention Termidor, Bora-Care, baiting)
  - Rodent Control (rats, mice — exclusion, baiting, trapping)
  - Mosquito Control — WaveGuard program (Bronze/Silver/Gold/Platinum)
  - Stinging Insects (wasps, yellow jackets, fire ants)
  - Bed Bug Treatment
  - Wildlife Removal (if applicable)
- Each mini-section: 2–3 sentences describing the service + "Learn more" link to hub site's full service page

**SECTION 4: The Waves Difference (200–300 words)**
- H2: "Why [City] Chooses Waves Pest Control"
- Family-owned, not a franchise
- SWFL native — we know the local pest pressure
- WaveGuard membership program
- Same-day and next-day availability
- Licensed & insured (FL license number)

**SECTION 5: Reviews (dynamic)**
- H2: "What [City] Homeowners Say"
- Pull 3–5 reviews from the nearest GBP listing
- Include reviewer first name, star rating, snippet
- Link to full Google reviews

**SECTION 6: Service Area Map**
- Embedded Google Map centered on target city
- List of neighborhoods/zip codes served
- "We also serve: [adjacent cities with links to their spoke sites]"

**SECTION 7: FAQ (generates FAQ schema)**
- H2: "Frequently Asked Questions About Pest Control in [City]"
- 5–8 questions, each with a unique answer:
  - "How much does pest control cost in [City]?"
  - "What pests are most common in [City]?"
  - "Do you offer same-day pest control in [City]?"
  - "Is your pest control safe for pets and children?"
  - "What is the WaveGuard pest control membership?"
  - "Do you handle termite inspections in [City]?"
  - "How often should I get pest control in [City]?"
  - "Are you licensed for pest control in [County] County?"

**SECTION 8: CTA Footer**
- Phone number (large, click-to-call)
- "Schedule Your Free Inspection"
- Business hours
- Physical address (if applicable to this GBP)

### Metadata for Each Pest Control Spoke

```
Title Tag: [City] Pest Control | Waves Pest Control — Licensed & Insured
Meta Description: Professional pest control in [City], FL. Termite, rodent, mosquito & general pest services. Family-owned, 5-star rated. Call (941) XXX-XXXX for a free estimate.
OG Title: [City] Pest Control — Waves Pest Control
OG Description: Serving [neighborhoods]. Licensed, insured, locally owned pest control.
Canonical: https://[domain]/
```

---

## 6. Spoke Site Template — Lawn Care

### Page Structure

```
Homepage (/) — Main landing page (2,000+ words)
├── /services/ — All lawn care service tiers
├── /about/ — About Waves, team
├── /contact/ — Contact form + map
└── /privacy-policy/
```

### Homepage Content Framework

**SECTION 1: Hero**
- H1: "[City] Lawn Care — Professional Treatment & Maintenance"
- Subheadline: "Expert lawn care for [City]'s St. Augustine, Zoysia & Bermuda grass"
- Phone number + CTA

**SECTION 2: The Local Lawn Challenge (300–400 words)**
- H2: "What [City] Lawns Need to Thrive"
- St. Augustine dominance in SWFL, but vary by city
- Local soil conditions (sandy soil, shell-heavy in some areas)
- Irrigation challenges (county water restrictions if applicable)
- Seasonal stress factors (summer heat, winter dormancy, chinch bug season)
- Name neighborhoods where lawn conditions vary

**SECTION 3: Service Tiers (400–500 words)**
- H2: "Lawn Care Programs for [City] Homes"
- 4-tier system: Basic, Standard, Premium, Elite
- For each tier: what's included, frequency, starting price range
- Mention grass track approach (A/B/C1/C2/D)
- Specialty services: dethatching, topdressing, lawn plugging, tree & shrub care, palm injection

**SECTION 4: WaveGuard Bundles (200 words)**
- H2: "Save More with WaveGuard Bundles"
- Bundle pest + lawn for 5–15% discount
- Bronze/Silver/Gold/Platinum tiers
- Link to hub site for full details

**SECTION 5: Reviews + Service Area Map + FAQ (same pattern as pest control)**

### Unique Lawn Care Content Angles by City

| City | Unique Angle |
|------|-------------|
| Bradenton | Older neighborhoods with established St. Augustine, shade tree competition, more chinch bug pressure in mature lawns |
| Parrish | Newer construction, builder-grade sod, establishing root systems, irrigation setup on well water |
| Sarasota | Mix of older Siesta Key/Gulf Gate lawns and newer LWR developments, salt air considerations near coast |
| Venice | Sandier soils, south county microclimate slightly warmer, earlier spring green-up |

---

## 7. Spoke Site Template — Exterminators

### The Key Difference

"Exterminator" keyword intent is different from "pest control." People searching for an exterminator typically:
- Have an ACTIVE infestation right now
- Want it gone IMMEDIATELY
- Are less price-sensitive, more urgency-driven
- May be searching at night or on weekends

The exterminator spoke sites should reflect this urgency.

### Homepage Content Framework

**SECTION 1: Hero — URGENT tone**
- H1: "[City] Exterminator — Fast, Professional Pest Elimination"
- Subheadline: "Same-Day & Emergency Service Available"
- Phone number LARGE and prominent
- "Call Now" CTA (not "Get an Estimate" — these people want action)
- "Available 7 Days a Week" badge

**SECTION 2: Emergency Services (300 words)**
- H2: "Need an Exterminator in [City] Today?"
- Emphasize response time
- List what qualifies for emergency/same-day: active rodent sighting, wasp nest near entry, severe roach infestation, bed bugs discovered, scorpion/snake inside home
- "Call now, we'll be there today" messaging

**SECTION 3: What We Exterminate (400 words)**
- H2: "Professional Extermination Services in [City]"
- More aggressive language than pest control pages
- Focus on elimination, not prevention
- Each pest type with urgency angle:
  - Roaches: "We don't just spray — we eliminate the colony"
  - Rodents: "Seal the entry points, trap the invaders, prevent return"
  - Termites: "Stop the damage before it costs you thousands"
  - Bed Bugs: "Heat treatment and chemical elimination — gone in one visit"

**SECTION 4: From Emergency to Prevention (200 words)**
- H2: "After the Emergency — Stay Protected"
- Transition from one-time extermination to recurring pest control
- WaveGuard membership pitch
- Link to hub site for ongoing programs

**SECTION 5: Reviews + FAQ + CTA (same pattern)**

### Exterminator FAQ Angles

- "How fast can an exterminator get to my [City] home?"
- "How much does an exterminator cost in [City]?"
- "Should I call an exterminator or pest control company?"
- "What should I do while waiting for the exterminator?"
- "Do you offer after-hours exterminator service in [City]?"

---

## 8. Content Generation System — Unique Content at Scale

### The Anti-Doorway-Page Strategy

Google's doorway page penalty targets sites that are "created to rank for particular similar search queries" and "funnel users to the really usable or relevant page." Your 13 spoke sites are at risk of this if:
- Content is identical or near-identical across sites
- Sites exist only to capture traffic and redirect to a single destination
- Pages are thin (under 500 words) with no real value

### How to Make Each Site Genuinely Unique

**1. City-Specific Research Database**

Build a reference document for each city that Claude Code uses when generating content:

```json
{
  "city": "Bradenton",
  "county": "Manatee",
  "neighborhoods": ["Palma Sola", "Northwest Bradenton", "Bayshore Gardens", "Cortez", "Village Green", "Trailer Estates", "Whitfield", "Oneco"],
  "zip_codes": ["34205", "34207", "34208", "34209", "34210", "34211"],
  "waterways": ["Manatee River", "Palma Sola Bay", "Sarasota Bay"],
  "climate_notes": "Slightly more protected from Gulf winds than Sarasota. Higher humidity in river-adjacent neighborhoods. Flooding risk in Cortez and low-lying areas.",
  "construction_notes": "Mix of 1960s-70s concrete block homes (Bayshore Gardens, Trailer Estates) and newer 2000s+ construction (east of I-75). Older homes have more pest entry points.",
  "soil_notes": "Sandy loam near coast, more clay content east of US-41. Drainage varies significantly by neighborhood.",
  "common_pests_emphasis": ["palmetto bugs (especially near river)", "subterranean termites (older block homes)", "ghost ants", "fire ants (newer developments)", "rats (especially near commercial corridors)"],
  "lawn_notes": "Established St. Augustine in older neighborhoods. Newer developments often have builder-grade Floratam that struggles in partial shade. Many Bradenton homes have mature oak canopy creating shade challenges.",
  "local_references": ["Manatee County Mosquito Control District", "IMG Academy area", "DeSoto Square area"],
  "regulations": {
    "county": "Manatee",
    "irrigation_restrictions": "2-day-per-week watering (odd/even address schedule)",
    "pesticide_notes": "Standard FL DOA regulations, no county-specific additional restrictions"
  }
}
```

Create one of these for each of the 8 cities (Bradenton, Palmetto, Parrish, Sarasota, Lakewood Ranch, Venice, North Port, Port Charlotte).

**2. Content Generation Prompt Template**

When Claude Code generates content for a spoke site, it uses the city reference data + this system prompt:

```
You are writing the homepage content for [DOMAIN] targeting "[CITY] [SERVICE]" keywords.

Use the city reference data provided to write genuinely unique, locally specific content. 
DO NOT write generic pest control / lawn care copy with the city name inserted.
Every paragraph must contain at least one specific local reference that could NOT apply to any other city in the network.

Examples of good local specificity:
- "Bradenton homes along the Manatee River see higher palmetto bug pressure due to moisture migration from the riverbank"
- "Parrish's rapid new construction in the Fort Hamer corridor means many homes have fresh landscaping that hasn't established pest barriers yet"
- "Venice's sandier coastal soils drain faster, which means your St. Augustine needs more frequent irrigation — but Sarasota County's 2-day watering restrictions make timing critical"

Examples of BAD generic copy (never write this):
- "[City] is a beautiful place to live but pests can be a problem"
- "Our team of experts provides quality pest control in [City]"
- "Contact us today for pest control services in the [City] area"

Tone: Authoritative but approachable. You know this area. You live here. You've treated these homes.
Length: 2,000-2,500 words for the full homepage.
```

**3. Content Differentiation Matrix**

Even with unique content, make sure the PAGE STRUCTURE varies slightly between spoke sites:

| Site | Lead Section Focus | Unique Content Block |
|------|-------------------|---------------------|
| Bradenton Pest | River proximity & moisture | "Manatee River Corridor Pest Pressure" |
| Palmetto Pest | Agricultural adjacency | "Living Near Florida's Agricultural Belt" |
| Parrish Pest | New construction boom | "New Construction Pest Prevention in Parrish" |
| Sarasota Pest | Coastal + urban mix | "Why Sarasota's Diverse Housing Stock Creates Diverse Pest Problems" |
| Venice Pest | Southern county climate | "South Sarasota County's Unique Pest Calendar" |

---

## 9. Schema Deployment — Per-Site

### LocalBusiness Schema Template

Each site gets its own JSON-LD block injected into the `<head>`. Claude Code deploys this via a simple mu-plugin or custom plugin on each site.

```json
{
  "@context": "https://schema.org",
  "@type": "PestControlService",
  "name": "Waves Pest Control — [City]",
  "image": "https://[domain]/logo.png",
  "url": "https://[domain]/",
  "telephone": "+1-941-XXX-XXXX",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "[If applicable]",
    "addressLocality": "[City]",
    "addressRegion": "FL",
    "postalCode": "[Primary ZIP]",
    "addressCountry": "US"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": [LAT],
    "longitude": [LNG]
  },
  "areaServed": [
    {"@type": "City", "name": "[City]"},
    {"@type": "City", "name": "[Adjacent City 1]"},
    {"@type": "City", "name": "[Adjacent City 2]"}
  ],
  "openingHoursSpecification": [
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
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
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "[RATING]",
    "reviewCount": "[COUNT]",
    "bestRating": "5"
  },
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Pest Control Services",
    "itemListElement": [
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "General Pest Control",
          "description": "Recurring interior and exterior pest treatment for [City] homes"
        }
      },
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "Termite Control",
          "description": "Termite inspection, baiting systems, and liquid treatment in [City]"
        }
      },
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "Mosquito Control",
          "description": "WaveGuard mosquito reduction program for [City] properties"
        }
      }
    ]
  },
  "sameAs": [
    "https://wavespestcontrol.com",
    "[GBP URL]",
    "[Facebook URL]"
  ]
}
```

### FAQ Schema (auto-generated from page content)

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How much does pest control cost in [City]?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Recurring pest control in [City] typically ranges from $XX–$XX per month depending on property size and service frequency. Our WaveGuard membership starts at $XX/month with no long-term contract required."
      }
    }
  ]
}
```

### Deployment Script

Claude Code can deploy schema across all sites using a custom plugin:

```php
<?php
/**
 * Plugin Name: Waves Schema
 * Description: LocalBusiness + FAQ schema for Waves network
 */
add_action('wp_head', function() {
    // Schema data stored as wp_option so it can be updated via REST API
    $schema = get_option('waves_schema_json', '');
    if ($schema) {
        echo '<script type="application/ld+json">' . $schema . '</script>';
    }
});
```

Then push schema data to each site:

```bash
curl --user "wavespestcontrol:PASSWORD" \
  -X POST "https://bradentonflpestcontrol.com/wp-json/wp/v2/settings" \
  -H "Content-Type: application/json" \
  -d '{"waves_schema_json": "{...escaped JSON...}"}'
```

Or store it as a custom option via the Options API.

---

## 10. Fleet Health Monitoring Dashboard

### Portal Admin: /admin/sites

This section of your customer portal becomes the nerve center for all 15 sites.

### Data Points to Track Per Site

| Metric | Source | Update Frequency |
|--------|--------|-----------------|
| Site Status (up/down) | HTTP HEAD request | Every 5 minutes |
| SSL Expiry Date | SSL check | Daily |
| WordPress Version | REST API /wp/v2/settings | Weekly |
| Plugin Count | REST API | Weekly |
| Plugin Updates Available | REST API | Weekly |
| GA4 Tracking Active | Check for gtag in page source | Weekly |
| Search Console Verified | Manual flag or Search Console API | On setup |
| Sitemap Submitted | Check /sitemap.xml exists | On setup |
| Schema Deployed | Check for JSON-LD in page source | Weekly |
| llms.txt Exists | Check /llms.txt exists | Weekly |
| Page Speed Score (Mobile) | PageSpeed Insights API | Weekly |
| Page Speed Score (Desktop) | PageSpeed Insights API | Weekly |
| Total Pages Indexed | Search Console API | Weekly |
| Content Last Updated | REST API /wp/v2/posts?orderby=modified | Weekly |
| robots.txt Status | Fetch /robots.txt, check for AI bot blocks | Monthly |

### Alert Conditions

- Site down for > 5 minutes → Slack alert
- SSL expiry within 30 days → Dashboard warning
- WordPress version behind latest → Dashboard warning
- PageSpeed mobile score < 50 → Dashboard warning
- Zero pages indexed after 2 weeks → Dashboard critical
- Content not updated in 6 months → Dashboard warning

### Express Endpoints for Monitoring

```javascript
// Check all sites health
router.get('/api/sites/health', async (req, res) => {
  const results = await Promise.allSettled(
    sites.sites.map(async (site) => {
      const start = Date.now();
      try {
        const resp = await axios.head(site.url, { timeout: 10000 });
        return {
          id: site.id,
          status: 'up',
          responseTime: Date.now() - start,
          statusCode: resp.status
        };
      } catch (err) {
        return {
          id: site.id,
          status: 'down',
          responseTime: Date.now() - start,
          error: err.message
        };
      }
    })
  );
  res.json(results.map(r => r.value || r.reason));
});

// Check PageSpeed for a site
router.get('/api/sites/:siteId/pagespeed', async (req, res) => {
  const site = sites.sites.find(s => s.id === req.params.siteId);
  const apiKey = process.env.PAGESPEED_API_KEY;
  const result = await axios.get(
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${site.url}&key=${apiKey}&strategy=mobile`
  );
  res.json({
    score: result.data.lighthouseResult.categories.performance.score * 100,
    fcp: result.data.lighthouseResult.audits['first-contentful-paint'].displayValue,
    lcp: result.data.lighthouseResult.audits['largest-contentful-paint'].displayValue,
    cls: result.data.lighthouseResult.audits['cumulative-layout-shift'].displayValue
  });
});
```

---

## 11. llms.txt & AI Visibility — Network-Wide

### Deploy llms.txt to All 15 Sites

Each site gets its own llms.txt file at the root. For spoke sites this is simple since they have minimal content.

**Example: bradentonflpestcontrol.com/llms.txt**

```markdown
# Waves Pest Control — Bradenton

> Professional pest control services for Bradenton, FL and surrounding Manatee County communities.

## About
Waves Pest Control is a family-owned pest control and lawn care company serving Southwest Florida. We specialize in residential and commercial pest management including general pest control, termite treatment, rodent exclusion, mosquito reduction, and wildlife removal.

## Service Area
Bradenton, West Bradenton, Northwest Bradenton, Palma Sola, Bayshore Gardens, Cortez, Whitfield, Oneco

## Services
- General Pest Control (recurring quarterly and bi-monthly programs)
- Termite Control (baiting systems, liquid treatment, Bora-Care, wood destroying organism inspections)
- Rodent Control (exclusion, trapping, baiting)
- Mosquito Control (WaveGuard Bronze/Silver/Gold/Platinum programs)
- Stinging Insect Removal (wasps, yellow jackets, fire ants)
- Bed Bug Treatment
- Lawn Care (fertilization, weed control, fungicide, insecticide, dethatching)

## Contact
- Phone: (941) XXX-XXXX
- Website: https://bradentonflpestcontrol.com
- Parent Company: https://wavespestcontrol.com

## Pages
- [Home](https://bradentonflpestcontrol.com/)
- [Services](https://bradentonflpestcontrol.com/services/)
- [About](https://bradentonflpestcontrol.com/about/)
- [Contact](https://bradentonflpestcontrol.com/contact/)
```

### robots.txt — Don't Block AI Crawlers

Verify all 15 sites have a robots.txt that allows AI crawlers:

```
User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

Sitemap: https://[domain]/sitemap.xml
```

If any site uses Cloudflare, check that "AI Bot" blocking is turned OFF.

---

## 12. Cross-Domain Attribution & Phone Tracking

### Phone Number Strategy

Each spoke site needs a tracking phone number so you know which domain generated the call. But the schema must use the real GBP-matching business number.

**The solution:** Display the tracking number visibly on the page (in the hero, in the CTA sections), but in the JSON-LD schema, use the real business number. Add a small JavaScript snippet that swaps the display number for tracking:

```javascript
// Dynamic number insertion
// Schema uses real number, visible page shows tracking number
document.addEventListener('DOMContentLoaded', function() {
  const trackingNumber = 'TRACKING_NUMBER_FOR_THIS_DOMAIN';
  document.querySelectorAll('.phone-display').forEach(el => {
    el.textContent = trackingNumber;
    el.href = 'tel:' + trackingNumber.replace(/[^0-9+]/g, '');
  });
});
```

### UTM Parameters for Hub Links

When spoke sites link to the hub (e.g., "Learn more about WaveGuard"), append UTM parameters:

```
https://wavespestcontrol.com/waveguard/?utm_source=bradentonflpestcontrol.com&utm_medium=spoke_site&utm_campaign=bradenton_pest
```

This way GA4 shows you exactly which spoke sites are driving traffic to your hub.

### Lead Source Tracking

Every contact form submission on a spoke site should capture:
- The domain it came from (automatically from `window.location.hostname`)
- The referring source (UTM params if any)
- The page URL
- Timestamp

Push this into your portal's lead pipeline so you can track ROI per domain.

---

## 13. Portal Integration — The Sites Admin Module

### React Component: /admin/sites

This becomes a new section in your admin panel alongside reviews, estimates, and collections.

**Views:**

1. **Fleet Overview** — Grid of all 15 sites with status indicators (green/yellow/red dots for each metric)
2. **Site Detail** — Click into any site to see full health metrics, last content update, schema status, PageSpeed scores, GA4 data
3. **Bulk Actions** — "Deploy schema to all sites," "Check all PageSpeed scores," "Verify all llms.txt files"
4. **Content Status** — Which spoke sites have content published vs. still need content

**Data Model (Postgres):**

```sql
CREATE TABLE wordpress_sites (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  site_type VARCHAR(10) NOT NULL, -- 'hub' or 'spoke'
  vertical VARCHAR(20) NOT NULL, -- 'pest_control', 'lawn_care', 'exterminator'
  url VARCHAR(255) NOT NULL,
  api_url VARCHAR(255) NOT NULL,
  username VARCHAR(100),
  target_city VARCHAR(100),
  nearest_hub VARCHAR(50) REFERENCES wordpress_sites(id),
  gbp_listing VARCHAR(255),
  ga4_measurement_id VARCHAR(20),
  tracking_phone VARCHAR(20),
  search_console_verified BOOLEAN DEFAULT FALSE,
  schema_deployed BOOLEAN DEFAULT FALSE,
  llms_txt_deployed BOOLEAN DEFAULT FALSE,
  content_status VARCHAR(20) DEFAULT 'needs_content', -- needs_content, draft, published, needs_update
  last_health_check TIMESTAMP,
  last_content_update TIMESTAMP,
  pagespeed_mobile INTEGER,
  pagespeed_desktop INTEGER,
  ssl_expiry TIMESTAMP,
  wordpress_version VARCHAR(10),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE site_health_logs (
  id SERIAL PRIMARY KEY,
  site_id VARCHAR(50) REFERENCES wordpress_sites(id),
  check_type VARCHAR(50), -- 'uptime', 'pagespeed', 'ssl', 'schema', 'llms'
  status VARCHAR(20),
  details JSONB,
  checked_at TIMESTAMP DEFAULT NOW()
);
```

---

## 14. Plugin Strategy — Hub vs. Spoke

### Hub Sites (wavespestcontrol.com, waveslawncare.com)

Full stack, same as current:
- Elementor + Elementor Pro
- Rank Math + Rank Math Pro
- NitroPack
- Akismet
- CookieYes
- Image Optimizer
- MonsterInsights (or replace with lightweight GA4 mu-plugin)
- Widgets for Google Reviews (or replace with custom widget)
- Chaty (until AI voice agent replaces)
- WordPress MCP Adapter (when ready)
- LLMagnet or LovedByAI (llms.txt + AI bot tracking)
- Custom waves-functions plugin (schema, snippets, internal linking)

### Spoke Sites (all 13 city domains)

**Absolute minimum:**
- A lightweight theme (GeneratePress, Kadence, or Astra Free — NOT Elementor unless you need it)
- Waves GA4 Tracker (custom mu-plugin, 10 lines)
- Waves Schema (custom plugin for JSON-LD injection)
- Waves llms.txt (custom plugin or static file)
- Contact form (WPForms Lite or Forminator, or a simple HTML form that POSTs to your Railway API)
- No caching plugin needed — EasyWP handles basic caching, and lightweight sites don't need NitroPack
- No SEO plugin needed — handle meta tags via the theme or a simple custom plugin

**Why no Rank Math on spoke sites?** Each spoke site has 4–5 pages total. You set the meta titles, descriptions, and schema once via the REST API or a custom plugin. Rank Math's overhead is unnecessary.

**Why no Elementor on spoke sites?** If you can build the landing page with a lightweight theme + the block editor (Gutenberg), do it. Elementor adds significant page weight. The spoke sites need to load FAST.

**Target specs for spoke sites:**
- < 5 plugins active
- < 1.5 second load time
- PageSpeed mobile score > 85
- Total page weight < 500KB

---

## 15. Security & Maintenance Protocol

### Application Passwords

- One password per site, named "Portal API Access"
- Store in encrypted environment variable or secrets manager (not in plain JSON committed to git)
- Rotate every 90 days
- Revoke immediately if any compromise suspected

### WordPress Updates

Claude Code can check WordPress version across all sites weekly:

```bash
for site in "${SITE_URLS[@]}"; do
  curl -s "$site/wp-json" | jq -r '.name + ": WordPress " + .version'
done
```

For EasyWP, WordPress core updates are often managed by the host, but verify.

### Backup Strategy

EasyWP provides automated backups. Verify this is enabled for all 15 sites. If not, set up a weekly cron that exports content via the REST API (posts, pages, options) to a backup location.

### Monitoring Cadence

| Check | Frequency | Method |
|-------|-----------|--------|
| Uptime | Every 5 min | HTTP HEAD from Railway |
| SSL Expiry | Weekly | SSL check script |
| WordPress Version | Weekly | REST API |
| Plugin Updates | Weekly | REST API |
| PageSpeed Scores | Weekly | PageSpeed API |
| Content Freshness | Monthly | REST API last modified |
| Schema Validity | Monthly | Structured Data Testing Tool API |
| robots.txt Check | Monthly | Fetch and parse |
| Search Console Errors | Weekly | Search Console API |
| GA4 Data Flowing | Weekly | GA4 Admin API |

---

## 16. Full Implementation Timeline

### Week 1: Foundation

**Day 1–2: Analytics**
- [ ] Create GA4 property "Waves Network"
- [ ] Create single web data stream, get Measurement ID
- [ ] Configure cross-domain measurement for all 15 domains
- [ ] Add all domains to referral exclusion list
- [ ] Deploy GA4 tracking snippet to all 15 sites

**Day 3–4: Search Console**
- [ ] Add all 15 domains to Google Search Console
- [ ] Add DNS TXT verification records in Namecheap for each domain
- [ ] Submit sitemaps for all 15 sites
- [ ] Verify all sitemaps are accessible

**Day 5: REST API Access**
- [ ] Generate application password on each site
- [ ] Store credentials in site registry
- [ ] Test REST API access on all 15 sites
- [ ] Build fleet health check endpoint on Railway

### Week 2: Spoke Site Infrastructure

**Day 1–2: Theme & Plugin Setup**
- [ ] Install lightweight theme on all 13 spoke sites
- [ ] Remove unnecessary default plugins (Hello Dolly, etc.)
- [ ] Deploy Waves Schema plugin to all spoke sites
- [ ] Deploy Waves GA4 Tracker mu-plugin to all spoke sites
- [ ] Install minimal contact form on all spoke sites

**Day 3–5: City Reference Data**
- [ ] Build city reference JSON for: Bradenton, Palmetto, Parrish, Sarasota, Venice
- [ ] Research neighborhoods, waterways, soil types, construction patterns for each
- [ ] Document county-specific regulations (Manatee vs. Sarasota)
- [ ] Create pest emphasis profiles per city

### Week 3: Content Generation — Pest Control Sites

- [ ] Generate unique homepage content for bradentonflpestcontrol.com
- [ ] Generate unique homepage content for palmettoflpestcontrol.com
- [ ] Generate unique homepage content for parrishpestcontrol.com
- [ ] Generate unique homepage content for sarasotaflpestcontrol.com
- [ ] Generate unique homepage content for veniceflpestcontrol.com
- [ ] Create Services, About, Contact pages for each
- [ ] Review all content for uniqueness (run plagiarism/similarity check between sites)
- [ ] Publish all pest control spoke sites

### Week 4: Content Generation — Lawn Care & Exterminator Sites

- [ ] Generate homepage content for all 4 lawn care spoke sites
- [ ] Generate homepage content for all 4 exterminator spoke sites
- [ ] Create supporting pages for all 8 sites
- [ ] Review for uniqueness
- [ ] Publish all lawn care and exterminator spoke sites

### Week 5: Schema, llms.txt, and SEO

- [ ] Deploy LocalBusiness schema to all 15 sites
- [ ] Deploy FAQ schema to all spoke sites
- [ ] Create and deploy llms.txt to all 15 sites
- [ ] Verify robots.txt on all 15 sites allows AI crawlers
- [ ] Set meta titles and descriptions on all spoke site pages
- [ ] Run PageSpeed tests on all sites, optimize any below 80
- [ ] Submit all spoke sites for Google indexing via Search Console "Request Indexing"

### Week 6: Portal Integration & Monitoring

- [ ] Build Sites admin module in portal (/admin/sites)
- [ ] Implement fleet health check (uptime, SSL, WordPress version)
- [ ] Implement PageSpeed tracking
- [ ] Implement schema validation check
- [ ] Set up alerting (Slack notifications for site down, SSL expiry)
- [ ] Deploy phone tracking numbers to each spoke site
- [ ] Configure UTM parameters on all hub links from spoke sites
- [ ] Run final audit across all 15 sites

### Ongoing (Monthly)

- [ ] Check all spoke site content is still indexed
- [ ] Update spoke site content quarterly (freshness signal)
- [ ] Monitor GA4 for traffic patterns per domain
- [ ] Monitor Search Console for crawl errors
- [ ] Update review counts in AggregateRating schema
- [ ] Check for new AI crawlers to whitelist
- [ ] Rotate application passwords (every 90 days)

---

## Appendix: Quick Reference — Site-to-GBP Mapping

| Site | Target City | Nearest GBP | Schema Phone |
|------|-------------|-------------|-------------|
| wavespestcontrol.com | Lakewood Ranch | Waves Pest Control — LWR | Main line |
| waveslawncare.com | Lakewood Ranch | Waves Lawn Care — LWR | Main line |
| bradentonflpestcontrol.com | Bradenton | Waves PC — Bradenton | Bradenton GBP |
| palmettoflpestcontrol.com | Palmetto | Waves PC — Bradenton | Bradenton GBP |
| parrishpestcontrol.com | Parrish | Waves PC — Bradenton | Bradenton GBP |
| sarasotaflpestcontrol.com | Sarasota | Waves PC — Sarasota | Sarasota GBP |
| veniceflpestcontrol.com | Venice | Waves PC — Venice | Venice GBP |
| bradentonfllawncare.com | Bradenton | Waves LC — Bradenton | Bradenton GBP |
| parrishfllawncare.com | Parrish | Waves LC — Bradenton | Bradenton GBP |
| sarasotafllawncare.com | Sarasota | Waves LC — Sarasota | Sarasota GBP |
| venicelawncare.com | Venice | Waves LC — Venice | Venice GBP |
| bradentonflexterminator.com | Bradenton | Waves PC — Bradenton | Bradenton GBP |
| palmettoexterminator.com | Palmetto | Waves PC — Bradenton | Bradenton GBP |
| parrishexterminator.com | Parrish | Waves PC — Bradenton | Bradenton GBP |
| sarasotaflexterminator.com | Sarasota | Waves PC — Sarasota | Sarasota GBP |

---

## Appendix: Content Uniqueness Verification

After generating all spoke site content, run a cross-site similarity check:

```python
# Compare all homepage content pairwise
# Flag any pair with > 30% similarity (Jaccard or cosine)
# Rewrite flagged content until all pairs are < 25% similar
```

This is critical. Google can and will detect near-duplicate content across domains with the same registrant. Every spoke site must pass the "newspaper test" — if you printed all 13 homepage articles side by side, a human reader should see 13 clearly different articles about 13 clearly different local markets.
