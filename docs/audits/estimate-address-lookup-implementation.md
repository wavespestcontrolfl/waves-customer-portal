# Estimate address lookup accuracy

This change addresses the approved address-lookup audit, with accuracy taking priority
when staff retrieve property details to build an estimate.

## Result

- Interactive estimator lookups give each county retrieval its own attempt.
  Slow earlier work no longer skips satellite analysis or stories evidence.
  Individual provider timeouts remain. Complete county/GIS measurements can
  satisfy the property search without a redundant AI search.
- AI output cannot gain county authority merely by citing a county URL.
  A county or builder citation cannot conceal a contradictory house-number
  citation. A geocoder cannot replace the requested house number with a neighbor.
- Changing the address clears the prior property's measurements, evidence,
  satellite images, and generated estimate. A late response for an earlier
  address is discarded. Refresh preserves manual home/lot/stories corrections
  for the same address and clears missing automatic home/lot measurements.
- The results panel shows individual measurements, source links, retrieval
  time, missing facts, and an address-correction action. Each measurement has
  its own verification action. Saving home area does not verify lot or stories.
- Property status completes before optional customer suggestions finish.
  Missing measurements are described as missing, including in the estimate
  preview. Other county house numbers are context, not proposed corrections;
  the broad parcel count is no longer displayed in the warning.
- Refresh bypasses the existing cache. Incomplete county records use the
  existing 21-day short TTL rather than the standard 180-day TTL; condo records
  without a private lot remain eligible for the standard TTL. Cached AI claims
  previously mislabeled as county evidence are refreshed.

## Verification

- 796 server tests passed across 35 property lookup suites, including source
  authority, county adapters, cache behavior, geocoder/address guards, units,
  commercial/association records, and slow lookup regressions.
- 22 client tests passed across all seven EstimateToolViewV2 test files.
- `npm run build` passed, including blog-schema and affiliate-registry vendor
  checks, `check:portal-brand`, and `check:domain-rules`.
- Targeted ESLint reported no errors. Existing large modules retain structural
  warnings; the new results component and measurement defaults have none.
- The actual pipeline/create-estimate page was exercised in Chromium at
  1440px and 390px with synthetic API fixtures. Source links, refresh requests,
  per-field verification payloads, retained manual corrections, address reset,
  address-field focus, and horizontal overflow checks passed. Desktop and
  mobile screenshots of sourced and missing-address states were reviewed.

## Limits

All application API interactions were mocked. No dev database was available;
migrations and end-to-end DB verification were not run. No production database,
paid provider calls, or customer communications were used during verification.
The screenshot's actual correct address and measurements remain unconfirmed;
a missing county house number is not enough to select a replacement property.
