// Read-only "what they were sent and what they did" feed for one customer
// (GET /admin/customers/:id/activity, GATE_CUSTOMER_ACTIVITY_TIMELINE). The
// server answers { enabled: false } while the gate is dark and this renders
// nothing at all. Only first-party, already-filtered evidence (a short-link
// click, a recorded page view, a text reply) carries the "Engaged" badge and
// sets "Last engaged". Email opens, email-provider clicks and raw token-page
// views are listed, labelled by the server, and never engaged.
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Globe, Link2, Mail, MessageSquare, Phone, Smartphone } from "lucide-react";
import { Badge, Button, Card } from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

const CHANNELS = {
  sms: { label: "Text", Icon: MessageSquare },
  email: { label: "Email", Icon: Mail },
  page: { label: "Page", Icon: Globe },
  call: { label: "Call", Icon: Phone },
  portal: { label: "Portal", Icon: Smartphone },
  push: { label: "Push", Icon: Bell },
  // A short-link click with no recorded channel: neither a text nor an email.
  link: { label: "Link", Icon: Link2 },
};

function fmtWhen(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// Informational only: neither of these is engagement, and each says why.
function SummaryNotes({ summary }) {
  return (
    <>
      {summary?.lastEmailOpenAt && (
        <p className="mb-2 text-14 text-ink-secondary" data-testid="engagement-last-open">
          Last email open {fmtWhen(summary.lastEmailOpenAt)} (unreliable — Apple Mail fakes opens, so it is not counted).
        </p>
      )}
      {summary?.lastProviderClickAt && (
        <p className="mb-2 text-14 text-ink-secondary" data-testid="engagement-last-provider-click">
          Last email link click reported by the email provider {fmtWhen(summary.lastProviderClickAt)} (unfiltered — security scanners click links too, so it is not counted).
        </p>
      )}
    </>
  );
}

// `adminOnly` is the caller's isAdmin: technicians never fetch or see the feed.
export default function CustomerEngagementTimeline({ customerId, adminOnly = true }) {
  const [state, setState] = useState({ scope: null, enabled: false, events: [], summary: null, hasMore: false, nextCursor: null, unavailable: [] });
  const [error, setError] = useState(null);
  // A failed "Load older" must not blank the events already on screen (that is
  // what `error` does for a failed first load), so it has its own state.
  const [pageError, setPageError] = useState(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef({ scope: null, number: 0 });
  const scope = adminOnly ? String(customerId || "") : "";
  const mine = state.scope === scope;

  const load = useCallback(async (cursor = null) => {
    if (!scope) return;
    const number = requestRef.current.number + 1;
    requestRef.current = { scope, number };
    const current = () => requestRef.current.scope === scope && requestRef.current.number === number;
    setLoading(true);
    if (cursor) setPageError(null);
    try {
      const qs = cursor ? `?before=${encodeURIComponent(cursor)}` : "";
      const body = await adminFetch(`/admin/customers/${encodeURIComponent(scope)}/activity${qs}`);
      if (!current()) return;
      setError(null);
      setPageError(null);
      setState((prev) => {
        if (body.enabled !== true) return { ...prev, scope, enabled: false, events: [] };
        const older = cursor && prev.scope === scope ? prev.events : [];
        const seen = new Set(older.map((e) => e.id));
        return {
          scope,
          enabled: true,
          events: [...older, ...(body.events || []).filter((e) => !seen.has(e.id))],
          // Only the first page carries the summary; keep it while paging.
          summary: cursor && prev.scope === scope ? prev.summary : body.summary || null,
          hasMore: !!body.hasMore,
          nextCursor: body.nextCursor || null,
          unavailable: [...new Set([...(cursor && prev.scope === scope ? prev.unavailable : []), ...(body.unavailableSources || [])])],
        };
      });
    } catch (err) {
      if (!current()) return;
      if (cursor) setPageError(err.message || "Could not load older activity.");
      else setError(err.message || "Could not load activity.");
    } finally {
      if (current()) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    setError(null);
    setPageError(null);
    load();
  }, [load]);

  if (!scope) return null;
  if (error && !(mine && state.enabled)) {
    return (
      <div className="mb-3 flex items-center gap-3 text-14 text-ink-secondary" role="alert">
        <span>Could not load engagement activity.</span>
        <Button variant="secondary" onClick={() => load()} disabled={loading}>Retry</Button>
      </div>
    );
  }
  if (!mine || !state.enabled) return null;

  const { summary, events } = state;
  return (
    <section className="mb-5" aria-label="Engagement activity" data-testid="engagement-timeline">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-18 font-medium tracking-tight">What they received and did</h2>
        {summary && (
          <span className="text-14 text-ink-secondary" data-testid="engagement-summary">
            {summary.lastEngagedAt
              ? `Last engaged ${fmtWhen(summary.lastEngagedAt)}`
              : "No engagement recorded yet"}
          </span>
        )}
      </div>
      <SummaryNotes summary={summary} />
      {state.unavailable.length > 0 && (
        <p role="status" className="mb-2 text-14 text-ink-secondary">Some sources could not be read: {state.unavailable.join(", ")}.</p>
      )}
      <Card>
        <ul className="divide-y divide-zinc-200" aria-label="Customer engagement history">
          {events.map((e) => {
            const { Icon, label } = CHANNELS[e.channel] || CHANNELS.page;
            return (
              <li key={e.id} className="flex items-start gap-3 px-3 py-3" data-kind={e.kind}>
                <span className="mt-0.5 shrink-0 text-ink-secondary" title={label}>
                  <Icon size={17} aria-label={label} />
                </span>
                <span className="min-w-0 flex-1 text-14 leading-relaxed">
                  <strong className="block font-medium break-words">
                    {e.title}
                    {e.engaged && <Badge tone="strong" className="ml-2 align-middle">Engaged</Badge>}
                  </strong>
                  {e.detail && <span className="block text-ink-secondary break-words">{e.detail}</span>}
                </span>
                <time className="shrink-0 text-right text-14 text-ink-secondary" dateTime={e.at}>{fmtWhen(e.at)}</time>
              </li>
            );
          })}
          {events.length === 0 && (
            <li className="px-3 py-4 text-14 text-ink-secondary">Nothing recorded for this customer yet.</li>
          )}
        </ul>
        {state.hasMore && (
          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-200 p-3">
            {pageError && (
              <span className="text-14 text-ink-secondary" role="alert">Could not load older events.</span>
            )}
            <Button variant="secondary" onClick={() => load(state.nextCursor)} disabled={loading}>
              {loading ? "Loading…" : pageError ? "Retry" : "Load older"}
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}
