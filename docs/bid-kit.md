# Bid kit

Admin-only page at `/admin/bid-kit`, behind `GATE_BID_KIT` (dark; see `docs/gates-and-env.md`). One place for the papers and company facts every government bid asks for, so a bid is not rejected for a missing paper. Evidence: Sarasota County Schools bid 24-0118 (May 2024) rejected 3 of 5 bids, the lowest included, for a missing business license copy, state employee ID cards, the certified operator's certificate and renewal, a notarized statement that the certified operator works full-time for the bidder, and the product list.

## What it holds

The catalog is in `shared/bid-kit-catalog.cjs` (server and page both read it): papers that sank bids, insurance, registration and tax, plans and company, references, and company facts. Rows live in `bid_kit_items` (one new table; `business_credentials` is untouched). The catalog has no seed rows: a row appears when the owner fills an item.

Each row keeps: its private file, limits (insurance, whole dollars), source document, the date it was checked, its expiry, the date a reference gave permission, and the owner's sign-off.

## Never public

- Nothing here is on the website or in `/api/public/credentials`. Every route needs an admin login and answers 404 while the gate is off.
- A file is stored privately in S3 and opens only through a signed link that lasts 5 minutes. No route returns a stored key.
- Nothing is sent to an agency, a customer or anyone else. The only notice is one admin bell per paper that expired or expires within 30 days, at most once a week per paper. A daily run raises at most 3 new bells (expired first, then soonest expiry); any more are one quiet standing count on the Activity feed with the list under Show full text, closed when it reaches zero (docs/admin-notifications.md rule 3).
- The activity log (who changed what) never holds a custom item's label, value, notes or details: a catalog item is named by its catalog label, a custom item as "custom item", and an edit lists the changed field names only.
- A FEIN, EIN or SSN is never stored, parsed or shown. One detector (`detectTaxId`) screens typed text: every field alone (label, value, source, notes, every reference detail; a number counts as its digits), and every pair of fields read together (the stored values with an edit applied, so `EIN` saved in one edit and a grouped nine-digit number in another are refused). A separator is any run of space, hyphen, en dash, dot, underscore or slash. Refused, with or without any label: (A) the SSN shape (3-2-4 digits), (B) the EIN shape (2-7 digits), and (C) exactly nine contiguous digits that are not part of a longer digit run (`123456789`, `Policy 123456789`). So a nine-digit number with no letters cannot be stored: save it with its letters, or keep it in the file. (D) Nine digits in any other grouping (`1234 56789`, `123.456.789`) are refused when a tax phrase appears anywhere in the same text or the same pair, before the digits, after them or far away. There is no distance rule. The phrases are EIN, FEIN, TIN, ITIN, SSN, taxpayer, tax id, tax identification, tax number, tax no, tax #, federal id, federal tax, employer id, employer identification, social security, W9, W-9 and W 9 (case does not matter, whole words). A bare "tax" is no phrase, so `Local business tax receipt 2025-12345` is fine. In an uploaded file name any nine-digit run in any grouping is refused, phrase or not. Eight-digit and ten-digit runs, dates, phone numbers, amounts and a grouped number with no tax phrase (`34202-1234`) are fine. A stored file's key is a random token and a whitelisted extension, never the original name. The W-9 file is the only place one lives.

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
