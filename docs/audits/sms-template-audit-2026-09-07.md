# SMS template and deliverability audit — September 7, 2026

The refreshed repository SMS library reconstructs to **132 templates**. Before this change, the base sample is **70 one-segment / 61 two-segment / 1 three-segment**. After universal HTTPS display-prefix removal and seven copy trims, it is **73 / 59 / 0**. With longer personalization and conditional clauses, three-segment templates fall from **seven to four**. The separate review-outreach registry contains 13 bodies; all fit one segment with the base sample.

**These are source-model counts, not production database counts or sent-message counts.** Templates and active variants are editable in the database. No production database was queried. The local Twilio credentials initially returned HTTP 401; a subsequent read using the deployed credentials succeeded. Actual provider outcomes are reported separately below. No production database connection was made. No SMS or email was sent.

Audit baseline: refreshed `origin/main`, SHA `aa1e0d15d` (September 7). The initial checkout count of 129 was superseded when remote main was refreshed: three newer templates are included here. Secure-card samples now use the actual 22-character bearer shape, and prep-guide links use 32-character tokens. Local implementation is on `codex/sms-audit-20260907`; deployment is not verified.

The [template-by-template CSV](sms-template-audit-2026-09-07.csv) includes every modeled template, sample renders, segment counts before/after link formatting and copy changes, and its source file. The reproduction command also writes `.tmp/sms-audit/evidence.json` with every sample variable and scenario. Generated catalogue/evidence JSON is kept out of the diff; the CSV and source evaluator are committed.

**Actual Twilio outcomes**

Read-only Messages API inventory, `DateSent > 2026-08-08` through September 7 at 07:52 UTC, fully paginated (two pages). These are actual sends, distinct from the template examples above. Only aggregate counts were retained in the [provider evidence](sms-template-audit-2026-09-07-delivery.json); no recipients, bodies, credentials, or message identifiers were saved.

- **1,465 outbound SMS: 1,457 delivered (99.45%), five failed, three undelivered.**
- Provider segment distribution: **1,048 one-segment / 414 two-segment / 3 three-segment** SMS. All three three-segment messages delivered. The segment field is provider-reported; it is not a billing reconciliation.
- Seven additional outbound MMS all delivered and are excluded from the SMS counts.
- Four errors were [21610: recipient opted out](https://www.twilio.com/docs/api/errors/21610); three were [30006: landline or unreachable carrier](https://www.twilio.com/docs/api/errors/30006); one was [21266: sender and recipient numbers were the same](https://www.twilio.com/docs/api/errors/21266).
- No 30007 filtering or 30034 unregistered-sender errors appeared in this window.
- One Messaging Service has a `VERIFIED` A2P campaign. All 30 SMS-capable local numbers belong to that service; none were outside it. This verifies campaign status and service membership, not individual handset receipt or every carrier's registration state. [Twilio campaign status API](https://www.twilio.com/docs/messaging/api/usapptoperson-resource).

The observed failures do not point to message length or spam filtering as the current problem. The three long-message observations are too few to establish a general delivery guarantee. Keep honoring opt-outs, avoid repeat attempts to landlines, and check the self-addressed-send path. Existing suppression/Lookup guards remain; this PR changes formatting/copy, not recipient policy.

**How the counts were calculated**

The offline model evaluates 111 SMS-related migration sources in filename order against an in-memory table. It applies their conditional copy changes and deletions without importing the app, connecting to PostgreSQL, or running SQL. This models repository defaults; it cannot reproduce administrator edits, existing variant rows, historical production state, or enabled feature gates. It is not PostgreSQL migration verification.

Bodies are measured after placeholder substitution, time formatting, whitespace cleanup, and the application's GSM punctuation normalization. Before counts use the original seven bodies and old portal-only scheme stripping; after counts use the revised bodies and universal HTTPS display-prefix removal. Counts use `server/services/messaging/segment-counter.js`. Every sample is synthetic.

| Library scenario | Before: 1 / 2 / 3 / 4 segments | After: 1 / 2 / 3 / 4 segments | Total |
|---|---:|---:|---:|
| Base sample | 70 / 61 / 1 / 0 | 73 / 59 / 0 / 0 | 132 |
| Longer sample + conditional clauses | 56 / 69 / 7 / 0 | 56 / 72 / 4 / 0 | 132 |
| Longer sample + token-URL fallback | 41 / 80 / 10 / 1 | 41 / 81 / 10 / 0 | 132 |

Base: eight-character first name, `Quarterly Pest Control`, ordinary displayed dates, normal appointment/reschedule links, 10-character short codes, invoice links with an invoice/date prefix, and secure-card links carrying 22-character tokens. Conditional fee, card-hold, past-due, and similar clauses are empty. This is a reproducible base case, **not an assertion that these clauses are usually absent**.

Longer sample: 12-character first name, a combined service label, and populated conditional clauses. The $50 fee and $100 balance are illustrative inputs, not verified live configuration. Short links still work. The last scenario additionally substitutes 64-character token links to illustrate shortener-failure sensitivity; it is neither a universal maximum nor proof that all routes use 64-character tokens.

The model marks 115 rows enabled and 17 disabled. Among those 115 modeled enabled rows, the base split changes from 59/55/1 to 62/53/0 and the longer split from 47/61/7 to 47/64/4. Actual production toggles and sender reachability are unknown; a default enabled row does not prove its workflow sends.

The review-outreach registry is counted separately to avoid conflating it with editable `sms_templates` rows. Its 13 bodies include one labeled `Final Nudge (email)`; these are registry choices, not 13 active SMS automations. Base split: 13/0/0. With the longer name: 12/1/0 before the local change and 13/0/0 afterward. With fallback long links: 3/10/0. Dynamic/manual/AI text, referral settings overrides, custom database templates, and active database variants have no complete fixed source inventory and are outside these numeric totals.

For US local-number SMS, GSM-7 permits 160 units in one segment and 153 per concatenated segment: two segments hold 306 units, three hold 459. Unicode reduces this to 70/67; extension characters and emoji require special counting. US/Canada toll-free concatenation instead uses 152/66. Twilio recommends keeping messages under 320 characters; a strict two-segment GSM budget is slightly tighter at 306. These counts assume local-number GSM SMS, not MMS. [Twilio segment guidance](https://www.twilio.com/docs/glossary/what-sms-character-limit).

**Copy changes**

| Template | Longer sample GSM units: before → after | Segments: before → after |
|---|---:|---:|
| `reminder_24h` | 448 → 332 | 3 → 3 |
| `secure_appointment_card_plans` | 371 → 320 | 3 → 3 |
| `reminder_24h_v2` | 351 → 344 | 3 → 3 |
| `reminder_72h` | 343 → 331 | 3 → 3 |
| `service_complete_with_invoice` | 308 → 276 | 3 → 2 |
| `service_report_v1_with_invoice` | 308 → 276 | 3 → 2 |
| `auto_sprinkler_timer` | 332 → 230 | 3 → 2 |

The reminders retain the complete card-hold disclosure, including the free-cancellation cutoff, fee conditions, and free rescheduling. Payment choices retain the prepay exception to no charge today, cancellation-fee clause, and card-security language. Report messages retain both report and payment links plus the full previous-balance clause. The sprinkler guide retains opt-out and help instructions. The legacy 24-hour reminder uses the two-hour `{window}` already supplied by its sender.

The new copy-only migration uses exact-body comparisons for base rows and variants, preserving administrator wording, activation, and experiment settings. It adds the sender's existing `window` variable to the legacy reminder's list, including custom parents whose control variants use the new copy. Its rollback is intentionally a no-op to preserve later edits. Render-time formatting covers all links regardless of whether a stored body matches the copy migration. No message is truncated or silently withheld for length.

**Findings and recommendations**

1. **Link formatting was inconsistent across outbound paths.** At the baseline, `server/routes/admin-sms-templates.js` stripped only two portal hosts, while `server/services/twilio.js` normalized punctuation without stripping URLs. External review links and direct/manual builders could retain HTTPS. The local fix uses `server/services/messaging/sms-link-policy.js:4` for the renderer, composer link inserts, link-presence checks, send audit, and Twilio boundary. It strips the leading HTTPS display prefix while retaining nested URL values and destination bytes. URLs used by email, redirects, and Twilio media/status callbacks retain their schemes. MMS captions retain their existing behavior.

2. **Protocol removal has a modest segment benefit.** Prefix removal alone saves eight characters in linked review requests, the sprinkler guide, and prep-guide messages. The copy trims produce the larger reductions shown above. It also saves eight characters for linked review-outreach messages that bypassed the renderer, moving the longer `winback_ask` example from two segments to one. I found no evidence in Twilio's guidance that hiding HTTPS itself improves carrier deliverability. Twilio's own shortening examples retain HTTPS and emphasize domain ownership. Bare-link tapping and previews remain device-dependent and were not tested on phones. [Twilio link shortening](https://www.twilio.com/docs/messaging/features/link-shortening).

3. **Shortener failures increase length.** `server/services/short-url.js:184` deliberately returns the original URL on failure. Keep this delivery-preserving fallback, but measure how often it occurs and budget templates for it. Prefer the existing branded `/l/` mechanism consistently; preserve token entropy and permanent receipt access. Twilio identifies shared public shorteners and domain reputation as filtering concerns. [Twilio deliverability guidance](https://www.twilio.com/en-us/blog/high-volume-messaging-solution).

4. **Template preview is not a final SMS budget check.** `server/routes/admin-sms-templates.js:243` returns raw/substituted character lengths; it does not expose final encoding or segment counts. The renderer separately selects variants at `server/routes/admin-sms-templates.js:417`. Extend the existing preview/editor to show final sent text, encoding, segments, and room remaining, with longer samples and variants. The outgoing segment validator is intentionally advisory (`server/services/messaging/segment-counter.js:143`); do not start silently dropping essential notices over length.

5. **Conditional migrations leave multiple plausible copy versions.** `server/models/migrations/20260801000001_sms_house_voice_sweep.js` preserves administrator edits with exact-body predicates; the earlier audit migration also falls back to mechanical edits (`server/models/migrations/20260730000020_sms_template_audit.js:101`). That protection means reading only the latest rewrite table overstates coverage. The reconstructed catalogue retains older copy in some paths, including the 24-hour reminder. A complete live inventory needs the actual base and active-variant rows before choosing copy to replace.

6. **Existing safeguards should be retained.** GSM punctuation normalization already runs at `server/services/twilio.js`; meaningful non-GSM names can still require Unicode. Measure final output instead of treating `.length` as segments. Maintain consent, STOP suppression, appropriate cadence, and sender identification. Twilio distinguishes informational consent from promotional consent and requires sender identification except in ongoing conversations; first messages need an opt-out instruction. This is a delivery-policy review, not a finding that live Waves consent is defective. [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy).

7. **Continue measuring provider outcomes.** Read access is restored and the 30-day results above show no filtering/unregistered-sender errors. Track `delivered`, `undelivered`, `failed`, provider `num_segments`, and error codes over time; correlate length with outcomes before attributing failures to it. The application audit records its own segment estimate, while the status callback records status/error fields. Queue acceptance and final delivery are separate outcomes. [Twilio status lifecycle](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks).

**Local implementation and validation**

The requested SMS HTTPS-prefix change covers stored-template and variant rendering, composer inserts, direct sends, and segment-audit consistency. The old host-specific helper and contradictory external-link lint rule were removed; internal callers share one helper. Existing public-shortener detection remains. The seven-body migration changes copy and the legacy reminder's advertised variable list; no dependency, schema, token destination, fee, consent rule, or feature gate changes.

Validation: 444 focused renderer/composer/send/lint tests passed after rebasing onto refreshed main. Twelve copy/segment assertions and three real PostgreSQL migration tests also passed. PostgreSQL evidence used the dedicated `codex-dev` cluster and this worktree's empty QA database, importing only the three relevant table schemas from a migrated development database. All test rows and migration writes ran inside `BEGIN`/`ROLLBACK`; administrator copy, inactive base rows, paused/custom variants, JSONB variable lists, audit inserts, idempotency, and no-op rollback were checked. This verifies the relevant development schema, not production state or the entire migration history.

No production database was queried or changed, and no customer message or device delivery test was sent. Merge and deployment remain pending review and authorization.

Reproduce the offline inventory with `node docs/audits/sms-template-audit-2026-09-07-render.cjs`. That command rewrites only the local audit evidence JSON and CSV. `sms-template-audit-2026-09-07-reproduce.cjs` contains the isolated migration-source evaluator; its optional standalone output is `.tmp/sms-audit/catalogue.json`.
