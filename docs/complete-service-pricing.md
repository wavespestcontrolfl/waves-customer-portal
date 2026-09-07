# Complete Service: estimate and pricing

`GATE_COMPLETION_SERVICE_PRICING=true` enables the inline pricing card in Complete Service. It is off by default. The existing completion endpoint accepts an optional pricing review; older browser/native requests retain their existing behavior. No migration, new rate, or production data repair is part of this change.

The card resolves the scheduled job's explicit accepted estimate and its matching service lines. A parent source can be inherited only when customer, property, and service identity agree. It never selects the customer's newest estimate. Duplicate source identities, another property, and missing accepted-price evidence remain visible review states. Completion waits for pricing to load and requires a read retry on failure. Opening the matched estimate keeps completion mounted; the full accepted PDF is available from the same dialog.

The existing accepted-price mapper supplies the agreed net. Its completion-only option preserves duplicate evidence and explicit fully discounted per-application amounts. Existing scheduling/acceptance consumers retain their normal normalization and response shapes.

An admin can apply a proven missing accepted discount or an eligible missing tier benefit. Tier rates come from `pricing_config`; membership and service eligibility use the existing discount engine. An older agreement is not repriced merely because the customer's tier increased. Existing discounted net prices are not discounted twice. A recorded fixed catalog adjustment stacks only when its catalog rule explicitly permits stacking; unknown and percentage stacks require the existing price editor. Unexplained differences between the stored appointment total and its financial lines also require review.

The server derives the proposed amounts through the existing appointment financial helpers. On completion, it checks the review again under the estimate, customer, parent (when inherited), and visit locks. The transaction saves the price and discount stamps, records an activity event, and freezes the reviewed amount on the service record. The existing invoice builder consumes those stamps. A committed retry restores the frozen amount, including zero, without applying discounts again. A stale uncommitted review returns `completion_pricing_changed`; the form refreshes pricing while preserving treatment entries.

Adjustments apply to this application. Changing a recurring parent requires the existing `GATE_EDIT_APPT_PRICE_SERVICE_SCOPE` mechanism to be enabled so its original future template can be pinned. Parent add-on changes remain in the existing scoped price editor. Prepaid, annual coverage, already invoiced, callback, and incompatible billing lanes do not receive new discounts here. Existing invoice, payer, credit, tax, Auto Pay, and communications controls continue to govern completion.

## Local verification

- PostgreSQL tests use a dedicated local `completion_qa` database with a schema-only copy and synthetic fixtures that roll back. They verify persisted prices, the real invoice line builder, stale reviews, grouped services, lawn eligibility, inherited source/property checks, duplicate evidence, saved adjustments, future-series templates, and fully discounted/resumed applications.
- Pure/source-contract regressions cover the existing estimate mapper, appointment discounts, invoice lines, completion attempts, and required-invoice retry behavior.
- Client tests cover price toggles, late responses, failed reads, source-dialog focus/draft retention, and retry keys.
- The actual `CompletionPanel` was rendered at 390px and 1440px. A synthetic browser submission confirmed that the form submits only the review witness/choice, never a dollar amount. Screenshot artifacts are retained with the local build handoff.
- No production records, communications, payments, deployment, or feature gates were changed. No migrations were run. Full production-provider closeout was not exercised.

To run the PostgreSQL suite against a disposable schema-only local database:

```sh
DATABASE_URL=postgresql://localhost/waves_completion_qa_20260906 \
COMPLETION_PRICING_TEST_DATABASE_URL=postgresql://localhost/waves_completion_qa_20260906 \
NODE_ENV=test node_modules/.bin/jest \
  --config '{"rootDir":"server","testEnvironment":"node"}' \
  --runInBand --forceExit tests/completion-pricing.postgres.test.js
```

## Deferred P2 cleanup

The retained `CompletionPanel`, `formatEstimateLine`, `acceptanceServiceLists`, and `completeScheduledService` functions exceed the existing structural lint thresholds. Decomposing these shared legacy functions would broaden this task; that cleanup is deferred. The new pricing service and card pass lint without warnings.
