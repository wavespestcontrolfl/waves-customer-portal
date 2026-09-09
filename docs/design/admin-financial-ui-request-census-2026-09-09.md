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
