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

## Remaining drawer work

Application-rate review and any catalog/protocol rate fan-out remain separate
from this weather scope. The Protocol/SOP changes, dispatch strips, Score, Truck,
and property memory map are subsequent lanes. Score weights, truck-count policy,
and field-measurement precedence still require owner decisions.

PDF adapter references: [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs)
and [Anthropic PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support).
