# Bid kit

Admin-only page at `/admin/bid-kit`, behind `GATE_BID_KIT` (dark; see `docs/gates-and-env.md`). One place for the papers and company facts every government bid asks for, so a bid is not rejected for a missing paper. Evidence: Sarasota County Schools bid 24-0118 (May 2024) rejected 3 of 5 bids, the lowest included, for a missing business license copy, state employee ID cards, the certified operator's certificate and renewal, a notarized statement that the certified operator works full-time for the bidder, and the product list.

## What it holds

The catalog is in `shared/bid-kit-catalog.cjs` (server and page both read it): papers that sank bids, insurance, registration and tax, plans and company, references, and company facts. Rows live in `bid_kit_items` (one new table; `business_credentials` is untouched). The catalog has no seed rows: a row appears when the owner fills an item.

Each row keeps: its private file, limits (insurance, whole dollars), source document, the date it was checked, its expiry, the date a reference gave permission, and the owner's sign-off.

## Never public

- Nothing here is on the website or in `/api/public/credentials`. Every route needs an admin login and answers 404 while the gate is off.
- A file is stored privately in S3 and opens only through a signed link that lasts 5 minutes. No route returns a stored key.
- Nothing is sent to an agency, a customer or anyone else. The only notice is one admin bell per paper that expired or expires within 30 days, at most once a week per paper.
- A FEIN, EIN or SSN is never stored, parsed or shown. A tax ID typed into a text field is refused. The W-9 file is the only place one lives.

## The sign-off rule

A paper counts as **ready** only after the owner presses Sign off. The sign-off covers the item as the owner saw it:

- Any change to the value, file, limits, details, source document, checked-on date, expiry, permission date or credential link clears the sign-off in the same update. A stale sign-off cannot survive an edit.
- Sign-off is refused for an item that is missing or expired, and for a version that changed since the page loaded (reload and look again).
- Status is computed, never stored: missing, expired, expiring (30 days), needs permission (a reference with no permission date), needs sign-off, ready.

## Facts sheet

The Facts sheet view lists each fact value and each paper's number and expiry date with a Copy button, for filling flat agency forms by hand. It never shows a file, a key or a link.
