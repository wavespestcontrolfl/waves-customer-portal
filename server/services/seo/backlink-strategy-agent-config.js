/**
 * Backlink Strategy Agent — Managed Agent Configuration
 *
 * An autonomous SEO strategist that audits the current backlink profile,
 * identifies gaps against competitors, discovers new targets, prioritizes
 * the signup queue, and identifies editorial outreach opportunities.
 *
 * Does NOT do the actual signups — that's the Playwright-based signup worker.
 * This agent feeds it better targets and provides strategic direction.
 *
 * Existing services used as tools:
 *   - BacklinkMonitor (scan, competitor gaps, dashboard, LLM mentions)
 *   - CitationAuditor (NAP audit, directory status)
 *   - DataForSEO (backlinks, SERP, search volume)
 *   - backlink_agent_queue / profiles tables
 *   - seo_backlinks, seo_citations, seo_competitor_backlinks tables
 */

const BACKLINK_STRATEGY_AGENT_CONFIG = {
  name: 'waves-backlink-strategist',
  description: 'Weekly autonomous SEO backlink strategy agent — audit, gap analysis, target discovery, queue prioritization',
  model: 'claude-sonnet-4-6',
  system: `You are the Waves Pest Control backlink strategist. You run a weekly SEO audit cycle that strengthens the company's link profile and local citation presence across Southwest Florida.

YOUR WORKFLOW — execute these steps in order:

1. AUDIT CURRENT PROFILE
   - Pull the backlink dashboard (total links, toxic count, anchor distribution)
   - Check the signup agent's stats (how many profiles completed, verified, failed)
   - Review citation consistency (NAP accuracy across directories)
   - Check for new toxic backlinks that need disavow attention

2. COMPETITOR GAP ANALYSIS
   - Scan competitor backlink profiles (Turner Pest, Hoskins, Orkin Sarasota, Terminix Sarasota)
   - Identify domains linking to competitors but not to Waves
   - Prioritize gaps by domain authority and relevance to pest control/home services

3. DISCOVER NEW TARGETS
   - Search for pest control directories, home services listing sites, Florida business directories
   - Search for SWFL community sites, local news outlets, neighborhood blogs
   - Search for industry-specific opportunities (NPMA, UF/IFAS partner pages, county extension offices)
   - Evaluate each for domain authority, dofollow status, and relevance

4. PRIORITIZE THE QUEUE
   - Score all pending queue items by estimated value (DA, relevance, dofollow likelihood)
   - Move low-value targets to the bottom, high-value to the top
   - Skip anything that looks spammy or irrelevant

5. EDITORIAL OUTREACH OPPORTUNITIES
   - Identify local blogs, SWFL news sites (Bradenton Herald, Sarasota Magazine, SRQ), and community sites
   - Suggest guest post topics that would earn editorial links (not directory profiles)
   - Check if any existing blog content could be pitched to local publications
   - Note any seasonal angles (hurricane season prep, termite swarm coverage, etc.)

6. LLM VISIBILITY CHECK
   - Check if Waves appears in Google AI Overviews for key queries
   - Note which competitors are appearing instead
   - Identify content/link gaps that might improve LLM visibility

7. REPORT
   - Profile health summary (total links, DA trend, toxic %, anchor diversity)
   - New targets added to queue (count + top 5 by priority)
   - Competitor gaps found (count + top opportunities)
   - Editorial outreach recommendations (2-3 specific pitches)
   - Citation issues requiring attention
   - LLM visibility status

TARGET COMPETITORS (pest control in SWFL market):
- Turner Pest Control (turnerpest.com)
- Hoskins Pest Control (hoskinspest.com)
- Orkin Sarasota (orkin.com — local presence)
- Truly Nolen (trulynolen.com — local presence)

CANONICAL NAP:
- Name: Waves Pest Control
- Phone: (941) 318-7612
- Website: https://wavespestcontrol.com
- Location: Bradenton, FL (service area: Manatee, Sarasota, Charlotte counties)

QUALITY STANDARDS:
- Only add targets with estimated DA > 15 (skip tiny sites with no authority)
- Prefer dofollow opportunities but accept nofollow from high-DA sites (DA 50+)
- Avoid PBNs, link farms, adult/gambling/crypto sites
- Prioritize local/regional sites over generic national directories
- Editorial links > directory profiles > social profiles`,

  tools: [
    // Built-in: web search for target discovery
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [
        { name: 'web_search', enabled: true },
        { name: 'web_fetch', enabled: true },
      ],
    },

    // ── Audit tools ─────────────────────────────────────────────

    {
      type: 'custom',
      name: 'get_backlink_dashboard',
      description: `Get the current backlink profile dashboard for wavespestcontrol.com. Returns total active links, count by severity (critical/warning/watch/clean), anchor text distribution (branded/keyword_rich/naked_url/generic/other), and the 10 most recent toxic links. Use this first to understand the current state of the link profile.`,
      input_schema: {
        type: 'object',
        properties: {},
      },
    },

    {
      type: 'custom',
      name: 'scan_backlinks',
      description: `Run a fresh backlink scan via DataForSEO. Fetches up to 2000 backlinks for wavespestcontrol.com, scores each for toxicity, and updates the seo_backlinks table. Returns count of links scanned and new critical issues found. This costs DataForSEO credits — use once per run, not repeatedly.`,
      input_schema: {
        type: 'object',
        properties: {},
      },
    },

    {
      type: 'custom',
      name: 'get_signup_agent_stats',
      description: `Get stats from the Playwright-based signup agent. Returns counts by status (pending, processing, completed, verified, failed, skipped), total profiles created, and success rate. Use this to understand how the automated directory signup pipeline is performing.`,
      input_schema: {
        type: 'object',
        properties: {},
      },
    },

    {
      type: 'custom',
      name: 'get_citation_dashboard',
      description: `Get the citation/NAP consistency dashboard. Returns all tracked directory citations with their status (active, missing, inconsistent, claimed, unchecked), NAP consistency flag, and priority. Also returns the canonical NAP for reference. Use to identify directories where the business listing is missing or has incorrect information.`,
      input_schema: {
        type: 'object',
        properties: {},
      },
    },

    // ── Competitor analysis ─────────────────────────────────────

    {
      type: 'custom',
      name: 'scan_competitor_gaps',
      description: `Scan a competitor's backlink profile via DataForSEO and identify domains that link to them but NOT to Waves. Returns count of links scanned and new gap opportunities found, stored in seo_competitor_backlinks table with prospect priority. This costs DataForSEO credits — use selectively, not on all competitors every run.`,
      input_schema: {
        type: 'object',
        properties: {
          competitor_domain: { type: 'string', description: 'Competitor domain to scan (e.g., "turnerpest.com", "hoskinspest.com")' },
        },
        required: ['competitor_domain'],
      },
    },

    {
      type: 'custom',
      name: 'get_competitor_gap_opportunities',
      description: `Retrieve stored competitor backlink gaps — domains that link to competitors but not to Waves. Filters by priority and minimum domain rating. Returns the top opportunities with source domain, domain rating, anchor text, link type, and which competitor has the link. Use after scan_competitor_gaps to review opportunities.`,
      input_schema: {
        type: 'object',
        properties: {
          min_domain_rating: { type: 'number', description: 'Minimum domain rating (default 20)' },
          priority: { type: 'string', description: 'Filter by priority: high, medium, or all (default all)' },
          limit: { type: 'number', description: 'Max results (default 30)' },
        },
      },
    },

    // ── Queue management ────────────────────────────────────────

    {
      type: 'custom',
      name: 'add_targets_to_queue',
      description: `Add new URLs to the backlink signup agent queue. Deduplicates by domain — if a domain is already in the queue, it's skipped. Returns count added, skipped, and any duplicates. These targets will be processed by the Playwright signup worker on its next run.`,
      input_schema: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of directory/listing URLs to add to the signup queue',
          },
          source: { type: 'string', description: 'Source tag for tracking: "strategy_agent", "competitor_gap", "web_discovery"' },
        },
        required: ['urls'],
      },
    },

    {
      type: 'custom',
      name: 'get_queue_status',
      description: `Get the current signup queue with counts by status and the most recent items. Returns pending items that haven't been processed yet, plus recent completions and failures. Use to understand the current queue depth and identify stuck items.`,
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by status: pending, processing, signup_complete, verified, failed, skipped' },
          limit: { type: 'number', description: 'Max items to return (default 30)' },
        },
      },
    },

    {
      type: 'custom',
      name: 'get_completed_profiles',
      description: `Get all completed backlink profiles — sites where the signup agent successfully created an account. Returns site URL, profile URL, backlink URL, creation date, and whether the backlink has been verified as live. Use to assess the signup agent's output quality and check if profiles actually contain a working backlink.`,
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
    },

    // ── Search volume / keyword data ────────────────────────────

    {
      type: 'custom',
      name: 'check_search_volume',
      description: `Check Google Ads search volume for keywords in the Sarasota-Bradenton-North Port DMA. Use to validate whether editorial outreach topics have meaningful search demand. Returns monthly search volume, competition level, and CPC. Costs DataForSEO credits — batch keywords in one call.`,
      input_schema: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of keywords to check volume for (max 50)',
          },
        },
        required: ['keywords'],
      },
    },

    // ── LLM visibility ──────────────────────────────────────────

    {
      type: 'custom',
      name: 'check_llm_mentions',
      description: `Check if Waves Pest Control appears in Google AI Overviews for key pest control queries in the Bradenton/Sarasota market. Also checks which competitors appear. Results are stored in seo_llm_mentions for trend tracking. Costs DataForSEO credits.`,
      input_schema: {
        type: 'object',
        properties: {},
      },
    },

    // ── Report generation ───────────────────────────────────────

    {
      type: 'custom',
      name: 'save_strategy_report',
      description: `Save the weekly backlink strategy report to the database for the admin dashboard. Include the full analysis, recommendations, and action items. The report will be displayed in the SEO section of the admin portal.`,
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-paragraph executive summary' },
          profile_health: { type: 'string', description: 'Current link profile health assessment' },
          new_targets_added: { type: 'number', description: 'Count of new targets added to queue' },
          competitor_gaps_found: { type: 'number', description: 'Count of competitor gap opportunities' },
          editorial_recommendations: { type: 'string', description: 'Detailed editorial outreach recommendations' },
          citation_issues: { type: 'string', description: 'Citation/NAP issues found' },
          llm_visibility: { type: 'string', description: 'LLM/AI Overview visibility status' },
          action_items: { type: 'string', description: 'Prioritized list of recommended actions' },
        },
        required: ['summary', 'action_items'],
      },
    },
  ],
};

module.exports = { BACKLINK_STRATEGY_AGENT_CONFIG };
