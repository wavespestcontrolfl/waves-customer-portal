# Commercial bid builder

The existing commercial proposal editor supports construction and turf bids with decimal quantities, project costing, a fixed validity date, and the reviewed North Port and Cove PDF forms. The branded proposal remains the main scope-and-price document.

The new authoring controls and required-form endpoint are released behind `GATE_COMMERCIAL_BID_BUILDER`, off by default. Enable it in the selected environment after review. Unsetting it hides new controls and disables form exports; previously saved quantities and price holds still apply, and saved costs/dates remain visible without editing. The server refuses unit, costing and validity edits from a stale editor while the gate is off. Older editors that omit the date preserve the stored hold.

## Author a bid

1. Add building or area line items using reviewed treatment quantities. Quantities and unit prices support four decimal places; each extended charge rounds to cents. Choose the unit explicitly: square feet, linear feet, acres, pounds, gallons, each, lump sum, hours, days, or trips. For these bid forms, choose **One-time** frequency. Record scope, drawing references, phases, and contractual requirements in the existing scope, building-note, and terms fields.
2. Complete **Project cost sheet · private** with materials, total crew hours, equipment, mobilizations, travel, monitoring, and warranty/retreatment costs. Each row costs quantity × unit cost × occurrences. Include every obligation in the entered quantities and occurrences. Compare one-time revenue plus the selected number of recurring-revenue years against those costs. The displayed gross profit and margin describe the entered cost sheet; they do not set proposal prices.
3. Set **Valid through (Eastern time)** to the solicitation's required end date. A fixed date lasts through 11:59:59.999 p.m. Eastern and survives resends. Sending or scheduling after it is refused. Automatic renewal and generic extensions do not change it. An expired fixed-date bid can be explicitly revised in this editor. A blank date retains the standard seven-day send window.
4. Save, review the quoted quantities, prices and terms, then download the branded proposal and any required bid form.

Quantities are operator-reviewed inputs. Building coverage, gross floor area and treated slab area are different measurements. Project costs and application rates must come from the reviewed scope and business inputs.

## Required PDF forms

Upload the original PDF and select its form page. Files are limited to 12 MB and 100 pages. The exporter checks the blank page's content fingerprint, dimensions and rotation before drawing, preserving every uploaded page. A revised form layout requires a reviewed template update. Uploaded originals are processed for that download and are not retained.

| Form | Original page | Price mapping |
| --- | --- | --- |
| North Port PR27-02 | 15 in the RFQ | Product in lb or gal, application in acres, an optional additional item, and freight. Product and application each require a consistent unit price. The saved total must be at most $34,999.99, with no separate tax amount because the form has no tax field. |
| Cove + Willoughby termite scope | 3 in the termite scope PDF | Apartment buildings, clubhouse, and garages/maintenance. Each group needs reviewed SF lines; other units can contribute prices but are not counted as SF. Each treated area must appear once. Base-bid rows include quoted tax and reconcile to the saved total. Enter the OCIP deduct explicitly, including zero if none. |

Every saved building line must map to exactly one form row. Programs, corrective-work lists and recurring building lines are refused by these form profiles; use one-time building lines for their complete itemization. The exporter refuses inconsistent aggregate quantities/rates, missing mappings, changed proposals and unsupported originals.

Both form profiles require an explicit validity date. North Port also enforces December 21, 2026 or later: RFQ page 13 requires a 90-day hold after the bid due date, and Addendum No. 1 moves that date to September 22, 2026. If later addenda change the deadline, enter the corresponding later validity date and review the form profile. For Cove, confirm the submission date and set the required 90-day hold explicitly.

Company/contact text and the Cove OCIP alternate are entered for each export. Signatures, signature dates, discounts, legal attestations, and other packet pages remain for manual completion. Downloading a filled price form does not submit a bid or establish that the full submission package is complete.

## Implementation and verification

- Public quantities, units, rates and `validThrough` live in `estimate_data.proposal`. Private cost inputs live separately in `estimate_data.proposalCosting`, returned only by the admin proposal endpoint. The public allowlist, customer renderers and PDFs exclude them.
- Shared four-decimal quantity/rate math is in `shared/proposal-bid.cjs`. Invoice displays use cent-formatted rates, so fractional bids retain the exact quantity/rate basis in the invoice description and bill their reviewed extended charge.
- Proposal saves retain the existing status, price-lock, archive, delivery-claim and group locks and now check the loaded edit version. The expiry column changes atomically with the authored bid. Form downloads verify the saved version before and after generation.
- The original-PDF upload and temporary browser download are recorded as reviewed portal-only exceptions in `docs/intelligence-bar-capabilities.json` (PR #4270). They require an admin-selected file that is not retained or available to Intelligence Bar tools; no tool parity is claimed. The entries record permissions, inputs/effects, source fingerprints and the actual form-export verification. `npm run check:ib-coverage` checks this inventory without resetting its baseline.
- No database migration or new dependency is needed. Tests cover normalization, costing, validity/DST, save concurrency, invoice amounts, expiration/renewal, form mapping and existing delivery behavior. Browser verification uses synthetic records; actual supplied form PDFs are filled with clearly marked test prices. Production records and messaging are not involved. Database integration uses a private development database with synthetic records and blocked outbound providers.
