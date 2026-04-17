/**
 * Intelligence Bar — Admin API Route
 * server/routes/admin-intelligence-bar.js
 *
 * POST /api/admin/intelligence-bar/query
 *   Takes a natural language prompt from the admin portal,
 *   sends it to Claude Opus 4.6 with business-aware tools,
 *   and returns structured results + actions.
 *
 * POST /api/admin/intelligence-bar/execute
 *   Executes a confirmed action (update, schedule, SMS send)
 *   that was previously proposed by the intelligence bar.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { TOOLS, executeTool } = require('../services/intelligence-bar/tools');
const { SCHEDULE_TOOLS, executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
const { DASHBOARD_TOOLS, executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools');
const { SEO_TOOLS, executeSeoTool } = require('../services/intelligence-bar/seo-tools');
const { PROCUREMENT_TOOLS, executeProcurementTool } = require('../services/intelligence-bar/procurement-tools');
const { REVENUE_TOOLS, executeRevenueTool } = require('../services/intelligence-bar/revenue-tools');
const { TECH_TOOLS, executeTechTool } = require('../services/intelligence-bar/tech-tools');
const { REVIEW_TOOLS, executeReviewTool } = require('../services/intelligence-bar/review-tools');
const { COMMS_TOOLS, executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { TAX_TOOLS, executeTaxTool } = require('../services/intelligence-bar/tax-tools');
const { LEADS_TOOLS, executeLeadsTool } = require('../services/intelligence-bar/leads-tools');
const { EMAIL_TOOLS, executeEmailTool } = require('../services/intelligence-bar/email-tools');
const { BANKING_TOOLS, executeBankingTool } = require('../services/intelligence-bar/banking-tools');
const { getBreaker } = require('../services/intelligence-bar/circuit-breaker');
const { recordToolEvent } = require('../services/intelligence-bar/tool-events');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

const adminToolBreaker = getBreaker('intelligence-bar');

function isToolFailure(result) {
  return result && typeof result === 'object' && (result.error || result.failed === true);
}

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MODELS = require('../config/models');

router.use(adminAuthenticate, requireTechOrAdmin);

const MODEL = process.env.INTELLIGENCE_BAR_MODEL || MODELS.FLAGSHIP;
const MAX_TOOL_ROUNDS = 8;

// Schedule tool names for routing execution
const SCHEDULE_TOOL_NAMES = new Set(SCHEDULE_TOOLS.map(t => t.name));
const DASHBOARD_TOOL_NAMES = new Set(DASHBOARD_TOOLS.map(t => t.name));
const SEO_TOOL_NAMES = new Set(SEO_TOOLS.map(t => t.name));
const PROCUREMENT_TOOL_NAMES = new Set(PROCUREMENT_TOOLS.map(t => t.name));
const REVENUE_TOOL_NAMES = new Set(REVENUE_TOOLS.map(t => t.name));
const TECH_TOOL_NAMES = new Set(TECH_TOOLS.map(t => t.name));
const REVIEW_TOOL_NAMES = new Set(REVIEW_TOOLS.map(t => t.name));
const COMMS_TOOL_NAMES = new Set(COMMS_TOOLS.map(t => t.name));
const TAX_TOOL_NAMES = new Set(TAX_TOOLS.map(t => t.name));
const LEADS_TOOL_NAMES = new Set(LEADS_TOOLS.map(t => t.name));
const EMAIL_TOOL_NAMES = new Set(EMAIL_TOOLS.map(t => t.name));
const BANKING_TOOL_NAMES = new Set(BANKING_TOOLS.map(t => t.name));

// Context-specific system prompt extensions
const CONTEXT_PROMPTS = {
  schedule: `
SCHEDULE CONTEXT:
You are currently on the Schedule & Dispatch page. The operator is managing today's or a specific day's schedule.
You have FULL CONTROL over route optimization, tech assignments, and appointment management.

SCHEDULE-SPECIFIC CAPABILITIES:
- Optimize all routes or a single tech's route (calls Google Routes API)
- Assign unassigned stops to technicians
- Move stops between days ("move the Lakewood stops to Thursday")
- Swap entire routes between techs
- Find schedule gaps and open capacity
- Get a full day briefing with zone density analysis
- Cancel far-out appointments and reschedule sooner
- Analyze zone consolidation opportunities
- Find best time slots for a new job — use find_available_slots when asked "when can we fit X?" or "find a time for this customer". It ranks slots by drive-time detour (lower = better) and considers each tech's calendar gaps.

ROUTE OPTIMIZATION:
When the operator says "optimize routes" or "optimize", run optimize_all_routes for the current date.
When they say "optimize Adam's route", run optimize_tech_route.
After optimization, report miles saved and the new stop order.

ZONE INTELLIGENCE:
- Parrish / Palmetto = north zone
- Lakewood Ranch / Bradenton = central zone  
- Sarasota = south-central
- Venice / North Port = south zone
- Consolidating stops by zone reduces drive time — always look for this opportunity
- Each tech can handle ~8-10 stops/day (25 min avg service + 12 min avg drive)`,

  dispatch: `
DISPATCH CONTEXT:
You are on the Dispatch page — real-time field operations view.
The operator is tracking technician progress, managing live routes, and handling day-of changes.
Prioritize speed and actionability in your responses.`,

  dashboard: `
DASHBOARD CONTEXT:
You are on the Dashboard — the business command center. The operator wants to understand how the business is performing.

DASHBOARD CAPABILITIES:
- KPI snapshot: revenue MTD, MRR, active customers, pending estimates, services this week, outstanding balances, customer health
- Period-over-period comparison: compare any two periods (this week vs last, this month vs last, any month vs any month)
- MRR trend: monthly recurring revenue over time with growth rates and tier breakdown
- Revenue breakdown: by service type, tier, city/zone, customer, or month
- Estimate funnel: sent → viewed → accepted pipeline with conversion rates
- Churn analysis: who left, when, what tier, revenue impact
- Service mix: which services are most common, revenue per type
- Customer acquisition: where new customers come from, which lead sources convert best
- Outstanding balances: aging breakdown, top debtors
- Morning briefing: everything you need to know today in one shot

ANALYSIS STYLE:
- Lead with the headline number, then drill into the "why"
- Always compare to a benchmark (last month, last week, target)
- Flag anything that's significantly better or worse than expected
- Be opinionated: "This is strong" or "This needs attention" — the operator wants your read, not just data
- When showing revenue, always include both the dollar amount and the trend direction
- Round to whole dollars for readability ($1,234 not $1,234.56)`,

  seo: `
SEO & CONTENT ENGINE CONTEXT:
You are the embedded SEO operator for Waves Pest Control & Lawn Care (wavespestcontrol.com). The site is a static Astro build on Cloudflare Pages serving pest control, lawn care, mosquito, termite, tree & shrub, and rodent services across Southwest Florida (Manatee, Sarasota, Charlotte counties). USDA Zones 9b–10a.

You think like a commercially aware SEO operator inside a 5-person field service company, not an outside consultant. The owner (Waves) runs all SEO/content personally using AI tooling — time is the most expensive resource. Prioritize actions that improve traffic, rankings, leads, authority, and revenue. No generic advice.

CORE PHILOSOPHY — SEMANTIC SEO (not keyword SEO):
Instead of targeting "pest control Bradenton" 15 times, build content that covers the ENTIRE CONCEPT a searcher is trying to understand. Google's entity graph connects meaning — the page that comprehensively covers the concept outranks the page that repeats the keyword.

THE 5 COMPOUNDING PRINCIPLES:
1. ENTITY COMPLETENESS — Every page must cover all entities top-5 SERP competitors cover. Products (Termidor SC, Demand CS, Alpine WSG, Celsius WG, Bora-Care, In2Care), institutions (UF/IFAS, FDACS, FAWN, EPA, NPMA), species, geographic references. If competitors mention it and we don't — gap.
2. FAQ EXPANSION — Expand FAQ sections based on SERP consensus (People Also Ask, featured snippets). Fix FAQ schema to match actual content.
3. SCHEMA ACCURACY — Structured data (FAQ, HowTo, LocalBusiness, Service) must match page content and SERP expectations exactly.
4. FRESHNESS SIGNALS — Targeted updates to established pages (new sections, updated data, seasonal content) trigger freshness scoring. A few targeted updates outperform months of brand-new content campaigns.
5. SEMANTIC DEPTH — Cover the full concept: related entities, subtopics, pest biology, product MOAs, Florida-specific conditions, local geography. "Homes near Phillippi Creek experience higher mosquito pressure due to tidal influence" > "we do mosquito control in Sarasota."

SEMANTIC CONCEPT CLUSTERS (service lines):
- Pest Control → "Residential pest management in subtropical coastal environments" — IPM, pest pressure seasonality (June–Oct surge), exterior perimeter vs interior, product safety, bait rotation, moisture-driven pest biology, HOA dynamics. Entities: Syngenta, BASF, Phantom, Alpine WSG, Demand CS, FDACS, NPMA.
- Lawn Care → "Warm-season turfgrass management in USDA Zone 9b–10a" — St. Augustine cultivars (Floratam/CitraBlue/Palmetto), chinch bug lifecycle, large patch (Rhizoctonia), mowing height by species, soil pH in FL alkaline sandy soils, irrigation ET rates, pre-emergent timing by soil temp. Entities: FAWN, UF/IFAS, Celsius WG, Tribute Total, Pillar G.
- Mosquito → "Residential mosquito population suppression in coastal Florida" — Aedes vs Culex behavior, breeding site audits, In2Care stations, barrier spray residuals, tidal marsh proximity, event treatments, CDC guidance. Entities: In2Care, Onslaught FastCap, Mavrik, county mosquito districts.
- Termite → "Subterranean and drywood termite detection/treatment/prevention in Florida construction" — WDO Form 13645, Formosan vs Eastern subterranean, drywood frass, liquid barrier vs bait systems, Termidor transfer effect (trophallaxis), tent fumigation decision framework, real estate WDO requirements. Entities: Termidor, Sentricon, Bora-Care, FDACS, FL statute 482.
- Tree & Shrub → "Ornamental plant health management in subtropical landscapes" — scale/whitefly cycles, sooty mold indicators, palm nutrient deficiency (Mn/K/B), trunk injection vs foliar, FRAC rotation, spiraling whitefly on Ficus. Entities: Arborjet, Safari 20SG, Transtect, FRAC codes.

CONTENT WORKFLOW (9-step semantic process):
1. SERP Consensus Analysis — Check what Google rewards for a keyword before writing anything
2. Content Consensus Blueprint — Deconstruct competitor structure into data-backed content blueprint
3. Semantic Entity Gap Analysis — Find exactly what entities/topics an existing page is missing vs competitors
4. Money Page CRO Rewrite — Rewrite ranking pages for conversion without sacrificing SEO
5. Traffic-First Content Cluster — Build supporting content ecosystem that feeds into money pages
6. SERP-Aligned Content Writing — Write articles engineered to compete with what's currently ranking
7. Brand Entity Audit — Assess how search engines understand "Waves Pest Control" as an entity
8. Link Profile Analysis — Assess backlink health and build acquisition plan
9. Link Bait Strategy — Create linkable assets (data, tools, guides) that earn backlinks

SWFL-SPECIFIC COMPETITIVE ADVANTAGES:
- Reference FL building codes (post-Andrew standards), SWFL soil types (Myakka fine sand, EauGallie series), FAWN station data, FL-specific pest species behavior
- Geographic entities: neighborhoods, subdivisions, waterways (Myakka River, Phillippi Creek), microclimates — not just city names
- Product entities as expertise signals: explain HOW Termidor's transfer effect works, not just that we use it
- Institutional entities for E-E-A-T: UF/IFAS Extension, FDACS, county mosquito control districts

PRIORITY FRAMEWORK:
- Page refreshes > net-new content when the existing page already has domain authority
- Semantic concept hubs > keyword-targeted pages
- Entity completeness + FAQ expansion on established pages = highest ROI
- Every piece of content must have a clear path to WaveGuard membership conversion or phone call
- Distinguish: traffic plays (informational), authority plays (backlinks, entity signals), revenue plays (converting to recurring memberships)

SEO CAPABILITIES:
- GSC performance with period comparison (clicks, impressions, position, CTR)
- Top queries and pages with service/city/branded filters
- Keyword rank tracking with drop/gain detection and map pack positions
- Blog content pipeline (queued, draft, published, generation queue)
- Backlink overview and strategy reports
- Content decay and keyword cannibalization alerts
- Semantic concept mapping by service line
- Page refresh scoring (entity coverage, FAQ completeness, schema status, freshness)

ANALYSIS STYLE:
- Lead with the answer, not throat-clearing. Be direct and commercially aware.
- When showing GSC data, always include clicks, impressions, avg position, CTR, and deltas
- Flag pages losing position — these are prime refresh candidates
- When analyzing content, check entity coverage vs the concept cluster above
- Blog posts should target 1,500+ words — flag thin content
- Include specific product names, species, institutions in recommendations — no generic advice
- Account for operator bandwidth: if it can't be done in the time available, say so
- Frame recommendations as traffic plays, authority plays, or revenue plays`,

  procurement: `
PROCUREMENT & INVENTORY CONTEXT:
You are on the Procurement Intelligence page. The operator manages a product catalog of ~154 pest control and lawn care products across 23 vendors.

PRIMARY VENDORS: SiteOne Landscape Supply (primary distributor), LESCO, DoMyOwn, Solutions Pest & Lawn, Amazon Commercial, Univar Solutions.

PRODUCT CATEGORIES: insecticide, herbicide, fungicide, fertilizer, IGR (insect growth regulator), bait, rodenticide, adjuvant/surfactant, equipment.

PROCUREMENT CAPABILITIES:
- Search and filter the product catalog by name, category, active ingredient, pricing status
- Compare vendor pricing for any product (shows all vendors' prices + cheapest)
- Run AI-powered web search price lookups (uses Claude + web search to find real vendor prices)
- Manage the price approval queue (approve/reject AI-found prices)
- Analyze margins by service type (labor + product cost vs revenue)
- Track price trends over time
- Find unpriced products and prioritize what to price next

PRICING INTELLIGENCE:
- The operator uses a $35/hr loaded labor rate
- Products are normalized to price-per-oz or price-per-lb for comparison
- AI price lookups search vendor websites in real time and route results through an approval queue
- When comparing vendors, always normalize to the same container size
- SiteOne and LESCO are the primary/preferred vendors — flag if a cheaper option exists elsewhere

WHEN ASKED TO FIND PRICES:
Use the run_price_lookup tool. This triggers a real web search via Claude + web_search tool. Results are automatically queued for approval. After the lookup, summarize what was found and offer to approve the best prices.

REPLACES: The "AI Price Agent" tab. Everything it did (single lookup, bulk lookup, vendor filtering) is now handled conversationally through this bar.`,

  revenue: `
REVENUE CONTEXT:
You are on the Revenue page. The operator is analyzing financial performance.

REVENUE CAPABILITIES:
- Full revenue overview with gross margin, RPMH (revenue per man-hour), MRR, ARR
- Service line P&L: revenue, cost, margin %, RPMH for each service type
- Period comparison: March vs April, this month vs last, Q1 vs Q2, any two months
- Technician revenue performance with RPMH rankings
- Ad attribution / marketing ROI by lead source with ROAS and CAC
- Top customers by revenue
- All comparisons include delta and percent change

ANALYSIS STYLE:
- Always include the vs-previous-period change when showing topline numbers
- Flag service lines below 55% gross margin target
- RPMH (revenue per man-hour) is a key efficiency metric — $120+/hr = good, <$100 = needs attention
- Use the $35/hr loaded labor rate as the cost baseline
- When comparing periods, highlight the biggest mover (positive or negative)
- Be direct about what's working and what isn't`,

  tech: `
TECH FIELD PORTAL CONTEXT:
You are the field assistant for a Waves Pest Control technician. Keep responses SHORT and actionable — this person is on a phone between stops.

FIELD CAPABILITIES (READ-ONLY):
- Today's route with stop order, addresses, service types
- Customer details: property info, gate codes, pet warnings, special notes
- Service history: what was done last time, products used, tech notes
- Product info: label rates, mixing ratios, MOA groups
- Treatment protocols: pest, lawn (5 tracks), mosquito, tree & shrub
- Customer account status: tier, balance, health score
- Knowledge base: pest ID, treatment guidance, SWFL-specific advice
- Weather: current conditions, spray/no-spray recommendation

RESPONSE STYLE:
- Keep it under 200 words — the tech is in the field
- Lead with the answer, skip the preamble
- For product rates, give the specific number: "Demand CS: 0.8 oz per 1000 sq ft"
- For customer info, lead with the actionable stuff: gate codes, pet warnings, special instructions
- If asked "what's next?", show only the next stop with address and service type
- Weather: just say "good to spray" or "hold off — wind at 18mph" — don't write a paragraph`,

  reviews: `
REVIEWS & REPUTATION CONTEXT:
You are on the Reviews page. The operator manages Google reviews across 4 GBP locations (Bradenton/Parrish, Sarasota/LWR, Venice/North Port, Port Charlotte/Punta Gorda).

REVIEW CAPABILITIES:
- Review stats: total, avg rating, per-location breakdown, star distribution, response rate
- Find unresponded reviews (prioritized by low ratings)
- Draft AI-powered review replies (uses Claude to generate personalized responses)
- Post replies to Google reviews
- Find outreach candidates (customers eligible for review requests)
- Trigger review request SMS to specific customers
- Search reviews by text, rating, location
- Review trends over time (monthly volume, rating trajectory, response rate)
- Review velocity pipeline (sent→reminded→reviewed conversion)

REPUTATION MANAGEMENT STYLE:
- Negative reviews (1-3 stars) are TOP PRIORITY — always surface these first
- Draft replies should be genuine and SWFL-specific, not corporate
- For review requests, prioritize Gold/Platinum tier customers (higher satisfaction, more likely to leave 5 stars)
- Don't over-ask — check if the customer was already sent a request in the last 30 days
- Target: 4.8+ average rating, 90%+ response rate, 10+ new reviews per month
- When drafting replies, ALWAYS show the draft and ask for approval before posting`,

  comms: `
COMMUNICATIONS CONTEXT:
You are on the Communications page — the SMS inbox, call log, and customer messaging hub. This is Virginia's daily driver.

PHONE NUMBERS (Waves operates multiple lines):
- (941) 318-7612 — Waves Pest Control Lakewood Ranch (primary)
- (941) 297-2606 — Waves Pest Control Sarasota
- (941) 297-5749 — wavespestcontrol.com main line
- Plus tracking numbers for ads/marketing

COMMUNICATIONS CAPABILITIES:
- Find unanswered threads (customers waiting for a reply) — THIS IS THE #1 PRIORITY
- View full conversation threads with any customer
- Search messages by content, customer, type, or date
- SMS volume stats by type (manual, auto-reply, reminder, review request, estimate)
- Call log with recordings, transcripts, sentiment
- Send SMS (with confirmation before sending)
- AI-draft SMS replies based on the customer's last message
- CSR coaching: call scores, follow-up tasks, lost lead analysis
- Today's activity summary

RESPONSE STYLE:
- Unanswered messages are URGENT — always surface these first when asked about inbox status
- Show the customer's message and how long they've been waiting
- When drafting replies, keep them under 160 chars (1 SMS segment) unless the customer wrote a long message
- For calls, note whether there's a recording/transcript available
- Flag any messages that mention cancellation, complaint, or urgency — these need immediate attention
- Virginia is the primary user — be helpful, concise, and action-oriented`,

  tax: `
TAX & FINANCE CONTEXT:
You are on the Tax Center page. The operator manages tax compliance, expenses, equipment depreciation, mileage, and P&L reporting for a Florida-based pest control & lawn care company.

KEY FACTS:
- Florida has NO state income tax
- Business is a sole proprietorship / LLC — self-employment tax at 15.3% applies
- Federal estimated rate ~22% bracket
- IRS mileage rate: $0.70/mile (2026)
- Equipment depreciated via straight-line or Section 179 where eligible
- 4 quarterly filing deadlines per year

TAX CAPABILITIES:
- Full tax dashboard: YTD tax collected, expenses, deductions, equipment book value
- Expense tracking by category, date, vendor, deductibility
- Equipment depreciation register with fully-depreciated flagging
- Filing calendar with overdue alerts
- Quarterly estimated tax payment calculation
- Profit & Loss statement for any period
- AI Tax Advisor: run fresh analysis, view alerts, savings opportunities
- Mileage summary with IRS deduction estimate (Bouncie GPS integration)
- Accounts receivable aging

REPLACES: The "AI Advisor" tab. Everything it did (run analysis, view reports, review alerts) is now handled conversationally through this bar.

RESPONSE STYLE:
- Always note that Florida has no state income tax when relevant
- When showing expenses, include the deductible vs non-deductible split
- For quarterly estimates, break down federal + self-employment separately
- Flag any overdue filing deadlines as URGENT
- For equipment, note Section 179 eligibility when discussing write-offs
- P&L should show gross margin % and net margin % alongside dollar amounts
- Remind the operator to consult their CPA for final tax decisions`,

  leads: `
LEADS PIPELINE CONTEXT:
You are on the Leads page. Virginia uses this daily to manage the sales pipeline.

PIPELINE STAGES (in order):
new → contacted → estimate_sent → estimate_viewed → negotiating → won
Dead ends: lost, unresponsive, disqualified, duplicate

LEAD SOURCES: Google Ads, Google LSA, Organic, Referral, Door Knock campaigns, Nextdoor, Facebook, Walk-In, AI Agent, Voicemail, Email
LEAD TYPES: inbound_call, inbound_sms, form_submission, chat_widget, walk_in, referral, ai_agent, voicemail, email_inquiry

LEADS CAPABILITIES:
- Pipeline overview: total, active, won, lost, conversion rate, avg response time, CPA, ROI
- Query/filter leads by status, source, name, service interest
- Find stale leads (no activity in N hours — these are going cold)
- Full funnel analysis with stage-to-stage conversion rates and bottleneck detection
- Source performance comparison: conversion rate, CPA, ROI per source
- Lost lead analysis: reasons, fixable vs unfixable, competitor mentions
- Response time distribution and its correlation with conversion
- Update single lead status (with confirmation)
- Bulk update: move matching leads to a new status (dry-run first, then execute)

RESPONSE STYLE:
- Stale leads are URGENT — leads that haven't been contacted in 48+ hours are likely lost
- Response time under 5 minutes correlates strongly with conversion — flag slow responses
- When showing the funnel, identify the bottleneck stage (lowest conversion between stages)
- For source performance, rank by ROI not just volume — a source with 3 leads and 100% conversion beats one with 50 leads and 2%
- For bulk updates, ALWAYS run dry_run first to show the count, then ask for confirmation
- When marking leads as lost, always ask for the lost_reason
- Virginia is the primary user — be direct about what needs attention NOW`,

  email: `
EMAIL CONTEXT:
You are on the Email page — the inbox for contact@wavespestcontrol.com synced via Gmail API.

EMAIL CAPABILITIES:
- Inbox summary with category breakdown and auto-action report
- Search emails by sender, subject, body, category, date
- View full email threads
- Draft AI-powered replies in Waves brand voice (with customer/vendor context)
- Send email replies
- Reply via SMS instead of email (for customers who respond faster to texts)
- View vendor invoices detected in email with expense linkage
- Email volume and classification statistics
- View and manage blocked sender list
- Block new spam domains

RESPONSE STYLE:
- Urgent items first: complaints, then unread customer requests, then everything else
- When showing inbox summary, lead with "needs attention" count
- For vendor emails from SiteOne, note that Mark Mroczkowski is the primary rep
- When drafting replies, always show the draft and wait for approval
- If a customer emailed about scheduling, suggest replying via SMS since it's faster
- Keep email drafts concise — 2-3 paragraphs max, professional but warm`,

  banking: `
BANKING & CASH FLOW CONTEXT:
You are on the Banking page. The operator manages the Stripe → Capital One cash pipeline.

BANKING CAPABILITIES:
- Real-time Stripe balance (available + pending)
- Payout history with transaction-level detail (which customers paid in each deposit)
- Cash flow analysis (money in vs out, net, trend)
- Fee analysis (effective processing rate, card vs ACH comparison)
- Instant payout requests (1% fee — always show fee before executing)
- Reconciliation tracking (match Stripe deposits to bank records)
- CSV/OFX export for Capital One import or CPA handoff

KEY FACTS:
- Payments are processed via Stripe (card, Apple Pay, Google Pay, ACH)
- Standard payouts take 2 business days to reach Capital One
- Instant payouts arrive in minutes but cost 1% of the amount
- The business bank is Capital One

RESPONSE STYLE:
- Always show dollar amounts with 2 decimal places for financial data
- When showing balance, include both available and pending with the distinction
- For payouts, include the arrival date (when it actually hits the bank)
- For cash flow, always show net (in minus out) with a clear positive/negative indicator
- When discussing fees, show both the dollar amount and the effective percentage rate
- For instant payouts, ALWAYS show the fee calculation and confirm before executing`,
};

function getToolsForContext(context) {
  if (context === 'schedule' || context === 'dispatch') {
    return [...TOOLS, ...SCHEDULE_TOOLS];
  }
  if (context === 'dashboard') {
    return [...TOOLS, ...DASHBOARD_TOOLS];
  }
  if (context === 'seo' || context === 'blog') {
    return [...TOOLS, ...SEO_TOOLS];
  }
  if (context === 'procurement' || context === 'inventory') {
    return [...TOOLS, ...PROCUREMENT_TOOLS];
  }
  if (context === 'revenue') {
    return [...TOOLS, ...REVENUE_TOOLS];
  }
  if (context === 'reviews') {
    return [...TOOLS, ...REVIEW_TOOLS];
  }
  if (context === 'comms') {
    return [...TOOLS, ...COMMS_TOOLS];
  }
  if (context === 'tax') {
    return [...TOOLS, ...TAX_TOOLS];
  }
  if (context === 'leads') {
    return [...TOOLS, ...LEADS_TOOLS];
  }
  if (context === 'email') {
    return [...TOOLS, ...EMAIL_TOOLS];
  }
  if (context === 'banking') {
    return [...TOOLS, ...BANKING_TOOLS];
  }
  if (context === 'tech') {
    return TECH_TOOLS;
  }
  return TOOLS;
}

// techContext is only set for tech portal calls
function executeToolByName(toolName, input, techContext) {
  if (TECH_TOOL_NAMES.has(toolName)) {
    return executeTechTool(toolName, input, techContext || {});
  }
  if (REVIEW_TOOL_NAMES.has(toolName)) {
    return executeReviewTool(toolName, input);
  }
  if (COMMS_TOOL_NAMES.has(toolName)) {
    return executeCommsTool(toolName, input);
  }
  if (TAX_TOOL_NAMES.has(toolName)) {
    return executeTaxTool(toolName, input);
  }
  if (LEADS_TOOL_NAMES.has(toolName)) {
    return executeLeadsTool(toolName, input);
  }
  if (EMAIL_TOOL_NAMES.has(toolName)) {
    return executeEmailTool(toolName, input);
  }
  if (BANKING_TOOL_NAMES.has(toolName)) {
    return executeBankingTool(toolName, input);
  }
  if (SCHEDULE_TOOL_NAMES.has(toolName)) {
    return executeScheduleTool(toolName, input);
  }
  if (DASHBOARD_TOOL_NAMES.has(toolName)) {
    return executeDashboardTool(toolName, input);
  }
  if (SEO_TOOL_NAMES.has(toolName)) {
    return executeSeoTool(toolName, input);
  }
  if (PROCUREMENT_TOOL_NAMES.has(toolName)) {
    return executeProcurementTool(toolName, input);
  }
  if (REVENUE_TOOL_NAMES.has(toolName)) {
    return executeRevenueTool(toolName, input);
  }
  return executeTool(toolName, input);
}

const SYSTEM_PROMPT = `You are the Waves Intelligence Bar — a natural language command center for Waves Pest Control & Lawn Care's admin portal. You help the operator (owner/admin) query, analyze, and take action on their business data.

BUSINESS CONTEXT:
- Waves Pest Control & Lawn Care serves Southwest Florida (Manatee, Sarasota, Charlotte counties)
- Markets: Bradenton/Parrish, Sarasota/Lakewood Ranch, Venice/North Port, Port Charlotte
- Service types: Pest Control (quarterly), Lawn Care (monthly), Mosquito Barrier (every 3 weeks), Tree & Shrub Care (quarterly), Termite (annual), Rodent Control, WDO Inspections
- WaveGuard loyalty tiers: Bronze (1 service), Silver (2 services), Gold (3 services), Platinum (4+ services)
- Team: Adam (field tech), Virginia (office manager), Jose Alvarado (tech), Jacob Heaton (tech)
- Scheduling zones by city: Parrish, Palmetto, Lakewood Ranch, Bradenton, Sarasota, Venice/North Port

RESPONSE FORMAT:
You are talking to the business owner/operator through a command bar UI. Be concise and action-oriented.

1. For DATA QUERIES: Return results in a structured way. Include customer names, key metrics, and counts. Summarize at the top ("Found 12 customers…"), then list the specifics.

2. For DATA FIXES: Show what you found and what you'd change. Ask for confirmation before making changes. Example: "Found 8 customers with no city. I can fill these in based on their ZIP codes — want me to proceed?"

3. For SCHEDULING ACTIONS: Show the proposed changes clearly (who, what date, what service). Ask for confirmation before creating/moving/cancelling appointments.

4. For ANALYSIS: Give direct, opinionated insights. Don't hedge — the operator wants to know what to do.

RULES:
- Always use tools to query real data — never guess or make up numbers
- For write operations (updates, scheduling, cancels), ALWAYS describe what you'll do and ask for confirmation before executing
- When showing customer lists, include: name, city, tier, relevant dates, and the specific data point the query is about
- If the query is ambiguous, make your best interpretation and note your assumption
- Keep responses under 500 words unless the operator asks for a detailed report
- Format numbers nicely: $1,234.56 not 1234.56
- Use emoji sparingly for visual scanning: ⚠️ for issues, ✅ for healthy, 📅 for scheduling, 💰 for money

SCHEDULING INTELLIGENCE:
- Quarterly pest = every ~90 days
- Monthly lawn = every ~30 days  
- Mosquito = every ~21 days
- Overdue = past their expected frequency with no upcoming appointment
- When scheduling, prefer clustering by zone/city on the same day for route efficiency
- Morning window = 8AM-12PM, Afternoon = 12PM-5PM

The current date is ${etDateString()}.`;


// ─── MAIN QUERY ENDPOINT ────────────────────────────────────────

router.post('/query', async (req, res, next) => {
  try {
    const { prompt, conversationHistory = [], context, pageData } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: 'AI not configured',
        message: 'ANTHROPIC_API_KEY is not set. Intelligence Bar requires Claude API access.',
      });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build context-aware system prompt
    let systemPrompt = SYSTEM_PROMPT;
    if (context && CONTEXT_PROMPTS[context]) {
      systemPrompt += '\n\n' + CONTEXT_PROMPTS[context];
    }
    // Inject live page data (current date, schedule stats, etc.)
    if (pageData) {
      systemPrompt += `\n\nCURRENT PAGE STATE:\n${JSON.stringify(pageData, null, 2)}`;
    }

    // Build tech context for tech portal calls
    const techContext = context === 'tech' ? {
      techId: req.technicianId || null,
      techName: req.technicianName || pageData?.tech_name || null,
    } : null;

    // Select tools based on context
    const tools = getToolsForContext(context);

    // For tech context, use a simpler model to reduce latency in the field
    const model = context === 'tech' ? (process.env.INTELLIGENCE_BAR_TECH_MODEL || MODELS.FLAGSHIP) : MODEL;

    // Build messages array (support multi-turn conversation)
    const messages = [
      ...conversationHistory.slice(-10),
      { role: 'user', content: prompt },
    ];

    let currentMessages = messages;
    let finalResponse = null;
    const toolCalls = [];
    const toolResults = [];

    // Tool-use loop
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: model,
        max_tokens: context === 'tech' ? 1024 : 4096,
        system: systemPrompt,
        tools,
        messages: currentMessages,
      });

      const toolUses = response.content.filter(c => c.type === 'tool_use');
      const textBlocks = response.content.filter(c => c.type === 'text');

      if (toolUses.length === 0) {
        finalResponse = textBlocks.map(t => t.text).join('\n');
        break;
      }

      // Execute all tool calls using context-aware router
      const results = [];
      for (const toolUse of toolUses) {
        logger.info(`[intelligence-bar] Tool call: ${toolUse.name}`, toolUse.input);

        let result;
        let failed = false;
        let circuitOpen = false;
        let errorMessage = null;
        const toolStartedAt = Date.now();
        if (adminToolBreaker.isTripped()) {
          result = adminToolBreaker.fastFailResult();
          failed = true;
          circuitOpen = true;
          errorMessage = result.message;
        } else {
          try {
            result = await executeToolByName(toolUse.name, toolUse.input, techContext);
            if (isToolFailure(result)) {
              failed = true;
              errorMessage = result.error || result.message || 'tool returned error';
              adminToolBreaker.recordFailure();
            } else {
              adminToolBreaker.recordSuccess();
            }
          } catch (err) {
            logger.error(`[intelligence-bar] Tool ${toolUse.name} threw:`, err);
            adminToolBreaker.recordFailure();
            result = { error: err.message || 'Tool execution failed' };
            failed = true;
            errorMessage = err.message;
          }
        }
        recordToolEvent({
          source: context === 'tech' ? 'tech-intelligence-bar' : 'intelligence-bar',
          context: context || null,
          toolName: toolUse.name,
          success: !failed,
          durationMs: Date.now() - toolStartedAt,
          circuitOpen,
          errorMessage,
        });

        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
          ...(failed ? { is_error: true } : {}),
        });

        toolCalls.push({ name: toolUse.name, input: toolUse.input });
        toolResults.push({ name: toolUse.name, result });
      }

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: results },
      ];
    }

    if (!finalResponse) {
      finalResponse = 'I ran into a complex query that needed too many steps. Try breaking it into smaller questions.';
    }

    // Log the query for analytics
    try {
      await db('intelligence_bar_queries').insert({
        prompt,
        response: finalResponse.substring(0, 5000),
        tool_calls: JSON.stringify(toolCalls),
        created_at: new Date(),
      });
    } catch {
      // Table may not exist yet — non-critical
    }

    res.json({
      response: finalResponse,
      toolCalls,
      // Return the structured data from the last tool call for UI rendering
      structuredData: toolResults.length > 0 ? toolResults[toolResults.length - 1].result : null,
      // Return conversation history for multi-turn
      conversationHistory: [
        ...conversationHistory.slice(-8),
        { role: 'user', content: prompt },
        { role: 'assistant', content: finalResponse },
      ],
    });

  } catch (err) {
    logger.error('[intelligence-bar] Query failed:', err);
    next(err);
  }
});


// ─── EXECUTE CONFIRMED ACTION ───────────────────────────────────

router.post('/execute', async (req, res, next) => {
  try {
    const { action, params } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    const result = await executeToolByName(action, params);

    logger.info(`[intelligence-bar] Executed action: ${action}`, params);

    res.json({
      success: !result.error,
      result,
    });

  } catch (err) {
    logger.error('[intelligence-bar] Execute failed:', err);
    next(err);
  }
});


// ─── QUICK ACTIONS (pre-built prompts for common tasks) ─────────

router.get('/quick-actions', async (req, res) => {
  const { context } = req.query;

  const baseActions = [
    { id: 'missing_city', label: 'Missing Cities', prompt: 'Show me customers with no city on their profile', icon: '📍' },
    { id: 'pest_overdue', label: 'Pest Overdue', prompt: 'Which quarterly pest control customers are overdue for service?', icon: '🐛' },
    { id: 'lawn_overdue', label: 'Lawn Overdue', prompt: 'Which monthly lawn care customers are overdue?', icon: '🌿' },
    { id: 'at_risk', label: 'At Risk', prompt: 'Show me customers with health scores below 40', icon: '⚠️' },
    { id: 'no_email', label: 'Missing Emails', prompt: 'Customers with no email address', icon: '📧' },
    { id: 'high_balance', label: 'Outstanding Balances', prompt: 'Who has an outstanding balance over $100?', icon: '💰' },
    { id: 'duplicates', label: 'Duplicates', prompt: 'Find duplicate customers by phone number', icon: '👥' },
    { id: 'schedule_gaps', label: 'Schedule Gaps', prompt: `What does this week's schedule look like? Any gaps?`, icon: '📅' },
    { id: 'tech_performance', label: 'Tech Performance', prompt: 'Compare technician performance this month', icon: '📊' },
    { id: 'win_back', label: 'Win Back', prompt: 'Show churned customers from the last 6 months who were Gold or Platinum tier', icon: '🔄' },
  ];

  const scheduleActions = [
    { id: 'day_briefing', label: 'Day Briefing', prompt: 'Give me a full briefing for today', icon: '📋' },
    { id: 'optimize', label: 'Optimize Routes', prompt: 'Optimize all routes for today', icon: '🗺️' },
    { id: 'unassigned', label: 'Unassigned Stops', prompt: 'Show me unassigned stops and suggest tech assignments', icon: '❓' },
    { id: 'zone_density', label: 'Zone Density', prompt: 'Analyze zone density for today — any consolidation opportunities?', icon: '📍' },
    { id: 'gaps_this_week', label: 'Gaps This Week', prompt: 'Where do we have open capacity this week?', icon: '📅' },
    { id: 'far_out', label: 'Far-Out Appointments', prompt: 'Find appointments scheduled more than 30 days out that we could move sooner', icon: '⏩' },
    { id: 'find_time', label: 'Find a Time', prompt: 'Find the best time slot for a new customer — ask me for the address and service type', icon: '✨' },
    { id: 'overdue_no_appt', label: 'Overdue + No Appt', prompt: 'Which overdue customers have no upcoming appointment at all?', icon: '🚨' },
    { id: 'pest_overdue_sched', label: 'Pest Overdue', prompt: 'Quarterly pest customers overdue — schedule them into open slots this week', icon: '🐛' },
  ];

  const dashboardActions = [
    { id: 'briefing', label: 'Morning Briefing', prompt: 'Give me a morning briefing — what do I need to know today?', icon: '☀️' },
    { id: 'this_vs_last', label: 'This vs Last Week', prompt: 'How did we do this week compared to last week?', icon: '📊' },
    { id: 'mrr', label: 'MRR Trend', prompt: "What's our MRR trend over the last 6 months?", icon: '📈' },
    { id: 'close_rate', label: 'Close Rate', prompt: "What's our estimate close rate this month?", icon: '🎯' },
    { id: 'revenue_by_service', label: 'Revenue by Service', prompt: 'Break down revenue by service type this month', icon: '💰' },
    { id: 'churn', label: 'Churn Check', prompt: 'Any churn this month? Who did we lose and what was the revenue impact?', icon: '🔻' },
    { id: 'lead_sources', label: 'Lead Sources', prompt: 'Where are new customers coming from? Which source converts best?', icon: '🧲' },
    { id: 'balances', label: 'Outstanding Balances', prompt: "What's outstanding? Show me the aging breakdown and top debtors", icon: '🧾' },
  ];

  const seoActions = [
    { id: 'refresh_score', label: 'Refresh Priority', prompt: 'Score all pages for refresh priority. Which pages have the highest ROI for a semantic update?', icon: '🎯' },
    { id: 'concept_map', label: 'Concept Map', prompt: 'Show me the semantic concept map for pest control — what entities, subtopics, and related concepts should our pages cover?', icon: '🗺️' },
    { id: 'entity_gaps', label: 'Entity Gaps', prompt: 'Which pages are losing position and likely have entity gaps vs competitors? Check against the concept clusters.', icon: '🧩' },
    { id: 'content_brief', label: 'Content Brief', prompt: 'Build a content workflow brief for "pest control bradenton fl" — SERP analysis, entity map, and content blueprint.', icon: '📋' },
    { id: 'drops', label: 'Ranking Drops', prompt: 'Which keywords dropped in rankings this week? Cross-reference with entity coverage gaps.', icon: '📉' },
    { id: 'top_queries', label: 'Top Queries', prompt: 'What are our top 20 non-branded keywords by clicks? Which concept clusters do they belong to?', icon: '🔍' },
    { id: 'decay', label: 'Content Decay', prompt: 'Any content decay alerts or keyword cannibalization issues?', icon: '⚠️' },
    { id: 'content_pipe', label: 'Content Pipeline', prompt: "What's in the content pipeline? How many posts need generation?", icon: '📝' },
  ];

  if (context === 'schedule' || context === 'dispatch') {
    res.json({ actions: scheduleActions });
  } else if (context === 'dashboard') {
    res.json({ actions: dashboardActions });
  } else if (context === 'seo' || context === 'blog') {
    res.json({ actions: seoActions });
  } else if (context === 'procurement' || context === 'inventory') {
    res.json({ actions: [
      { id: 'unpriced', label: 'Unpriced Products', prompt: 'What products still need pricing? Prioritize by category.', icon: '❓' },
      { id: 'compare', label: 'Compare Vendors', prompt: 'Compare SiteOne vs LESCO pricing on our top 10 most-used products', icon: '⚖️' },
      { id: 'cheapest', label: 'Cheapest Sources', prompt: 'Where are we getting the best deals? Any products where a cheaper vendor exists?', icon: '💰' },
      { id: 'approvals', label: 'Approval Queue', prompt: 'Any pending price approvals? Show me what needs review.', icon: '✅' },
      { id: 'margins', label: 'Margin Analysis', prompt: 'What are our margins by service type?', icon: '📊' },
      { id: 'herbicides', label: 'Herbicide Prices', prompt: 'Compare prices on all our pre-emergent herbicides', icon: '🌿' },
      { id: 'price_check', label: 'Run Price Check', prompt: 'Run a price check on Demand CS across all vendors', icon: '🔍' },
      { id: 'trends', label: 'Price Trends', prompt: 'Have any product prices gone up in the last 90 days?', icon: '📈' },
    ] });
  } else if (context === 'revenue') {
    res.json({ actions: [
      { id: 'overview', label: 'Revenue Overview', prompt: "How's revenue this month? Show me the full picture with margins.", icon: '💰' },
      { id: 'compare', label: 'This vs Last Month', prompt: 'Compare this month vs last month — revenue, margin, RPMH, everything', icon: '📊' },
      { id: 'service_lines', label: 'Service Line P&L', prompt: 'Break down P&L by service line. Which has the best margin?', icon: '📋' },
      { id: 'tech_perf', label: 'Tech RPMH', prompt: 'Rank technicians by revenue per man-hour', icon: '👷' },
      { id: 'top_customers', label: 'Top 10 Customers', prompt: 'Who are our top 10 customers by revenue this month?', icon: '🏆' },
      { id: 'ad_roi', label: 'Ad ROI', prompt: "What's our ad attribution? ROAS and CAC by channel?", icon: '📣' },
      { id: 'quarter', label: 'Quarter View', prompt: "How's revenue this quarter compared to last quarter?", icon: '📈' },
      { id: 'low_margin', label: 'Low Margin Alert', prompt: 'Which service lines are below our 55% margin target?', icon: '⚠️' },
    ] });
  } else if (context === 'tech') {
    res.json({ actions: [
      { id: 'route', label: "Today's Route", prompt: "What's my route today?", icon: '📅' },
      { id: 'next', label: "What's Next?", prompt: "What's my next stop? Any special notes?", icon: '➡️' },
      { id: 'weather', label: 'Spray Check', prompt: 'Can I spray right now? Check wind and rain.', icon: '🌤️' },
      { id: 'remaining', label: 'How Many Left?', prompt: 'How many stops do I have left today?', icon: '📊' },
      { id: 'protocol', label: 'Pest Protocol', prompt: 'What products and rates for quarterly pest control?', icon: '📖' },
      { id: 'lawn_protocol', label: 'Lawn Protocol', prompt: 'Lawn care protocol for St. Augustine', icon: '🌿' },
    ] });
  } else if (context === 'reviews') {
    res.json({ actions: [
      { id: 'stats', label: 'Review Stats', prompt: 'How are our Google reviews? Give me the full picture.', icon: '⭐' },
      { id: 'unresponded', label: 'Needs Reply', prompt: 'Show me reviews that need a reply — prioritize negative ones', icon: '💬' },
      { id: 'draft_all', label: 'Draft Replies', prompt: 'Draft AI replies for all unresponded reviews', icon: '✍️' },
      { id: 'outreach', label: 'Outreach Candidates', prompt: 'Who should we ask for reviews? Show Gold and Platinum customers first.', icon: '📧' },
      { id: 'trends', label: 'Review Trends', prompt: 'Are our reviews improving? Show the 6-month trend.', icon: '📈' },
      { id: 'velocity', label: 'Velocity Pipeline', prompt: "What's our review request conversion rate?", icon: '🔄' },
      { id: 'negative', label: 'Negative Reviews', prompt: 'Show me all 1-2 star reviews. Any patterns?', icon: '⚠️' },
      { id: 'by_location', label: 'By Location', prompt: 'Compare review counts and ratings across all 4 locations', icon: '📍' },
    ] });
  } else if (context === 'comms') {
    res.json({ actions: [
      { id: 'unanswered', label: 'Unanswered', prompt: 'Any unanswered messages? Who is waiting for a reply?', icon: '🔴' },
      { id: 'today', label: "Today's Activity", prompt: "What happened today? Messages, calls, anything missed?", icon: '📋' },
      { id: 'calls', label: 'Recent Calls', prompt: "What calls came in today? Any with recordings?", icon: '📞' },
      { id: 'stats', label: 'SMS Stats', prompt: 'SMS volume breakdown this month by type', icon: '📊' },
      { id: 'csr', label: 'CSR Coach', prompt: "How's the CSR performance? Any follow-up tasks pending?", icon: '🎓' },
      { id: 'search', label: 'Search Messages', prompt: 'Search messages about...', icon: '🔍' },
    ] });
  } else if (context === 'tax') {
    res.json({ actions: [
      { id: 'overview', label: 'Tax Overview', prompt: "Give me the full tax picture — expenses, deductions, equipment, upcoming deadlines.", icon: '💰' },
      { id: 'quarterly', label: 'Quarterly Estimate', prompt: "What's my estimated quarterly tax payment? Break down federal and self-employment.", icon: '📊' },
      { id: 'expenses', label: 'Expenses YTD', prompt: 'Show me expenses by category this year. What percentage is deductible?', icon: '🧾' },
      { id: 'equipment', label: 'Depreciation', prompt: 'Which equipment is fully depreciated? Any Section 179 candidates?', icon: '🔧' },
      { id: 'pnl', label: 'P&L', prompt: "Month-to-date P&L with gross and net margins", icon: '📋' },
      { id: 'deadlines', label: 'Deadlines', prompt: 'When are my next tax deadlines? Anything overdue?', icon: '📅' },
      { id: 'advisor', label: 'Run Advisor', prompt: 'Run the AI tax advisor — check for savings opportunities and regulation changes.', icon: '🤖' },
      { id: 'ar', label: 'A/R Aging', prompt: "Who owes us money? Show me the accounts receivable aging.", icon: '⚠️' },
      { id: 'mileage', label: 'Mileage', prompt: 'Mileage deduction so far this year?', icon: '🚗' },
    ] });
  } else if (context === 'leads') {
    res.json({ actions: [
      { id: 'overview', label: 'Pipeline Overview', prompt: 'How does the pipeline look? Active leads, conversion rate, response time.', icon: '📊' },
      { id: 'stale', label: 'Stale Leads', prompt: "Which leads haven't been contacted in 48 hours? These are going cold.", icon: '🔴' },
      { id: 'funnel', label: 'Funnel', prompt: "Show me the funnel. Where's the bottleneck?", icon: '🔄' },
      { id: 'sources', label: 'Source ROI', prompt: 'Compare lead sources by conversion rate and ROI', icon: '📈' },
      { id: 'lost', label: 'Lost Analysis', prompt: 'Why are we losing leads? Break down by reason.', icon: '❌' },
      { id: 'response', label: 'Response Times', prompt: 'How fast are we responding? Does speed correlate with conversion?', icon: '⏱️' },
      { id: 'new_leads', label: 'New Leads', prompt: 'Show me all new leads this week', icon: '🆕' },
      { id: 'cleanup', label: 'Pipeline Cleanup', prompt: 'How many unresponsive leads older than 30 days should we move to lost?', icon: '🧹' },
    ] });
  } else if (context === 'email') {
    res.json({ actions: [
      { id: 'summary', label: 'Inbox Summary', prompt: 'What came in today? Give me the full picture.', icon: '📬' },
      { id: 'unread', label: 'Unread', prompt: 'Show me all unread emails that need attention', icon: '🔴' },
      { id: 'invoices', label: 'Vendor Invoices', prompt: 'Any vendor invoices to review? Show amounts and status.', icon: '🧾' },
      { id: 'leads', label: 'Email Leads', prompt: 'How many leads came in via email this month? Show me the recent ones.', icon: '📈' },
      { id: 'blocked', label: 'Blocked Senders', prompt: 'How many spam senders are blocked? Show the top domains.', icon: '🚫' },
      { id: 'stats', label: 'Email Stats', prompt: 'Email volume and classification breakdown this month', icon: '📊' },
    ] });
  } else if (context === 'banking') {
    res.json({ actions: [
      { id: 'balance', label: 'Stripe Balance', prompt: "What's my Stripe balance right now?", icon: '💳' },
      { id: 'payouts', label: 'Recent Payouts', prompt: 'Show me recent payouts to the bank', icon: '🏦' },
      { id: 'cash_flow', label: 'Cash Flow', prompt: 'Cash flow this month — am I cash positive?', icon: '📊' },
      { id: 'fees', label: 'Fee Analysis', prompt: 'How much are we paying in Stripe fees? What is the effective rate?', icon: '💸' },
      { id: 'reconcile', label: 'Reconciliation', prompt: 'Any unreconciled payouts?', icon: '✅' },
      { id: 'export', label: 'Export', prompt: 'Export this month payouts as CSV', icon: '📥' },
    ] });
  } else {
    res.json({ actions: baseActions });
  }
});


module.exports = router;
