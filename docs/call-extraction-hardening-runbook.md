# Call-extraction hardening runbook

Context: an inbound call (human-answered by Adam) for a bed-bug job produced a
lead with **no last name** and an **unverified, wrong service address**
("7620 Charleston St, Sarasota"). Root cause: the live lead/customer write uses
the **legacy V1 extraction**, which persists whatever address/name the model
returns with **no validation**. The V2 stack (Google Address Validation +
structured triage flags) already runs on every call but in **shadow**
(`CALL_EXTRACTION_V2_ENABLED=true`, `CALL_EXTRACTION_V2_DRIVES_ROUTING=false`),
so none of it touched the live record.

This runbook covers the three hardening layers.

---

## 1. Address-validation bridge (shipped in this PR)

While V2 is in shadow, the live write now consumes **just** the already-computed
Google verdict (`v2AddressValidation`) — no appointment/routing changes:

- **Auto-correct** — when Google decisively accepts/corrects an in-area premise
  (`validated_accept` / `corrected`), the normalized address (e.g. the fixed
  ZIP/street) is written into both the customer and the lead.
- **Flag, don't silently persist** — when a street was given but Google can't
  resolve it (`missing_component` / `ambiguous` / `confirm_needed` /
  `out_of_service_area`), the raw address is kept **and** the call is flagged:
  - lead AI-triage activity gets a `⚠ CONFIRM BEFORE DISPATCH: …` line,
  - `leads.extracted_data.needs_confirmation` records the reasons,
  - `call_log.review_status = 'open'`.
- **Identity signals** on real (hot/warm) prospects — `caller_not_authorized`
  (caller arranging service for someone else, e.g. Elaine for her fiancé Martin)
  and a missing surname are added to the same `needs_confirmation` list.

Decision logic is the pure, unit-tested `deriveCallReviewBridge()` in
`server/services/call-triage-flags.js`. The bridge **auto-disables** the moment
routing is promoted (it is guarded on `!CALL_EXTRACTION_V2_DRIVES_ROUTING`), so it
never double-acts with the enforce-mode gate.

---

## 2. CSR / field call-handling checklist (process, no code)

The defective call was human-answered. Cheapest possible hardening — confirm on
the call:

- [ ] **Account holder name, spelled** — and explicitly identify *who the account
      is for* when the caller ≠ the person being serviced ("Is this for you, or
      someone else?"). The caller's name is not always the customer's.
- [ ] **Full service address read back**, including ZIP. ("Let me read that back…")
- [ ] **Email confirmed letter-by-letter** when given.
- [ ] **Best callback number** if different from the line they're on.

Pair with the worklist below: leads with `needs_confirmation` / calls with
`review_status='open'` are what Virginia clears before dispatch.

---

## 3. Promotion decision — shadow → enforce

The real fix is promoting V2 to drive routing (`CALL_EXTRACTION_V2_DRIVES_ROUTING=true`),
which routes unverifiable-address / caller-not-authorized calls into the
`triage_items` review queue automatically. It's a money-path change, so verify
shadow agreement first. Run against prod (read-only):

```sql
-- a) Google address-validation verdict distribution (last 30d).
--    High share of validated_accept/corrected => promotion mostly auto-routes;
--    high confirm_needed/missing_component => more goes to human review.
SELECT (ai_address_validation::jsonb ->> 'status') AS av_status, COUNT(*)
FROM call_log
WHERE created_at > now() - interval '30 days'
  AND ai_address_validation IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;

-- b) Shadow routing outcome: how many calls WOULD auto-route vs need review.
SELECT action, COUNT(*)
FROM route_decisions
WHERE mode = 'shadow' AND created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 2 DESC;

-- c) V2 schema-pass rate by prompt version (promotion readiness — want ~all 'valid').
SELECT ai_extraction_prompt_version, v2_extraction_status, COUNT(*)
FROM call_log
WHERE created_at > now() - interval '30 days' AND v2_extraction_status IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

(`ai_address_validation` / `ai_validation` are JSON text — cast `::jsonb` as above.)

Promote when: (c) shows near-100% `valid` on the current prompt version, and
(b)'s `shadow_needs_review_candidate` rate is an acceptable manual-review volume.
Then set `CALL_EXTRACTION_V2_DRIVES_ROUTING=true` on Railway and redeploy. The
bridge in §1 goes inert automatically.
