# Waves — Local SEO Page Audit Prompt

You have already loaded `waves-seo-operator-prompt.md`. That gave you the business context, service map, brand voice, and tool inventory. This file tells you how to run a **single-page local SEO audit** and what the deliverable must look like.

## Inputs

The invoking task will pass arguments in roughly this shape:

```
url=<full https URL on wavespestcontrol.com>
city=<target city or neighborhood>
primary_keyword=<main keyword to rank for, e.g. "mosquito control Siesta Key">
[secondary_keywords=<comma-separated list>]
[competitors=<comma-separated domains to check against>]
[notes=<free-form context from the operator>]
```

If the operator only gives a URL, **infer** the city and primary keyword from the page's copy/slug and state your inference at the top of the report. Don't refuse to run.

## What to actually do (execution order)

Run these in order. Don't skip steps — every section of the report depends on evidence from one of them.

### 1. Render the target page (Playwright)

- Navigate to the URL with a desktop viewport (1440×900) and again with a mobile viewport (iPhone 14 Pro, 390×844).
- Capture:
  - Final rendered HTML (not just view-source — we need post-JS state).
  - `<title>`, meta description, canonical, hreflang (if any), robots directives.
  - All H1–H3 text, in order.
  - All CTAs (anchor text + destination + whether they're tel: / form / scroll).
  - Every JSON-LD block — dump it verbatim.
  - Image count, first 10 image `alt` attributes, presence of `loading="lazy"`.
  - NAP (name, address, phone) — does it match the corresponding GBP? Is the phone a tracking number?
  - Core Web Vitals via the Performance API if available: LCP, CLS, INP (or TBT), TTFB.
  - Mobile tap-target issues (overlapping CTAs, phone number not tappable, sticky elements covering content).
- Screenshot: above-the-fold desktop, above-the-fold mobile.

### 2. Check the live SERP (Brave Search MCP)

For the primary keyword, query Brave with location bias set to the target city (or the nearest Brave-supported locale). Record:
- Top 10 organic results (position, title, URL, domain).
- Local Pack (3-pack) presence and who's in it. If Waves is in it, what's the position?
- Featured snippet / PAA questions — list them, they're content opportunities.
- Ads present for the keyword (yes/no, count).

Repeat for up to 3 secondary keywords if provided.

### 3. Check the Google Business Profile (Playwright → Google Maps)

- Navigate to Google Maps, search `Waves Pest Control [city]`.
- Capture, for the profile that matches:
  - Business name exact string, primary category, secondary categories.
  - Star rating, review count, most recent review date.
  - Phone number — does it match the tracking number on the audited page?
  - Address / service area radius.
  - Hours (current, not "special hours").
  - Posts — date of most recent post.
  - Photos — approximate count, date of most recent upload.
  - Q&A — count and any unanswered questions.
  - Services listed — match or mismatch vs. the page being audited?
- If no GBP appears for the city, flag it as a **critical gap**.

### 4. Spot-check 2 competitor pages

Pick the top 2 organic competitors from step 2 that aren't Waves. For each, in under 5 minutes:
- Word count (rendered text).
- H1 + meta title.
- Local signals present (embedded map, city name density, testimonials with city names, NAP).
- Schema types present.
- One thing they do better than the Waves page.
- One thing the Waves page does better.

Don't go deeper than that — the audit is about the Waves page, not about writing a full competitor teardown.

## Output format

Save to `docs/seo-playbook/audits/[YYYY-MM-DD]-[page-slug].md`. Use today's date in America/New_York. Slug = last meaningful path segment (e.g. `mosquito-control-siesta-key`). If that file already exists, append `-v2` (or `-v3`, etc.).

Write the report in this structure. Use the exact headings.

```markdown
# Local SEO Audit — [Page Title]

**URL:** [full URL]
**Target city:** [city]
**Primary keyword:** [keyword]
**Secondary keywords:** [list or "none supplied"]
**Audit date:** [YYYY-MM-DD]
**Auditor:** Claude (via /local-seo-audit)

## Executive summary

[3–5 sentences. State the page's current local-search posture in plain English.
End with the single biggest lever to pull.]

**Overall score: XX / 100**

| Dimension | Score | Weight |
|---|---|---|
| On-page content & intent match | /20 | 20% |
| Technical & Core Web Vitals | /15 | 15% |
| Local signals (NAP, schema, embedded map, city language) | /20 | 20% |
| Google Business Profile alignment | /15 | 15% |
| SERP competitiveness | /15 | 15% |
| Conversion / CTA quality | /15 | 15% |

## 1. On-page content & intent match

- **H1:** [exact text] — [verdict]
- **Title tag:** [exact text, char count] — [verdict]
- **Meta description:** [exact text, char count] — [verdict]
- **Word count (rendered):** [number]
- **City name density:** [city] appears [N] times in body copy.
- **Keyword coverage:** [primary keyword] appears [N] times; in H1? title? first 100 words?
- **Content depth:** [does the page answer what a [city] homeowner actually wants to know? name specific gaps]
- **PAA / snippet gaps:** [list the PAA questions from the SERP this page does NOT answer]

## 2. Technical & Core Web Vitals

| Metric | Desktop | Mobile | Threshold | Pass? |
|---|---|---|---|---|
| LCP | | | ≤2.5s | |
| CLS | | | ≤0.1 | |
| INP (or TBT) | | | ≤200ms | |
| TTFB | | | ≤800ms | |

- **Canonical:** [value]
- **Robots:** [value]
- **Image issues:** [count missing alt, count non-lazy above-fold, etc.]
- **Mobile UX issues:** [tap targets, sticky overlay, font size, etc.]

## 3. Local signals

- **NAP on page:** [name] / [address] / [phone] — matches GBP? [yes/no]
- **Embedded map:** [yes/no, which location]
- **City/neighborhood mentions:** [list of cities/neighborhoods named in the copy]
- **Local testimonials:** [count with city name attached]
- **Schema present:** [list JSON-LD @type values]
- **Schema missing that should exist:** [list]

## 4. Google Business Profile alignment

- **Profile found:** [yes/no — if no, mark CRITICAL]
- **Name / primary category / phone:** [values, flag mismatches with page]
- **Rating / review count / last review:** [values]
- **Last post / last photo:** [dates — flag if >30 days]
- **Services list vs. page content:** [match / gaps]
- **Unanswered Q&A:** [count]

## 5. SERP competitiveness

**Primary keyword: [keyword]** — Local Pack: [Waves position or "not present"]. Organic: [Waves position or "not in top 10"].

Top 10 organic:

| # | Domain | Title |
|---|---|---|
| 1 | | |
| ... | | |

**Secondary keywords:** [brief table or bullet list per keyword]

**PAA questions:** [list]

### Competitor spot-checks

**[Competitor 1 domain]** — [one-line take].
**[Competitor 2 domain]** — [one-line take].

## 6. Conversion / CTA quality

- **Primary CTA:** [what it is, where it is, is it above the fold?]
- **Phone CTA:** [clickable `tel:`? tracking number? matches GBP?]
- **Form CTA:** [fields, length, friction points]
- **Trust signals visible above fold:** [rating, review count, years in business, named technicians, license #]
- **WaveGuard / loyalty mention (if mosquito page):** [present? tiered options shown?]

## Recommendations (ranked)

Order by **impact × ease**. Each recommendation gets a tag: 🔴 critical / 🟡 high / 🟢 medium / ⚪ low-effort polish.

1. 🔴 **[One-line action].** Why: [reason tied to evidence above]. Effort: [S/M/L].
2. 🟡 **[One-line action].** Why: [...]. Effort: [...].
3. ...

Stop at 10 recommendations. Quality over volume.

## Appendix: raw captures

- Desktop screenshot: [path or inline]
- Mobile screenshot: [path or inline]
- JSON-LD blocks: [fenced code blocks, one per block]
- Full Brave SERP result set: [collapsed list]
```

## Scoring rubric (how to assign the numbers)

Apply the weights in the executive-summary table to the six dimensions. Within each dimension, score against these anchors:

- **On-page content & intent match (/20):**
  - 18–20 — H1/title/meta all contain primary keyword and city, copy answers 3+ PAA questions, 800+ words of genuine local content.
  - 14–17 — Mostly there but one of (H1, title, meta) is generic or missing the city.
  - 10–13 — Thin content (<500 words) OR keyword/city barely present.
  - <10 — Wrong intent, missing city, obvious template page.
- **Technical & CWV (/15):** All three CWV green = 13–15. Two green = 10–12. One green = 6–9. Zero = <6.
- **Local signals (/20):** NAP matches GBP + `LocalBusiness` + `Service` schema + embedded map + city-named testimonials = 18–20. Missing one = 14–17. Missing two = 10–13. Missing three+ = <10.
- **GBP alignment (/15):** Active (post in last 14d, photo in last 30d), category matches page, NAP matches, no unanswered Q&A = 13–15. Stale posts/photos = 9–12. No matching profile = 0.
- **SERP competitiveness (/15):** Top 3 organic + in Local Pack = 13–15. Top 10 organic = 9–12. Page 2 = 5–8. Not found = 0–4.
- **Conversion / CTA (/15):** Phone + form above fold, trust signals visible, mobile-tappable, matching tracking number = 13–15. Two of those = 9–12. One = 5–8. None = 0–4.

Sum the weighted scores. Round to a whole number. Show your work implicitly by filling in each per-dimension score — don't make the operator recompute.

## Don't

- Don't write more than 10 recommendations. More is noise.
- Don't recommend "improve content" without saying what specifically to add.
- Don't cite a competitor or SERP position without having actually pulled it in step 2.
- Don't assert a CWV number you didn't measure.
- Don't touch the live site or the GBP in the course of the audit. Recommend, don't ship.
- Don't invent keyword volume, DA, or backlink counts you have no tool to measure. Write "not measured" instead.
