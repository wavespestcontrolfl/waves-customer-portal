# The Waves WordPress Protocol
## A Complete System for Managing WordPress with Claude Code

---

## Part 1: The Foundation — WordPress MCP Adapter

This is the single biggest unlock. WordPress 6.9 introduced the Abilities API, and the official MCP Adapter turns your entire WordPress site into a set of tools that Claude Code can discover and execute through natural conversation.

### What This Means for You

Instead of logging into wp-admin, clicking through Elementor, updating Rank Math fields, managing plugins — you tell Claude Code what you want and it does it. Not through brittle scripts. Through a structured, permission-gated protocol where WordPress tells Claude Code exactly what actions are available, what inputs they need, and what permissions are required.

### Setup

**Step 1: Install the MCP Adapter on your WordPress site**

```bash
# Via Composer (recommended)
composer require wordpress/abilities-api wordpress/mcp-adapter
```

Or download the plugin ZIP from the GitHub releases page and install through wp-admin.

**Step 2: Generate an Application Password**

Go to Users → Your Profile → Application Passwords in wp-admin. Generate one. This is your API key.

**Step 3: Connect Claude Code**

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "npx",
      "args": ["-y", "@automattic/mcp-wordpress-remote@latest"],
      "env": {
        "WP_API_URL": "https://wavespestcontrol.com/wp-json/mcp/mcp-adapter-default-server",
        "WP_API_USERNAME": "your-admin-username",
        "WP_API_PASSWORD": "xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

**Step 4: Create a CLAUDE.md file** in your project root with WordPress-specific context:

```markdown
# WordPress Site Management — Waves Pest Control

## Credentials
WordPress site credentials are stored in `wordpress-sites.json`.

## WordPress API Requests
When sending JSON with special characters (quotes, em-dashes, apostrophes) to the WordPress REST API, avoid using bash HEREDOCs as they cause quoting issues. Instead:
1. Write the JSON to a temporary file
2. Use `curl -d @filename` to read from the file
3. Delete the temp file after the request completes

## Publishing Blog Posts
Do not include the featured image in the post body. The theme automatically displays it above the post content.

## Rank Math SEO
All posts require: focus keyword, meta description, og:title, og:description via Rank Math REST API fields.

## Service Areas
Bradenton/Parrish, Sarasota/LWR, Venice/North Port, Port Charlotte

## Brand Voice
Provocative clickbait titles, vivid intros, Key Takeaways boxes, em dash-heavy copy, SWFL local specificity, sarcastic FAQ sections.
```

### What You Can Do Once Connected

Claude Code can now:
- Create, update, publish, and schedule posts
- Upload media and set featured images
- Manage plugin activation/deactivation
- Update page content (including Elementor pages via REST)
- Query and modify Rank Math SEO fields
- Purge caches (NitroPack API)
- Search and manage taxonomies (categories, tags)
- Audit the entire site for issues

---

## Part 2: The Plugin Audit — What Stays, What Goes, What's New

### Kill List (Replace with Claude Code + Your Monorepo)

| Plugin | Why It Goes | Replacement |
|--------|-------------|-------------|
| **Code Snippets** | You're running a full monorepo. Version-control your PHP in a custom plugin. | Custom `waves-functions` plugin in your repo |
| **Internal Link Juicer** | Linking logic belongs in your content pipeline. | Build keyword→URL mapping into your blog publishing flow |
| **Auto Image Attributes** | Trivial to handle during media upload. | 3 lines in your upload script: set alt, title, caption from filename |
| **Better Search Replace** | One-off tool. Use WP-CLI via Claude Code when needed. | `wp search-replace` via REST or SSH |
| **Feedzy RSS** | Server-side RSS processing on Railway is cleaner. | Express endpoint that fetches and processes feeds |
| **GTranslate** | You serve SWFL. Your customers speak English and Spanish. A full translation layer adds bloat for minimal ROI. | If you need Spanish, build targeted Spanish landing pages manually — better for local SEO anyway |

### Keep List (Not Worth Rebuilding)

| Plugin | Why It Stays |
|--------|-------------|
| **Elementor + Pro** | Your entire site is built on it. The visual builder isn't something you'd replace with code. |
| **Rank Math + Pro** | SEO infrastructure. But now you'll *drive* it programmatically via REST API instead of clicking through the UI. |
| **NitroPack** | Caching, CDN, Core Web Vitals optimization. Their edge network does things you don't want to rebuild. |
| **Akismet** | Spam filtering. Costs nothing, works perfectly. |
| **CookieYes** | GDPR compliance widget. Legal checkbox, leave it alone. |
| **Image Optimizer (Elementor)** | WebP/AVIF conversion + compression. Keep unless you build this into your media pipeline. |

### Candidates for Replacement (Evaluate)

| Plugin | Consideration |
|--------|--------------|
| **MonsterInsights** | You could pull GA4 data directly into your portal dashboard via the Google Analytics Data API. Saves a plugin, centralizes your analytics. But only worth it if you actually build the dashboard. |
| **Widgets for Google Reviews** | You're building a review engine in your portal. A custom Elementor widget pulling from your own review data would be more powerful and on-brand. |
| **Chaty** | If/when you build the AI voice agent, replace this with your own chat widget that feeds into your lead capture pipeline. |
| **Autocomplete Google Address** | Evaluate if you actually use this. If it's for a service area form, you can handle this with the Google Places API in your own forms. |
| **WP-Optimize** | NitroPack handles caching. WP-Optimize's database cleanup can be done via WP-CLI. The image compression overlaps with Image Optimizer. Likely redundant. |

### New Additions

| Plugin/Tool | Why |
|-------------|-----|
| **WordPress MCP Adapter** | The foundation of this entire protocol. |
| **LLMagnet or LovedByAI** | Generate `llms.txt` and `llms-full.txt` files, track AI bot traffic, optimize content for AI answer engines. This is the new SEO frontier. |
| **Schema Pro or custom JSON-LD** | If Rank Math's schema isn't granular enough for your multi-location setup, consider a dedicated schema plugin or inject custom JSON-LD via your functions plugin. |

---

## Part 3: SEO Protocol — Traditional + Local + AI

### 3A: Traditional SEO (What Rank Math Handles, Automated)

Every post published through your content pipeline should automatically get:

- **Focus keyword** set via Rank Math REST API field `rank_math_focus_keyword`
- **Meta description** generated and set via `rank_math_description`
- **Open Graph title/description** via `rank_math_og_content_title` and `rank_math_og_content_description`
- **Internal links** injected based on your keyword→URL mapping
- **Schema type** set appropriately (Article for blog posts, FAQPage for FAQ content)
- **Canonical URL** verified

Claude Code can audit these fields across all posts and flag gaps. Run this weekly:

```
"Audit all published posts. Flag any missing: focus keyword, meta description, 
featured image, or alt text on images. Output as a spreadsheet."
```

### 3B: Local SEO — The Multi-Location Engine

This is where you differentiate. You have four service zones and four GBP listings. Most pest control companies have one generic "Services" page. You need depth.

**Service × Location Page Matrix:**

For each major service, you need a dedicated page for each service zone:

| Service | Bradenton/Parrish | Sarasota/LWR | Venice/North Port | Port Charlotte |
|---------|-------------------|--------------|-------------------|----------------|
| General Pest Control | ✓ | ✓ | ✓ | ✓ |
| Termite Control | ✓ | ✓ | ✓ | ✓ |
| Mosquito Control (WaveGuard) | ✓ | ✓ | ✓ | ✓ |
| Rodent Control | ✓ | ✓ | ✓ | ✓ |
| Lawn Care | ✓ | ✓ | ✓ | ✓ |
| Tree & Shrub Care | ✓ | ✓ | ✓ | ✓ |

That's 24+ unique pages. Each one needs:

- **Unique content** — not templates with city names swapped. Local climate discussion, neighborhood references, seasonal patterns specific to that zone.
- **Embedded Google Map** centered on that service area
- **LocalBusiness schema** specific to the nearest GBP location
- **Service schema** defining the specific service
- **FAQ schema** with locally-relevant questions
- **NAP consistency** matching the GBP listing for that zone
- **City-specific testimonials** pulled from your review system

**Claude Code can generate these pages programmatically:**

```
"Create a pest control service page for Bradenton/Parrish. Include local climate 
discussion about subtropical humidity and its effect on pest pressure. Reference 
neighborhoods like Palma Sola, Northwest Bradenton, Parrish Village. Include FAQ 
schema. Set the canonical to /pest-control-bradenton/. Publish as draft."
```

**Schema Markup — Per Location:**

Each service zone page needs its own `LocalBusiness` JSON-LD block:

```json
{
  "@context": "https://schema.org",
  "@type": "PestControlService",
  "name": "Waves Pest Control — Bradenton",
  "image": "https://wavespestcontrol.com/logo.png",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "Bradenton",
    "addressRegion": "FL",
    "postalCode": "34205"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": 27.4989,
    "longitude": -82.5748
  },
  "url": "https://wavespestcontrol.com/pest-control-bradenton/",
  "telephone": "+1-941-XXX-XXXX",
  "areaServed": ["Bradenton", "Parrish", "Palma Sola", "Northwest Bradenton"],
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Pest Control Services",
    "itemListElement": [
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "General Pest Control",
          "description": "Recurring pest control for homes in Bradenton and Parrish"
        }
      },
      {
        "@type": "Offer",
        "itemOffered": {
          "@type": "Service",
          "name": "Termite Treatment",
          "description": "Termite baiting, trenching, and Bora-Care treatments"
        }
      }
    ]
  },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "4.9",
    "reviewCount": "127"
  }
}
```

Claude Code can inject this into each page's `<head>` via a custom function in your waves-functions plugin, or via Rank Math's custom schema editor.

**Phone Number Tracking:**

You already have a tracking number master map. The critical rule: dynamic number insertion must NOT break NAP consistency. Your GBP phone number and your schema `telephone` field must match the real business number, not a tracking number. Tracking numbers go in the visible page content only, swapped via JavaScript after page load.

### 3C: Seasonal Content Calendar Automation

Pest control demand is deeply seasonal in SWFL:

| Season | Peak Pests | Content Timing |
|--------|-----------|----------------|
| Feb–Mar | Termite swarm season | Publish termite content by mid-January |
| Apr–May | Ant season, early mosquitoes | Publish by mid-March |
| Jun–Aug | Peak mosquito, palmetto bugs, no-see-ums | Publish by mid-May |
| Sep–Oct | Rodent season begins (seeking shelter) | Publish by mid-August |
| Nov–Jan | Indoor infestations, rodents, German roaches | Publish by mid-October |

Your 157-post content calendar should map to this. Claude Code should:

1. Pull the content calendar from Google Sheets
2. Identify posts scheduled 30–45 days before each seasonal spike
3. Flag gaps where a pest type × location combination has no content
4. Generate drafts to fill gaps
5. Publish on schedule with full SEO metadata

### 3D: AI Search Optimization (GEO/AEO) — The New Frontier

This is the layer most pest control companies are completely ignoring. When someone asks ChatGPT or Perplexity "best pest control in Bradenton," you want to be cited.

**The Data:**
- About 40% of all search queries now trigger AI Overviews in Google
- For local business queries specifically, AI Overviews appear at a lower rate (~8%), but this is growing fast
- Pages with structured data (schema markup) are significantly more likely to appear in AI-generated answers

**What to Do:**

**1. Install an llms.txt generator** (LLMagnet or LovedByAI plugin)
- Auto-generates `/llms.txt` and `/llms-full.txt` at your site root
- Creates clean Markdown exports of your content that AI crawlers can parse
- Tracks which AI bots (ChatGPT, Claude, Perplexity, Gemini) are visiting your site

**2. Don't block AI crawlers**
- Check your robots.txt — make sure you're not blocking GPTBot, ClaudeBot, PerplexityBot, etc.
- Check NitroPack/Cloudflare settings — Cloudflare recently started blocking AI bots by default
- Check server logs for AI bot user agents

**3. Structure content for AI extraction**
- Lead every section with a direct answer before providing context
- Use clear H2/H3 heading hierarchies with one topic per section
- Include FAQ sections with question-based headings (these get pulled into AI answers)
- Use comparison tables where relevant
- Include entity-rich content: name specific pests, specific neighborhoods, specific treatment methods

**4. Build citation authority**
- The more your brand is mentioned across the web, the more AI tools will reference you
- Focus on local directories, industry citations, and backlinks from local sources
- Reviews drive entity recognition — your review velocity initiative directly feeds this

**5. Monitor AI visibility**
- Track which AI bots are crawling your site (LLMagnet dashboard)
- Periodically ask ChatGPT, Perplexity, and Claude "best pest control in Bradenton" and see if you appear
- Track changes over time as you implement these optimizations

---

## Part 4: Content Pipeline — Full Automation via Claude Code

Your existing blog pipeline (Sheets → AI Draft → DALL-E Image → WordPress → Social) is solid. Here's how to make it airtight with Claude Code managing the WordPress layer:

### The Enhanced Flow

```
1. Content Calendar (Google Sheets)
   ↓
2. Claude Code pulls next scheduled post
   ↓
3. Draft generation with brand voice system prompt
   ↓
4. DALL-E image generation
   ↓
5. Claude Code → WordPress MCP:
   a. Upload image to media library (wp_upload_media)
   b. Create post as draft (wp_create_post)
   c. Set featured image
   d. Set Rank Math SEO fields (focus keyword, meta desc, OG tags)
   e. Inject internal links based on keyword→URL map
   f. Set schema type (Article + FAQ if applicable)
   g. Add FAQ schema via Rank Math custom schema
   h. Set categories and tags
   ↓
6. Preview link generated → approval gate
   ↓
7. Claude Code publishes (wp_update_post status → publish)
   ↓
8. Cache purge (NitroPack API)
   ↓
9. Social distribution webhook
   ↓
10. Google Sheets status update
```

### Internal Linking Engine

Build a keyword→URL mapping table in your monorepo or Google Sheets:

| Keyword Phrase | Target URL | Anchor Text Variations |
|---------------|------------|----------------------|
| pest control bradenton | /pest-control-bradenton/ | "pest control in Bradenton", "Bradenton pest control services" |
| termite treatment | /termite-control/ | "termite treatment options", "professional termite control" |
| waveguard mosquito | /waveguard/ | "WaveGuard mosquito protection", "our mosquito program" |
| lawn care sarasota | /lawn-care-sarasota/ | "lawn care in Sarasota", "Sarasota lawn service" |

When Claude Code generates a post, it scans the content for these phrases and converts the first occurrence of each into an internal link. This replaces Internal Link Juicer entirely, and you control the mapping.

---

## Part 5: Technical SEO Automation

### Weekly Site Health Audit (Claude Code Script)

Set up a recurring Claude Code task or cron-triggered Express endpoint:

```
Run a weekly WordPress audit:
1. List all published posts/pages missing meta descriptions
2. List all images missing alt text
3. Check for broken internal links (404s)
4. Verify all service area pages have LocalBusiness schema
5. Check Core Web Vitals via PageSpeed Insights API
6. Verify XML sitemap includes all published pages
7. Check robots.txt isn't blocking important paths
8. Verify HTTPS on all pages (no mixed content)
9. Flag any posts older than 12 months that haven't been updated
10. Output report to Google Sheets or Slack
```

### Automated Redirects

When you rename or restructure pages, Claude Code can:
- Create 301 redirects via the Rank Math redirect manager REST API
- Update internal links across all posts that pointed to the old URL
- Verify the redirect works

### Image Optimization Pipeline

Before Claude Code uploads any image to WordPress:
1. Resize to max 1200px width
2. Convert to WebP
3. Compress (target <100KB for blog images)
4. Generate descriptive filename (e.g., `termite-damage-bradenton-home.webp`)
5. Set alt text, title, caption from context
6. Upload via WordPress media REST endpoint

This can run in your Express server or as a Claude Code pre-upload step.

---

## Part 6: Review Velocity → SEO Flywheel

Your review system in the portal is directly connected to SEO. Here's the flywheel:

```
Great Service
    ↓
Post-Service Review Request (your portal)
    ↓
Score ≥8 → Route to nearest GBP review link
    ↓
Google Reviews increase
    ↓
GBP ranking improves (reviews are #1 Map Pack factor)
    ↓
AI systems pick up review signals → better citation authority
    ↓
AggregateRating schema updates automatically
    ↓
Rich snippets in search results (stars)
    ↓
Higher CTR → more leads → more service → more reviews
```

Claude Code can automate the schema update: periodically query your GBP review data (via the Google Business Profile API or your portal's review database), update the `aggregateRating` in your LocalBusiness schema across all service area pages.

---

## Part 7: Multi-Domain Strategy + SEO

You operate city-specific pest control and exterminator domains across SWFL. Claude Code can manage all of these through WordPress Multisite or individual installs, each with their own MCP connection.

**For each satellite domain:**
- Ensure NAP matches the relevant GBP listing
- Implement `hreflang` if any content overlaps with the main site
- Set canonical URLs to prevent duplicate content issues
- Deploy identical schema markup patterns
- Monitor for content drift

**Claude Code multi-site management:**

Store credentials for all sites in a `wordpress-sites.json` file:

```json
{
  "sites": [
    {
      "name": "Waves Pest Control (Main)",
      "url": "https://wavespestcontrol.com",
      "api_url": "https://wavespestcontrol.com/wp-json",
      "username": "admin",
      "app_password": "xxxx-xxxx-xxxx-xxxx"
    },
    {
      "name": "GoWaves FL",
      "url": "https://gowavesfl.com",
      "api_url": "https://gowavesfl.com/wp-json",
      "username": "admin",
      "app_password": "yyyy-yyyy-yyyy-yyyy"
    }
  ]
}
```

Claude Code reads this file and can operate on any site by name.

---

## Part 8: Security Protocol

### Application Password Hygiene
- Rotate application passwords every 90 days
- Use a dedicated API user with only the capabilities needed (Editor role, not Administrator, for content operations)
- Keep `wordpress-sites.json` out of version control (add to `.gitignore`)
- Revoke immediately if any password is compromised

### Principle of Least Privilege
- Create a `waves-api` user with Editor role for content operations
- Create a separate `waves-admin-api` user with Administrator role for plugin management (use sparingly)
- Claude Code should default to the Editor-level user for routine operations

### Audit Trail
- All changes via the REST API are logged by WordPress
- Claude Code's CLAUDE.md should instruct it to always create posts as drafts first, never publish directly without an approval step
- Review the WordPress activity log weekly

---

## Part 9: The Implementation Roadmap

### Week 1: Foundation
- [ ] Install WordPress MCP Adapter on wavespestcontrol.com
- [ ] Generate application password for dedicated API user
- [ ] Connect Claude Code to WordPress via MCP
- [ ] Create CLAUDE.md with site-specific context
- [ ] Test basic operations: create draft post, upload media, read plugins

### Week 2: SEO Infrastructure
- [ ] Install LLMagnet or LovedByAI for llms.txt generation
- [ ] Audit robots.txt for AI crawler blocking
- [ ] Build keyword→URL mapping table
- [ ] Create custom `waves-functions` plugin for JSON-LD schema injection
- [ ] Migrate Code Snippets content to the new plugin

### Week 3: Content Pipeline Integration
- [ ] Connect blog content pipeline to WordPress MCP (replace direct REST API calls)
- [ ] Add Rank Math SEO field automation to publishing flow
- [ ] Build internal linking engine using keyword→URL map
- [ ] Test end-to-end: Sheets → Draft → SEO → Preview → Publish

### Week 4: Local SEO Build-Out
- [ ] Generate first batch of Service × Location pages (start with pest control across all 4 zones)
- [ ] Deploy LocalBusiness + Service + FAQ schema on all location pages
- [ ] Verify NAP consistency across all pages and GBP listings
- [ ] Set up AggregateRating schema auto-update from review data

### Week 5: Automation & Monitoring
- [ ] Set up weekly site health audit script
- [ ] Configure image optimization pipeline
- [ ] Remove deprecated plugins (Code Snippets, Internal Link Juicer, Auto Image Attributes, Better Search Replace, Feedzy RSS)
- [ ] Build AI visibility monitoring dashboard (track AI bot crawls)

### Week 6: Expansion
- [ ] Connect additional domains to Claude Code via MCP
- [ ] Begin seasonal content gap analysis
- [ ] Deploy remaining Service × Location pages
- [ ] Set up review velocity → schema update automation

---

## Part 10: The Competitive Moat

Here's what this protocol gives you that 99% of pest control companies in SWFL don't have:

1. **Programmatic local SEO** — 24+ unique service area pages with real local content, not template garbage
2. **AI search visibility** — llms.txt, structured schema, FAQ sections that get cited in AI answers
3. **Zero-touch content publishing** — from content calendar to live post with full SEO, no manual clicking
4. **Review-driven SEO flywheel** — reviews automatically update schema, schema improves rankings, rankings drive more leads
5. **Multi-location schema authority** — separate LocalBusiness blocks for each GBP, with accurate NAP and AggregateRating
6. **Seasonal content timing** — content published 30-45 days before demand spikes, every time
7. **AI-managed WordPress** — plugin updates, content audits, technical SEO fixes, all through Claude Code without touching wp-admin

The companies paying $3,000-5,000/month to SEO agencies are getting maybe 40% of what this system delivers. And you own it.
