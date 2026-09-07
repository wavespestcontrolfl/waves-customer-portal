# SMS template and deliverability audit — September 7, 2026

The repository's SMS library reconstructs to **129 templates**. With the base sample below, **70 fit one segment and 59 fit two**. Longer personalization and conditional clauses move **six templates into three segments**. The separate review-outreach registry contains 13 bodies; all fit one segment with the base sample.

**These are source-model counts, not production database counts or sent-message counts.** Templates and active variants are editable in the database. No production database was queried. A read-only Twilio Messages API request returned HTTP 401, so actual delivery rates, billed segments, registration state, and carrier filtering remain unverified. No SMS or email was sent.

Audit target: local `main`, SHA `a2bb0bc49b9f6a1ebb776af29ee58a3d1439c9cf`. The shared checkout's unrelated changes were preserved. Local implementation is on `codex/sms-audit-20260907` in `/Users/wavespestcontrol/wt-sms-audit-20260907`. Remote main was not refreshed and deployment was not verified.

The [template-by-template CSV](sms-template-audit-2026-09-07.csv) includes every modeled template, sample renders, segment counts before/after link formatting, and its source file. The [evidence JSON](sms-template-audit-2026-09-07-evidence.json) records all sample variables and scenarios.

**How the counts were calculated**

The offline model evaluates 107 SMS-related migration sources in filename order against an in-memory table. It applies their conditional copy changes and deletions without importing the app, connecting to PostgreSQL, or running SQL. This models repository defaults; it cannot reproduce administrator edits, existing variant rows, historical production state, or enabled feature gates. It is not PostgreSQL migration verification.

Bodies are measured after placeholder substitution, time formatting, existing portal-scheme stripping, whitespace cleanup, and the application's GSM punctuation normalization. Counts use `server/services/messaging/segment-counter.js`. Every sample is synthetic.

| Library scenario | 1 segment | 2 segments | 3 segments | 4 segments | Total |
|---|---:|---:|---:|---:|---:|
| Base sample | 70 | 59 | 0 | 0 | 129 |
| Longer sample + conditional clauses | 56 | 67 | 6 | 0 | 129 |
| Longer sample + token-URL fallback | 41 | 78 | 9 | 1 | 129 |

Base: eight-character first name, `Quarterly Pest Control`, ordinary displayed dates, normal appointment/reschedule links, 10-character short codes, and invoice links with an invoice/date prefix. Conditional fee, card-hold, past-due, and similar clauses are empty. This is a reproducible base case, **not an assertion that these clauses are usually absent**.

Longer sample: 12-character first name, a combined service label, and populated conditional clauses. The $50 fee and $100 balance are illustrative inputs, not verified live configuration. Short links still work. The last scenario additionally substitutes 64-character token links to illustrate shortener-failure sensitivity; it is neither a universal maximum nor proof that all routes use 64-character tokens.

The model marks 112 rows enabled and 17 disabled. Among those 112 modeled enabled rows, the base split is 59/53/0 and the longer split is 47/59/6. Actual production toggles and sender reachability are unknown; a default enabled row does not prove its workflow sends.

The review-outreach registry is counted separately to avoid conflating it with editable `sms_templates` rows. Its 13 bodies include one labeled `Final Nudge (email)`; these are registry choices, not 13 active SMS automations. Base split: 13/0/0. With the longer name: 12/1/0 before the local change and 13/0/0 afterward. With fallback long links: 3/10/0. Dynamic/manual/AI text, referral settings overrides, custom database templates, and active database variants have no complete fixed source inventory and are outside these numeric totals.

For US local-number SMS, GSM-7 permits 160 units in one segment and 153 per concatenated segment: two segments hold 306 units, three hold 459. Unicode reduces this to 70/67; extension characters and emoji require special counting. US/Canada toll-free concatenation instead uses 152/66. Twilio recommends keeping messages under 320 characters; a strict two-segment GSM budget is slightly tighter at 306. These counts assume local-number GSM SMS, not MMS. [Twilio segment guidance](https://www.twilio.com/docs/glossary/what-sms-character-limit).

**Templates to shorten first**

| Template | Longer sample GSM units | Segments | Main contributor |
|---|---:|---:|---|
| `reminder_24h` | 448 | 3 | Older verbose reminder plus card-hold disclosure |
| `secure_appointment_card_plans` | 354 | 3 | Payment choices, link, cancellation-fee and card-security disclosures |
| `reminder_24h_v2` | 351 | 3 | Visit-details link plus card-hold disclosure |
| `reminder_72h` | 343 | 3 | Reschedule link plus card-hold disclosure |
| `service_complete_with_invoice` | 308 | 3 | Report link, invoice link, previous-balance clause |
| `service_report_v1_with_invoice` | 308 | 3 | Same two-link and previous-balance combination |

These six remain three segments after universal HTTPS-prefix removal: their portal links already lose the prefix. The two report/invoice examples are only two units over the two-segment limit, but should be shortened with room for different names and balances. The older 24-hour reminder reaches four segments in the fallback-link scenario.

Retain required financial and consent disclosures. Shorten surrounding prose and link labels, and evaluate all conditional combinations before rewriting templates. A single well-chosen destination can reduce length when the destination truly contains everything promised; removing an invoice link from a billed report without verifying that contract would be a regression.

**Findings and recommendations**

1. **Link formatting was inconsistent across outbound paths.** At the audited HEAD, `server/routes/admin-sms-templates.js:112` stripped only two portal hosts, while `server/services/twilio.js:408` normalized punctuation without stripping URLs. External review links and direct/manual builders could retain HTTPS. The local fix uses `server/services/messaging/sms-link-policy.js:4` for the renderer, composer link inserts, link-presence checks, send audit, and Twilio boundary. It strips the leading HTTPS display prefix while retaining nested URL values and destination bytes. URLs used by email, redirects, and Twilio media/status callbacks retain their schemes. MMS captions retain their existing behavior.

2. **Protocol removal has a modest segment benefit.** In the base library sample, it saves eight characters in `review_request_followup` without reducing that template's segment count; all other library sample links already use portal stripping or are already bare. It also saves eight characters for linked review-outreach messages that bypassed the renderer, moving the longer `winback_ask` example from two segments to one. I found no evidence in Twilio's guidance that hiding HTTPS itself improves carrier deliverability. Twilio's own shortening examples retain HTTPS and emphasize domain ownership. Bare-link tapping and previews remain device-dependent and were not tested on phones. [Twilio link shortening](https://www.twilio.com/docs/messaging/features/link-shortening).

3. **Shortener failures increase length.** `server/services/short-url.js:184` deliberately returns the original URL on failure. Keep this delivery-preserving fallback, but measure how often it occurs and budget templates for it. Prefer the existing branded `/l/` mechanism consistently; preserve token entropy and permanent receipt access. Twilio identifies shared public shorteners and domain reputation as filtering concerns. [Twilio deliverability guidance](https://www.twilio.com/en-us/blog/high-volume-messaging-solution).

4. **Template preview is not a final SMS budget check.** `server/routes/admin-sms-templates.js:243` returns raw/substituted character lengths; it does not expose final encoding or segment counts. The renderer separately selects variants at `server/routes/admin-sms-templates.js:417`. Extend the existing preview/editor to show final sent text, encoding, segments, and room remaining, with longer samples and variants. The outgoing segment validator is intentionally advisory (`server/services/messaging/segment-counter.js:143`); do not start silently dropping essential notices over length.

5. **Conditional migrations leave multiple plausible copy versions.** `server/models/migrations/20260801000001_sms_house_voice_sweep.js` preserves administrator edits with exact-body predicates; the earlier audit migration also falls back to mechanical edits (`server/models/migrations/20260730000020_sms_template_audit.js:101`). That protection means reading only the latest rewrite table overstates coverage. The reconstructed catalogue retains older copy in some paths, including the 24-hour reminder. A complete live inventory needs the actual base and active-variant rows before choosing copy to replace.

6. **Existing safeguards should be retained.** GSM punctuation normalization already runs at `server/services/twilio.js:408`; meaningful non-GSM names can still require Unicode. Measure final output instead of treating `.length` as segments. Maintain consent, STOP suppression, appropriate cadence, and sender identification. Twilio distinguishes informational consent from promotional consent and requires sender identification except in ongoing conversations; first messages need an opt-out instruction. This is a delivery-policy review, not a finding that live Waves consent is defective. [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy).

7. **Measure carrier outcomes once read access is restored.** Review a full recent period of outbound SMS by `delivered`, `undelivered`, `failed`, actual provider `num_segments`, sender, link host, and error code. The application audit currently records its own estimate (`server/services/messaging/audit.js:62`), while the status callback reads status/error fields (`server/routes/twilio-webhook.js:1384`). Correlate long messages with failures before blaming segmentation. Specifically check [30007 filtering](https://www.twilio.com/docs/api/errors/30007) and [30034 unregistered senders](https://www.twilio.com/docs/api/errors/30034), and verify every outbound local number belongs to the approved A2P campaign. Queue acceptance and final delivery are separate outcomes. [Twilio status lifecycle](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks).

**Local implementation and validation**

The requested SMS HTTPS-prefix change is implemented locally, including stored-template and variant rendering, composer inserts, direct sends, and segment-audit consistency. The old host-specific helper and contradictory external-link lint rule were removed; internal callers now share one helper. Existing public-shortener detection remains in place. No dependency, database schema, token destination, fee, consent rule, or feature gate changed.

381 focused tests passed across 13 suites, covering the renderer and variants, composer link paths, payment-link presence, segment-audit agreement, direct Twilio calls, callback/media URLs, nested query preservation, and lint policy. `npm run check:domain-rules` passed. ESLint returned no errors; touched legacy modules have existing structural/unused warnings. `git diff --check` passed.

No production migration, application startup, device delivery test, push, PR, merge, or deployment was performed. The change is available for review in the isolated checkout.

Reproduce the offline inventory with `node docs/audits/sms-template-audit-2026-09-07-render.cjs`. That command rewrites only the local audit evidence JSON and CSV. `sms-template-audit-2026-09-07-reproduce.cjs` contains the isolated migration-source evaluator; its optional standalone output is the catalogue JSON.
