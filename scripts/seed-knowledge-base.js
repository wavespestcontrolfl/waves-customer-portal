/**
 * Seed Knowledge Base — run with: node scripts/seed-knowledge-base.js
 *
 * 1. Imports all /wiki/*.md files
 * 2. Creates token credential tracking entries
 * 3. Seeds core business knowledge (pricing, chemicals, regulations)
 */

const path = require('path');
const fs = require('fs');
const db = require('../server/models/db');

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 190);
}

async function seedWikiFiles() {
  const wikiDir = path.join(__dirname, '..', 'wiki');
  const categories = ['protocols', 'services', 'techs'];
  let imported = 0;

  for (const cat of categories) {
    const dir = path.join(wikiDir, cat);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');

      // Extract title from first # heading
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : file.replace('.md', '');

      // Extract tags from **Tags:** line
      const tagsMatch = content.match(/\*\*Tags:\*\*\s*(.+)$/m);
      const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [cat];

      const slug = slugify(title);
      const existing = await db('knowledge_base').where({ slug }).first();
      if (existing) {
        console.log(`  skip (exists): ${slug}`);
        continue;
      }

      await db('knowledge_base').insert({
        // path is NOT NULL in knowledge_base — use the source wiki file path.
        path: `wiki/${cat}/${file}`,
        slug,
        title,
        content,
        category: cat === 'techs' ? 'operations' : cat === 'services' ? 'operations' : cat,
        tags: JSON.stringify(tags),
        source: 'wiki-import',
        confidence: 'high',
        last_verified_at: new Date(),
        verified_by: 'wiki-import',
        status: 'active',
        metadata: JSON.stringify({ importedFrom: `wiki/${cat}/${file}` }),
      });
      imported++;
      console.log(`  imported: ${title} -> ${slug}`);
    }
  }
  return imported;
}

async function seedTokenCredentials() {
  const credentials = [
    { platform: 'facebook', credential_type: 'oauth-token', env_var_name: 'FACEBOOK_ACCESS_TOKEN', metadata: { refreshUrl: 'https://developers.facebook.com/tools/explorer/', ttl: '60 days', notes: 'Long-lived page access token. Must regenerate via Graph API Explorer -> Exchange for long-lived -> Get page token from /me/accounts.' } },
    { platform: 'instagram', credential_type: 'oauth-token', env_var_name: 'FACEBOOK_ACCESS_TOKEN', metadata: { notes: 'Uses same Meta token as Facebook. Also requires INSTAGRAM_ACCOUNT_ID and a public image URL for posting.' } },
    { platform: 'linkedin', credential_type: 'oauth-token', env_var_name: 'LINKEDIN_ACCESS_TOKEN', metadata: { refreshUrl: 'https://www.linkedin.com/developers/apps', ttl: '60 days (or 365 for some apps)', notes: 'LinkedIn OAuth 2.0 token. Regenerate via LinkedIn Developer Portal -> Auth tab -> Generate token.' } },
    { platform: 'gbp-lakewood-ranch', credential_type: 'refresh-token', env_var_name: 'GBP_REFRESH_TOKEN_LWR', metadata: { authUrl: '/api/admin/settings/google/auth?location=lakewood-ranch', requires: ['GBP_CLIENT_ID_LWR', 'GBP_CLIENT_SECRET_LWR'], notes: 'Google OAuth refresh token. Use the auth URL to re-authorize. Must set Client ID and Secret first.' } },
    { platform: 'gbp-parrish', credential_type: 'refresh-token', env_var_name: 'GBP_REFRESH_TOKEN_PARRISH', metadata: { authUrl: '/api/admin/settings/google/auth?location=parrish', requires: ['GBP_CLIENT_ID_PARRISH', 'GBP_CLIENT_SECRET_PARRISH'] } },
    { platform: 'gbp-sarasota', credential_type: 'refresh-token', env_var_name: 'GBP_REFRESH_TOKEN_SARASOTA', metadata: { authUrl: '/api/admin/settings/google/auth?location=sarasota', requires: ['GBP_CLIENT_ID_SARASOTA', 'GBP_CLIENT_SECRET_SARASOTA'] } },
    { platform: 'gbp-venice', credential_type: 'refresh-token', env_var_name: 'GBP_REFRESH_TOKEN_VENICE', metadata: { authUrl: '/api/admin/settings/google/auth?location=venice', requires: ['GBP_CLIENT_ID_VENICE', 'GBP_CLIENT_SECRET_VENICE'] } },
  ];

  let created = 0;
  for (const cred of credentials) {
    const existing = await db('token_credentials')
      .where({ platform: cred.platform, credential_type: cred.credential_type }).first();
    if (existing) {
      console.log(`  skip (exists): ${cred.platform}`);
      continue;
    }
    await db('token_credentials').insert({
      ...cred,
      metadata: JSON.stringify(cred.metadata),
      status: 'unknown',
    });
    created++;
    console.log(`  created credential tracker: ${cred.platform}`);
  }
  return created;
}

async function seedCoreKnowledge() {
  const entries = [
    {
      title: 'Nitrogen Blackout — Sarasota, Manatee & Charlotte Counties',
      slug: 'nitrogen-blackout-sarasota-manatee',
      category: 'agronomics',
      tags: ['nitrogen', 'phosphorus', 'fertilizer', 'blackout', 'regulation', 'sarasota', 'manatee', 'charlotte'],
      confidence: 'high',
      // Correction (2026-05-28): forceUpdate re-seeds this row in place. The
      // prior version wrongly excluded Charlotte County; without this the
      // skip-if-exists loop would leave the stale row live in prod.
      forceUpdate: true,
      content: `# Nitrogen Blackout — June 1 through September 30

Sarasota, Manatee, AND Charlotte counties all prohibit nitrogen- and phosphorus-containing fertilizer application from June 1 to September 30 each year.

## Key Rules
- NO nitrogen in ANY form during the blackout window (liquid, granular, slow-release)
- NO phosphorus during the blackout window
- Iron-only and micronutrient-only applications ARE allowed during blackout
- Potassium (0-0-X) products ARE allowed
- Outside the blackout, ≥50% slow-release nitrogen is required (all three counties)
- Violation can result in fines and license issues

## Impact on Lawn Programs
- Switch to iron + micro treatments (FeSO4, chelated iron) June-September
- Pre-load nitrogen in late May (last app before June 1) — EXCEPT North Port, where the last app is before APRIL 1 (city ordinance; see North Port Exception below)
- Resume nitrogen in early October (first app after September 30)
- Communicate blackout reason to customers proactively — prevents "why is my lawn yellow" calls

## County Scope
All three Waves service counties — Sarasota, Manatee, and Charlotte — run the same June 1–Sept 30 county blackout. Charlotte County's ordinance (in place since 2008) protects Charlotte Harbor from red-tide / algal-bloom nutrient runoff. Geo note: North Port falls under Sarasota County; Port Charlotte under Charlotte County.

## ⚠ North Port Exception — Blackout Starts April 1
The City of North Port has its OWN fertilizer ordinance with a LONGER restricted period: April 1 through September 30 (nitrogen AND phosphorus on turf), broader than the June 1–Sept 30 county window. For North Port jobs the LAST nitrogen application is before APRIL 1 (not June 1); resume after September 30. Do NOT apply the June 1 county date to North Port. (Encoded in server/config/protocols.json — "LAST N before Jun 1 blackout (Apr 1 North Port)".)

Sources: charlottecountyfl.gov (One Charlotte One Water) for Charlotte County; cityofnorthport.com fertilizer ordinance for the North Port April 1 start. Verified 2026-05-28.`,
    },
    {
      title: 'Celsius WG — Application Limits',
      slug: 'celsius-wg-application-limits',
      category: 'chemicals',
      tags: ['celsius', 'herbicide', 'wg', 'application-limit', 'warm-season-turf'],
      confidence: 'high',
      content: `# Celsius WG — Max 3 Applications Per Property Per Year

## Label Restriction
Celsius WG (thiencarbazone-methyl + iodosulfuron + dicamba) is limited to a MAXIMUM of 3 applications per property per calendar year per the label.

## Rates
- Standard rate: 0.085 oz per 1,000 sq ft
- Do NOT exceed 0.113 oz per 1,000 sq ft per application
- Annual max: 0.254 oz per 1,000 sq ft per year

## Application Tracking
- Track Celsius apps per property in service notes
- Flag customers approaching 3rd application — switch to alternative (Dismiss, Certainty, or manual pulling)
- Do NOT apply if property has received 3 applications this calendar year regardless of who applied them

## Alternatives After Cap
- Dismiss NXT (sulfentrazone + prodiamine) — different MOA, no annual cap concern
- Certainty (sulfosulfuron) — good for sedge pressure
- Recognition + Fusilade II tank mix — bermudagrass suppression in St. Augustine (bermudagrass ONLY — bahiagrass is not in the 2026 Fusilade II weed table; NEVER Fusilade alone over St. Augustine; see the Recognition + Fusilade II article)`,
      // Correction (2026-08-07): the alternatives list pointed at Fusilade II
      // ALONE for bermuda in St. Augustine — the solo-application injury
      // failure mode. forceUpdate re-seeds this row in place on a manual
      // re-run; migration 20260808000001 corrects the live row on deploy.
      forceUpdate: true,
    },
    {
      title: 'Recognition + Fusilade II — Bermudagrass Suppression in St. Augustine',
      // Slug kept from the original (wrong) article so the live row is
      // corrected in place rather than orphaned alongside a duplicate.
      slug: 'fusilade-ii-bermuda-bahia-eradication',
      category: 'chemicals',
      tags: ['fusilade', 'recognition', 'bermuda', 'st-augustine', 'tank-mix', '2ee'],
      confidence: 'high',
      // Correction (2026-08-07): the original article taught Fusilade II ALONE
      // at 1 oz/gal per 1,000 sq ft — 4-8x the labeled turf rate, on a use
      // (over-the-top St. Augustine) the standalone Fusilade label does not
      // allow. Rewritten to the Recognition + Fusilade II tank-mix protocol
      // (matches the published blog protocol, fact-checked 2026-08-05).
      // forceUpdate re-seeds in place; migration 20260808000001 fixes prod.
      forceUpdate: true,
      content: `# Recognition + Fusilade II — Bermudagrass Suppression in St. Augustine (TANK MIX ONLY)

## ⛔ Never Fusilade alone
An earlier version of this article described Fusilade II by itself at 1 oz per gallon per 1,000 sq ft. That is 4-8x the labeled turf rate, and St. Augustine is NOT a labeled turf for over-the-top Fusilade at all — solo application injures the lawn. The ONLY sanctioned use is the tank mix below, under the Florida FIFRA 2(ee) recommendation (dated 2023-05-11).

## How it works
- Fusilade II (fluazifop-P-butyl, Group 1 ACCase inhibitor) is what kills the bermudagrass.
- Recognition (trifloxysulfuron-sodium 20.4% + the safener metcamifen) is what lets St. Augustine tolerate it. The safener changes plant metabolism — it does not neutralize or shield anything.
- Monument or any plain trifloxysulfuron product is NOT a substitute for Recognition — no safener, no program.
- Resistance note: Recognition's Group 2 active does not control bermudagrass, so for bermuda this is a SINGLE mode-of-action program.

## Rates (per application)
- Recognition: 1.95 oz/acre = 0.045 oz per 1,000 sq ft (the FL 2(ee) allows down to 1.29 oz/acre)
- Fusilade II: 24 fl oz/acre for bermudagrass (0.55 fl oz per 1,000 sq ft) — Syngenta recommends the full rate for bermuda; label range is 12-24
- Non-ionic surfactant (>=80% active): 0.25-0.5% of spray volume
- Mix order: water -> agitation -> Recognition fully dispersed -> Fusilade -> surfactant LAST. No MSO/COC, no acidifiers, no organophosphate insecticides/nematicides in the tank. Buffer toward pH 7 if carrier water is below 5.5.

## Application limits — HARD CEILING: 2 per growing season
- Recognition label alone: min 28 days between applications, max 1.95 oz/acre per application, 6.26 oz/acre/yr.
- The 2026 Fusilade II master label (EPA-accepted 2026-07-15) resistance clause caps this MOA at 2 applications per season, and there is no overlapping-MOA exception for bermuda (see above). A 3rd application waits for the NEXT spring.
- Fusilade annual cap: 1.125 lb fluazifop-P-butyl per acre per year.

## Timing and follow-up
- Spring only (UF/IFAS). Avoid late summer/fall applications.
- Symptoms in 7-14 days; control at 10-21 days; rhizome regrowth appears weeks 4-6.
- Application 2 lands in weeks 5-6, triggered by OBSERVED regrowth — not the calendar.

## Eligibility gates (check BEFORE quoting)
- Cultivars: Floratam / Palmetto / Raleigh / SunClipse -> proceed. CitraBlue -> test area first. Seville -> do NOT treat. ProVista and Captiva -> EXCLUDED (the 2(ee) prohibits Captiva). Unknown cultivar -> test area watched 3-4 weeks. Wait 4 weeks after new sod/sprigs/seed.
- Do NOT treat stressed turf (drought stress, saturated soil, chinch damage, active disease, nematodes, recent scalping) — the safener relies on healthy plant metabolism.
- Mostly-bermuda lawns: do not treat — recommend renovation/re-sod instead.
- Torpedograss: SUPPRESSION only. Never sell this program as torpedograss removal.

## Field rules
- No mowing 7 days before OR after application.
- 3-hour dry minimum (Recognition rainfast 3 hr, Fusilade 1 hr); avoid rain/irrigation within 48 hr.
- 12-month replant interval before planting anything but turfgrass in a treated area.
- Sprayer cleanout: 2.5 oz household ammonia per gallon, recirculate 15+ min, repeat, rinse.

## Critical warnings
- The mix kills bermudagrass AND zoysiagrass — confirm the lawn is St. Augustine first.
- Bahiagrass is NOT in the 2026 Fusilade II weed table — do not sell or apply this program for bahia.
- Single-MOA for bermuda: never exceed the 2-application season ceiling — that is how resistant bermudagrass gets selected.

Source of truth: the published blog protocol /lawn-care/remove-bermudagrass-from-st-augustine/ (fact-checked 2026-08-05), the Syngenta Recognition and Fusilade II labels, and the Florida 2(ee).`,
    },
    {
      title: 'WaveGuard Membership Tiers — Discount Structure',
      slug: 'waveguard-membership-discount-structure',
      category: 'pricing',
      tags: ['waveguard', 'membership', 'bronze', 'silver', 'gold', 'platinum', 'discounts'],
      confidence: 'medium',
      metadata: { needsReconciliation: true, note: 'Earlier inconsistency noted between website-displayed discounts and estimator values — verify current values against live estimator before marking high confidence' },
      content: `# WaveGuard Membership Tiers

## Tier Discounts
- **Bronze:** No discount (base pricing) — entry tier for quarterly pest customers
- **Silver:** 10% discount on all services
- **Gold:** 15% discount on all services — RECOMMENDED tier (highlighted in estimator)
- **Platinum:** 20% discount on all services — best value for multi-service customers

## Service Coverage
Tiers apply across: Pest Control, Lawn Care, Mosquito Control, Termite Services, Tree & Shrub

## Key Business Rules
- Discounts stack on the service base price BEFORE tax
- Year 2+ renewal pricing uses green highlighting in the estimator
- Gold tier uses the RECOMMENDED chip + Von Restorff isolation (visual differentiation)
- Bronze is intentionally muted in the estimator display (behavioral design)
- Monthly price is the hero number (larger font, primary color)

## RECONCILIATION NEEDED
There was a noted inconsistency between the website-displayed discount percentages and the values in the estimator calculator. Before quoting a customer, verify the current tier discount matches what the estimator produces.`,
    },
    {
      title: 'Loaded Labor Rate',
      slug: 'loaded-labor-rate',
      category: 'pricing',
      tags: ['labor', 'rate', 'cost', 'pricing-model', 'margin'],
      confidence: 'high',
      content: `# Loaded Labor Rate: $35/hour

The loaded labor rate of $35/hour is used throughout ALL pricing models in the Waves system. This rate includes:
- Base technician wage
- Payroll taxes (FICA, FUTA, SUTA)
- Workers comp insurance
- Vehicle cost allocation
- Equipment wear

## Where This Rate Appears
- Recurring pest control pricing (time x $35)
- Lawn care v4 pricing engine (time-scaled labor across grass tracks A/B/C1/C2/D)
- Tree & Shrub program calculations
- Rodent exclusion labor estimates
- WDO inspection pricing model
- Stinging insect removal calculations

## Updating
If this rate changes, it needs to be updated in EVERY pricing model simultaneously. The rate is likely defined as a constant in the pricing service — search for 35 or LABOR_RATE in the codebase.`,
    },
    {
      title: 'Social Media Token Refresh — Facebook',
      slug: 'social-media-token-facebook',
      category: 'credentials',
      tags: ['facebook', 'meta', 'oauth', 'token', 'social-media', 'api'],
      confidence: 'high',
      metadata: { envVar: 'FACEBOOK_ACCESS_TOKEN', ttlDays: 60, platform: 'facebook' },
      content: `# Facebook Page Access Token — Refresh Procedure

## Token Lifecycle
Facebook long-lived page access tokens expire after ~60 days.

## Refresh Steps
1. Go to https://developers.facebook.com/tools/explorer/
2. Select the Waves Pest Control app
3. Generate a User Access Token with permissions: pages_manage_posts, pages_read_engagement, pages_read_user_content, pages_show_list, instagram_basic, instagram_manage_insights. The social engagement ingest needs pages_read_engagement + pages_read_user_content (Facebook post likes/comments — first live sweep 2026-08-27 got "(#10) requires pages_read_engagement / pages_read_user_content" on every Facebook post with a token missing pages_read_user_content) and instagram_manage_insights (Instagram share counts via Media Insights). If Meta still returns #10 with those granted, the app needs App Review approval for pages_read_engagement / pages_read_user_content (the Page Public Content Access feature is the alternative).
4. Exchange for long-lived token: GET /oauth/access_token?grant_type=fb_exchange_token&client_id={APP_ID}&client_secret={APP_SECRET}&fb_exchange_token={SHORT_TOKEN}
5. Get Page Access Token: GET /me/accounts?access_token={LONG_LIVED_USER_TOKEN}
6. Copy the page access token for page ID 110336442031847
7. Update FACEBOOK_ACCESS_TOKEN in Railway environment variables
8. Redeploy

## Instagram Note
Instagram posting uses the SAME token (FACEBOOK_ACCESS_TOKEN). Refreshing Facebook also fixes Instagram. The engagement ingest (SOCIAL_ENGAGEMENT_SYNC_ENABLED) reads Instagram share counts via Media Insights, which needs instagram_manage_insights on this token — a token generated without it still syncs likes/comments but records shares as not measured and warns in the sweep log.
The Instagram Business Account ID is 17841465266249854.

## Monitoring
The token health check runs daily and will SMS alert when this token fails or approaches expiry.`,
    },
    {
      title: 'Social Media Token Refresh — LinkedIn',
      slug: 'social-media-token-linkedin',
      category: 'credentials',
      tags: ['linkedin', 'oauth', 'token', 'social-media', 'api'],
      confidence: 'high',
      metadata: { envVar: 'LINKEDIN_ACCESS_TOKEN', ttlDays: 60, platform: 'linkedin' },
      content: `# LinkedIn OAuth Token — Refresh Procedure

## Token Lifecycle
LinkedIn access tokens expire after 60 days (some apps get 365-day tokens).

## Refresh Steps
1. Go to https://www.linkedin.com/developers/apps
2. Select the Waves Pest Control app
3. Go to Auth tab
4. Under OAuth 2.0 tools, generate a new access token
5. Required scopes: w_member_social, r_liteprofile, w_organization_social
6. Copy the new access token
7. Update LINKEDIN_ACCESS_TOKEN in Railway environment variables
8. Redeploy

## Company Page
LinkedIn Company ID: 89173265
Posts are published as the company page via urn:li:organization:89173265`,
    },
    {
      title: 'GBP OAuth Setup — Per Location',
      slug: 'gbp-oauth-setup-per-location',
      category: 'credentials',
      tags: ['gbp', 'google-business-profile', 'oauth', 'token', 'per-location'],
      confidence: 'high',
      metadata: { platform: 'gbp' },
      content: `# Google Business Profile — Per-Location OAuth Setup

## Architecture
Each GBP location uses its own Google Cloud project with separate OAuth credentials:
- GBP_CLIENT_ID_{KEY} + GBP_CLIENT_SECRET_{KEY} + GBP_REFRESH_TOKEN_{KEY}
- Keys: LWR, PARRISH, SARASOTA, VENICE

## Setup Steps (per location)
1. Create or access the Google Cloud project for that location's Google account
2. Enable the "My Business" API (mybusiness.googleapis.com)
3. Create OAuth 2.0 credentials (Web application type)
4. Set authorized redirect URI to: https://{RAILWAY_DOMAIN}/api/admin/settings/google/callback
5. Add GBP_CLIENT_ID_{KEY} and GBP_CLIENT_SECRET_{KEY} to Railway env vars
6. Redeploy
7. Visit /api/admin/settings/google/auth?location={location-id} to authorize
8. Copy the refresh token from the success page
9. Add GBP_REFRESH_TOKEN_{KEY} to Railway env vars
10. Redeploy again

## Location IDs and Env Keys
- lakewood-ranch -> LWR (Account: 115462050041013627815, Location: 11325506936615341094)
- parrish -> PARRISH (Account: 107615291009184011722, Location: 3749219908465956526)
- sarasota -> SARASOTA (Account: 115143019869062526912, Location: 2262372053807555721)
- venice -> VENICE (Account: 111995684974127201844, Location: 9775694678945206688)

## Refresh Tokens
Google OAuth refresh tokens do NOT expire unless revoked. If a refresh token stops working:
- The user may have revoked access in Google Account settings
- The Cloud project may have been disabled
- Re-run the auth flow from step 7 above

## Current Status (as of seed)
- Sarasota: Has credentials but getting 403 on posts — check API enablement and scope
- LWR, Parrish, Venice: Missing credentials entirely — need full setup from step 1`,
    },
    {
      title: 'Instagram Image Pipeline — Known Gap',
      slug: 'instagram-image-pipeline-gap',
      category: 'integrations',
      tags: ['instagram', 'image', 'gemini', 's3', 'social-media', 'bug'],
      confidence: 'high',
      metadata: { type: 'known-issue' },
      content: `# Instagram Image Pipeline — Broken

## Problem
Instagram Graph API requires a publicly accessible image URL to create a media container. The current social media engine generates images via Gemini (base64) but never uploads them to a public URL.

## Code Path
1. social-media.js generateImage() -> returns { base64, mimeType }
2. publishToAll() stores this as generatedImageUrl
3. Line 355: typeof generatedImageUrl === 'string' check FAILS (it's an object)
4. Instagram is skipped with "No public image URL"

## Fix Needed
After Gemini generates the base64 image:
1. Upload to AWS S3 (already configured in the portal for other features)
2. Get the public S3 URL
3. Pass that URL to postToInstagram()

## Workaround
Manual posting with a pre-existing public image URL works fine. The compose tab allows specifying an imageUrl directly.`,
    },
    {
      title: 'FAWN Weather Stations — Blog & Pest Pressure',
      slug: 'fawn-weather-stations',
      category: 'agronomics',
      tags: ['fawn', 'weather', 'myakka', 'arcadia', 'stations', 'pest-pressure', 'blog'],
      confidence: 'high',
      content: `# FAWN Weather Station Data

The blog content engine and pest pressure matrix pull weather data from two UF/IFAS FAWN stations:

## Stations
- **Station 311 — Myakka River:** Primary for Sarasota/Venice service areas
- **Station 260 — Arcadia:** Secondary, covers Charlotte county edge and North Port

## Data Used
- Temperature (min/max/avg) — drives pest activity models
- Rainfall — triggers mosquito pressure alerts, lawn disease risk
- Humidity — factor in fungal disease forecasting
- Soil temperature — determines when to push pre-emergent, when grubs are active

## Integration
- Blog Generate tab pulls FAWN data automatically when creating pest/lawn articles
- Pest pressure matrix uses temperature + humidity thresholds
- Data is fetched via FAWN's public API / CSV endpoints at fawn.ifas.ufl.edu`,
    },
  ];

  let created = 0;
  let updated = 0;
  for (const entry of entries) {
    // forceUpdate is a seed-control flag, not a DB column — strip it.
    const { forceUpdate, ...row } = entry;
    const payload = {
      // path is NOT NULL in knowledge_base. Mirror the canonical convention
      // used by server/services/knowledge-base.js: kb/<category>/<slug>.md.
      path: `kb/${row.category || 'general'}/${row.slug}.md`,
      ...row,
      tags: JSON.stringify(row.tags || []),
      metadata: JSON.stringify(row.metadata || {}),
      source: 'seed',
      last_verified_at: new Date(),
      verified_by: 'seed',
      status: row.status || 'active',
    };
    const existing = await db('knowledge_base').where({ slug: entry.slug }).first();
    if (existing) {
      if (!forceUpdate) {
        console.log(`  skip (exists): ${entry.slug}`);
        continue;
      }
      // Re-seed the existing row in place (slug is the stable key, not updated).
      const { slug, ...updateFields } = payload;
      await db('knowledge_base').where({ slug: entry.slug }).update(updateFields);
      updated++;
      console.log(`  updated (forceUpdate): ${entry.title}`);
      continue;
    }
    await db('knowledge_base').insert(payload);
    created++;
    console.log(`  seeded: ${entry.title}`);
  }
  if (updated) console.log(`  -> ${updated} existing entr${updated === 1 ? 'y' : 'ies'} updated in place`);
  return created;
}

async function main() {
  console.log('\nSeeding Knowledge Base...\n');

  console.log('-- Wiki Import --');
  const wikiCount = await seedWikiFiles();
  console.log(`  -> ${wikiCount} wiki files imported\n`);

  console.log('-- Token Credentials --');
  const tokenCount = await seedTokenCredentials();
  console.log(`  -> ${tokenCount} credential trackers created\n`);

  console.log('-- Core Knowledge --');
  const coreCount = await seedCoreKnowledge();
  console.log(`  -> ${coreCount} core entries seeded\n`);

  console.log(`Done. Total: ${wikiCount + tokenCount + coreCount} entries created.\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
