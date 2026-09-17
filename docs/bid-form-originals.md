# Reviewed bid-form originals

The bid exporter accepts the untouched North Port PR27-02 RFQ (form page 15)
and Cove + Willoughby termite scope (form page 3). Originals are supplied for
each download and never retained. Revised packets need a reviewed fingerprint
update before export.

Run `node server/scripts/bid-form-fingerprint.js <original.pdf> <page>` on the
untouched original and record all three values in `FORM_PAGE_FINGERPRINTS` in
`server/services/pdf/bid-form-original.js`. Content fingerprints include each
stream's dictionary and framed bytes; resource fingerprints cover referenced
objects. The packet fingerprint pins the other pages, annotations, page state,
field tree and catalog. Changing stream decoding with the same bytes is refused.

These profiles were regenerated from the supplied original RFQ and termite
scope PDFs. Filled fields, signed or flattened packets, annotations on the
selected page, altered boxes and unreviewed actions are refused. The North Port
original's unsigned signature fields and original JavaScript remain unchanged.

The admin proposal editor exposes the download while the existing commercial
bid-builder gate is enabled. Save an authored proposal with one-time building
lines, an explicit validity date, and a form-row mapping for every priced line.
The route compares the saved edit version before and after generation.

North Port requires product quantities in lb or gal, application area in acres,
consistent unit prices per row, no separate tax and a total at most $34,999.99.
The September 8 Addendum No. 1 moves the due date to September 22; the RFQ's
90-day hold requires Valid through December 21, 2026 or later. Recheck later
addenda before submission. Cove needs reviewed SF quantities for apartments,
clubhouse and garages; base-bid rows include tax. Enter the OCIP deduct alternate
explicitly, including zero. Other units may contribute dollars but never SF.

The editor refuses changes made during its pre-export save. The PDF is downloaded
only to the requesting device; this neither submits the bid nor delivers it to
a customer. Signatures, dates, discounts and legal attestations stay blank for
manual completion. Save uses `updateFieldAppearances:false` so inspecting blank
fields does not regenerate appearances on untouched packet pages. Uploaded
originals are limited to 12 MB and 100 pages. The gate remains off by default.

The upload and local download are reviewed portal-only exceptions in
`docs/intelligence-bar-capabilities.json`: Intelligence Bar has no retained
source-file contract for this browser-selected PDF.
