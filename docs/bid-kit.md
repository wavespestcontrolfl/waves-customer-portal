# Bid kit

Admin-only page at `/admin/bid-kit`, behind `GATE_BID_KIT` (dark; see `docs/gates-and-env.md`). One place for the papers and company facts every government bid asks for, so a bid is not rejected for a missing paper. Evidence: Sarasota County Schools bid 24-0118 (May 2024) rejected 3 of 5 bids, the lowest included, for a missing business license copy, state employee ID cards, the certified operator's certificate and renewal, a notarized statement that the certified operator works full-time for the bidder, and the product list.

## What it holds

The catalog is in `shared/bid-kit-catalog.cjs` (server and page both read it): papers that sank bids, insurance, registration and tax, plans and company, references, and company facts. Rows live in `bid_kit_items` (one new table; `business_credentials` is untouched). The catalog has no seed rows: a row appears when the owner fills an item.

Each row keeps: its private file, limits (insurance, whole dollars), source document, the date it was checked, its expiry, the date a reference gave permission, and the owner's sign-off.

## Never public

- Nothing here is on the website or in `/api/public/credentials`. Every route needs an admin login and answers 404 while the gate is off.
- A file is stored privately in S3 and opens only through a signed link that lasts 5 minutes. No route returns a stored key.
- Nothing is sent to an agency, a customer or anyone else. The only notice is one admin bell per paper that expired or expires within 30 days, at most once a week per paper.
- A FEIN, EIN or SSN is never stored, parsed or shown. One detector refuses a tax ID or SSN in every typed field, every reference detail, every pair of fields read together (the stored values with an edit applied, so `EIN` saved in one edit and nine digits in another are refused) and every uploaded file name. A separator is any run of space, hyphen, en dash, dot, underscore or slash. It refuses the SSN shape (3-2-4 digits) and the EIN shape (2-7 digits) with or without a label, and nine digits in any grouping (`1234 56789`, `123.456.789`) when a tax label (EIN, FEIN, TIN, SSN, tax id, taxpayer, W9, W-9) ends at most 12 characters before them or starts at most 12 characters after them (`123456789 EIN`). In a file name any nine-digit run is refused, label or not. Eight-digit and ten-digit runs, dates, phone numbers and an ordinary policy number (`Policy number` with nine digits) are fine. A stored file's key is a random token and a whitelisted extension, never the original name. The W-9 file is the only place one lives.

## The sign-off rule

A document counts only with a file (a typed number alone leaves it **missing**); a fact or a reference counts on its text (a reference needs a value or the name of its entity; a file alone never makes a fact or a reference count). A paper counts as **ready** only after the owner presses Sign off. The sign-off covers the item as the owner saw it:

- Every write, a file replacement and an archive included, carries the version of the item the page loaded. A stale page gets a 409 and the open editors close, so old fields never go out with a new version.
- The expiry bell closes by itself when the item is renewed or archived. Raising and closing a bell run under one lock per item and read the item again inside it, so a renewal or archive that lands while the daily run is working is never undone.
- Logs never carry a database error's message (it can quote a reference's name, email or address): a log line is a fixed sentence plus the error code.
- A document counts only with a file: a typed number alone leaves it missing (facts and references are there on text; a file alone never counts for either).
- A check date and a permission date cannot be after today (Eastern); an expiry date may be ahead. The sign-off time is shown in Eastern time with the zone named.
- A custom item's label is part of what a sign-off covers; a catalog item's label is not.
- Any change to the value, file, limits, details, source document, checked-on date, expiry, or permission date clears the sign-off in the same update. A stale sign-off cannot survive an edit.
- Sign-off is refused while an item is missing, expired, or has no expiry date when its catalog entry says it expires ("Add the expiry date first"), and for a version that changed since the page loaded (reload and look again).
- Status is computed, never stored, first match wins: missing, expired, needs expiry, needs permission (a reference with no permission date), needs sign-off, expiring (complete and signed off, but expires within 30 days), ready. The summary counts ready and expiring together as ready, and shows the expiring-soon count beside it ("14 of 31 ready · 2 expiring soon").

## Facts sheet

The Facts sheet view lists each fact value and each paper's number and expiry date with a Copy button, for filling flat agency forms by hand. It never shows a file, a key or a link.

## A file that may be left behind

A replacement stores the new file first, then commits the row that points at it. The new object is deleted only when the replacement is known not to have committed (the server refused it, the version was stale, or a failure came before any commit). When the commit's acknowledgement is lost the outcome is unknown, so the new object is kept and a log line names the item (id only). The page shows the row as it is on the next load. The previous object is deleted only after the new reference is committed, best effort. So an object in the private store can be left with no row pointing at it. It is safe to remove only when no `bid_kit_items.file_s3_key` references it.
