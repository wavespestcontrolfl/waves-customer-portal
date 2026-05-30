# Waves Lawn Care Program Explainer and Service Outline System

## Executive Summary

Build this as a compliance-controlled content system, not simply an AI writing feature.

The final product has three connected layers:

1. Public education page: an SEO-friendly and customer-friendly explanation of what Waves lawn care includes.
2. Approved content and facts library: the source of truth for turf protocols, seasonal messaging, product facts, safety language, local fertilizer rules, FAQs, and post-service report language.
3. Personalized service outline composer: a rules-first, AI-assisted customer packet generated from estimate data, turf type, service address, season, verified product facts, and approved copy modules.

Core architectural rule:

> Rules decide what can be said. Approved modules provide the facts. AI may assemble and polish, but it may not invent or determine product, safety, legal, or treatment claims.

## Product Goals

### Customer Goal

Help the customer understand what they are paying for before approving the estimate.

The customer should understand:

- lawn care is not the same treatment every month
- turf type changes the program
- season, weather, and local fertilizer rules change the program
- some products may be held because of heat, turf stress, labels, or local rules
- post-service reports show what actually happened
- Waves is selling a managed turf program, not a basic monthly spray

### Business Goal

Improve close rate, reduce objections, reduce expectation mismatches, and make service reporting feel like part of the value.

### Compliance Goal

Prevent unsupported product claims, unsafe safety language, invented EPA registration numbers, local-rule mistakes, and AI hallucinations.

## Non-Negotiable Design Principles

### "May Be Used" Beats "Will Be Applied"

The estimate outline explains what may be used based on turf type, season, weather, condition, label directions, and local rules.

The post-service report explains what was actually applied.

| Document | Language |
| --- | --- |
| Public page | Products and treatment categories may change by season and condition. |
| Estimate outline | These products or categories may be relevant for your lawn. |
| Service report | These products were applied today. |

### AI Cannot Create Regulated Facts

AI must not generate:

- EPA registration numbers
- active ingredients
- product rates
- treatment intervals
- re-entry intervals
- pesticide safety claims
- fertilizer legality claims
- pest guarantees
- disease guarantees
- turf compatibility claims
- local ordinance interpretations
- "safe for pets/kids" statements

AI can only summarize or assemble verified source modules.

### Customer Pages Stay Simple

Use three layers:

| Layer | Audience | Detail |
| --- | --- | --- |
| Public page | Prospects and customers | Plain-language |
| Personalized outline | Specific customer | Plain-language with optional detail |
| Internal admin/protocol view | Waves team | Technical detail |

### Generated Outlines Must Be Traceable

Every packet records:

- content module versions used
- product fact versions used
- turf protocol version used
- local rule version used
- estimate snapshot
- AI model version, if applicable
- admin edits
- approval status
- send history
- view history

The packet is a snapshot, not a live page that silently changes after modules are updated.

## Public Page Spec

URL:

`/lawn-care/what-is-included`

Page title:

`What's Included in a Waves Lawn Care Visit?`

Meta title:

`What's Included in Lawn Care Service? | Waves Lawn Care`

Meta description:

`Learn how Waves lawn care visits are planned around grass type, season, lawn condition, product accountability, local fertilizer rules, and post-service reporting.`

### Hero

Headline:

`What's Included in a Waves Lawn Care Visit?`

Subhead:

`Waves lawn care is a documented turf health program built around grass type, seasonal timing, lawn assessment, product accountability, and clear post-service reporting.`

Primary CTA:

`Request Lawn Care Estimate`

Secondary CTA:

`See How Visits Are Documented`

Trust bullets:

- Turf-specific program
- Season-aware treatments
- Product transparency
- Local fertilizer-rule awareness
- Photos and service notes
- Customer portal history

### Section 1: More Than a Standard Spray Visit

Core message:

`Assessment comes before application.`

Customer copy:

`Your lawn does not need the same treatment every visit. A Waves visit starts with assessment, then treatment decisions are adjusted based on turf type, season, weather, weed pressure, insect pressure, disease risk, irrigation, local fertilizer rules, and previous service history.`

### Section 2: What We Assess Each Visit

Checklist:

- turf color and density
- thinning or bare areas
- weed pressure
- sedge or grassy weed breakthrough
- insect pressure
- disease indicators
- irrigation coverage
- drought or heat stress
- mowing or scalping stress
- thatch indicators
- shade stress
- improvement or decline since last visit
- visible pest or disease patterns
- areas needing customer action

Positioning copy:

`Inspection is part of the service. The products used on a visit should reflect what the lawn actually needs, not just what is on a calendar.`

### Section 3: Turf Type Expectations

Use crawlable tabs or accordions.

#### St. Augustine

Headline:

`St. Augustine: Managed for density, color, stress, weeds, insects, and disease risk.`

Customer copy:

`St. Augustine is managed as one core turf program, then adjusted by site conditions such as shade, irrigation, heat stress, disease pressure, and herbicide safety.`

Priorities:

- density and color support
- chinch bug scouting
- weed and sedge management
- disease monitoring
- irrigation and stress observations
- soil-test-gated fertility decisions
- thatch checks
- seasonal pre-emergent planning

Internal protocol points that should drive logic but not dominate customer copy:

- apply Prodiamine Visit 1 by January 15 where applicable
- maximum three Celsius applications per property per year
- K-Flow rotation in June and September, calcium in July, magnesium/calcium in August
- explicit nitrogen rate control
- soil-test branching for phosphorus and potassium
- chinch IPM threshold
- FRAC rotation for disease history
- SpeedZone weather-gated at 90 F
- August drive-by scout
- December wellness touchpoint
- March and October thatch measurements
- irrigation audits
- one St. Augustine track; site observations drive shade/stress/herbicide decisions

#### Bermuda

Headline:

`Bermuda: Dense, durable turf that needs active management.`

Customer copy:

`Bermuda can produce dense, durable turf, but it requires active management. We track growth response, insect pressure, weed pressure, disease risk, and winter dormancy expectations.`

Priorities:

- controlled growth and density
- seasonal nitrogen planning
- weed pressure monitoring
- armyworm and mole cricket scouting
- disease prevention where history indicates risk
- winter dormancy expectations
- growth-regulator documentation where used

Internal protocol points:

- no Atrazine on Bermuda
- SpeedZone never above 90 F; use Celsius in summer broadleaf windows when appropriate
- Primo Maxx growth response documented when used
- high-input nitrogen budget
- SDS preventive calendar in fall before soil temperatures drop
- armyworm and mole cricket IPM
- August and December all-tier touchpoints

#### Zoysia

Headline:

`Zoysia: Dense turf that should be managed conservatively.`

Customer copy:

`Zoysia is managed conservatively because excess fertility and growth stimulation can create thatch and disease pressure.`

Priorities:

- lower nitrogen ceiling
- large patch monitoring and prevention
- careful growth management
- irrigation control
- thatch monitoring
- weed control without over-stressing turf

Internal protocol points:

- no Atrazine
- no Anuew EZ
- conservative Primo Maxx use
- SpeedZone never above 90 F
- Celsius for summer broadleaf windows where appropriate
- large patch FRAC rotation
- lower thatch threshold than Bermuda
- irrigation VWC audits

#### Bahia

Headline:

`Bahia: Realistic improvement for a low-input survival turf.`

Customer copy:

`Bahia care is about realistic improvement, weed reduction, mole cricket monitoring, and expectation management - not forcing Bahia to behave like premium irrigated St. Augustine.`

Priorities:

- weed reduction
- mole cricket monitoring
- realistic color and density expectations
- irrigated versus non-irrigated classification
- seed head expectations
- dormancy expectations
- reduced product load where appropriate

Internal protocol points:

- low-input turf
- maximum 2.0 lb N/K/year
- more nitrogen means more mowing, not better quality
- mole cricket is primary insect threat
- no PGR
- no Atrazine
- classify irrigated versus non-irrigated at Visit 1
- soapy flush method and threshold for mole cricket IPM
- fire ant protocol when history supports it
- crabgrass breakthrough curative path
- seed head and dormancy expectation talks

### Section 4: Seasonal Treatment Calendar

#### January-March: Prevention and Baseline

- pre-emergent planning
- early weed pressure control
- soil sample for new accounts where appropriate
- spring green-up preparation
- disease scouting
- irrigation observations
- baseline turf condition notes

#### April-May: Spring Nutrition and Pest Preparation

Launch-season copy for May 2026:

`Late spring is often focused on final spring nutrition decisions, iron and color support, weed and sedge checks, insect-pressure preparation, and getting the lawn ready for summer heat and local fertilizer restrictions.`

Include:

- final spring nutrition where allowed
- soil-test-gated phosphorus
- iron/color support
- biostimulants where appropriate
- sedge and weed checks
- heat-gated herbicide decisions
- pest pressure preparation
- summer stress planning

#### June-September: Summer Stress and Restricted-Season Strategy

Copy:

`Summer service often shifts away from pushing growth and toward stress management, pest scouting, micronutrient support, moisture observations, and careful product selection.`

Include:

- nitrogen/phosphorus restriction awareness
- potassium, calcium, magnesium, iron, and micronutrient support where appropriate
- heat-safe weed control
- chinch bug, armyworm, or mole cricket scouting depending on turf
- irrigation and moisture observations
- no unnecessary growth pushing

Do not hard-code one blackout rule for all customers. Fertilizer restrictions vary by jurisdiction.

#### October-December: Recovery, Disease Prevention, and Winter Prep

- fall recovery
- disease prevention where risk/history supports it
- thatch comparison
- winter potassium and magnesium support
- dormancy expectations for Bermuda and Bahia
- annual report
- December wellness touchpoint

### Section 5: Product Transparency

Public page starts with product categories and a few approved examples, not a full catalog dump.

Categories:

- weed prevention
- post-emergent weed control
- sedge control
- insect monitoring and treatment
- disease prevention or treatment
- fertilizer
- iron and micronutrients
- soil and root support
- wetting agents
- biostimulants
- growth management

Product cards require:

- product name
- category
- active ingredient, where applicable
- EPA registration number, where applicable
- fertilizer analysis, where applicable
- labeled turf species
- excluded turf species
- public-safe explanation
- timing reason
- customer precaution language
- label source
- label verified date
- public visibility status
- content approval status

Product card language:

`This product may be used when site conditions, turf type, season, label directions, and local rules allow.`

### Section 6: Safety and Label Compliance

Recommended copy:

`When a pesticide product is used, it is applied according to label directions. EPA registration numbers are provided where applicable. Fertilizers, biostimulants, soil amendments, and some support products may not have EPA registration numbers because they are not pesticide products.`

Pet/child wording:

`After a treatment, follow the technician's service report and any product-specific instructions. As a general precaution, people and pets should stay off treated areas until the application has dried, unless the product label or technician instructions require a longer interval.`

Avoid blanket "safe for pets and children" claims.

### Section 7: Post-Service Reports

Positioning:

`You should not have to guess what happened after a visit.`

Each report should include:

- service date
- technician
- service type
- areas serviced
- products actually applied
- EPA registration number where applicable
- active ingredient where applicable
- lawn observations
- photos
- technician notes
- what to expect
- customer action items
- follow-up items

Core distinction:

`The estimate outline explains what may be used. The post-service report shows what was actually done.`

### Section 8: GPS Tracking, Reminders, and Customer Portal

GPS-tracked service history:

- documents arrival/completion
- supports accountability
- helps review service questions

Service reminders:

- upcoming visit
- service completed
- report ready
- follow-up item reminder

Customer portal:

- service reports
- invoices
- upcoming visits
- photos
- recommendations
- service history
- communication

### Section 9: What This Does Not Include

Copy:

`Lawn care treatments support turf health, weed control, pest monitoring, and seasonal improvement, but some issues require separate work or customer action.`

Examples:

- irrigation repairs are not included unless separately quoted
- mowing is not included unless separately quoted
- bare areas may require sod, seed, topdressing, irrigation correction, or cultural changes
- heavy shade may limit turf density
- disease or pest outbreaks may require follow-up treatment
- non-irrigated Bahia has different expectations than irrigated turf
- results depend on watering, mowing, weather, soil, shade, and prior lawn condition

### Section 10: FAQs

Recommended FAQs:

1. What is included in a lawn care visit?
2. Do you use the same products every month?
3. Are your products EPA registered?
4. Are treatments safe for pets and children?
5. Why was fertilizer not applied during my visit?
6. Why do you skip some products in summer?
7. Why does Bahia look different than St. Augustine?
8. Why does Bermuda turn brown in winter?
9. Why is Zoysia treated more conservatively?
10. What is a post-service report?
11. Can I see what products were used?
12. What should I do after my lawn treatment?
13. How long until I see results?
14. What if my lawn has mixed turf types?
15. What if irrigation coverage is poor?

## Personalized Service Outline Spec

Customer-facing name:

`Your Waves Lawn Care Program Overview`

Internal feature name:

`Waves AI Lawn Service Outline Composer`

Primary locations:

- lawn estimate screen
- estimate preview workflow
- Waves AI panel

Secondary locations:

- customer profile
- lead profile
- pipeline action menu
- post-estimate follow-up workflow

Main button:

`Generate Lawn Service Outline`

Secondary actions:

- Preview
- Save Draft
- Copy Link
- Send SMS
- Send Email
- Send Both
- Regenerate From Latest Facts
- Revoke Link

## Admin Workflow

1. Admin opens or creates a lawn estimate.
2. System detects `service_line = lawn_care`.
3. Admin clicks `Generate Lawn Service Outline`.
4. Composer opens.
5. System pulls customer, address, estimate, turf type, lawn square footage, service tier, current month, jurisdiction, protocol summary, local fertilizer rule, approved content modules, approved product facts, and prior service reports if available.
6. System runs validation.
7. Admin chooses detail level: concise, standard, or technical.
8. System generates preview.
9. Admin can edit greeting, customer-specific note, visible exclusions, and CTA text.
10. Admin cannot freely edit safety claims, EPA registration numbers, product facts, local rule text, label-supported claims, or application eligibility logic.
11. Admin approves packet.
12. Admin sends by SMS/email or copies link.
13. Timeline event is logged.
14. Customer opens packet.
15. View event is logged.
16. Customer clicks estimate CTA.
17. Approval/conversion event is logged.

## Generated Outline Structure

Title:

`Your Waves Lawn Care Program Overview for [Turf Type]`

Intro:

`Based on your estimate, this outline explains how Waves approaches your lawn care program, what we assess each visit, why treatments change by season, and how your service is documented.`

Sections:

1. Property summary
2. Your turf type
3. This season's focus
4. What a typical visit includes
5. Products or treatment categories that may be relevant
6. Why timing matters
7. Safety and product transparency
8. Local fertilizer-rule note
9. What to expect after service
10. Post-service reports
11. Portal, reminders, and GPS-tracked service history
12. What this does not include
13. CTA to view or approve estimate

## Turf-Specific Logic

### Unknown Turf

Generate a limited outline:

`We will confirm turf type and site conditions during the first visit before finalizing treatment decisions.`

Do not show turf-specific product recommendations.

### Mixed Turf

Show:

`Your lawn appears to include more than one turf type. Mixed turf requires more careful treatment decisions because a product or approach that fits one area may not fit another.`

Require admin confirmation before sending product details.

Supported mixed turf cases:

- St. Augustine + Bahia
- Bermuda + Bahia
- St. Augustine + Zoysia
- newly installed sod
- shaded turf zones
- non-irrigated turf zones
- high-traffic zones
- commercial multi-zone properties

## Season and Month Logic

May 2026 outline emphasis:

- final spring nutrition where allowed
- soil-test-gated phosphorus
- iron/color support
- biostimulants where appropriate
- sedge and weed checks
- summer heat preparation
- pest-pressure preparation
- upcoming local fertilizer restrictions

June-September emphasis:

- no nitrogen/phosphorus where restricted by local rule
- potassium, calcium, magnesium, iron, and micronutrient support where appropriate
- heat-safe weed control only
- pest scouting
- moisture and irrigation observations
- no unnecessary growth pushing

October-December emphasis:

- recovery
- disease prevention where relevant
- winter hardening
- dormancy expectations
- thatch comparison
- annual report or wellness touchpoint

January-March emphasis:

- pre-emergent timing
- early weed control
- soil sample where appropriate
- baseline scouting
- spring green-up preparation
- irrigation observations

## Local Fertilizer Rule Resolver

Build this as its own subsystem.

Resolver inputs:

- service address
- county
- municipality
- parcel or geocode, if available
- service date
- product category
- fertilizer analysis
- nitrogen content
- phosphorus content
- slow-release nitrogen percentage
- soil test status
- new turf exception
- storm/rain restriction
- waterway buffer condition, if available

Resolver output example:

```json
{
  "jurisdiction_id": "sarasota_county_fl",
  "rule_version": "2026-05-30",
  "restricted_season_active": true,
  "restricted_start": "2026-06-01",
  "restricted_end": "2026-09-30",
  "nitrogen_allowed": false,
  "phosphorus_allowed": false,
  "phosphorus_soil_test_required": true,
  "minimum_slow_release_nitrogen_percent": 50,
  "public_summary": "Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.",
  "admin_warning": "Do not include nitrogen/phosphorus fertilizer recommendations unless an allowed exception applies."
}
```

Customer-facing wording:

`Based on your service area, local fertilizer rules may affect whether nitrogen or phosphorus can be applied during certain months. When fertilizer is restricted, the visit may focus on inspection, weed or pest monitoring, micronutrients, iron, soil support, moisture observations, and stress management instead.`

## Product Registry Upgrade

Treat the product registry as a compliance object.

Required fields:

```text
products
- id
- name
- manufacturer
- category
- product_type
- active_ingredient
- epa_registration_number
- fertilizer_analysis
- label_source_url
- label_file_id
- label_verified_at
- label_version
- labeled_turf_species
- excluded_turf_species
- allowed_service_lines
- restricted_service_lines
- rate_unit
- rate_public_visibility
- public_summary
- portal_summary
- service_report_summary
- customer_precaution_summary
- pet_child_guidance
- reentry_summary
- use_conditions
- heat_restrictions
- irrigation_notes
- local_rule_sensitivity
- approved_for_public_page
- approved_for_estimate_packet
- approved_for_service_report
- content_status
- approved_by
- approved_at
- review_due_at
- created_at
- updated_at
```

A product cannot appear in a customer packet unless:

- `approved_for_estimate_packet = true`
- `content_status = approved`
- label data is verified
- turf type is compatible
- month/season is compatible
- local rule resolver allows the category
- safety copy exists
- product fact record is not stale

## Approved Content Module System

Table:

```text
content_modules
- id
- key
- title
- audience
- body_json
- plain_text
- status
- version
- valid_from
- valid_to
- approved_by
- approved_at
- source_notes
- created_at
- updated_at
```

Required modules:

1. `lawn_program_overview`
2. `assessment_protocol`
3. `st_augustine_protocol_summary`
4. `bermuda_protocol_summary`
5. `zoysia_protocol_summary`
6. `bahia_protocol_summary`
7. `mixed_turf_summary`
8. `unknown_turf_summary`
9. `season_jan_mar`
10. `season_apr_may`
11. `season_jun_sep`
12. `season_oct_dec`
13. `product_transparency`
14. `safety_and_label_compliance`
15. `local_fertilizer_rules`
16. `post_service_reports`
17. `gps_tracking`
18. `service_reminders`
19. `customer_portal`
20. `what_to_expect`
21. `what_this_does_not_include`
22. `faq`
23. `estimate_cta`
24. `service_report_actual_products`

## AI Architecture

Use a rules-first composer with AI-assisted tone.

1. Data collection: pull estimate, customer, property, turf, address, month, tier, local rules, protocol modules, seasonal modules, product facts, and prior service summaries.
2. Deterministic eligibility: rules engine decides allowed turf module, seasonal module, local rule language, allowed product categories, allowed product cards, blocked facts, warnings, and exclusions.
3. Content assembly: system assembles approved modules.
4. AI polish: AI may shorten, expand, adjust reading level, warm tone, summarize approved facts, and write customer-friendly intro/closing.
5. Validation: system scans final output before save/send.
6. Admin review: admin previews warnings and approves.

## AI Guardrails

Hard-banned generated claims:

- safe for pets
- safe for kids
- guaranteed green lawn
- kills all bugs
- eliminates weeds permanently
- always applied
- non-toxic
- chemical-free
- harmless
- no risk
- EPA approved
- organic, unless substantiated
- pesticide-free, unless literally true
- will be applied
- guaranteed results
- permanent solution
- one-time fix
- no need to water
- no follow-up needed

Required replacements:

| Risky phrase | Approved replacement |
| --- | --- |
| safe for pets and kids | follow label and technician instructions before re-entering treated areas |
| will be applied | may be used when conditions allow |
| guaranteed green lawn | supports turf color and health where site conditions allow |
| kills all bugs | targets listed pests when label and site conditions allow |
| chemical-free | avoid unless literally true and approved |
| EPA approved | use EPA registered where applicable |

Missing product fact fallback:

`Specific products are selected by the technician based on turf condition, weather, label directions, and local rules. Product details are provided in the post-service report when an application is made.`

## Validation and Blocked States

Block send if:

- turf type is unknown and product details are enabled
- service address cannot resolve jurisdiction
- local fertilizer rule is missing
- selected product lacks approved public summary
- selected pesticide lacks EPA registration number
- selected product label is stale
- safety copy is missing
- content module is not approved
- banned phrase appears
- AI output introduces unapproved product fact
- packet contains full address and public token page is enabled
- estimate is missing required CTA
- customer lacks SMS consent and SMS send is selected

Allow limited send if:

- turf type is unknown but product details are disabled
- product cards are hidden
- local rule language is generic and approved
- admin accepts warning

Limited packet wording:

`This outline explains the Waves lawn care process at a high level. Turf-specific product decisions will be confirmed after the first lawn assessment.`

## Data Model

### `service_outline_packets`

```text
service_outline_packets
- id
- customer_id
- lead_id
- estimate_id
- service_line
- status
- title
- turf_type
- turf_confidence
- mixed_turf_flag
- protocol_track
- service_tier
- month
- season_band
- jurisdiction_id
- fertilizer_rule_version
- content_library_version
- protocol_version
- product_registry_version
- template_version
- ai_model_version
- generation_mode
- estimate_snapshot_json
- input_snapshot_json
- summary_json
- content_json
- content_html
- validation_status
- validation_errors_json
- admin_warnings_json
- token_hash
- token_last_four
- token_created_at
- expires_at
- revoked_at
- noindex
- created_by
- approved_by
- approved_at
- sent_at
- sent_method
- first_viewed_at
- last_viewed_at
- view_count
- created_at
- updated_at
```

### `service_outline_events`

```text
service_outline_events
- id
- packet_id
- customer_id
- lead_id
- estimate_id
- event_type
- metadata_json
- actor_type
- actor_id
- ip_hash
- user_agent_hash
- created_at
```

### `service_outline_packet_products`

```text
service_outline_packet_products
- id
- packet_id
- product_id
- product_fact_version
- display_mode
- relevance_reason
- eligibility_status
- blocked_reason
- created_at
```

### `jurisdiction_fertilizer_rules`

```text
jurisdiction_fertilizer_rules
- id
- jurisdiction_id
- jurisdiction_name
- state
- county
- municipality
- restricted_start_month
- restricted_start_day
- restricted_end_month
- restricted_end_day
- nitrogen_restricted
- phosphorus_restricted
- phosphorus_soil_test_required
- minimum_slow_release_nitrogen_percent
- storm_event_restriction
- waterway_buffer_rule
- new_turf_exception
- professional_certification_note
- public_summary
- admin_summary
- source_url
- source_verified_at
- status
- version
- created_at
- updated_at
```

### `packet_admin_edits`

```text
packet_admin_edits
- id
- packet_id
- edited_by
- field_key
- old_value
- new_value
- edit_type
- requires_approval
- approved_by
- approved_at
- created_at
```

## Backend Routes

Admin routes:

```text
GET    /api/admin/service-outlines/templates
GET    /api/admin/service-outlines/content-modules
POST   /api/admin/service-outlines/validate
POST   /api/admin/service-outlines/preview
POST   /api/admin/service-outlines
GET    /api/admin/service-outlines/:id
PATCH  /api/admin/service-outlines/:id
POST   /api/admin/service-outlines/:id/approve
POST   /api/admin/service-outlines/:id/send
POST   /api/admin/service-outlines/:id/revoke
POST   /api/admin/service-outlines/:id/regenerate
GET    /api/admin/service-outlines/:id/events
```

Product/fact routes:

```text
GET    /api/admin/product-public-facts
GET    /api/admin/product-public-facts/:id
PATCH  /api/admin/product-public-facts/:id
POST   /api/admin/product-public-facts/:id/approve
```

Public route:

```text
GET    /service-outlines/:token
```

## Tokenized Public Page Security

Required controls:

- high-entropy random token
- store only token hash
- never store raw token after creation
- token expiration
- revocation
- noindex/noarchive
- rate limiting
- minimal PII
- no invoices on public token page
- no payment links unless behind authenticated session
- no full address unless absolutely necessary
- no third-party analytics that leak token path
- referrer policy
- HTTPS only
- audit log views
- separate token packet access from authenticated portal access

Public page should show:

- first name or customer display name
- partial property summary
- turf type
- service outline
- estimate CTA

Public page should not show:

- full billing history
- invoices
- payment methods
- private notes
- internal protocol notes
- internal pricing logic
- exact property details beyond what is necessary
- unrelated customer records

## Admin UI Layout

Composer drawer/modal:

- Header: customer, estimate number, service address summary, turf type, service tier, current season/month, validation badge.
- Left panel: turf type selector, confidence, mixed turf toggle, detail level, section toggles, CTA type.
- Main panel: live preview with collapsible sections, product cards, safety section, local rule note, CTA.
- Right panel: missing facts, local rule status, label verification status, module versions, AI guardrail status, banned phrase scan, blocked reasons, warnings, internal notes.
- Footer: Save Draft, Preview Public Page, Copy Link, Send SMS, Send Email, Send Both, Approve, Revoke Link.

## Client Page Layout

Sections:

1. Header with Waves logo, title, and estimate CTA
2. Property summary
3. Your turf type
4. This season's focus
5. What each visit includes
6. What we inspect
7. Products or treatment categories that may be relevant
8. Product transparency
9. Safety and label compliance
10. Local fertilizer-rule note
11. What to expect after service
12. Post-service report preview
13. GPS, reminders, and portal
14. What this does not include
15. CTA

## SMS/Email Sending Compliance

Required SMS fields:

```text
customer_communication_preferences
- customer_id
- sms_consent_status
- sms_consent_source
- sms_consent_at
- sms_revoked_at
- email_consent_status
- email_unsubscribed_at
- transactional_sms_allowed
- marketing_sms_allowed
- last_updated_at
```

Before SMS send:

- customer has valid SMS consent
- message type is classified
- opt-out language is included where required
- STOP handling is active
- revoked customers are blocked
- send event is logged

Recommended SMS copy:

`Waves: Your lawn care program overview is ready: [link] Reply STOP to opt out.`

## Implementation Phases

### Phase 0: Foundation and Risk Control

Deliverables:

- approved content module structure
- product public fact schema
- local fertilizer rule resolver design
- safety copy library
- banned phrase list
- validation requirements
- public token security requirements
- SMS consent requirements

Exit criteria:

- team agrees what AI can and cannot say
- required data fields are defined
- compliance-sensitive copy is approved

### Phase 1: Content Source of Truth

Deliverables:

- content modules
- turf summaries
- seasonal summaries
- safety module
- local rule module
- product transparency module
- post-service report module
- what-this-does-not-include module
- FAQ module

Exit criteria:

- all required modules have approved versions
- modules are reusable by public page, estimate packet, and service report
- public-safe and internal-only content are separated

### Phase 2: Product Registry Upgrade

Deliverables:

- product fact fields
- public visibility controls
- label verification fields
- review due dates
- approval workflow
- product-card eligibility rules

Exit criteria:

- no customer-facing product card can render from unapproved facts
- pesticide and non-pesticide products are clearly separated
- stale product facts trigger warnings or blocks

### Phase 3: Public Page MVP

Deliverables:

- hero
- assessment section
- turf sections
- seasonal calendar
- product transparency section
- safety section
- post-service report section
- GPS/reminders/portal section
- what-this-does-not-include section
- FAQs
- CTAs

Exit criteria:

- page is crawlable
- page is readable by a homeowner
- CTAs work
- content uses approved modules
- no banned phrases
- no unsupported claims

### Phase 4: Rules-First Admin Composer

Deliverables:

- composer UI
- deterministic content assembly
- turf logic
- season logic
- local rule summary
- product category eligibility
- preview
- save draft
- validation warnings
- blocked send states

Exit criteria:

- admin can generate valid standard outline in under 30 seconds
- missing facts produce warnings or blocks
- generated packet is traceable to module versions
- AI is not required for core output

### Phase 5: AI-Assisted Polish

Deliverables:

- tone adjustment
- concise/standard/technical detail levels
- customer-friendly intro generation
- summary generation from approved modules
- post-generation validation

Exit criteria:

- AI output passes banned phrase scan
- AI output does not introduce unsupported facts
- admin sees source/fact status
- packets can be regenerated from latest approved modules

### Phase 6: Tokenized Customer Packet

Deliverables:

- public packet page
- secure token generation
- token hash storage
- expiration
- revocation
- noindex
- rate limiting
- view tracking
- CTA tracking

Exit criteria:

- page exposes minimal PII
- revoked/expired links fail safely
- packet views are logged
- estimate CTA works

### Phase 7: Sending and Timeline

Deliverables:

- SMS send
- email send
- copy link
- resend
- delivery status
- timeline logging
- consent checks
- STOP/revocation handling

Exit criteria:

- no SMS sends without valid consent
- failed sends are logged
- timeline shows outline lifecycle
- customer replies/opt-outs are handled

### Phase 8: Post-Service Report Integration

Deliverables:

- service report uses same product facts
- service report distinguishes actual applied products
- product cards match packet language
- report references relevant customer expectations
- follow-up items are logged

Exit criteria:

- estimate, outline, and service report tell the same story
- customer can see may be used versus was applied
- product transparency continues after the sale

## Success Metrics

Sales metrics:

- estimate approval rate before/after launch
- packet view-to-approval conversion rate
- percentage of estimates sent with outline
- time from estimate creation to customer send
- CTA click-through rate
- close rate by turf type
- close rate by detail level

Customer understanding metrics:

- reduction in "what is included?" calls/texts
- reduction in "why didn't you fertilize?" complaints
- reduction in "what did you apply?" questions
- customer portal report views
- post-service report open rate

Admin efficiency metrics:

- average time to generate outline
- average time to send outline
- percentage of packets requiring manual edits
- number of blocked generations
- most common missing facts

Compliance metrics:

- packets sent with unsupported product facts: 0
- packets sent with banned phrases: 0
- packets sent with stale product facts: 0
- packets sent without local rule resolution: 0 unless limited/generic mode
- packets sent with unapproved safety language: 0

SEO/content metrics:

- organic traffic to public page
- rankings for lawn care included/service terms
- internal CTA clicks
- estimate requests from public page
- scroll depth
- FAQ engagement
- turf section engagement

## Launch Acceptance Checklist

Content:

- all required modules approved
- public and internal content separated
- what-this-does-not-include section approved
- FAQs approved
- safety language approved

Product facts:

- public product summaries approved
- EPA registration numbers verified where applicable
- non-pesticide products clearly marked
- stale label review dates flagged
- product-card eligibility rules working

Local rules:

- jurisdiction resolver works for target service areas
- restricted season logic works
- fallback copy approved
- admin warnings visible

AI and validation:

- AI cannot output unsupported facts
- banned phrase scanner works
- blocked send states work
- missing facts produce fallback copy
- content versions are stored

Security:

- token is high entropy
- token hash stored
- token expiration works
- revocation works
- noindex works
- rate limiting enabled
- no financial/private data on public packet
- HTTPS only

Sending:

- SMS consent check works
- email send works
- STOP/revocation handling works
- send events logged
- view events logged
- failed sends logged

UX:

- admin can generate/send in under 30 seconds
- customer page is mobile-friendly
- CTA is obvious
- packet is understandable without technical knowledge

## MVP Cuts

Do not include in MVP:

- full product card library
- highly technical protocol details by default
- AI-generated product explanations
- product rates
- broad technical mode for customers
- full prior service history
- invoice/payment data on public token pages
- complex predictive product recommendations
- unverified local municipality rules
- FAQ schema as a major SEO dependency

MVP focuses on:

1. approved public page
2. approved content library
3. product fact safety controls
4. deterministic outline composer
5. secure customer packet
6. send/view/timeline tracking
7. post-service report alignment

## Final Recommendation

Build this as a Waves Lawn Care Content and Outline System, not an AI estimate writer.

The strongest first release is:

1. Content source of truth
2. Product registry public-fact upgrade
3. Public page
4. Rules-first service outline composer
5. Secure tokenized client packet
6. SMS/email send with consent controls
7. Post-service report integration
