# Commercial bid builder

The commercial proposal editor supports reviewed decimal quantities, unit pricing, and fixed validity dates. The branded proposal remains the scope-and-price document.

New unit and validity controls are behind `GATE_COMMERCIAL_BID_BUILDER`, off by default. Unsetting it hides unused controls and leaves saved units and dates visible without editing. The server refuses changes to those fields from a stale editor while the gate is off. Older editors that omit the date preserve the stored hold. Saved quantities and price holds continue to govern documents, invoices and expiry.

## Author a bid

1. Add building or area line items using reviewed treatment quantities. Quantities and unit prices support four decimal places; each extended charge rounds to cents. Choose square feet, linear feet, acres, pounds, gallons, each, lump sum, hours, days, or trips. Record scope, drawing references, phases, and contractual requirements in the existing scope, building-note, and terms fields.
2. Set **Valid through (Eastern time)** to the required end date. A fixed date lasts through 11:59:59.999 p.m. Eastern and survives resends. Sending or scheduling after it is refused, including when a sent or viewed sibling carries the hold; a schedule must also land on a five-minute scheduler tick inside the day, so 11:55 p.m. Eastern is the last accepted time. Shortening any editable group member’s hold must still cover pending group sends. Automatic renewal and generic extensions do not change it. A grouped extension refuses before changing any property if any live sibling — including one whose send is in flight — has a fixed date; proposal edits and the extension share the group lock. Ordinary siblings keep their own seven-day send window, except that the delivered group link (the anchor's token) stays viewable through the group's longest fixed date so the fixed property never drops out early. An expired fixed-date bid can be explicitly revised in this editor. A blank date retains the standard seven-day send window.
3. Save, review the quoted quantities, prices and terms, then download the branded proposal.

### Offer deadline vs group-link viewability

These are two separate things and they are stored separately. `estimates.expires_at`
is always a single property's own **offer deadline** — its authored `Valid through`
date, or the standard seven-day window — and no grouped sibling ever widens it.
Acceptance, voice quoting, reminder eligibility, reminder copy, the CTA and every
displayed deadline read it directly.

The window during which the delivered group entry link keeps resolving is
**group-link viewability**, held in `estimate_data.groupLinkViewableThrough` on the
anchor whose token was delivered, and read by nothing but the token path. It exists
because the delivered link is the anchor's token: an ordinary anchor's offer ends
after seven days, and without a separate window the customer could no longer reach
a fixed sibling valid for months. It is monotonic — a link already promised a date
keeps it even if a hold is later shortened, because what closes is the offer, not
the route to it. A reachable group of expired cards still renders every card as
expired and refuses acceptance.

Do not fold one into the other. Widening `expires_at` to carry reachability makes
every reader that means "offer deadline" wrong by default, and it cannot be undone
downstream: an ordinary row stores no authored date to recover.


Quantities are operator-reviewed inputs. Building coverage, gross floor area and treated slab area are different measurements. Application rates must come from the reviewed scope and business inputs.

## Implementation and verification

- Quantities, units, rates and `validThrough` live in `estimate_data.proposal` and flow through the normalized public proposal and customer documents.
- Shared four-decimal quantity/rate math is in `shared/proposal-bid.cjs`. Invoice displays use cent-formatted rates, so fractional bids retain the exact quantity/rate basis in the invoice description and bill their reviewed extended charge.
- Proposal saves retain the existing status, price-lock, archive, delivery-claim and group locks and now check the loaded edit version. The expiry column changes atomically with the authored bid.
- No database migration or new dependency is needed. Tests cover normalization, validity/DST, save concurrency, invoice amounts, expiration/renewal and existing delivery behavior. Browser and database verification use synthetic records with outbound providers blocked.
