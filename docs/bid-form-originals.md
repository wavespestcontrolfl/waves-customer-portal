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

The export consumer is a separate change. This foundation does not enable a
route, submit a bid, send a document or change a rollout gate.
