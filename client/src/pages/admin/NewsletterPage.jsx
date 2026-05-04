// client/src/pages/admin/NewsletterPage.jsx
//
// Top-level newsletter dashboard — first-class admin page under the
// Marketing sidebar group. Five tabs:
//   - Dashboard     stats + sample events + quick actions + recent posts
//   - Compose       draft + send a newsletter
//   - History       past sends
//   - Subscribers   list + manage
//   - Automations   drip + trigger flows
//
// Per-tab URL state via ?tab=dashboard|compose|history|subscribers|automations
// so a refresh or a shared link lands on the right view. Default = dashboard.
//
// Compose / History / Subscribers render named exports from
// ./NewsletterTabs (formerly NewsletterTabV2 — consolidated under
// /admin/newsletter when newsletter-v1 was rolled out). Automations
// renders EmailAutomationsPanelV2 directly.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody } from '../../components/ui';
import {
  Users,
  Zap,
  Calendar,
  FileText,
  TrendingUp,
  Sparkles,
  Upload,
  MapPin,
  MailPlus,
  Send,
} from 'lucide-react';
import { ComposeView, HistoryView, SubscribersView } from './NewsletterTabs';
import EmailAutomationsPanelV2 from './EmailAutomationsPanelV2';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
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
  { key: 'dashboard', label: 'Dashboard', desc: 'Overview' },
  { key: 'compose', label: 'Compose', desc: 'Draft + send' },
  { key: 'history', label: 'History', desc: 'Performance' },
  { key: 'subscribers', label: 'Subscribers', desc: 'Audience' },
  { key: 'automations', label: 'Automations', desc: 'Drips' },
];

function StatTile({ icon: Icon, label, value, sub }) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-2 mb-2 text-ink-secondary">
          <Icon size={14} strokeWidth={1.75} aria-hidden />
          <span className="u-label">{label}</span>
        </div>
        <div className="u-nums font-medium text-ink-primary" style={{ fontSize: 24 }}>{value}</div>
        {sub && <div className="text-11 text-ink-tertiary mt-1">{sub}</div>}
      </CardBody>
    </Card>
  );
}

function SectionHeader({ title, hint, action }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-3">
      <div className="min-w-0">
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
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-8 w-8 rounded-sm bg-zinc-900 text-white inline-flex items-center justify-center">
              <MailPlus size={16} strokeWidth={1.75} aria-hidden />
            </div>
            <div>
              <h1 className="text-24 sm:text-28 font-medium text-ink-primary leading-tight m-0">Newsletter</h1>
              <p className="text-12 text-ink-tertiary mt-0.5">
                Plan, write, send, and track the Waves neighborhood email list.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Badge tone="muted">{subscribersActive != null ? subscribersActive.toLocaleString() : '—'} active subscribers</Badge>
            <Badge tone="muted">{sentCount != null ? sentCount.toLocaleString() : '—'} sent campaigns</Badge>
            <Badge tone={scheduledCount ? 'neutral' : 'muted'}>{scheduledCount ?? '—'} scheduled</Badge>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 lg:justify-end">
          <Button onClick={onCompose}>
            <MailPlus size={14} strokeWidth={1.75} className="mr-2" aria-hidden />
            New Campaign
          </Button>
        </div>
      </div>
    </div>
  );
}

function TabBar({ tab, tabs, tabCounts, onSelect }) {
  return (
    <div className="tab-pill-scroll mb-5">
      <div className="tab-pill-scroll-inner inline-flex min-w-full sm:min-w-0 items-stretch gap-1 bg-zinc-100 border-hairline border-zinc-200 rounded-sm p-1">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              className={[
                'min-h-[44px] sm:min-h-0 sm:h-12 px-3 sm:px-4 rounded-xs text-left transition-colors u-focus-ring flex-1 sm:flex-none',
                active ? 'bg-zinc-900 text-white' : 'bg-transparent text-ink-secondary hover:bg-white hover:text-ink-primary',
              ].join(' ')}
            >
              <span className="block text-12 font-medium uppercase tracking-label whitespace-nowrap">
                {t.label}
                {tabCounts[t.key] != null && (
                  <span className={active ? 'text-zinc-300 ml-1.5' : 'text-ink-tertiary ml-1.5'}>
                    ({tabCounts[t.key].toLocaleString()})
                  </span>
                )}
              </span>
              <span className={active ? 'block text-10 text-zinc-300 mt-0.5' : 'block text-10 text-ink-tertiary mt-0.5'}>
                {t.desc}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Allowlist URL protocols on the render side too — events_raw rows
// pre-dating the ingestion-side validation could still contain a
// `javascript:` URL, and rendering that into <a href> would execute
// on click. Server already filters at ingestion (event-ingestion.js
// safeHttpUrl); this is the second layer.
function safeHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
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
    ? new Date(event.startAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Ongoing';
  const cityLabel = event.city ? event.city.replace(/(?:^|\s)\S/g, (s) => s.toUpperCase()) : null;
  const sourceLabel = (event.sourceName || '').split('·')[0].trim().slice(0, 18) || 'Source';
  const safeUrl = safeHttpUrl(event.eventUrl);

  // Map deep-link. Prefer geocoded lat/lng (precise) over the raw
  // venue_address string fallback (Google still resolves it server-side
  // but precision is better with coords). Only render the link when at
  // least one of those is present.
  const mapUrl = (event.geoLat != null && event.geoLng != null)
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${event.geoLat},${event.geoLng}`)}`
    : event.venueAddress
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.venueAddress)}`
      : null;

  return (
    <div className="bg-white border-hairline border-zinc-200 rounded-sm p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-13 font-medium text-ink-primary truncate">{event.title}</div>
          <div className="text-11 text-ink-tertiary mt-0.5 u-nums">
            {dateLabel}{cityLabel ? ` · ${cityLabel}` : ''}
          </div>
        </div>
        <Badge tone="neutral">{sourceLabel}</Badge>
      </div>
      {(event.venueName || event.venueAddress) && (
        <div className="flex items-start gap-1.5 text-11 text-ink-tertiary leading-snug">
          <MapPin size={11} strokeWidth={1.75} aria-hidden className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            {event.venueName && <div className="text-ink-secondary truncate">{event.venueName}</div>}
            {event.venueAddress && <div className="truncate">{event.venueAddress}</div>}
          </div>
        </div>
      )}
      {event.description && (
        <div className="text-12 text-ink-secondary leading-snug line-clamp-2">{event.description}</div>
      )}
      <div className="flex justify-end gap-2 mt-1">
        {mapUrl && (
          <a
            href={mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-12 font-medium text-zinc-700 hover:text-zinc-900 underline underline-offset-2"
          >
            View on map ↗
          </a>
        )}
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-12 font-medium text-zinc-700 hover:text-zinc-900 underline underline-offset-2"
          >
            View source ↗
          </a>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={onDraft || undefined}
          disabled={!onDraft}
          title={onDraft ? 'Switch to Compose with this event pre-loaded for AI Draft' : 'Wire-up pending'}
        >
          <Sparkles size={12} strokeWidth={1.75} className="mr-1" />
          Draft newsletter
        </Button>
      </div>
    </div>
  );
}

function QuickActions({ onSelectTab }) {
  // "Draft from event" was retired — that workflow is the "Draft
  // newsletter" button on each EventCard tile in the section below.
  // Keep this grid 2-up.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Card className="cursor-pointer hover:bg-zinc-50 transition-colors" onClick={() => onSelectTab('compose')}>
        <CardBody>
          <div className="flex items-center gap-2 mb-2">
            <FileText size={18} strokeWidth={1.75} className="text-zinc-900" />
            <span className="text-14 font-medium text-ink-primary">Compose manually</span>
          </div>
          <div className="text-12 text-ink-tertiary">
            Start a blank draft in the composer.
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelectTab('compose'); }}
            className="inline-block mt-3 text-12 font-medium text-zinc-900 underline underline-offset-2 bg-transparent border-0 p-0 cursor-pointer"
          >
            Open composer →
          </button>
        </CardBody>
      </Card>

      <Card className="cursor-pointer hover:bg-zinc-50 transition-colors" onClick={() => onSelectTab('subscribers')}>
        <CardBody>
          <div className="flex items-center gap-2 mb-2">
            <Upload size={18} strokeWidth={1.75} className="text-zinc-900" />
            <span className="text-14 font-medium text-ink-primary">Import subscribers</span>
          </div>
          <div className="text-12 text-ink-tertiary">
            Bulk import subscribers from a CSV.
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelectTab('subscribers'); }}
            className="inline-block mt-3 text-12 font-medium text-zinc-900 underline underline-offset-2 bg-transparent border-0 p-0 cursor-pointer"
          >
            Go to subscribers →
          </button>
        </CardBody>
      </Card>
    </div>
  );
}

function ManageTile({ icon: Icon, title, body, onClick }) {
  return (
    <Card className="cursor-pointer hover:bg-zinc-50 transition-colors" onClick={onClick}>
      <CardBody>
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-sm bg-zinc-100 text-zinc-900 inline-flex items-center justify-center flex-shrink-0">
            <Icon size={17} strokeWidth={1.75} aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="text-14 font-medium text-ink-primary">{title}</div>
            <div className="text-12 text-ink-tertiary mt-1 leading-snug">{body}</div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function PostStatusBadge({ status }) {
  if (status === 'sent') return <Badge tone="strong">Sent</Badge>;
  if (status === 'sending') return <Badge tone="neutral">Sending…</Badge>;
  if (status === 'scheduled') return <Badge tone="neutral">Scheduled</Badge>;
  if (status === 'failed') return <Badge tone="alert">Failed</Badge>;
  return <Badge tone="muted">Draft</Badge>;
}

function RecentPosts({ posts, loading }) {
  if (loading) {
    return <div className="p-6 text-center text-13 text-ink-secondary">Loading…</div>;
  }
  if (!posts || posts.length === 0) {
    return (
      <Card>
        <CardBody className="text-center">
          <div className="text-14 text-ink-primary mb-1">No posts yet</div>
          <div className="text-13 text-ink-tertiary">
            Draft your first newsletter from an event, or compose manually.
          </div>
        </CardBody>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {posts.map((p) => {
        const openRate = p.delivered_count > 0 ? p.opened_count / p.delivered_count : null;
        return (
          <div
            key={p.id}
            className="bg-white border-hairline border-zinc-200 rounded-sm px-3 py-2.5 flex items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="text-13 font-medium text-ink-primary truncate">{p.subject || '(untitled)'}</div>
              <div className="text-11 text-ink-tertiary mt-0.5 u-nums flex items-center gap-2 flex-wrap">
                {p.sent_at && <span>Sent {new Date(p.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
                {openRate != null && <span>· {(openRate * 100).toFixed(0)}% open</span>}
                {p.recipient_count != null && p.recipient_count > 0 && <span>· {p.recipient_count.toLocaleString()} recipients</span>}
              </div>
            </div>
            <PostStatusBadge status={p.status || 'draft'} />
          </div>
        );
      })}
    </div>
  );
}

function DashboardView({ onSelectTab, onDraftFromEvent, sendsData, sendsLoading, subscribersActive }) {
  // Recent posts + Last open rate are derived from the sends payload owned
  // by the parent (NewsletterPage) so the sends/subscribers fetches don't
  // run twice on the default dashboard tab. Events stay local — only the
  // dashboard uses them. `loadingPosts` is gated on the parent's loading
  // flag (not `sendsData == null`) so a fetch error clears the spinner
  // instead of leaving the panel stuck on "Loading…".
  const recentPosts = useMemo(() => (sendsData?.sends || []).slice(0, 5), [sendsData]);
  const lastOpenRate = useMemo(() => {
    const sends = sendsData?.sends || [];
    // Most recent sent row, regardless of delivered_count — a send to an
    // empty segment can land with delivered_count=0, and the tile should
    // reflect the *true* latest send (rendering '—' when there's nothing
    // to compute), not skip to an older one.
    const lastSent = sends.find((s) => s.status === 'sent');
    return (lastSent && lastSent.delivered_count > 0)
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
    adminFetch('/admin/newsletter/events?days=14&limit=12')
      .then((d) => { if (!ignore) { setEvents(d.events || []); setLoadingEvents(false); } })
      .catch(() => { if (!ignore) setLoadingEvents(false); });
    return () => { ignore = true; };
  }, []);

  return (
    <div>
      {/* Stats strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatTile
          icon={Users}
          label="Subscribers"
          value={stats.subscribers != null ? stats.subscribers.toLocaleString() : '—'}
          sub="active list"
        />
        <StatTile
          icon={TrendingUp}
          label="Last open rate"
          value={stats.lastOpenRate != null ? `${(stats.lastOpenRate * 100).toFixed(0)}%` : '—'}
          sub="most recent send"
        />
        <StatTile
          icon={Calendar}
          label="Scheduled"
          value={stats.scheduledCount != null ? stats.scheduledCount : '—'}
          sub="queued sends"
        />
      </div>

      {/* Quick actions */}
      <div className="mb-6">
        <SectionHeader
          title="Quick start"
          hint="Pick a starting point — or use the event tiles below for an event-anchored draft"
        />
        <QuickActions onSelectTab={onSelectTab} />
      </div>

      {/* Upcoming events — pulled from event_sources via the daily
          ingestion cron (server/services/event-ingestion.js). P3a ships
          RSS-only; iCal + scrape land in P3b. */}
      <div className="mb-6">
        <SectionHeader
          title="Upcoming events worth writing about"
          hint="Pulled from local SWFL feeds (Tampa.gov, Bay News 9, Manatee Chamber, Sarasota Magazine, The Gabber, Lakewood Ranch). Refreshes daily 4am ET."
        />
        {loadingEvents ? (
          <div className="text-13 text-ink-tertiary p-3">Loading events…</div>
        ) : events.length === 0 ? (
          <Card>
            <CardBody className="text-center">
              <div className="text-14 text-ink-primary mb-1">No upcoming events</div>
              <div className="text-13 text-ink-tertiary">
                The next ingestion run is at 4am ET. Sources can be inspected in the event_sources table.
              </div>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {events.map((e) => (
              <EventCard key={e.id} event={e} onDraft={onDraftFromEvent ? () => onDraftFromEvent(e) : null} />
            ))}
          </div>
        )}
      </div>

      {/* Recent posts */}
      <div className="mb-6">
        <SectionHeader
          title="Recent posts"
          action={(
            <button
              type="button"
              onClick={() => onSelectTab('history')}
              className="text-12 font-medium text-zinc-900 underline underline-offset-2 bg-transparent border-0 p-0 cursor-pointer"
            >
              View all →
            </button>
          )}
        />
        <RecentPosts posts={recentPosts} loading={loadingPosts} />
      </div>

      {/* Sub-page tile — Automations */}
      <div className="mb-6">
        <SectionHeader title="Manage" hint="Jump straight to a section" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <ManageTile
            icon={Send}
            title="Past sends"
            body="Review delivered counts, bounces, unsubscribes, and A/B subject performance."
            onClick={() => onSelectTab('history')}
          />
          <ManageTile
            icon={Users}
            title="Audience"
            body="Search, export, add, and unsubscribe newsletter contacts."
            onClick={() => onSelectTab('subscribers')}
          />
          <ManageTile
            icon={Zap}
            title="Automations"
            body="Manage referral nudges, payment failed flows, booking triggers, and drips."
            onClick={() => onSelectTab('automations')}
          />
        </div>
      </div>
    </div>
  );
}

export default function NewsletterPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = useMemo(() => {
    const requested = searchParams.get('tab');
    return TABS.find((t) => t.key === requested)?.key || 'dashboard';
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
    adminFetch('/admin/newsletter/sends')
      .then((d) => { if (!ignore) { setSendsData(d || { sends: [], counts: {} }); setSendsLoading(false); } })
      // Clear sendsData on error so a failed refresh doesn't silently keep
      // showing stale History counts and recent-post data — the badge/stats
      // disappearance signals to the admin that the refresh didn't land.
      .catch(() => { if (!ignore) { setSendsData(null); setSendsLoading(false); } });
    adminFetch('/admin/newsletter/subscribers?limit=1')
      .then((d) => { if (!ignore) setSubscribersActive(d.counts?.active ?? 0); })
      // Clear on error for the same reason as /sends — a failed refresh
      // would otherwise keep the prior count in both the stats tile and
      // the Subscribers tab badge with no signal that the refresh failed.
      .catch(() => { if (!ignore) setSubscribersActive(null); });
    return () => { ignore = true; };
  }, [refreshKey]);

  // Refetch on Dashboard re-entry — mirrors the prior per-tab DashboardView
  // remount so a campaign sent in Compose or a subscriber added in Subscribers
  // is reflected when the user returns to the dashboard. Skips refetch on
  // tab switches that don't land on dashboard (e.g. Compose → Subscribers).
  const prevTabRef = useRef(tab);
  useEffect(() => {
    if (tab === 'dashboard' && prevTabRef.current !== 'dashboard') {
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
    if (next === 'dashboard') newParams.delete('tab');
    else newParams.set('tab', next);
    setSearchParams(newParams, { replace: true });
  };

  const onDraftFromEvent = (event) => {
    setPendingDraftEvent(event);
    setTab('compose');
  };
  const clearPendingDraftEvent = () => setPendingDraftEvent(null);

  return (
    <div className="space-y-0">
      <PageHeader
        onCompose={() => setTab('compose')}
        subscribersActive={subscribersActive}
        sendsData={sendsData}
      />

      <TabBar tab={tab} tabs={TABS} tabCounts={tabCounts} onSelect={setTab} />

      {/* Tab content */}
      {tab === 'dashboard' && (
        <DashboardView
          onSelectTab={setTab}
          onDraftFromEvent={onDraftFromEvent}
          sendsData={sendsData}
          sendsLoading={sendsLoading}
          subscribersActive={subscribersActive}
        />
      )}
      {tab === 'compose' && (
        <ComposeView
          pendingEvent={pendingDraftEvent}
          onPendingEventConsumed={clearPendingDraftEvent}
          onSendComplete={() => { setRefreshKey((k) => k + 1); setTab('history'); }}
        />
      )}
      {tab === 'history' && <HistoryView />}
      {tab === 'subscribers' && <SubscribersView />}
      {tab === 'automations' && <EmailAutomationsPanelV2 />}
    </div>
  );
}
