# Weekly irrigation email and app plan

The approved scope is the resource section in all seven weekly irrigation emails, followed by a Monday app notification and a saved plan in My Property. Exact watering-day reminders and app-only plan generation are separate work.

## Email resources

Email PR #4050 was merged and deployed September 7 as `8c4b46bf592486951f0466c70e983dde814b318f`. Railway deployment `514ec07e-6cea-46ea-9d4b-c50f0b827f73` succeeded and logged `Batch 964 run: 1 migrations`.

The email publication migration appends active versions with four guides under **Helpful guides from the Waves blog**: the sprinkler timer index, Rain Bird manual-operation guide, overwatering/underwatering article, and mowing-height article. It replaces only the exact old resource block, preserves staff-authored copy and historical versions, and deduplicates destinations. Custom plain text receives the same links. The shorter “Weekly target for {{grass_label}}” label improves phone spacing; opt-out copy directs customers to reply because the old Seasonal Lawn Tips control was removed.

The existing Monday 7:00 AM America/New_York sender, watering calculation and customer/week deduplication stay authoritative. This change does not resend any week's email. The prior template can be republished through the library for rollback.

## App behavior

`GET /api/property/watering-plan` is customer-authenticated and returns only the currently selected property's validated plan, with private/no-store headers. The reader reuses the sent `irrigation_week_plans` snapshot, checks its current week and restriction policy, matches the home, and validates current eligibility and irrigation inputs against the saved decision. A changed decision is withheld; it is never substituted for the instruction already emailed. A moved home, changed unit, changed schedule, missing snapshot, email opt-out or inactive customer can leave the card without a plan.

My Property displays the email's summary, watering instruction, forecast condition, restriction note, validity date and four guides. It hides old instructions immediately during an irrigation edit, waits for all newer edits to save, revalidates when the app regains focus or visibility, and retires an open plan at the end of its Eastern week. A notification for another owned property uses the existing property switch and save-flush path, then scrolls to the plan beneath the sticky header. Unowned IDs never become switch targets.

The existing property-alerts sweep runs daily at 10:05 AM Eastern. The new rule delivers only on Monday. A valid weekly plan suppresses competing rain/reassurance candidates for that customer throughout the week; a failed weekly-plan lookup suppresses the legacy irrigation rule. Existing per-customer caps and quiet hours remain in force, so a prior unrelated advisory can consume the first week's slot. Successive Monday plans use calendar-day spacing to tolerate runtime drift and DST. No separate cron or subscriber list is introduced.

The notification preserves a conditional plan's rain condition. The weekly customer/event key reuses the existing advisory-lock bell deduplication. The plan, gates, weather preference and quiet hours are checked again before each provider leg. Weekly instructions are excluded from the unvalidated 30-day dashboard alert feed.

Bell creation and push outcome are distinct. The advisory ledger records the notification ID and sanitized provider acceptance/failure/expiry/skip counts. A failed push does not erase the bell; a replayed bell does not push again. A ledger failure can self-heal with an unknown push outcome rather than inventing successful device delivery.

Perishable advisories use APNs expiration zero, FCM Android TTL zero and web-push TTL zero, so providers do not store them for later delivery to an offline device. Provider acceptance does not prove device receipt or display. Existing native URL fields and same-origin navigation are retained; both native shells load the hosted portal.

## Release controls and limits

`GATE_IRRIGATION_APP_PLAN=true` enables the card and weekly rule; it defaults off. `GATE_IRRIGATION_WEEK_PLAN` must also be on. Notifications additionally require the existing `GATE_PROPERTY_ALERTS` and cron gates. Turning off the new gate hides the card and prevents new weekly dispatches. It does not retract historical bell entries or already accepted pushes. Owner authorization is required before activating the customer-facing gate.

The first version requires a sent email plan and shares the email audience, including email preferences. A missing settings row does not remove a recurring lawn customer from the email audience: the existing setup/confirmation variant requests the missing information, but it does not create an app watering prescription. App-only customers need a separate, channel-independent plan lifecycle before they can join.

Assigned watering weekdays and hours are not established by the customer's entered controller schedule. This release summarizes the existing plan; it does not send “water now” reminders or control sprinklers. Service-report watering-in instructions still govern after treatment.

## Verification and remaining production evidence

The empty private Railway dev PostgreSQL database ran all repository migrations. Real transaction tests cover template publication/history/auditing and current-plan round trips for a synthetic newly recurring customer, including sent-state, settings, home identity, expiry and historical-feed exclusion. Targeted server, client, native-link and push transport tests cover authentication, opt-outs, quiet hours, recurrence caps, duplicate protection, offline expiry, property switching and overlapping saves.

Synthetic email proofs and the rendered app were checked at 1440 and 390 pixels, with no horizontal overflow, missing guide links or broken email images. Run, conditional, hold, unavailable, disabled and mismatched-property states were exercised. Local proof artifacts are under `.pr-shots/irrigation-email/` and `.pr-shots/irrigation-app/`; PR descriptions carry native attachments.

The live email/week-plan/property-alert gates were enabled when checked September 7; the new app gate was unset. Individual recent production customer records remain unverified: the admin API initially rejected the saved credential as expired, and later requests returned HTTP 403. Working admin access is required to complete that check. No production database was connected, and no real customer record was used as a test fixture. Native device receipt/display has not been verified on an owner-created test account.
