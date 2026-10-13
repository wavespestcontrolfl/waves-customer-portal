import React, { useState, useCallback } from "react";
import { Button, Card, CardBody, cn } from "../../components/ui";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";

// Held lines: every line whose texts are held because the caller said it cannot get texts. The inbox
// tabs only reach the newest 100 closed cards, but the number-wide hold stays until someone releases it,
// so this panel reads the hold rows (GET /admin/triage/held-lines). One row per line; a line several
// calls hold shows the newest releasable call and a count. Releasing goes through the page's own
// "Line can get texts" confirm (onRelease), so the copy and the request are the card's.
const CARD_STATE_LABELS = { open: "open", in_progress: "in progress", resolved: "resolved", dismissed: "dismissed" };

// The server sends one row per line (the newest hold on it) with calls_on_line, line_since and the LINE's
// blocked flag, capped after grouping. This still groups by phone so an older response shape (one row per
// hold) reads the same.
export function groupHeldLines(lines) {
  const byPhone = new Map();
  for (const line of lines || []) {
    if (!byPhone.has(line.phone_e164)) byPhone.set(line.phone_e164, []);
    byPhone.get(line.phone_e164).push(line);
  }
  return [...byPhone.entries()].map(([phone, rows]) => {
    // A call with an unresolved "not my number" card can only defer the release: prefer one that can clear it.
    const primary = rows.find((r) => !r.blocked_by_ownership_card) || rows[0];
    const first = (r) => new Date(r.line_since || r.held_at);
    const since = rows.reduce((a, r) => (first(r) < new Date(a) ? (r.line_since || r.held_at) : a), rows[0].line_since || rows[0].held_at);
    const calls = Math.max(rows.length, ...rows.map((r) => Number(r.calls_on_line) || 1));
    return { phone, primary, since, others: calls - 1, blocked: rows.some((r) => r.blocked_by_ownership_card) };
  });
}

// The pseudo card the page's "Line can get texts" flow works on. `line_e164` is the line the operator
// picked: the server releases that line, not "the newest" of the call.
export function heldLineItem(line) {
  return {
    held: true,
    line_e164: line.phone_e164,
    id: line.card_id,
    status: line.card_status,
    updated_at: line.card_updated_at,
    first_name: line.first_name,
    last_name: line.last_name,
    payload: { ani_phone: line.phone_e164 },
  };
}

function heldDate(ts) {
  if (!ts) return "unknown date";
  return new Date(ts).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
}

const heldCallerName = (line) => [line.first_name, line.last_name].filter(Boolean).join(" ").trim() || "Unknown caller";

// The panel's data: closed until opened (nothing loads on mount), reads the hold rows, never the inbox list.
// `onError(message)` is the page's error banner.
export function useHeldLines({ onError }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState(null); // null until first loaded
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/triage/held-lines")
      .then((d) => { setLines(Array.isArray(d?.lines) ? d.lines : []); setLoading(false); })
      .catch((err) => {
        setLoading(false);
        onError(isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : "Failed to load held lines.");
      });
  }, [onError]);

  const toggle = () => {
    setOpen(!open);
    if (!open) reload();
  };

  // Reloads only while the panel is open: callers that change a card or a hold just call this.
  const refresh = () => { if (open) reload(); };

  return { open, lines, loading, toggle, reload, refresh };
}

// Admin only: the route lists held numbers with names and is closed to technicians, so they are not offered it.
export function HeldLinesChip({ held, isAdmin }) {
  if (!isAdmin) return null;
  return (
    <button
      type="button"
      onClick={held.toggle}
      aria-pressed={held.open}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-3 rounded-md border-hairline text-14 font-medium transition-colors",
        held.open
          ? "bg-zinc-900 text-white border-zinc-900"
          : "bg-surface-card text-ink-secondary border-zinc-200 hover:bg-surface-hover"
      )}
    >
      Held lines
      {held.lines && <span className={cn("text-14", held.open ? "text-zinc-300" : "text-ink-tertiary")}>{groupHeldLines(held.lines).length}</span>}
    </button>
  );
}

function HeldLineRow({ group, actioning, onRelease }) {
  const { phone, primary, since, others, blocked } = group;
  return (
    <div className="py-3 px-3 flex flex-wrap items-start justify-between gap-2" data-testid="held-line" data-phone={phone}>
      <div className="min-w-0">
        <div className="text-14 font-medium text-zinc-900">{phone}</div>
        <div className="text-14 text-ink-secondary">
          Held since {heldDate(since)} · call of {heldDate(primary.call_created_at)} · {heldCallerName(primary)}
        </div>
        <div className="text-14 text-ink-tertiary">
          Card {CARD_STATE_LABELS[primary.card_status] || primary.card_status}, updated {heldDate(primary.card_updated_at)}
          {others > 0 && ` · ${others} more call${others === 1 ? "" : "s"} hold this line`}
        </div>
        {blocked && (
          <div className="text-14 text-alert-fg">A call on this line also has an open "not my number" card. Resolve that card first.</div>
        )}
      </div>
      <Button size="sm" variant="secondary" disabled={actioning === primary.card_id} onClick={() => onRelease(heldLineItem(primary))}>
        Line can get texts
      </Button>
    </div>
  );
}

// Shows only for an admin, only while open, and only in the page's triage mode (the auto-routed mode has no holds to show).
export default function HeldLinesPanel({ held, isAdmin, triageMode, actioning, onRelease }) {
  if (!isAdmin || !held.open || !triageMode) return null;
  const groups = groupHeldLines(held.lines);
  let body;
  if (held.loading && held.lines === null) body = <div className="p-6 text-center text-ink-tertiary text-14">Loading…</div>;
  else if (groups.length === 0) body = <div className="p-6 text-center text-14 text-ink-secondary">No held lines.</div>;
  else body = <div className="divide-y divide-zinc-200">{groups.map((g) => <HeldLineRow key={g.phone} group={g} actioning={actioning} onRelease={onRelease} />)}</div>;
  return (
    <Card>
      <CardBody>
        <div className="px-3 pt-3 text-14 font-medium text-zinc-900">Held lines</div>
        <p className="px-3 text-14 text-ink-tertiary mb-2">
          Lines where the caller said texts cannot arrive. They stay blocked until someone confirms the line can get texts.
        </p>
        {body}
      </CardBody>
    </Card>
  );
}
