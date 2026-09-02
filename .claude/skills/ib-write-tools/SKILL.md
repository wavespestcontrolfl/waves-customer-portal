---
name: ib-write-tools
description: Use when adding or changing an Intelligence Bar tool that writes anything (create, update, send, schedule) — every write goes through the confirm trust boundary and must register in write-gates.js.
---

# Intelligence Bar write tools — the trust boundary

With `GATE_IB_UI_CONFIRM=true` (prod default), an IB write tool never
executes from the model loop. The flow is:

1. The tool call returns a **preview** (no side effects).
2. The route persists a pending action in `ib_pending_actions`
   (actor-bound, 10-minute expiry, payload hash, single-use).
3. The client renders a Confirm/Cancel card (`PendingActionsCard`).
4. Only the operator's click commits, via `/confirm-action` — never a model
   tool; the pending id is never model-visible.

## Adding a new write tool — checklist

1. Implement the tool in the context module
   (`server/services/intelligence-bar/{context}-tools.js`) following the
   `TOOLS` + `executeTool` pattern (see
   `server/services/intelligence-bar/README.md`).
2. **Register it in `server/services/intelligence-bar/write-gates.js`.**
   A write tool missing from the gate set executes directly from the model
   loop — that's a trust-boundary breach, not a style nit.
3. Update the mirror test
   `server/tests/intelligence-bar-write-gate-contract.test.js` — it exists to
   make step 2 unforgettable; it should fail until the registration is right.
4. The preview must show the operator everything the commit will do
   (recipient, amount, date — no hidden fields).
5. Tech-portal contexts stay read-only. Never add a write tool to
   `tech-tools`.
