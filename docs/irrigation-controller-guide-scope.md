# Sprinkler Timer Guide — verified scope

Concept scope · Waves Lawn Care · 2026-09-05 · scoping only, nothing built.

The concept: a brand-by-brand guide that teaches lawn customers to operate
the irrigation controller on their own wall — an email with brand buttons,
a linkable page per brand, and a printed copy for the truck. This document
checks the concept's claims against both repos and reshapes the build
around what actually exists.

## Verdict

Worth doing. Owner clarification 2026-09-05: one helpful email, sent once,
for a customer who has never opened the box. The concept's prep-lane
delivery needs one adjustment (no visit token, since the email links to
the hub and a lawn visit already owns `prep.lawn`), and its example
watering block over-promises (no weekday or hour window exists in the
policy). Everything else holds. Build = hub content, one template seed,
one manual-send config entry. Brand capture is a separable follow-on.

## Claims checked against the code

| Concept claim | What the code says |
|---|---|
| "Every extra CTA block in a portal email is a gold bar (owner ruling 2026-07-06)." | Confirmed by rendering. `ctaChip` in `server/services/email-template.js` returns the full gold `ctaButton` under the glass theme (owner call 2026-07-06); the "first CTA gold, later ones quiet chips" comment in `renderBlocks` describes the classic theme only. Five stacked cta blocks render as five identical gold bars. The irrigation blog-links migration (`20260803000000_irrigation_blog_links.js`) chose an inline link line in a `small_note` precisely because stacked bars bury the primary action, so a brand row belongs in an email whose only job is the guide, not in the weekly plan. |
| "A new `prep.irrigation_controller` key drops into the prep-guide lane." | Structural conflict. A `scheduled_services` row carries ONE `prep_token` and ONE `prep_template_key` (`ensureServicePrepToken`, `server/services/project-email.js`), and `markServicePrepSent` moves the key at confirmed delivery. Lawn visits already own `prep.lawn`; a second guide on the same visit would retarget the already-emailed prep URL. The public page also strips `cta` blocks (`EMAIL_ONLY_BLOCK_TYPES`, `server/routes/prep-public.js`), so brand buttons never render on `/prep/:token`. Manual send (`PREP_CONFIG`, `prep-guide-sender.js`) covers flea / bed bug / cockroach only; `prep.lawn` fires from project-email for `one_time_lawn_treatment` projects, not recurring lawn customers, who are the audience. |
| "The weekly irrigation email is the guide's natural sibling link." | Confirmed, and stronger than stated. `irrigation-week-plan.js` already renders "about N minutes per turf zone" on "your permitted day (hours note)", the restriction note, and the after-treatment water-in copy (`renderWeekPlanAfterTreatment`). The personalized block IS the weekly email. Six `irrigation.weekly_*` templates already carry a hub-link `small_note`. |
| "Rendered from policy and address: 'Your watering day is Wednesday, 12:01 to 4:00 AM.'" | Cannot render today. `config/irrigation-restrictions.js` resolves COUNTY only (fail closed on partial Charlotte and straddling ZIPs), and `hoursNote` is the generic "on your assigned day, during your area's allowed hours". No day-of-week or hour window exists anywhere. The concept's example block over-promises. |
| "`property_preferences` has zones, head types, rain sensor, watering days, run minutes, controller location." | Confirmed: `irrigation_controller_location`, `irrigation_zones`, `watering_days`, `irrigation_run_minutes`, `irrigation_system_type`, `rain_sensor`, `irrigation_issues`, plus the `irrigation_confirmed_fields` ledger. No brand or model column. |
| "The tech records the controller during the lawn assessment; tech write-through." | No write path exists. `admin-lawn-assessment.js` writes only `customer_turf_profiles.grass_type`; `LawnAssessmentPanel.jsx` has a free-text irrigation issues field on the assessment, not on `property_preferences`; `TechLawnDiagnosticPage.jsx` never touches preferences. Tech write-through is new plumbing, not an extension. |
| "Zero controller brand mentions on the hub." | Confirmed across `~/wavespestcontrol-astro/src`. Prep guides live as markdown in `src/content/pages/preparation/` (nested dirs work), so a `guides/` sibling fits. Nothing on the site links to `lawn-treatment-prep` today except the portal emails. |
| "Hub pages auto-appear in the SMS composer link library." | Confirmed. `server/services/link-library.js` upserts every sitemap URL nightly; the Communications Insert Link sheet lists them. Office or tech can text a hub guide link with zero portal build. |
| "The facts bank already forbids the irrigation-repair claim." | Not in the facts bank. The prohibition lives in hub copy (`src/pages/lp/lawn-care.astro`: irrigation repair referred out) and `estimate-service-details.js` / `estimate-proposal-generate.js` ("quoted separately"). Keep the referral line; cite those. |
| "Reusing `/prep/:token` adds no public route." | True but moot: hub pages are Astro pages, not portal routes. No new `/:token` route in any option below. |
| "PDF twin is free." | Only inside the prep lane. Outside it the printable is a print stylesheet on the hub page (or a static PDF asset next to it). |

## Recommended shape

Owner clarification 2026-09-05: this is ONE helpful email, sent once, for a
customer who has never opened the box. Nothing more. Content on the hub,
the email is the front door.

Owner direction 2026-09-05, manual-first: most customers will run the
system by hand, so the guide teaches one weekly move (dial to MANUAL or
RUN ALL ZONES, enter the minutes from Monday's email, walk away) instead
of five settings. A skip week is "do nothing". A programmed schedule is
the optional path at the end of each brand page, recommended only where
the county's allowed hours are overnight. Two lines the copy must carry:
a hand run counts the same as a scheduled one for the assigned day and
allowed hours; and the dial rests on OFF between runs, which is what
keeps a builder's leftover program from double-watering.

1. **Hub pages** (astro). `src/content/pages/guides/sprinkler-timers/` —
   an identify-your-box index, a dial-position comparison, one page per
   brand family, print stylesheet as the truck copy. Link from
   `lawn-treatment-prep.md`. Sitemap sync puts every page in the composer
   link library the next night, so the office can also text a link.
2. **One email template, one-time manual send** (portal). A new protected
   key `prep.sprinkler_timer`, seeded by migration: heading, an opening
   paragraph that names the Monday-morning watering plan the customer
   already receives (`irrigation-weekly-email.js`) so the reason for the
   send is the first thing they read, a plain find-the-brand paragraph,
   five stacked cta blocks (Rain Bird, Hunter, Orbit
   B-hyve, Rachio, "Not sure? Text us a photo") that render as five gold
   bars under the glass theme, a `{{watering_block}}` callout, a
   three-step list (dial rests on OFF between runs; weekly: MANUAL or
   RUN ALL ZONES with Monday's minutes, then back to OFF; skip week: do
   nothing), the assigned-day and allowed-hours rule with the
   overnight-hours pointer to the schedule section, and the referral
   note. Sent from the Communications "Send prep guide" button through a
   `PREP_CONFIG` entry keyed to lawn, with a flag so the entry never mints
   a visit prep token (the email links to the hub, needs no `/prep` page,
   and must not touch a visit's `prep_template_key`). Rendered and checked
   through `renderTemplate` on 2026-09-05; no renderer work.
3. **Watering block**, rendered at send time from what exists: the day
   count from `currentRestrictionPolicy` for the customer's resolved
   county, and minutes from `irrigation_run_minutes` when on file.
   Fail closed to "check your county's assigned day" copy when the policy
   cannot be established. No weekday, no hour window.
4. **Brand capture** (optional, later). Two columns beside controller
   location; then the button row collapses to the one matching guide.
   Constraint: the renderer only turns markdown links written in the
   TEMPLATE into anchors, never a link inside a payload value (Codex
   #3167 ordering rule), so a per-brand link is a `cta` block with a
   `url_variable`, not prose.

Not in v1: a tokened `/prep` page, a PDF twin, weekly-email attachment,
any automation, a tech-portal write-through, or assigned-day / hour-window
copy.

## Rules it sits under (unchanged, with sources)

- Restrictions are a hard constraint above the model (owner ruling
  2026-08-28); day counts and hours come from `irrigation-restrictions.js`
  only, fail closed. The brand mechanics render regardless.
- Owner ruling 2026-09-05: customers MAY leave the controller OFF. Under
  manual-first, OFF is the resting position: nothing waters unless the
  customer starts it, so a leftover builder program can never fire and no
  "clear the old program" step is needed. The old "never turn it off"
  rule was schedule-mode advice (turning off to skip a week and forgetting
  to turn it back on) and applies only inside the optional schedule
  section of each brand page.
- No irrigation-repair claims; referral line only (hub lp copy, estimate
  service details).
- Own words and photos; link to the official Rain Bird / Hunter quick-start
  PDFs, never reproduce manual text (`waves-content` skill).
- The owner sends. Template versions are migration-seeded; keys stay on the
  protected list in `admin-email-templates.js`.

## Phasing (revised)

| Phase | Scope | Effort |
|---|---|---|
| 0 · Content | Per brand, manual-first: OFF between runs, manual / run-all-zones with minutes, then the schedule section (clock, day, start time, minutes, rain delay, sensor bypass). Rain Bird ESP-TM2 / Me3 and Hunter X-Core / Pro-C / Hydrawise first, identify-your-controller page, Tier 2/3 stubs, faceplate photos. | 2–3 days + a photo session on the route |
| 1 · Hub pages | Index + per-brand markdown pages, dial-position comparison, link from the lawn prep page. Print stylesheet doubles as the truck copy. | 1 day |
| 2 · Email + send | Template seed migration, `PREP_CONFIG` entry with the no-token flag, Communications allow-list, SMS companion copy. | 1 day |
| 3 · Brand capture (optional) | Columns, validation, portal + admin inputs, one-button collapse. | 1–1½ days |

Content and photos remain the long pole. Code is about two days without brand capture.

## Decisions needed before build

1. **Brands.** Start with Rain Bird TM2/Me3 and Hunter X-Core/Pro-C/Hydrawise, stub the rest? A week of noting controllers on the route re-ranks the list.
2. **Hub only, or the lawn spokes too?** Hub only is simplest and keeps brand isolation.
3. **Brand capture at all?** Phases 0–2 need no schema change. It only buys the one-button collapse.
4. **Assigned day and hours.** Drop from the block (recommended for v1) or fund an address-level restriction lane first. The policy today cannot say "Wednesday" or "12:01–4:00 AM".
5. **Photos.** Own photos of customer controllers with permission, manufacturer imagery, or diagrams.
6. **Name.** "Sprinkler timer" (customer language and search volume) vs "irrigation controller" (trade term). Recommend the customer word in titles and URLs, the trade term once in the body.

Sources: Rain Bird ESP-TM2 and ESP-Me3 manuals (rainbird.com); Hunter
residential controller comparison chart, X-Core quick start RC-172 and
Pro-C support pages (hunterirrigation.com); SWFWMD Modified Phase III
order and its 2026-08-27 extension; Sarasota, Manatee and Charlotte County
watering restriction notices; UF/IFAS turf irrigation guidance already
cited by the irrigation weekly emails.
