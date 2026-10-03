# EPA label weather review

This first remaining Tech Resource Drawer lane adds source-backed weather review
to Inventory → Products → expand a product. It feeds the existing Job Card spray
check. It does not review application rates, change pricing, assign equipment,
or send communications.

`GATE_LABEL_PIPELINE` defaults off and is checked at request and write time.
Inventory fetches availability once at the Products boundary. The flag also
controls consumption of reviewed weather facts: turning it off restores the
existing catalog-based spray check. Review records remain stored for a later
re-enable; revoke an individual review to withdraw its evidence.

## Review flow

1. An authenticated admin chooses **Find & read EPA label**. Opening Inventory
   only reads availability; opening a product also verifies any approved EPA
   source. Neither action runs model extraction.
2. The server finds a single active PPLS registration and its newest matching
   PDF. Registration transfers, distributor suffixes, exempt products, missing
   documents, oversized files, and uncertain identity require manual source
   review. No registration is guessed or rewritten.
3. The existing `highStakes` cross-provider policy extracts four weather fields.
   Each is an explicit global numeric restriction, a conditional restriction,
   or not stated. Numeric/conditional facts carry a source quote and physical
   PDF page. These are candidates, never automatic approvals.
4. The admin compares the exact catalog product/formulation and source pages,
   then approves or rejects the candidate. Approval fetches the latest PPLS label
   and checks its filename and SHA-256, rechecks product identity and the candidate under a row
   lock, and writes the decision with a critical transactional audit event.
   Candidates expire after seven days; stale candidates can still be rejected.
5. **Revoke weather review** withdraws the active evidence on the next Job Card
   read. A changed source or an expired candidate requires extraction again.

## Trust boundary

The nullable `products_catalog.label_weather_review` JSONB column holds the
pending candidate and active decision. Every mutation uses the existing
`recordAuditEvent` writer in the same transaction. The source checksum,
registration, product snapshot, prompt version, facts, and reviewer are retained.
Company contacts returned by PPLS are not stored.

Weather approval does **not** write `label_verified_at`, label rates, legacy
weather columns, protocol data, or pricing. The general verification stamp also
authorizes mixing, so using it here would accidentally certify unrelated rates.
The Job Card's one spray-check builder consumes the scoped weather evidence.
An identity/formulation or legacy weather edit invalidates the active snapshot.
Inventory marks that stored approval INACTIVE / REVIEW REQUIRED and prompts source review
again; product refreshes also clear the source-confirmation checkbox.
No active review (or a disabled gate) retains existing behavior. A revoked or
stale active review stays UNKNOWN instead of falling back to an older stamp.

Inventory, Job Card, and mix-calculator reads validate active evidence against
the latest PPLS filename and PDF checksum. A newer document, changed bytes,
cancelled registration, or unavailable EPA source makes the review inactive and
the weather verdict UNKNOWN. Checks are coalesced in a bounded 128-entry cache
for at most 60 seconds; no PDF bytes are retained there. Approval always bypasses
that cache. Source requests happen outside catalog transactions and perform no
database writes or model calls.

Conditional restrictions remain UNKNOWN unless another reviewed limit already
establishes HOLD. If no numeric limit is established, the card stays UNKNOWN.
A checked source with no numeric limit is not a blanket clearance to apply.
Forecast coverage and known-breach behavior retain the existing Job Card rules.

Source requests allow only the fixed EPA JSON/PDF origins, reject redirects,
stream with byte limits, validate PDF magic/pages, and use a timeout. Model calls
receive the bounded PDF bytes through the existing provider helper. No arbitrary
URL, client-supplied fact, or model-supplied verification stamp can activate.
Extraction is limited to five requests per admin per ten minutes; pending current
candidates are reused without another model call.

## Rate review (dark: `GATE_LABEL_RATE_REVIEW`)

The same flow reviews application-rate directions, on its own routes
(`/:id/label-rate-review`), its own column (`products_catalog.label_rate_review`)
and its own gate, which also needs `GATE_LABEL_PIPELINE`. `product-label-review.js`
holds the one flow; `product-label-rates.js` holds what differs: the prompt, the
direction schema, validation and the reader.

A direction is one label line: use site, target pests, method, the source quote,
the physical PDF page, and `rateText`: the amount and what it is per, copied
verbatim out of the quote ("1/3 to 2/3 fl oz per 1,000 board feet"). The server
rejects a `rateText` that does not appear in the quote, so the stored amount is
always the label's own words: units, denominators and fractions stay as printed
and there is no model-made number or unit code beside the text. Limits the label
states for the line stay in the quote. A line whose amount depends on a table, a
calculation or the applicator's volume is `conditional` and carries no amount.

Approval is admin-only, needs the same identity and source-page confirmation,
and rechecks the latest PPLS filename and checksum. It writes only
`label_rate_review` plus a critical audit event (`product_label_rate.*`). It
does **not** write `label_verified_at`, any catalog rate column, protocols or
pricing. `label_verified_at` is not a label-provenance signal (planning rates
carry it), which is why rate evidence has its own record.

Nothing consumes approved directions for a dose in this change.
The mix tool parses `rateText` in code (never the model) and refuses what it
cannot parse.
`reviewedRates(product, sourceStatus)` is the reader for the later mix tool: it
returns the directions only for an approved review whose product identity
(name, registration, formulation) is unchanged and whose EPA source is current,
and `null` when there is no review or the gate is off. A weather-column edit
does not retire a rate review.

## Remaining drawer work

Catalog/protocol rate fan-out and the Intelligence Bar mix tool that reads
approved directions remain separate. The Protocol/SOP changes, dispatch strips, Score, Truck,
and property memory map are subsequent lanes. Score weights, truck-count policy,
and field-measurement precedence still require owner decisions.

PDF adapter references: [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs)
and [Anthropic PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support).
