# Customer 360 workspace follow-up

The workspace is available through `/admin/customers?customer360=workspace&customerId=<id>`. It stays inside the Waves admin shell and keeps the existing directory queries and customer endpoints.

## Implemented

- Call, Text, Email, and Address actions, with plain contact details underneath. Address opens Google Maps; Text opens this customer's Comms tab.
- Larger section labels and a vertical Overview: services, billing summary, health, then searchable activity. Activity supports text search and category filters across all history returned by the endpoint.
- An Estimates tab with references, statuses, original stored annual recurring and one-time quote totals, and links to the full estimates. Missing amounts are labeled “Not recorded”; historical estimates are never repriced from the current plan.
- The existing Messages composer in Comms, fixed to the profile's recipient and initialized to the latest known business line. It retains image attachments, AI draft, voice dictation, AI rewrite, links, and delayed text sending. Drafts survive section changes within the selected profile. Selecting another customer resets the composer.
- Notification preference switches are omitted from the workspace. Saved customer choices and billing recipient routing remain authoritative. This does not enable notifications or change preferences.
- White billing buttons, a legible Default payment-method badge, invoice references, and a customer-filtered invoice-list link.

Scheduled MMS remains unsupported by the existing scheduler; the shared composer explains this and retains the message and images. Dictation uses the existing browser speech support. Immediate sends clear a draft only after provider acceptance; suppressed sends retain it.

## Invoice workflow audit

`client/src/pages/admin/AdminInvoicesPage.jsx` already owns these operations and their eligibility/permission checks:

| Existing capability | Access from Customer 360 |
| --- | --- |
| Invoice creation, editing, send/resend, invoice and receipt PDFs | More → Invoice; invoice reference → expanded invoice |
| Invoice attachments and payment/delivery timeline | Invoice reference → expanded invoice |
| Pay link, in-person payment, saved method charge, recorded payment | Invoice reference → expanded invoice, where applicable |
| Apply account credit, payment plans, void/reverse workflows | Invoice reference → expanded invoice, where applicable |

The profile previously displayed invoice amounts and status without a direct link to the individual record. The new links preserve the full invoice workflow. Payment logic, pricing, payloads, and customer communications are still owned by their existing routes.

## Product research

These are design references and recommendations, not additions to Waves' dependencies.

The requested random-string exercise was used as a creative prompt for the final visual pass. Repeated characters and alternating dense/open runs suggested consistent outlines and a steady spacing rhythm. The resulting adjustments are flat writing-tool buttons, consistent control corners, and roomier send controls; the Waves palette and requested vertical layout govern the result.

| Source | Relevant pattern | Application to Waves |
| --- | --- | --- |
| [BoardUI](https://www.boardui.com/) | Restrained cards and controls, searchable content, composer attachments | Quiet outlined billing controls and clear grouping using the existing Waves UI kit |
| [Salesforce activity timeline filters](https://help.salesforce.com/s/articleView?id=sf.activity_timeline_filters.htm&language=en_US&type=5) | Filter the record's timeline by activity type | Search and category filtering in the account history |
| [HubSpot record timelines](https://knowledge.hubspot.com/records/filter-activities-on-a-record-timeline) | Search activity content, filter types, expand details, and pin activities | Search full returned descriptions now; consider pinned critical notes next |
| [Jobber client information](https://help.getjobber.com/en/articles/client-information-in-the-jobber-app/) | Client contact actions alongside linked work, quotes, invoices, notes, and attachments | Contact actions and linked estimates/invoices now; consider easier document access |
| [ServiceTitan customer and location records](https://help.servicetitan.com/docs/customer-and-location-records-overview) | Separate account and location context with associated work records | Consider a property selector that scopes history for customers with multiple addresses |

Recommended next additions, based on those patterns and existing Waves features:

1. Pin an important account note or access instruction, using existing interactions rather than a separate notes store.
2. Put open promises and follow-ups near the top, reusing the existing owed-commitment mechanism.
3. Scope history to a selected property through the existing property panel and record links.

## Verification scope

Validation completed: 111 focused tests passed across 13 files, the production build and its domain/brand checks passed, and ESLint reported no errors (existing structural warnings remain).

Local browser checks use synthetic fixtures with all backend/provider calls intercepted. Automated UI tests cover history search, stored quote values, fixed SMS recipients, thread selection, provider suppression, AI draft edits, rewrite context, attachments, dictation input, and delayed sending. Browser checks include desktop Chromium, mobile Chromium, and mobile/tablet WebKit, with simulated Safari viewport and keyboard changes.

No migrations, database end-to-end verification, real message delivery, live AI calls, real charges, or deployment were performed. Device speech recognition and an installed iPhone home-screen bookmark still need an on-device check.
