// client/src/pages/admin/NewsletterPage.jsx
//
// Top-level newsletter dashboard — first-class admin page under the
// Marketing sidebar group. Seven tabs:
//   - Dashboard     stats + sample events + quick actions + recent posts
//   - Calendar      editorial plan (16-week rolling view)
//   - Compose       draft + send a newsletter
//   - History       past sends
//   - Subscribers   list + manage
//   - Events        inbox + sources
//   - Automations   drip + trigger flows
//
// Per-tab URL state via ?tab=dashboard|calendar|compose|history|subscribers|events|automations
// so a refresh or a shared link lands on the right view. Default = dashboard.
//
// Compose / History / Subscribers render named exports from
// ./NewsletterTabs (formerly NewsletterTabV2 — consolidated under
// /admin/newsletter when newsletter-v1 was rolled out). Automations
// renders EmailAutomationsPanelV2 directly.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Select,
  Input,
  Table,
  THead,
  TR,
  TH,
  Checkbox,
  TBody,
  TD,
  UiSurface,
} from "../../components/ui";
import {
  Users,
  Zap,
  Calendar,
  CalendarDays,
  FileText,
  TrendingUp,
  Sparkles,
  Upload,
  MapPin,
  MailPlus,
  Send,
  ListFilter,
  Check,
  X,
  Star,
  Search,
  RefreshCw,
  GitMerge,
} from "lucide-react";
import { ComposeView, HistoryView, SubscribersView } from "./NewsletterTabs";
import EmailAutomationsPanelV2 from "./EmailAutomationsPanelV2";
import { NEWSLETTER_UI_COPY } from "./newsletterUiCopy";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  });
}
const TABS = [
  {
    key: "dashboard",
    label: "Dashboard",
    desc: "Overview",
    Icon: TrendingUp,
  },
  {
    key: "calendar",
    label: "Calendar",
    desc: NEWSLETTER_UI_COPY.sendCadence,
    Icon: CalendarDays,
  },
  {
    key: "compose",
    label: "Compose",
    desc: "Draft + send",
    Icon: MailPlus,
  },
  {
    key: "history",
    label: "History",
    desc: "Performance",
    Icon: FileText,
  },
  {
    key: "subscribers",
    label: "Subscribers",
    desc: "Audience",
    Icon: Users,
  },
  {
    key: "events",
    label: "Events",
    desc: "Inbox + sources",
    Icon: ListFilter,
  },
  {
    key: "automations",
    label: "Automations",
    desc: "Drips",
    Icon: Zap,
  },
];
const TAB_BY_KEY = Object.fromEntries(TABS.map((t) => [t.key, t]));

// The 7-tab bar is grouped into parent sections, each revealing its leaf
// tabs in a sub-row. `tab` still holds the LEAF key (URL ?tab=…), so every
// {tab === "..."} render block below is unchanged. Default/primary tab
// (dashboard) is the first group.
const NEWSLETTER_TAB_GROUPS = [
  {
    key: "dashboard",
    label: "Dashboard",
    Icon: TrendingUp,
    tabs: ["dashboard"],
  },
  {
    key: "compose",
    label: "Compose",
    Icon: MailPlus,
    tabs: ["compose"],
  },
  {
    key: "schedule",
    label: "Schedule",
    Icon: CalendarDays,
    tabs: ["calendar", "history"],
  },
  {
    key: "automation",
    label: "Automation",
    Icon: Zap,
    tabs: ["automations", "events"],
  },
  {
    key: "audience",
    label: "Audience",
    Icon: Users,
    tabs: ["subscribers"],
  },
];
function StatTile({ icon: Icon, label, value, sub }) {
  return (
    <Card>
      {" "}
      <CardBody>
        {" "}
        <div className="flex items-center gap-2 mb-2 text-ink-secondary">
          {" "}
          <Icon size={14} strokeWidth={1.75} aria-hidden />{" "}
          <span className="u-label">{label}</span>{" "}
        </div>{" "}
        <div className="u-nums font-medium text-ink-primary text-[24px]">
          {value}
        </div>
        {sub && (
          <div className="text-ui-body text-ink-tertiary mt-1">{sub}</div>
        )}
      </CardBody>{" "}
    </Card>
  );
}
function SectionHeader({ title, hint, action }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-3">
      {" "}
      <div className="min-w-0">
        {" "}
        <h2 className="text-14 font-medium text-ink-primary">{title}</h2>
        {hint && (
          <div className="text-ui-body text-ink-tertiary mt-0.5">{hint}</div>
        )}
      </div>
      {action}
    </div>
  );
}
// Allowlist URL protocols on the render side too — events_raw rows
// pre-dating the ingestion-side validation could still contain a
// `javascript:` URL, and rendering that into <a href>would execute
// on click. Server already filters at ingestion (event-ingestion.js
// safeHttpUrl); this is the second layer.
function safeHttpUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Renders one ingested event from /admin/newsletter/events. Shape:
//   { id, title, description, startAt, endAt, venueName, venueAddress,
//     city, geoLat, geoLng, eventUrl, imageUrl, categories, sourceName }
// startAt + city + sourceName + description + venue fields may be
// null for some feeds — render gracefully.
function EventCard({ event, onDraft }) {
  const dateLabel = event.startAt
    ? new Date(event.startAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Ongoing";
  const cityLabel = event.city
    ? event.city.replace(/(?:^|\s)\S/g, (s) => s.toUpperCase())
    : null;
  const sourceLabel =
    (event.sourceName || "").split("·")[0].trim().slice(0, 18) || "Source";
  const safeUrl = safeHttpUrl(event.eventUrl);

  // Map deep-link. Prefer geocoded lat/lng (precise) over the raw
  // venue_address string fallback (Google still resolves it server-side
  // but precision is better with coords). Only render the link when at
  // least one of those is present.
  const mapUrl =
    event.geoLat != null && event.geoLng != null
      ? `https://www.google.com/maps?q=${encodeURIComponent(`${event.geoLat},${event.geoLng}`)}`
      : event.venueAddress
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.venueAddress)}`
        : null;
  return (
    <div className="bg-white border-hairline border-zinc-200 rounded-sm p-3 flex flex-col gap-2">
      {" "}
      <div className="flex items-start justify-between gap-2">
        {" "}
        <div className="flex-1 min-w-0">
          {" "}
          <div className="text-ui-body font-medium text-ink-primary truncate">
            {event.title}
          </div>{" "}
          <div className="text-ui-body text-ink-tertiary mt-0.5 u-nums">
            {dateLabel}
            {cityLabel ? ` · ${cityLabel}` : ""}
          </div>{" "}
        </div>{" "}
        <Badge tone="neutral">{sourceLabel}</Badge>{" "}
      </div>
      {(event.venueName || event.venueAddress) && (
        <div className="flex items-start gap-1.5 text-ui-body text-ink-tertiary leading-snug">
          {" "}
          <MapPin
            size={11}
            strokeWidth={1.75}
            aria-hidden
            className="mt-0.5 flex-shrink-0"
          />{" "}
          <div className="min-w-0">
            {event.venueName && (
              <div className="text-ink-secondary truncate">
                {event.venueName}
              </div>
            )}
            {event.venueAddress && (
              <div className="truncate">{event.venueAddress}</div>
            )}
          </div>{" "}
        </div>
      )}
      {event.description && (
        <div className="text-ui-body text-ink-secondary leading-snug line-clamp-2">
          {event.description}
        </div>
      )}
      <div className="flex justify-end gap-2 mt-1">
        {mapUrl && (
          <a
            href={mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-ui-body font-medium text-zinc-700 hover:text-zinc-900 underline underline-offset-2"
          >
            View on map
          </a>
        )}
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-ui-body font-medium text-zinc-700 hover:text-zinc-900 underline underline-offset-2"
          >
            View source
          </a>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={onDraft || undefined}
          disabled={!onDraft}
          title={
            onDraft
              ? "Switch to Compose with this event pre-loaded for AI Draft"
              : "Wire-up pending"
          }
        >
          {" "}
          <Sparkles size={12} strokeWidth={1.75} className="mr-1" />
          Draft newsletter
        </Button>{" "}
      </div>{" "}
    </div>
  );
}
function QuickActions({ onSelectTab }) {
  // "Draft from event" was retired — that workflow is the "Draft
  // newsletter" button on each EventCard tile in the section below.
  // Keep this grid 2-up.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {" "}
      <Card
        className="cursor-pointer hover:bg-zinc-50 transition-colors"
        onClick={() => onSelectTab("compose")}
      >
        {" "}
        <CardBody>
          {" "}
          <div className="flex items-center gap-2 mb-2">
            {" "}
            <FileText
              size={18}
              strokeWidth={1.75}
              className="text-zinc-900"
            />{" "}
            <span className="text-14 font-medium text-ink-primary">
              Compose manually
            </span>{" "}
          </div>{" "}
          <div className="text-ui-body text-ink-tertiary">
            Start a blank draft in the composer.
          </div>{" "}
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectTab("compose");
            }}
            className="inline-block mt-3"
            variant="secondary"
          >
            Open composer →
          </Button>{" "}
        </CardBody>{" "}
      </Card>{" "}
      <Card
        className="cursor-pointer hover:bg-zinc-50 transition-colors"
        onClick={() => onSelectTab("subscribers")}
      >
        {" "}
        <CardBody>
          {" "}
          <div className="flex items-center gap-2 mb-2">
            {" "}
            <Upload
              size={18}
              strokeWidth={1.75}
              className="text-zinc-900"
            />{" "}
            <span className="text-14 font-medium text-ink-primary">
              Import subscribers
            </span>{" "}
          </div>{" "}
          <div className="text-ui-body text-ink-tertiary">
            Bulk import subscribers from a CSV.
          </div>{" "}
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectTab("subscribers");
            }}
            className="inline-block mt-3"
            variant="secondary"
          >
            Go to subscribers →
          </Button>{" "}
        </CardBody>{" "}
      </Card>{" "}
    </div>
  );
}
function ManageTile({ icon: Icon, title, body, onClick }) {
  return (
    <Card
      className="cursor-pointer hover:bg-zinc-50 transition-colors"
      onClick={onClick}
    >
      {" "}
      <CardBody>
        {" "}
        <div className="flex items-start gap-3">
          {" "}
          <div className="h-9 w-9 rounded-sm bg-zinc-100 text-zinc-900 inline-flex items-center justify-center flex-shrink-0">
            {" "}
            <Icon size={17} strokeWidth={1.75} aria-hidden />{" "}
          </div>{" "}
          <div className="min-w-0">
            {" "}
            <div className="text-14 font-medium text-ink-primary">
              {title}
            </div>{" "}
            <div className="text-ui-body text-ink-tertiary mt-1 leading-snug">
              {body}
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </CardBody>{" "}
    </Card>
  );
}
function PostStatusBadge({ status }) {
  if (status === "sent") return <Badge tone="strong">Sent</Badge>;
  if (status === "sending") return <Badge tone="neutral">Sending…</Badge>;
  if (status === "scheduled") return <Badge tone="neutral">Scheduled</Badge>;
  if (status === "failed") return <Badge tone="alert">Failed</Badge>;
  return <Badge tone="neutral">Draft</Badge>;
}
function RecentPosts({ posts, loading }) {
  if (loading) {
    return (
      <div className="p-6 text-center text-ui-body text-ink-secondary">
        Loading…
      </div>
    );
  }
  if (!posts || posts.length === 0) {
    return (
      <Card>
        {" "}
        <CardBody className="text-center">
          {" "}
          <div className="text-14 text-ink-primary mb-1">No posts yet</div>{" "}
          <div className="text-ui-body text-ink-tertiary">
            Draft your first newsletter from an event, or compose manually.
          </div>{" "}
        </CardBody>{" "}
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {posts.map((p) => {
        const openRate =
          p.delivered_count > 0 ? p.opened_count / p.delivered_count : null;
        return (
          <div
            key={p.id}
            className="bg-white border-hairline border-zinc-200 rounded-sm px-3 py-2.5 flex items-center gap-3"
          >
            {" "}
            <div className="flex-1 min-w-0">
              {" "}
              <div className="text-ui-body font-medium text-ink-primary truncate">
                {p.subject || "(untitled)"}
              </div>{" "}
              <div className="text-ui-body text-ink-tertiary mt-0.5 u-nums flex items-center gap-2 flex-wrap">
                {p.sent_at && (
                  <span>
                    Sent{" "}
                    {new Date(p.sent_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                )}
                {openRate != null && (
                  <span>· {(openRate * 100).toFixed(0)}% open</span>
                )}
                {p.recipient_count != null && p.recipient_count > 0 && (
                  <span>· {p.recipient_count.toLocaleString()} recipients</span>
                )}
              </div>{" "}
            </div>{" "}
            <PostStatusBadge status={p.status || "draft"} />{" "}
          </div>
        );
      })}
    </div>
  );
}
function DashboardView({
  onSelectTab,
  onDraftFromEvent,
  sendsData,
  sendsLoading,
  subscribersActive,
}) {
  // Recent posts + Last open rate are derived from the sends payload owned
  // by the parent (NewsletterPage) so the sends/subscribers fetches don't
  // run twice on the default dashboard tab. Events stay local — only the
  // dashboard uses them. `loadingPosts` is gated on the parent's loading
  // flag (not `sendsData == null`) so a fetch error clears the spinner
  // instead of leaving the panel stuck on "Loading…".
  const recentPosts = useMemo(
    () => (sendsData?.sends || []).slice(0, 5),
    [sendsData],
  );
  const lastOpenRate = useMemo(() => {
    const sends = sendsData?.sends || [];
    // Most recent sent row, regardless of delivered_count — a send to an
    // empty segment can land with delivered_count=0, and the tile should
    // reflect the *true* latest send (rendering '—' when there's nothing
    // to compute), not skip to an older one.
    const lastSent = sends.find((s) => s.status === "sent");
    return lastSent && lastSent.delivered_count > 0
      ? lastSent.opened_count / lastSent.delivered_count
      : null;
  }, [sendsData]);
  const scheduledCount = sendsData ? (sendsData.counts?.scheduled ?? 0) : null;
  const loadingPosts = sendsLoading;
  const stats = {
    subscribers: subscribersActive,
    lastOpenRate,
    scheduledCount,
  };
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  useEffect(() => {
    let ignore = false;
    adminFetch("/admin/newsletter/events?days=14&limit=12")
      .then((d) => {
        if (!ignore) {
          setEvents(d.events || []);
          setLoadingEvents(false);
        }
      })
      .catch(() => {
        if (!ignore) setLoadingEvents(false);
      });
    return () => {
      ignore = true;
    };
  }, []);
  return (
    <div>
      {/* Stats strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {" "}
        <StatTile
          icon={Users}
          label="Subscribers"
          value={
            stats.subscribers != null ? stats.subscribers.toLocaleString() : "—"
          }
          sub="active list"
        />{" "}
        <StatTile
          icon={TrendingUp}
          label="Last open rate"
          value={
            stats.lastOpenRate != null
              ? `${(stats.lastOpenRate * 100).toFixed(0)}%`
              : "—"
          }
          sub="most recent send"
        />{" "}
        <StatTile
          icon={Calendar}
          label="Scheduled"
          value={stats.scheduledCount != null ? stats.scheduledCount : "—"}
          sub="queued sends"
        />{" "}
      </div>
      {/* Quick actions */}
      <div className="mb-6">
        {" "}
        <SectionHeader
          title="Quick start"
          hint="Pick a starting point — or use the event tiles below for an event-anchored draft"
        />{" "}
        <QuickActions onSelectTab={onSelectTab} />{" "}
      </div>
      {/* Upcoming events — pulled from event_sources via the daily
          ingestion cron (server/services/event-ingestion.js). P3a ships
          RSS-only; iCal + scrape land in P3b. */}
      <div className="mb-6">
        {" "}
        <SectionHeader
          title="Upcoming events worth writing about"
          hint="Pulled from local SWFL feeds (Tampa.gov, Bay News 9, Manatee Chamber, Sarasota Magazine, The Gabber, Lakewood Ranch). Refreshes daily 4am ET."
        />
        {loadingEvents ? (
          <div className="text-ui-body text-ink-tertiary p-3">
            Loading events…
          </div>
        ) : events.length === 0 ? (
          <Card>
            {" "}
            <CardBody className="text-center">
              {" "}
              <div className="text-14 text-ink-primary mb-1">
                No upcoming events
              </div>{" "}
              <div className="text-ui-body text-ink-tertiary">
                The next ingestion run is at 4am ET. Sources can be inspected in
                the event_sources table.
              </div>{" "}
            </CardBody>{" "}
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {events.map((e) => (
              <EventCard
                key={e.id}
                event={e}
                onDraft={onDraftFromEvent ? () => onDraftFromEvent(e) : null}
              />
            ))}
          </div>
        )}
      </div>
      {/* Recent posts */}
      <div className="mb-6">
        {" "}
        <SectionHeader
          title="Recent posts"
          action={
            <Button
              type="button"
              onClick={() => onSelectTab("history")}
              className=""
              variant="secondary"
            >
              View all →
            </Button>
          }
        />{" "}
        <RecentPosts posts={recentPosts} loading={loadingPosts} />{" "}
      </div>
      {/* Sub-page tile — Automations */}
      <div className="mb-6">
        {" "}
        <SectionHeader title="Manage" hint="Jump straight to a section" />{" "}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {" "}
          <ManageTile
            icon={Send}
            title="Past sends"
            body="Review delivered counts, bounces, unsubscribes, and A/B subject performance."
            onClick={() => onSelectTab("history")}
          />{" "}
          <ManageTile
            icon={Users}
            title="Audience"
            body="Search, export, add, and unsubscribe newsletter contacts."
            onClick={() => onSelectTab("subscribers")}
          />{" "}
          <ManageTile
            icon={Zap}
            title="Automations"
            body="Manage referral nudges, payment failed flows, booking triggers, and drips."
            onClick={() => onSelectTab("automations")}
          />{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ── Event Inbox ──────────────────────────────────────────────────────

const FRESHNESS_LABELS = {
  fresh_one_time: "One-Time",
  fresh_annual: "Annual",
  fresh_limited_run_opening: "Opening Week",
  fresh_limited_run_closing: "Closing Week",
  fresh_series_launch: "Series Launch",
  fresh_special_edition: "Special Edition",
  stale_recurring: "Stale Recurring",
  expired: "Expired",
  needs_review: "Needs Review",
};
const STATUS_FILTERS = ["all", "pending", "approved", "rejected", "featured"];
function FreshnessBadge({ status }) {
  const label = FRESHNESS_LABELS[status] || status;
  const isFresh = status?.startsWith("fresh_");
  const isStale = status === "stale_recurring" || status === "expired";
  const cls = isFresh
    ? "bg-zinc-700 text-white"
    : isStale
      ? "bg-zinc-200 text-zinc-500"
      : "bg-zinc-100 text-zinc-500 border border-dashed border-zinc-300";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-ui-body font-medium ${cls}`}
    >
      {label}
    </span>
  );
}
function AdminStatusBadge({ status }) {
  const map = {
    pending: "bg-zinc-200 text-zinc-600",
    approved: "bg-zinc-800 text-white",
    rejected: "bg-zinc-100 text-zinc-400 line-through",
    featured: "bg-zinc-900 text-white",
  };
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-ui-body font-medium ${map[status] || "bg-zinc-100 text-zinc-500"}`}
    >
      {status === "featured" && "★ "}
      {status}
    </span>
  );
}
function EventInboxView({ onDraftFromEvent }) {
  const [events, setEvents] = useState([]);
  const [counts, setCounts] = useState({});
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [freshnessFilter, setFreshnessFilter] = useState("");
  const [zoneFilter, setZoneFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const eventsAbortRef = useRef(null);
  const [actionStatus, setActionStatus] = useState("");
  const fetchEvents = () => {
    eventsAbortRef.current?.abort();
    const controller = new AbortController();
    eventsAbortRef.current = controller;
    setLoading(true);
    const params = new URLSearchParams({
      limit: "100",
    });
    if (statusFilter && statusFilter !== "all")
      params.set("status", statusFilter);
    if (freshnessFilter) params.set("freshness", freshnessFilter);
    if (zoneFilter) params.set("zone", zoneFilter);
    if (searchQuery) params.set("q", searchQuery);
    adminFetch(`/admin/newsletter/events/inbox?${params}`, { signal: controller.signal })
      .then((d) => {
        if (controller.signal.aborted) return;
        setEvents(d.events || []);
        setCounts(d.counts || {});
        setSelected(new Set());
      })
      .catch((e) => {
        if (e.name !== "AbortError") setEvents([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  };
  const fetchSources = () => {
    adminFetch("/admin/newsletter/events/sources")
      .then((d) => setSources(d.sources || []))
      .catch(() => {});
  };
  useEffect(() => {
    fetchEvents();
    fetchSources();
    return () => eventsAbortRef.current?.abort();
  }, [statusFilter, freshnessFilter, zoneFilter]);
  const doSearch = () => fetchEvents();
  const patchEvent = async (id, body) => {
    setActionStatus("Saving event…");
    try {
      await adminFetch(`/admin/newsletter/events/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setActionStatus("Event updated.");
      fetchEvents();
    } catch (e) {
      setActionStatus("Event update failed: " + e.message);
    }
  };
  const bulkAction = async (action) => {
    if (selected.size === 0) return;
    if (
      action === "reject" &&
      !confirm(
        `Reject ${selected.size} selected event${selected.size === 1 ? "" : "s"}?`,
      )
    )
      return;
    setActionStatus(`${action} in progress…`);
    try {
      await adminFetch("/admin/newsletter/events/bulk-action", {
        method: "POST",
        body: JSON.stringify({ action, ids: [...selected] }),
      });
      setActionStatus(
        `${selected.size} event${selected.size === 1 ? "" : "s"} updated.`,
      );
      fetchEvents();
    } catch (e) {
      setActionStatus(`Bulk ${action} failed: ${e.message}`);
    }
  };

  // Merge duplicates. The survivor is chosen by a visible, deterministic rule
  // (most complete — has image, then has link — ties broken by table order),
  // NOT by click order, and the confirm names it so the admin can cancel if
  // it's not the one they meant to keep.
  const mergeSelected = async () => {
    if (selected.size < 2) return;
    // events is in displayed table order; filter preserves it. Stable sort
    // keeps table order for equally-complete rows.
    const chosen = events.filter((e) => selected.has(e.id));
    const completeness = (e) => (e.imageUrl ? 2 : 0) + (e.eventUrl ? 1 : 0);
    const primary = [...chosen].sort(
      (a, b) => completeness(b) - completeness(a),
    )[0];
    if (!primary) return;
    const primaryId = primary.id;
    const duplicateIds = chosen
      .filter((e) => e.id !== primaryId)
      .map((e) => e.id);
    if (
      !confirm(
        `Keep "${primary.title}" and merge ${duplicateIds.length} duplicate${duplicateIds.length === 1 ? "" : "s"} into it?\n\n` +
          `Kept because it's the most complete (image / link). The others will be rejected (removed from the queue) and any planned calendars repointed to the kept event.`,
      )
    )
      return;
    try {
      await adminFetch("/admin/newsletter/events/merge", {
        method: "POST",
        body: JSON.stringify({ primaryId, duplicateIds }),
      });
      setSelected(new Set());
      fetchEvents();
    } catch (e) {
      alert("Merge failed: " + e.message);
    }
  };
  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === events.length) setSelected(new Set());
    else setSelected(new Set(events.map((e) => e.id)));
  };
  const fmtDate = (d) => {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      weekday: "short",
      timeZone: "America/New_York",
    });
  };
  return (
    <div className="space-y-4 mt-4">
      {/* Source Health Strip */}
      <div className="bg-white border-hairline border-zinc-200 rounded-sm">
        <Button
          type="button"
          onClick={() => setSourcesOpen(!sourcesOpen)}
          className="w-full text-left"
          variant="secondary"
        >
          <span className="text-ui-body font-medium text-ink-primary">
            Event Sources ({sources.length})
          </span>
          <span className="text-ui-body text-ink-tertiary">
            {sourcesOpen ? "Hide" : "Show"}
          </span>
        </Button>
        {sourcesOpen && (
          <div className="px-4 pb-3 flex flex-wrap gap-2">
            {sources.map((s) => {
              // A source can "succeed" while yielding nothing for days —
              // that's a broken feed, not a healthy one. Amber once the
              // empty streak passes a week.
              const zeroYieldDegraded =
                s.lastPullStatus === "success" &&
                (s.consecutiveZeroYields ?? 0) >= 7;
              return (
                <div
                  key={s.id}
                  title={
                    zeroYieldDegraded
                      ? `Pulls succeed but 0 events for ${s.consecutiveZeroYields} runs`
                      : s.lastError || undefined
                  }
                  className="flex items-center gap-1.5 px-2 py-1 bg-zinc-50 border-hairline border-zinc-200 rounded text-ui-body"
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${s.lastPullStatus === "error" ? "bg-alert-fg" : zeroYieldDegraded ? "bg-warn-fg" : s.lastPullStatus === "success" ? "bg-green-500" : "bg-zinc-300"}`}
                  />
                  <span className="text-ink-primary font-medium truncate max-w-[140px]">
                    {s.name.split("—")[0].trim()}
                  </span>
                  <span className="text-ink-tertiary">{s.eventCount}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white border-hairline border-zinc-200 rounded-sm p-4 space-y-3">
        {/* Status tabs */}
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className="rounded-sm"
              aria-pressed={statusFilter === s}
              variant={statusFilter === s ? "primary" : "secondary"}
            >
              {s}
              {counts[s] != null ? ` (${counts[s]})` : ""}
            </Button>
          ))}
        </div>

        {/* Secondary filters */}
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-ui-body text-ink-tertiary mb-0.5">
              Freshness
            </label>
            <Select
              value={freshnessFilter}
              onChange={(e) => setFreshnessFilter(e.target.value)}
              className=""
              aria-label="Freshness"
            >
              <option value="">All</option>
              <option value="fresh">Fresh</option>
              <option value="stale">Stale</option>
              <option value="needs_review">Needs Review</option>
            </Select>
          </div>
          <div>
            <label className="block text-ui-body text-ink-tertiary mb-0.5">
              Zone
            </label>
            <Select
              value={zoneFilter}
              onChange={(e) => setZoneFilter(e.target.value)}
              className=""
              aria-label="Zone"
            >
              <option value="">All zones</option>
              <option value="south_sarasota">South Sarasota</option>
              <option value="sarasota">Sarasota</option>
              <option value="manatee">Manatee</option>
              <option value="pinellas">Pinellas</option>
              <option value="tampa">Tampa</option>
            </Select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-ui-body text-ink-tertiary mb-0.5">
              Search
            </label>
            <div className="flex gap-1">
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSearch()}
                placeholder="Search event titles..."
                className="flex-1"
                aria-label="Search"
              />
              <Button
                type="button"
                onClick={doSearch}
                aria-label="Search"
                className=""
                variant="secondary"
              >
                <Search size={13} strokeWidth={1.75} aria-hidden />
              </Button>
            </div>
          </div>
          <Button
            type="button"
            onClick={fetchEvents}
            className=""
            title="Refresh"
            variant="secondary"
            aria-label="Refresh"
          >
            <RefreshCw size={13} strokeWidth={1.75} />
          </Button>
        </div>

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-ui-body text-ink-secondary">
              {selected.size} selected
            </span>
            <Button size="sm" onClick={() => bulkAction("approve")}>
              <Check size={12} className="mr-1" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => bulkAction("reject")}
            >
              <X size={12} className="mr-1" />
              Reject
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => bulkAction("feature")}
            >
              <Star size={12} className="mr-1" />
              Feature
            </Button>
            {selected.size >= 2 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={mergeSelected}
                title="Merge duplicates — the most complete event (image/link) is kept; the confirm names it"
              >
                <GitMerge size={12} className="mr-1" />
                Merge {selected.size}
              </Button>
            )}
          </div>
        )}
      </div>

      {actionStatus && (
        <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm px-3 py-2 text-ui-body text-ink-secondary">
          {actionStatus}
        </div>
      )}

      {/* Event Table */}
      <div className="bg-white border-hairline border-zinc-200 rounded-sm overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-ui-body text-ink-tertiary">
            Loading events...
          </div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-ui-body text-ink-tertiary">
            No events match the current filters.
          </div>
        ) : (
          <Table className="w-full text-left">
            <THead>
              <TR className="border-b border-zinc-100">
                <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-8">
                  <Checkbox
                    checked={
                      selected.size === events.length && events.length > 0
                    }
                    onChange={toggleAll}
                    className="shrink-0"
                  />
                </TH>
                <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary">
                  Event
                </TH>
                <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-24">
                  Date
                </TH>
                <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-24">
                  City
                </TH>
                <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-28">
                  Freshness
                </TH>
                <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-20">
                  Status
                </TH>
                <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-20">
                  Score
                </TH>
                <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-28">
                  Actions
                </TH>
              </TR>
            </THead>
            <TBody>
              {events.map((ev) => (
                <TR
                  key={ev.id}
                  className={`border-b border-zinc-50 hover:bg-zinc-25 ${ev.adminStatus === "rejected" ? "opacity-50" : ""}`}
                >
                  <TD className="px-3 py-2">
                    <Checkbox
                      checked={selected.has(ev.id)}
                      onChange={() => toggleSelect(ev.id)}
                      className="shrink-0"
                    />
                  </TD>
                  <TD className="px-3 py-2">
                    <div className="text-ui-body font-medium text-ink-primary leading-snug line-clamp-1">
                      {(() => {
                        const safe = safeHttpUrl(ev.eventUrl);
                        return safe ? (
                          <a
                            href={safe}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            {ev.title}
                          </a>
                        ) : (
                          ev.title
                        );
                      })()}
                    </div>
                    {ev.venueName && (
                      <div className="text-ui-body text-ink-tertiary mt-0.5 line-clamp-1">
                        {ev.venueName}
                      </div>
                    )}
                    <div className="text-ui-body text-ink-tertiary mt-0.5">
                      {ev.sourceName?.split("—")[0]?.trim()}
                    </div>
                  </TD>
                  <TD className="px-3 py-2 text-ui-body text-ink-secondary">
                    {fmtDate(ev.startAt)}
                  </TD>
                  <TD className="px-3 py-2 text-ui-body text-ink-secondary">
                    {ev.city || "—"}
                  </TD>
                  <TD className="px-3 py-2">
                    <FreshnessBadge status={ev.freshnessStatus} />
                  </TD>
                  <TD className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <AdminStatusBadge status={ev.adminStatus} />
                      {ev.approvedVia === "auto_curation" && (
                        <span
                          title={ev.curationNote || "Approved by auto-curation"}
                          className="text-ui-body uppercase tracking-label text-ink-tertiary border-hairline border-zinc-200 rounded px-1 py-0.5"
                        >
                          Auto
                        </span>
                      )}
                      {!ev.approvedVia &&
                        ev.curatedAt &&
                        ev.adminStatus === "pending" && (
                          <span
                            title={
                              ev.curationNote ||
                              "Examined by auto-curation, left for human review"
                            }
                            className="text-ui-body uppercase tracking-label text-ink-tertiary border-hairline border-zinc-200 rounded px-1 py-0.5"
                          >
                            Held
                          </span>
                        )}
                    </div>
                  </TD>
                  <TD className="px-3 py-2 text-ui-body text-ink-secondary u-nums">
                    {ev.compositeScore ?? "—"}
                  </TD>
                  <TD className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        onClick={() => onDraftFromEvent?.(ev)}
                        className=""
                        title="Draft a newsletter with this event preloaded"
                        variant="secondary"
                        aria-label="Draft a newsletter with this event preloaded"
                      >
                        <FileText size={13} strokeWidth={2} />
                      </Button>
                      {ev.adminStatus !== "approved" &&
                        ev.adminStatus !== "featured" && (
                          <Button
                            type="button"
                            onClick={() =>
                              patchEvent(ev.id, {
                                adminStatus: "approved",
                              })
                            }
                            className=""
                            title="Approve"
                            variant="secondary"
                            aria-label="Approve"
                          >
                            <Check size={13} strokeWidth={2} />
                          </Button>
                        )}
                      {ev.adminStatus !== "rejected" && (
                        <Button
                          type="button"
                          onClick={() =>
                            patchEvent(ev.id, {
                              adminStatus: "rejected",
                              suppressionReason: "manual_reject",
                            })
                          }
                          className=""
                          title="Reject"
                          variant="secondary"
                          aria-label="Reject"
                        >
                          <X size={13} strokeWidth={2} />
                        </Button>
                      )}
                      {ev.adminStatus !== "featured" && (
                        <Button
                          type="button"
                          onClick={() =>
                            patchEvent(ev.id, {
                              adminStatus: "featured",
                            })
                          }
                          className=""
                          title="Feature"
                          variant="secondary"
                          aria-label="Feature"
                        >
                          <Star size={13} strokeWidth={2} />
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}

// ── Calendar View ───────────────────────────────────────────────────

function CalendarRow({
  row,
  isPast,
  isCurrent,
  rowCls,
  saving,
  onSave,
  onDraft,
  drafting,
  fmtWeekLabel,
  STATUS_STYLE,
}) {
  const [editTopic, setEditTopic] = useState(row.topic || "");
  const [editTip, setEditTip] = useState(row.homeownerMinuteTopic || "");
  const [dirty, setDirty] = useState(false);

  // Reset local state when row data changes (after save/fetch)
  useEffect(() => {
    setEditTopic(row.topic || "");
    setEditTip(row.homeownerMinuteTopic || "");
    setDirty(false);
  }, [row.topic, row.homeownerMinuteTopic]);
  const handleTopicChange = (e) => {
    setEditTopic(e.target.value);
    setDirty(true);
  };
  const handleTipChange = (e) => {
    setEditTip(e.target.value);
    setDirty(true);
  };
  const handleSave = () => {
    if (!dirty) return;
    onSave({
      topic: editTopic || null,
      homeownerMinuteTopic: editTip || null,
    });
  };
  const handleBlur = () => {
    if (dirty) handleSave();
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      e.target.blur();
    }
  };

  // Draft button is enabled only for planned rows that are not past
  const canDraft = !isPast && row.status === "planned" && !drafting;
  return (
    <TR className={`border-b border-zinc-50 hover:bg-zinc-25 ${rowCls}`}>
      <TD className="px-3 py-2">
        <div className="text-ui-body font-medium text-ink-primary">
          {fmtWeekLabel(row.weekOf)}
        </div>
        {isCurrent && (
          <div className="text-ui-body text-ink-tertiary font-medium">
            This week
          </div>
        )}
      </TD>
      <TD className="px-3 py-2">
        {isPast ? (
          <span className="text-ui-body text-ink-secondary">
            {row.topic || "—"}
          </span>
        ) : (
          <Input
            type="text"
            value={editTopic}
            onChange={handleTopicChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="Add topic..."
            className="w-full"
            aria-label="Add topic..."
          />
        )}
      </TD>
      <TD className="px-3 py-2">
        {isPast ? (
          <span className="text-ui-body text-ink-secondary">
            {row.homeownerMinuteTopic || "—"}
          </span>
        ) : (
          <Input
            type="text"
            value={editTip}
            onChange={handleTipChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="Tip topic..."
            className="w-full"
            aria-label="Tip topic..."
          />
        )}
      </TD>
      <TD className="px-3 py-2">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-ui-body font-medium ${STATUS_STYLE[row.status] || STATUS_STYLE.planned}`}
        >
          {row.status}
        </span>
      </TD>
      <TD className="px-3 py-2 text-ui-body text-ink-secondary u-nums">
        {(row.eventIds || []).length || "—"}
      </TD>
      <TD className="px-3 py-2">
        {row.send ? (
          <div className="text-ui-body text-ink-tertiary u-nums">
            <span>{row.send.deliveredCount || 0} delivered</span>
            {row.send.openedCount > 0 && (
              <span> · {row.send.openedCount} opened</span>
            )}
          </div>
        ) : (
          <span className="text-ui-body text-ink-tertiary">—</span>
        )}
      </TD>
      <TD className="px-3 py-2">
        {canDraft ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onDraft({
                ...row,
                topic: editTopic || null,
                homeownerMinuteTopic: editTip || null,
              })
            }
            disabled={drafting}
          >
            <Sparkles size={12} strokeWidth={1.75} className="mr-1" />
            Draft
          </Button>
        ) : drafting ? (
          <span className="text-ui-body text-ink-tertiary">Drafting...</span>
        ) : null}
      </TD>
    </TR>
  );
}
function CalendarView() {
  const [calendar, setCalendar] = useState([]);
  const [currentWeek, setCurrentWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null); // weekOf being saved
  const [calendarStatus, setCalendarStatus] = useState("");
  const [draftingWeek, setDraftingWeek] = useState(null); // weekOf being drafted

  const fetchCalendar = () => {
    setLoading(true);
    adminFetch('/admin/newsletter/calendar?pastWeeks=4&futureWeeks=12')
      .then((d) => {
        setCalendar(d.calendar || []);
        setCurrentWeek(d.currentWeek || null);
      })
      .catch(() => setCalendar([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    fetchCalendar();
  }, []);
  const saveEntry = async (weekOf, updates) => {
    setSaving(weekOf);
    setCalendarStatus("Saving calendar…");
    try {
      const entry = calendar.find((c) => c.weekOf === weekOf);
      if (entry && entry.id) {
        await adminFetch(`/admin/newsletter/calendar/${entry.id}`, {
          method: 'PATCH',
          body: JSON.stringify(updates),
        });
      } else {
        await adminFetch('/admin/newsletter/calendar', {
          method: 'POST',
          body: JSON.stringify({ weekOf, ...updates }),
        });
      }
      fetchCalendar();
      setCalendarStatus("Calendar saved.");
    } catch (e) {
      setCalendarStatus(`Calendar save failed: ${e.message}`);
    } finally {
      setSaving(null);
    }
  };
  const handleDraft = async (row) => {
    setDraftingWeek(row.weekOf);
    setCalendarStatus("Drafting newsletter…");
    try {
      let calendarId = row.id;

      // Save current editor values first (create or update)
      if (!calendarId) {
        // Placeholder — create the row
        const created = await adminFetch('/admin/newsletter/calendar', {
          method: 'POST',
          body: JSON.stringify({
            weekOf: row.weekOf,
            topic: row.topic || null,
            homeownerMinuteTopic: row.homeownerMinuteTopic || null,
          }),
        });
        calendarId = created.entry?.id;
        if (!calendarId) throw new Error("Failed to create calendar entry");
      } else {
        // Existing row — persist any pending edits
        await adminFetch(`/admin/newsletter/calendar/${calendarId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            topic: row.topic || null,
            homeownerMinuteTopic: row.homeownerMinuteTopic || null,
          }),
        });
      }

      // Now draft from the saved row
      await adminFetch(`/admin/newsletter/calendar/${calendarId}/draft-from-plan`, {
        method: 'POST',
      });
      fetchCalendar();
      setCalendarStatus("Draft created. Open Compose to review it.");
    } catch (e) {
      setCalendarStatus(`Draft failed: ${e.message}`);
    } finally {
      setDraftingWeek(null);
    }
  };
  const fmtWeekLabel = (weekOf) => {
    const start = new Date(weekOf + "T12:00:00Z");
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return `${start.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })} – ${end.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })}`;
  };
  const STATUS_STYLE = {
    planned: "bg-zinc-200 text-zinc-600",
    drafted: "bg-zinc-700 text-white",
    scheduled: "bg-zinc-800 text-white",
    sent: "bg-zinc-900 text-white",
    skipped: "bg-zinc-100 text-zinc-400 line-through",
  };
  if (loading) {
    return (
      <div className="p-8 text-center text-ui-body text-ink-tertiary">
        Loading calendar...
      </div>
    );
  }
  return (
    <div className="space-y-4 mt-4">
      {calendarStatus && (
        <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm px-3 py-2 text-ui-body text-ink-secondary">
          {calendarStatus}
        </div>
      )}
      <div className="bg-white border-hairline border-zinc-200 rounded-sm overflow-x-auto">
        <Table className="w-full text-left">
          <THead>
            <TR className="border-b border-zinc-100">
              <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-44">
                {NEWSLETTER_UI_COPY.calendarWeekHeading}
              </TH>
              <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary">
                Topic
              </TH>
              <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-40">
                Homeowner Tip
              </TH>
              <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-20">
                Status
              </TH>
              <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-16">
                Events
              </TH>
              <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-32">
                Performance
              </TH>
              <TH className="px-3 py-2 text-ui-body font-medium text-ink-tertiary w-24"></TH>
            </TR>
          </THead>
          <TBody>
            {calendar.map((row) => {
              const isPast = row.weekOf < currentWeek;
              const isCurrent = row.weekOf === currentWeek;
              const rowCls = isCurrent
                ? "bg-zinc-50 border-l-2 border-l-zinc-900"
                : isPast
                  ? "opacity-60"
                  : "";
              return (
                <CalendarRow
                  key={row.weekOf}
                  row={row}
                  isPast={isPast}
                  isCurrent={isCurrent}
                  rowCls={rowCls}
                  saving={saving === row.weekOf}
                  onSave={(updates) => saveEntry(row.weekOf, updates)}
                  onDraft={handleDraft}
                  drafting={draftingWeek === row.weekOf}
                  fmtWeekLabel={fmtWeekLabel}
                  STATUS_STYLE={STATUS_STYLE}
                />
              );
            })}
          </TBody>
        </Table>
      </div>
    </div>
  );
}
export default function NewsletterPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = useMemo(() => {
    const requested = searchParams.get("tab");
    return TABS.find((t) => t.key === requested)?.key || "dashboard";
  }, [searchParams]);

  // Usage beacon for the leaf that actually RENDERS: the ordinary
  // query-less landing resolves to 'dashboard' here, which the layout's
  // raw ?tab= beacon can't see — without this, explicit ?tab= leaves
  // outrank the actual default in the Portal Usage report (Codex #2961
  // r16). Deliberately NO active-re-click guard on setTab below: same-tab
  // calls carry real side effects there (New Campaign clears ?draftId);
  // the lib's dedupe absorbs repeated beacon assertions instead.
  useRenderedTabBeacon("/admin/newsletter", tab, [searchParams]);

  // Cross-tab handoff for "Draft newsletter" clicks on EventCard.
  // DashboardView calls onDraftFromEvent(event) → we stash the event +
  // switch to the Compose tab. ComposeView consumes pendingDraftEvent
  // on mount (applies the flagship template + opens the AI Draft
  // modal pre-filled with the event facts), then clears it via
  // clearPendingDraftEvent so reopening Compose later doesn't re-fire.
  const [pendingDraftEvent, setPendingDraftEvent] = useState(null);

  // Sends + subscribers are fetched once at the page level and shared with
  // DashboardView (avoids the duplicate /sends call on the default dashboard
  // tab). Tab counts and dashboard panels are derived from the same payloads.
  //   - sendsLoading=true   → badges hidden, dashboard shows "Loading…"
  //   - sendsData present   → counts.sent ?? 0 (empty bucket → "(0)")
  //   - fetch failed        → loading clears, sendsData stays null, badges hidden
  // /sends and /subscribers group rows by status, so absent keys mean zero —
  // coalesce missing keys to 0 on success rather than null, otherwise a
  // brand-new install with no sent campaigns would silently drop the badge.
  const [sendsData, setSendsData] = useState(null);
  const [sendsLoading, setSendsLoading] = useState(true);
  const [subscribersActive, setSubscribersActive] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let ignore = false;
    setSendsLoading(true);
    adminFetch("/admin/newsletter/sends")
      .then((d) => {
        if (!ignore) {
          setSendsData(
            d || {
              sends: [],
              counts: {},
            },
          );
          setSendsLoading(false);
        }
      })
      // Clear sendsData on error so a failed refresh doesn't silently keep
      // showing stale History counts and recent-post data — the badge/stats
      // disappearance signals to the admin that the refresh didn't land.
      .catch(() => {
        if (!ignore) {
          setSendsData(null);
          setSendsLoading(false);
        }
      });
    adminFetch("/admin/newsletter/subscribers?limit=1")
      .then((d) => {
        if (!ignore) setSubscribersActive(d.counts?.active ?? 0);
      })
      // Clear on error for the same reason as /sends — a failed refresh
      // would otherwise keep the prior count in both the stats tile and
      // the Subscribers tab badge with no signal that the refresh failed.
      .catch(() => {
        if (!ignore) setSubscribersActive(null);
      });
    return () => {
      ignore = true;
    };
  }, [refreshKey]);

  // Refetch on Dashboard re-entry — mirrors the prior per-tab DashboardView
  // remount so a campaign sent in Compose or a subscriber added in Subscribers
  // is reflected when the user returns to the dashboard. Skips refetch on
  // tab switches that don't land on dashboard (e.g. Compose → Subscribers).
  const prevTabRef = useRef(tab);
  useEffect(() => {
    if (tab === "dashboard" && prevTabRef.current !== "dashboard") {
      setRefreshKey((k) => k + 1);
    }
    prevTabRef.current = tab;
  }, [tab]);

  // History badge is null while loading AND on fetch error — only show
  // (0) when /sends actually succeeded with no sent rows, so an outage
  // isn't read as "no sent campaigns".
  const tabCounts = {
    history: sendsData ? (sendsData.counts?.sent ?? 0) : null,
    subscribers: subscribersActive,
  };
  const setTab = (next) => {
    const newParams = new URLSearchParams(searchParams);
    if (next === "dashboard") newParams.delete("tab");
    else newParams.set("tab", next);
    // Draft deep links are single-compose context. Normal navigation to a new
    // campaign (or away from Compose) must not silently rehydrate an old row.
    newParams.delete("draftId");
    if (next === "compose") newParams.delete("autopilotType");
    setSearchParams(newParams, {
      replace: true,
    });
  };
  const onDraftFromEvent = (event) => {
    setPendingDraftEvent(event);
    setTab("compose");
  };
  const clearPendingDraftEvent = () => setPendingDraftEvent(null);

  // `tab` holds the LEAF key; resolve its parent group for the top-level nav.
  const activeGroup =
    NEWSLETTER_TAB_GROUPS.find((g) => g.tabs.includes(tab)) ||
    NEWSLETTER_TAB_GROUPS[0];

  // Dynamic header badges (history "sent" count, subscribers "active" count)
  // live on leaves — surface them on their owning parent group's label.
  const groupBadgeLabel = (g) => {
    const badged = g.tabs.find((k) => tabCounts[k] != null);
    return badged != null
      ? `${g.label} (${Number(tabCounts[badged]).toLocaleString()})`
      : g.label;
  };
  return (
    <UiSurface density="comfortable" className="space-y-4">
      <div className="space-y-0">
        {" "}
        <AdminCommandHeader
          title="Newsletter"
          icon={MailPlus}
          sections={NEWSLETTER_TAB_GROUPS.map((g) => ({
            key: g.key,
            label: groupBadgeLabel(g),
            Icon: g.Icon,
          }))}
          activeKey={activeGroup.key}
          onSectionChange={(key) => {
            const g = NEWSLETTER_TAB_GROUPS.find((x) => x.key === key);
            if (g) setTab(g.tabs[0]);
          }}
          ariaLabel="Newsletter section"
          navGridClassName="grid-cols-2 md:grid-cols-3 lg:grid-cols-5"
          action={{
            label: "New Campaign",
            icon: MailPlus,
            onClick: () => setTab("compose"),
          }}
          variant="workspace"
        />
        {/* Leaf sub-tab pill row — only when the active group has >1 leaf. */}
        {activeGroup.tabs.length > 1 && (
          <div className="my-4 flex flex-wrap gap-2">
            {activeGroup.tabs.map((leafKey) => {
              const leaf = TAB_BY_KEY[leafKey];
              if (!leaf) return null;
              const LeafIcon = leaf.Icon;
              const active = tab === leafKey;
              const badge =
                tabCounts[leafKey] != null
                  ? ` (${Number(tabCounts[leafKey]).toLocaleString()})`
                  : "";
              return (
                <Button
                  key={leafKey}
                  type="button"
                  onClick={() => setTab(leafKey)}
                  variant={active ? "primary" : "secondary"}
                  aria-pressed={active}
                >
                  {LeafIcon && (
                    <LeafIcon size={14} strokeWidth={1.9} aria-hidden />
                  )}
                  {leaf.label}
                  {badge}
                </Button>
              );
            })}
          </div>
        )}
        {/* Tab content */}
        {tab === "dashboard" && (
          <DashboardView
            onSelectTab={setTab}
            onDraftFromEvent={onDraftFromEvent}
            sendsData={sendsData}
            sendsLoading={sendsLoading}
            subscribersActive={subscribersActive}
          />
        )}
        {tab === "calendar" && <CalendarView />}
        {tab === "compose" && (
          <ComposeView
            pendingEvent={pendingDraftEvent}
            onPendingEventConsumed={clearPendingDraftEvent}
            onSendComplete={() => {
              setRefreshKey((k) => k + 1);
              setTab("history");
            }}
          />
        )}
        {tab === "history" && <HistoryView />}
        {tab === "subscribers" && <SubscribersView />}
        {tab === "events" && (
          <EventInboxView onDraftFromEvent={onDraftFromEvent} />
        )}
        {tab === "automations" && <EmailAutomationsPanelV2 />}
      </div>
    </UiSurface>
  );
}
