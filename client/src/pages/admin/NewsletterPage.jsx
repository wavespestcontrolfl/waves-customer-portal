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

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { Badge, Button, Card, CardBody } from "../../components/ui";
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
  { key: "dashboard", label: "Dashboard", desc: "Overview", Icon: TrendingUp },
  { key: "calendar", label: "Calendar", desc: "Editorial plan", Icon: CalendarDays },
  { key: "compose", label: "Compose", desc: "Draft + send", Icon: MailPlus },
  { key: "history", label: "History", desc: "Performance", Icon: FileText },
  { key: "subscribers", label: "Subscribers", desc: "Audience", Icon: Users },
  { key: "events", label: "Events", desc: "Inbox + sources", Icon: ListFilter },
  { key: "automations", label: "Automations", desc: "Drips", Icon: Zap },
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
        <div
          className="u-nums font-medium text-ink-primary"
          style={{ fontSize: 24 }}
        >
          {value}
        </div>
        {sub && <div className="text-11 text-ink-tertiary mt-1">{sub}</div>}
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
        {hint && <div className="text-12 text-ink-tertiary mt-0.5">{hint}</div>}
      </div>
      {action}
    </div>
  );
}

function PageHeader({ onCompose, subscribersActive, sendsData }) {
  const sentCount = sendsData ? (sendsData.counts?.sent ?? 0) : null;
  const scheduledCount = sendsData ? (sendsData.counts?.scheduled ?? 0) : null;
  return (
    <div className="bg-white border-hairline border-zinc-200 rounded-sm p-4 sm:p-5 mb-4">
      {" "}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        {" "}
        <div className="min-w-0">
          {" "}
          <div className="flex items-center gap-2 mb-2">
            {" "}
            <div className="h-8 w-8 rounded-sm bg-zinc-900 text-white inline-flex items-center justify-center">
              {" "}
              <MailPlus size={16} strokeWidth={1.75} aria-hidden />{" "}
            </div>{" "}
            <div>
              {" "}
              <h1 className="text-24 sm:text-28 font-medium text-ink-primary leading-tight m-0">
                Newsletter
              </h1>{" "}
              <p className="text-12 text-ink-tertiary mt-0.5">
                Plan, write, send, and track the Waves neighborhood email list.
              </p>{" "}
            </div>{" "}
          </div>{" "}
          <div className="flex flex-wrap gap-2 mt-3">
            {" "}
            <Badge tone="muted">
              {subscribersActive != null
                ? subscribersActive.toLocaleString()
                : "—"}{" "}
              active subscribers
            </Badge>{" "}
            <Badge tone="muted">
              {sentCount != null ? sentCount.toLocaleString() : "—"} sent
              campaigns
            </Badge>{" "}
            <Badge tone={scheduledCount ? "neutral" : "muted"}>
              {scheduledCount ?? "—"} scheduled
            </Badge>{" "}
          </div>{" "}
        </div>{" "}
        <div className="flex flex-col sm:flex-row gap-2 lg:justify-end">
          {" "}
          <Button onClick={onCompose}>
            {" "}
            <MailPlus
              size={14}
              strokeWidth={1.75}
              className="mr-2"
              aria-hidden
            />
            New Campaign
          </Button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

function TabBar({ tab, tabs, tabCounts, onSelect }) {
  return (
    <div className="tab-pill-scroll mb-5">
      {" "}
      <div className="tab-pill-scroll-inner inline-flex min-w-full sm:min-w-0 items-stretch gap-1 bg-zinc-100 border-hairline border-zinc-200 rounded-sm p-1">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              className={[
                "min-h-[44px] sm:min-h-0 sm:h-12 px-3 sm:px-4 rounded-xs text-left transition-colors u-focus-ring flex-1 sm:flex-none",
                active
                  ? "bg-zinc-900 text-white"
                  : "bg-transparent text-ink-secondary hover:bg-white hover:text-ink-primary",
              ].join(" ")}
            >
              {" "}
              <span className="block text-12 font-medium uppercase tracking-label whitespace-nowrap">
                {t.label}
                {tabCounts[t.key] != null && (
                  <span
                    className={
                      active
                        ? "text-zinc-300 ml-1.5"
                        : "text-ink-tertiary ml-1.5"
                    }
                  >
                    ({tabCounts[t.key].toLocaleString()})
                  </span>
                )}
              </span>{" "}
              <span
                className={
                  active
                    ? "block text-10 text-zinc-300 mt-0.5"
                    : "block text-10 text-ink-tertiary mt-0.5"
                }
              >
                {t.desc}
              </span>{" "}
            </button>
          );
        })}
      </div>{" "}
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
          <div className="text-13 font-medium text-ink-primary truncate">
            {event.title}
          </div>{" "}
          <div className="text-11 text-ink-tertiary mt-0.5 u-nums">
            {dateLabel}
            {cityLabel ? ` · ${cityLabel}` : ""}
          </div>{" "}
        </div>{" "}
        <Badge tone="neutral">{sourceLabel}</Badge>{" "}
      </div>
      {(event.venueName || event.venueAddress) && (
        <div className="flex items-start gap-1.5 text-11 text-ink-tertiary leading-snug">
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
        <div className="text-12 text-ink-secondary leading-snug line-clamp-2">
          {event.description}
        </div>
      )}
      <div className="flex justify-end gap-2 mt-1">
        {mapUrl && (
          <a
            href={mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-12 font-medium text-zinc-700 hover:text-zinc-900 underline underline-offset-2"
          >
            View on map
          </a>
        )}
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-12 font-medium text-zinc-700 hover:text-zinc-900 underline underline-offset-2"
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
          <div className="text-12 text-ink-tertiary">
            Start a blank draft in the composer.
          </div>{" "}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectTab("compose");
            }}
            className="inline-block mt-3 text-12 font-medium text-zinc-900 underline underline-offset-2 bg-transparent border-0 p-0 cursor-pointer"
          >
            Open composer →
          </button>{" "}
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
          <div className="text-12 text-ink-tertiary">
            Bulk import subscribers from a CSV.
          </div>{" "}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectTab("subscribers");
            }}
            className="inline-block mt-3 text-12 font-medium text-zinc-900 underline underline-offset-2 bg-transparent border-0 p-0 cursor-pointer"
          >
            Go to subscribers →
          </button>{" "}
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
            <div className="text-12 text-ink-tertiary mt-1 leading-snug">
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
  return <Badge tone="muted">Draft</Badge>;
}

function RecentPosts({ posts, loading }) {
  if (loading) {
    return (
      <div className="p-6 text-center text-13 text-ink-secondary">Loading…</div>
    );
  }
  if (!posts || posts.length === 0) {
    return (
      <Card>
        {" "}
        <CardBody className="text-center">
          {" "}
          <div className="text-14 text-ink-primary mb-1">No posts yet</div>{" "}
          <div className="text-13 text-ink-tertiary">
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
              <div className="text-13 font-medium text-ink-primary truncate">
                {p.subject || "(untitled)"}
              </div>{" "}
              <div className="text-11 text-ink-tertiary mt-0.5 u-nums flex items-center gap-2 flex-wrap">
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
          <div className="text-13 text-ink-tertiary p-3">Loading events…</div>
        ) : events.length === 0 ? (
          <Card>
            {" "}
            <CardBody className="text-center">
              {" "}
              <div className="text-14 text-ink-primary mb-1">
                No upcoming events
              </div>{" "}
              <div className="text-13 text-ink-tertiary">
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
            <button
              type="button"
              onClick={() => onSelectTab("history")}
              className="text-12 font-medium text-zinc-900 underline underline-offset-2 bg-transparent border-0 p-0 cursor-pointer"
            >
              View all →
            </button>
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
  const isStale =
    status === "stale_recurring" || status === "expired";
  const cls = isFresh
    ? "bg-zinc-700 text-white"
    : isStale
      ? "bg-zinc-200 text-zinc-500"
      : "bg-zinc-100 text-zinc-500 border border-dashed border-zinc-300";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-10 font-medium ${cls}`}
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
      className={`inline-block px-1.5 py-0.5 rounded text-10 font-medium ${map[status] || "bg-zinc-100 text-zinc-500"}`}
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

  const fetchEvents = () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "100" });
    if (statusFilter && statusFilter !== "all")
      params.set("status", statusFilter);
    if (freshnessFilter) params.set("freshness", freshnessFilter);
    if (zoneFilter) params.set("zone", zoneFilter);
    if (searchQuery) params.set("q", searchQuery);
    adminFetch(`/admin/newsletter/events/inbox?${params}`)
      .then((d) => {
        setEvents(d.events || []);
        setCounts(d.counts || {});
        setSelected(new Set());
      })
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  };

  const fetchSources = () => {
    adminFetch("/admin/newsletter/events/sources")
      .then((d) => setSources(d.sources || []))
      .catch(() => {});
  };

  useEffect(() => {
    fetchEvents();
    fetchSources();
  }, [statusFilter, freshnessFilter, zoneFilter]);

  const doSearch = () => fetchEvents();

  const patchEvent = async (id, body) => {
    await adminFetch(`/admin/newsletter/events/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    fetchEvents();
  };

  const bulkAction = async (action) => {
    if (selected.size === 0) return;
    await adminFetch("/admin/newsletter/events/bulk-action", {
      method: "POST",
      body: JSON.stringify({ action, ids: [...selected] }),
    });
    fetchEvents();
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
    const primary = [...chosen].sort((a, b) => completeness(b) - completeness(a))[0];
    if (!primary) return;
    const primaryId = primary.id;
    const duplicateIds = chosen.filter((e) => e.id !== primaryId).map((e) => e.id);
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
        <button
          type="button"
          onClick={() => setSourcesOpen(!sourcesOpen)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-13 font-medium text-ink-primary">
            Event Sources ({sources.length})
          </span>
          <span className="text-11 text-ink-tertiary">
            {sourcesOpen ? "Hide" : "Show"}
          </span>
        </button>
        {sourcesOpen && (
          <div className="px-4 pb-3 flex flex-wrap gap-2">
            {sources.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-1.5 px-2 py-1 bg-zinc-50 border-hairline border-zinc-200 rounded text-11"
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full ${s.lastPullStatus === "success" ? "bg-green-500" : s.lastPullStatus === "error" ? "bg-red-500" : "bg-zinc-300"}`}
                />
                <span className="text-ink-primary font-medium truncate max-w-[140px]">
                  {s.name.split("—")[0].trim()}
                </span>
                <span className="text-ink-tertiary">
                  {s.eventCount}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white border-hairline border-zinc-200 rounded-sm p-4 space-y-3">
        {/* Status tabs */}
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded text-12 font-medium ${statusFilter === s ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
            >
              {s}
              {counts[s] != null ? ` (${counts[s]})` : ""}
            </button>
          ))}
        </div>

        {/* Secondary filters */}
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-11 text-ink-tertiary mb-0.5">
              Freshness
            </label>
            <select
              value={freshnessFilter}
              onChange={(e) => setFreshnessFilter(e.target.value)}
              className="h-8 px-2 text-12 bg-white border-hairline border-zinc-300 rounded-sm"
            >
              <option value="">All</option>
              <option value="fresh">Fresh</option>
              <option value="stale">Stale</option>
              <option value="needs_review">Needs Review</option>
            </select>
          </div>
          <div>
            <label className="block text-11 text-ink-tertiary mb-0.5">
              Zone
            </label>
            <select
              value={zoneFilter}
              onChange={(e) => setZoneFilter(e.target.value)}
              className="h-8 px-2 text-12 bg-white border-hairline border-zinc-300 rounded-sm"
            >
              <option value="">All zones</option>
              <option value="south_sarasota">South Sarasota</option>
              <option value="sarasota">Sarasota</option>
              <option value="manatee">Manatee</option>
              <option value="pinellas">Pinellas</option>
              <option value="tampa">Tampa</option>
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-11 text-ink-tertiary mb-0.5">
              Search
            </label>
            <div className="flex gap-1">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSearch()}
                placeholder="Search event titles..."
                className="flex-1 h-8 px-2 text-12 bg-white border-hairline border-zinc-300 rounded-sm"
              />
              <button
                type="button"
                onClick={doSearch}
                className="h-8 w-8 inline-flex items-center justify-center border-hairline border-zinc-300 rounded-sm hover:bg-zinc-50"
              >
                <Search size={13} strokeWidth={1.75} />
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={fetchEvents}
            className="h-8 w-8 inline-flex items-center justify-center border-hairline border-zinc-300 rounded-sm hover:bg-zinc-50"
            title="Refresh"
          >
            <RefreshCw size={13} strokeWidth={1.75} />
          </button>
        </div>

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-12 text-ink-secondary">
              {selected.size} selected
            </span>
            <Button
              size="sm"
              onClick={() => bulkAction("approve")}
            >
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

      {/* Event Table */}
      <div className="bg-white border-hairline border-zinc-200 rounded-sm overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-13 text-ink-tertiary">
            Loading events...
          </div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-13 text-ink-tertiary">
            No events match the current filters.
          </div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === events.length && events.length > 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-3 py-2 text-11 font-medium text-ink-tertiary">
                  Event
                </th>
                <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-24">
                  Date
                </th>
                <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-24">
                  City
                </th>
                <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-28">
                  Freshness
                </th>
                <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-20">
                  Status
                </th>
                <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-20">
                  Score
                </th>
                <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-28">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr
                  key={ev.id}
                  className={`border-b border-zinc-50 hover:bg-zinc-25 ${ev.adminStatus === "rejected" ? "opacity-50" : ""}`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(ev.id)}
                      onChange={() => toggleSelect(ev.id)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-13 font-medium text-ink-primary leading-snug line-clamp-1">
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
                      <div className="text-11 text-ink-tertiary mt-0.5 line-clamp-1">
                        {ev.venueName}
                      </div>
                    )}
                    <div className="text-10 text-ink-tertiary mt-0.5">
                      {ev.sourceName?.split("—")[0]?.trim()}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-12 text-ink-secondary">
                    {fmtDate(ev.startAt)}
                  </td>
                  <td className="px-3 py-2 text-12 text-ink-secondary">
                    {ev.city || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <FreshnessBadge status={ev.freshnessStatus} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <AdminStatusBadge status={ev.adminStatus} />
                      {ev.approvedVia === "auto_curation" && (
                        <span
                          title={ev.curationNote || "Approved by auto-curation"}
                          className="text-10 uppercase tracking-label text-ink-tertiary border-hairline border-zinc-200 rounded px-1 py-0.5"
                        >
                          Auto
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-12 text-ink-secondary u-nums">
                    {ev.compositeScore ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      {ev.adminStatus !== "approved" &&
                        ev.adminStatus !== "featured" && (
                          <button
                            type="button"
                            onClick={() =>
                              patchEvent(ev.id, { adminStatus: "approved" })
                            }
                            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-zinc-100"
                            title="Approve"
                          >
                            <Check size={13} strokeWidth={2} />
                          </button>
                        )}
                      {ev.adminStatus !== "rejected" && (
                        <button
                          type="button"
                          onClick={() =>
                            patchEvent(ev.id, {
                              adminStatus: "rejected",
                              suppressionReason: "manual_reject",
                            })
                          }
                          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-zinc-100"
                          title="Reject"
                        >
                          <X size={13} strokeWidth={2} />
                        </button>
                      )}
                      {ev.adminStatus !== "featured" && (
                        <button
                          type="button"
                          onClick={() =>
                            patchEvent(ev.id, { adminStatus: "featured" })
                          }
                          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-zinc-100"
                          title="Feature"
                        >
                          <Star size={13} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Calendar View ───────────────────────────────────────────────────

function CalendarRow({ row, isPast, isCurrent, rowCls, saving, onSave, onDraft, drafting, fmtWeekLabel, STATUS_STYLE }) {
  const [editTopic, setEditTopic] = useState(row.topic || '');
  const [editTip, setEditTip] = useState(row.homeownerMinuteTopic || '');
  const [dirty, setDirty] = useState(false);

  // Reset local state when row data changes (after save/fetch)
  useEffect(() => {
    setEditTopic(row.topic || '');
    setEditTip(row.homeownerMinuteTopic || '');
    setDirty(false);
  }, [row.topic, row.homeownerMinuteTopic]);

  const handleTopicChange = (e) => { setEditTopic(e.target.value); setDirty(true); };
  const handleTipChange = (e) => { setEditTip(e.target.value); setDirty(true); };

  const handleSave = () => {
    if (!dirty) return;
    onSave({ topic: editTopic || null, homeownerMinuteTopic: editTip || null });
  };

  const handleBlur = () => { if (dirty) handleSave(); };
  const handleKeyDown = (e) => { if (e.key === 'Enter') { e.target.blur(); } };

  // Draft button is enabled only for planned rows that are not past
  const canDraft = !isPast
    && row.status === 'planned'
    && !drafting;

  return (
    <tr className={`border-b border-zinc-50 hover:bg-zinc-25 ${rowCls}`}>
      <td className="px-3 py-2">
        <div className="text-12 font-medium text-ink-primary">{fmtWeekLabel(row.weekOf)}</div>
        {isCurrent && <div className="text-10 text-ink-tertiary font-medium">This week</div>}
      </td>
      <td className="px-3 py-2">
        {isPast ? (
          <span className="text-12 text-ink-secondary">{row.topic || '—'}</span>
        ) : (
          <input
            type="text"
            value={editTopic}
            onChange={handleTopicChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="Add topic..."
            className="w-full h-7 px-2 text-12 bg-transparent border-hairline border-zinc-200 rounded-sm focus:border-zinc-400 focus:outline-none"
          />
        )}
      </td>
      <td className="px-3 py-2">
        {isPast ? (
          <span className="text-12 text-ink-secondary">{row.homeownerMinuteTopic || '—'}</span>
        ) : (
          <input
            type="text"
            value={editTip}
            onChange={handleTipChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="Tip topic..."
            className="w-full h-7 px-2 text-12 bg-transparent border-hairline border-zinc-200 rounded-sm focus:border-zinc-400 focus:outline-none"
          />
        )}
      </td>
      <td className="px-3 py-2">
        <span className={`inline-block px-1.5 py-0.5 rounded text-10 font-medium ${STATUS_STYLE[row.status] || STATUS_STYLE.planned}`}>
          {row.status}
        </span>
      </td>
      <td className="px-3 py-2 text-12 text-ink-secondary u-nums">
        {(row.eventIds || []).length || '—'}
      </td>
      <td className="px-3 py-2">
        {row.send ? (
          <div className="text-10 text-ink-tertiary u-nums">
            <span>{row.send.deliveredCount || 0} delivered</span>
            {row.send.openedCount > 0 && <span> · {row.send.openedCount} opened</span>}
          </div>
        ) : (
          <span className="text-10 text-ink-tertiary">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {canDraft ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onDraft({ ...row, topic: editTopic || null, homeownerMinuteTopic: editTip || null })}
            disabled={drafting}
          >
            <Sparkles size={12} strokeWidth={1.75} className="mr-1" />
            Draft
          </Button>
        ) : drafting ? (
          <span className="text-10 text-ink-tertiary">Drafting...</span>
        ) : null}
      </td>
    </tr>
  );
}

function CalendarView() {
  const [calendar, setCalendar] = useState([]);
  const [currentWeek, setCurrentWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null); // weekOf being saved
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

  useEffect(() => { fetchCalendar(); }, []);

  const saveEntry = async (weekOf, updates) => {
    setSaving(weekOf);
    try {
      const entry = calendar.find(c => c.weekOf === weekOf);
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
    } catch (e) {
      console.error('Save failed:', e.message);
    } finally {
      setSaving(null);
    }
  };

  const handleDraft = async (row) => {
    setDraftingWeek(row.weekOf);
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
        if (!calendarId) throw new Error('Failed to create calendar entry');
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
    } catch (e) {
      console.error('Draft failed:', e.message);
    } finally {
      setDraftingWeek(null);
    }
  };

  const fmtWeekLabel = (weekOf) => {
    const start = new Date(weekOf + 'T12:00:00Z');
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  };

  const STATUS_STYLE = {
    planned: 'bg-zinc-200 text-zinc-600',
    drafted: 'bg-zinc-700 text-white',
    scheduled: 'bg-zinc-800 text-white',
    sent: 'bg-zinc-900 text-white',
    skipped: 'bg-zinc-100 text-zinc-400 line-through',
  };

  if (loading) {
    return <div className="p-8 text-center text-13 text-ink-tertiary">Loading calendar...</div>;
  }

  return (
    <div className="space-y-4 mt-4">
      <div className="bg-white border-hairline border-zinc-200 rounded-sm overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-zinc-100">
              <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-32">Week</th>
              <th className="px-3 py-2 text-11 font-medium text-ink-tertiary">Topic</th>
              <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-40">Homeowner Tip</th>
              <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-20">Status</th>
              <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-16">Events</th>
              <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-32">Performance</th>
              <th className="px-3 py-2 text-11 font-medium text-ink-tertiary w-24"></th>
            </tr>
          </thead>
          <tbody>
            {calendar.map((row) => {
              const isPast = row.weekOf < currentWeek;
              const isCurrent = row.weekOf === currentWeek;
              const rowCls = isCurrent
                ? 'bg-zinc-50 border-l-2 border-l-zinc-900'
                : isPast
                  ? 'opacity-60'
                  : '';

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
          </tbody>
        </table>
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

  // Cross-tab handoff for "Draft newsletter" clicks on EventCard.
  // DashboardView calls onDraftFromEvent(event) → we stash the event +
  // switch to the Compose tab. ComposeView consumes pendingDraftEvent
  // on mount (applies the Weekend Lineup template + opens the AI Draft
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
          setSendsData(d || { sends: [], counts: {} });
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
    setSearchParams(newParams, { replace: true });
  };

  const onDraftFromEvent = (event) => {
    setPendingDraftEvent(event);
    setTab("compose");
  };
  const clearPendingDraftEvent = () => setPendingDraftEvent(null);

  return (
    <div className="space-y-0">
      {" "}
      <AdminCommandHeader
        title="Newsletter"
        icon={MailPlus}
        sections={TABS.map((t) => ({
          ...t,
          label:
            tabCounts[t.key] != null
              ? `${t.label} (${Number(tabCounts[t.key]).toLocaleString()})`
              : t.label,
        }))}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Newsletter section"
        navGridClassName="grid-cols-2 md:grid-cols-4 lg:grid-cols-7"
        action={{
          label: "New Campaign",
          icon: MailPlus,
          onClick: () => setTab("compose"),
        }}
      />
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
      {tab === "events" && <EventInboxView onDraftFromEvent={onDraftFromEvent} />}
      {tab === "automations" && <EmailAutomationsPanelV2 />}
    </div>
  );
}
