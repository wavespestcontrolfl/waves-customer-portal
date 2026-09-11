# Financial UI request census review — September 9, 2026

The shared-control integrations preserve request contracts, but formatting,
equivalent URL expressions, and read-helper extraction change the source
fingerprints used by the Intelligence Bar coverage gate. These records remain
`reviewed_unmapped`: they do not claim an implemented Intelligence Bar capability.
Existing baseline fingerprints and all unrelated action records are retained.
No registry, policy, executor, permission or approval behavior changes here.

## Invoices

PR #4323 source reviewed at `0ee1cd72e0e0e1ba25ce24a2be5ff3f9692d91ec`,
against main `82c09751c06604c845f70bf2c6c9d228fd14a4ce`.
The census reports 18 changed fingerprints in AdminInvoicesPage and
MobileCardOnFileSheet. Babel parsing and compact generation with source-location,
comments and raw-literal metadata removed shows 15 identical call expressions.
The remaining three are equivalent GET URL constructions described below.
All direct API write expressions remain identical. Existing guards and request
permissions are exercised by the invoice and saved-card workflow tests.

| Action ID | Handler | Method / endpoint | Expression review |
| --- | --- | --- | --- |
| `0c7739cc1055e2a314703361` | `CreateInvoice` | `GET /admin/invoices/service-records/:param` | Same encoded input/path value; template becomes concatenation |
| `0d1c1e8d105f4b38bfdb53b3` | `CreateInvoice` | `GET /admin/services` | Same active-line description; q renamed query and template becomes concatenation |
| `0e4203c2f79e0b33f7e11986` | `CreateInvoice` | `GET /admin/invoices/customers/search` | Same encoded input/path value; template becomes concatenation |
| `192a75435b431fac623ee0f9` | `handleWriteNotesWithAI` | `POST /admin/invoices/notes/ai` | Identical normalized AST |
| `22e50b19e3dabf0e0cbe94ab` | `handleBatchSend` | `POST dynamic/local` | Identical normalized AST |
| `2b52f33e0ec3f3b1d8253be2` | `handleVoid` | `POST /admin/invoices/:param/void` | Identical normalized AST |
| `477848eaecc13a0dd75c8a69` | `handleUnarchive` | `POST /admin/invoices/:param/unarchive` | Identical normalized AST |
| `51f58bab276e8c15762e875f` | `apply` | `POST /admin/invoices/payment-notices/:param/apply` | Identical normalized AST |
| `5d3a505682ad8c8c78cb7833` | `ZelleNoticesCard` | `GET /admin/invoices/payment-notices` | Identical normalized AST |
| `67a71b92aa8c8253b4e4fefd` | `handleSend` | `POST /admin/invoices/:param/send-receipt` | Identical normalized AST |
| `75cab7babee78a44807e4d43` | `deleteAttachment` | `DELETE /admin/invoices/:param/attachments/:param` | Identical normalized AST |
| `78a0f8ab64a01d9c276eb9b7` | `uploadInvoiceAttachments` | `GET /admin/invoices/:param/attachments` | Identical normalized AST |
| `790988345e31ac81e25e0bee` | `handleWriteThankYouWithAI` | `POST /admin/invoices/email-message/ai` | Identical normalized AST |
| `89f847fdf4dfd3413ab74725` | `handleCharge` | `POST /admin/invoices/:param/charge-card` | Identical normalized AST |
| `9349cac64888bb0766d24d3a` | `ignore` | `POST /admin/invoices/payment-notices/:param/ignore` | Identical normalized AST |
| `95f76ae912f1b7483040c2c7` | `handleCancelPaymentPlan` | `POST /admin/invoices/:param/payment-plan/cancel` | Identical normalized AST |
| `acc64fb1751b2277136990d1` | `handleUnvoid` | `POST /admin/invoices/:param/unvoid` | Identical normalized AST |
| `dc19fe68dbb5bf0c35028aec` | `MobileCardOnFileSheet` | `GET /admin/customers/:param/cards` | Identical normalized AST |

Validation: `npm run check:ib-coverage` must pass with zero drift;
`cd server && npx jest --runInBand tests/intelligence-bar-coverage.test.js`
checks census and status semantics. The existing invoice/saved-card tests and
192-case Chromium/WebKit runner supply workflow evidence. The full financial
stack passed 96 focused tests and a production build before this metadata-only
correction. No live charge, send or database operation was performed.

The manifest still records 1,757 sites with 1,735 unsupported/unverified sites;
none became verified or excepted. All 18 changed rows remain unsupported.

## Finance

PR #4324 source reviewed at `a81f137a403e962ebc18a5a82073391a12093967`,
against the same main baseline above. Of 24 changed/new census sites, 11
request/export expressions have identical normalized ASTs. Twelve GET call
sites preserve existing URLs and response projections while extracting retry
loaders or changing literal syntax; the remaining site is the generic
`useTaxRead` GET adapter. Four new census IDs reflect moved handlers and the
new adapter, not new endpoints. All write expressions remain unchanged.

| Action ID | Handler | Method / endpoint | Expression review |
| --- | --- | --- | --- |
| `01f5105c8ebbbb0e30e187c1` | `setVehicleMethod` | `PUT /admin/revenue/settings` | Identical normalized AST |
| `02381658f96b87ad492cea92` | `loadTransactions` | `GET /admin/banking/payouts/:param` | Existing payout-detail GET moved from toggleExpand to loadTransactions with the same payoutId interpolation and transactions response projection; the extracted loader exposes retry/error state. |
| `0ffb0e228205a283090789ca` | `TaxPage` | `GET /admin/tax/accounts-receivable` | Existing /admin/tax/accounts-receivable GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `18f34113495448196ffd02fb` | `TaxRatesTab` | `GET /admin/tax/rates` | Existing /admin/tax/rates GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `2bf2f0db99d038c8231e4898` | `handleRunAdvisor` | `POST /admin/tax/advisor/run` | Identical normalized AST |
| `31c0181cab361be69b459329` | `act` | `POST dynamic/local` | Identical normalized AST |
| `453d3a8b92660b51109f41c4` | `AdvisorTab` | `GET /admin/tax/advisor/reports` | Existing /admin/tax/advisor/reports GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `54c9e5210aa634e7510e6346` | `confirmVehicleUse` | `PUT /admin/tax/equipment/:param` | Identical normalized AST |
| `6cb6dfcfb209d14b59c7335c` | `toggleTaxable` | `PUT /admin/tax/service-taxability/:param` | Identical normalized AST |
| `7dad9f6e74407d2d69c6d6ae` | `AccountsReceivableTab` | `GET /admin/tax/accounts-receivable` | Existing /admin/tax/accounts-receivable GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `931156f5b71e00d254c4eb00` | `BankImportTab` | `GET /admin/tax/bank-import/:param/expense-candidates` | Identical normalized AST |
| `99bc4a37701bd26e3187d23f` | `AdvisorTab` | `GET /admin/tax/advisor/alerts` | Existing /admin/tax/advisor/alerts GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `9e1d5968fb45dcd05bd36cda` | `handleAdd` | `POST /admin/tax/expenses` | Identical normalized AST |
| `a25eac570cbcf064c5dd1e56` | `TaxPage` | `GET /admin/tax/pnl` | Existing /admin/tax/pnl GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `a75a926448fe92be78ee3eb6` | `FilingCalendarTab` | `GET /admin/tax/filings` | Existing /admin/tax/filings GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `ae07a82b11ad27ae9bdd2e48` | `ExemptionsTab` | `GET /admin/tax/exemptions` | Existing /admin/tax/exemptions GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `b1b78e8e2ffb3994dc33040f` | `bulkClassify` | `POST /admin/tax/mileage/bulk-classify` | Identical normalized AST |
| `becd52cfa36878f285f8bef2` | `BankImportTab` | `GET /admin/tax/bank-import/:param/refund-candidates` | Identical normalized AST |
| `c020d2157337e58db6c10aa9` | `handleAlertAction` | `PUT /admin/tax/advisor/alerts/:param` | Identical normalized AST |
| `cd294d67d2572a0f0f3f88e3` | `EquipmentTab` | `GET /admin/tax/equipment` | Existing /admin/tax/equipment GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |
| `e7dd8153aed82cf6325c208e` | `useTaxRead` | `GET dynamic/local` | The extracted useTaxRead helper calls the existing authenticated adminFetch(path) with no options (GET). Its callers supply the existing tax read endpoints; it retains their response projections and adds loading/error/retry state and an unmount/stale-response guard. No write or new endpoint is introduced. |
| `f2c4f9ca170e4a97b2b39f08` | `BankImportTab` | `GET /admin/tax/bank-import/:param/payout-candidates` | Identical normalized AST |
| `f30f23f95af16b4aacad2729` | `handleRunAdvisor` | `GET /admin/tax/advisor/alerts` | The no-interpolation template literal becomes a string literal with the identical /admin/tax/advisor/alerts?status=new GET URL. |
| `f96791400cd99a8610aa7fba` | `ServiceTaxabilityTab` | `GET /admin/tax/service-taxability` | Existing /admin/tax/service-taxability GET is routed through useTaxRead with the same URL/query and response projection. The helper invokes adminFetch(path) without options and exposes loading/error/retry state; handler extraction changes the census location but introduces no write or endpoint. |

Validation: the coverage gate reports zero drift and its eight existing unit
tests pass. The manifest adds four unsupported census records (1,761 recorded,
1,739 unsupported); all 24 reviewed records remain `reviewed_unmapped`.
The Invoice records and every unrelated record are byte-equivalent as JSON
objects to the parent commit. Existing 34 finance tests, 322 synthetic browser
cases, and the full-stack 96-test/build run cover the UI behavior. This
correction changes only the census manifest and this evidence document.
