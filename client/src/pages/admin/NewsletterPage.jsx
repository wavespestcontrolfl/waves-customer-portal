// client/src/pages/admin/NewsletterPage.jsx
//
// Top-level newsletter dashboard — first-class admin page under the Marketing
// sidebar group. Shell only in this PR; sub-routes for Posts / Subscribers /
// Automations / Events Queue wire up in follow-ups. Existing NewsletterTabV2
// (Compose + History + Subscribers) still renders under Communications until
// we migrate the backend references.
//
// Vision: draft newsletters from local SWFL events (agent-discovered or
// RSS-ingested), auto-generate copy, publish, distribute to social.

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { Badge, Button, Card, CardBody, cn } from '../../components/ui';
import { Mail, Users, Zap, Calendar, FileText, TrendingUp, Sparkles, Plus, Upload } from 'lucide-react';

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
    <div className="flex items-baseline justify-between mb-3">
      <div>
        <h2 className="text-14 font-medium text-ink-primary">{title}</h2>
        {hint && <div className="text-12 text-ink-tertiary mt-0.5">{hint}</div>}
      </div>
      {action}
    </div>
  );
}

// Placeholder events — Phase 2 wires to rss_events / agent_events tables.
const SAMPLE_EVENTS = [
  {
    id: 'e1',
    title: 'Lakewood Ranch 4th of July Parade',
    source: 'Lakewood Ranch Town Hall events feed',
    date: '2026-07-04',
    angle: 'Pre-parade mosquito prep checklist — before-and-after yards',
  },
  {
    id: 'e2',
    title: 'Chinch bug pressure peak — Manatee County',
    source: 'Agent · pest-pressure calendar',
    date: '2026-06-15',
    angle: 'Flotation-test how-to + tech-captured field video from Parrish',
  },
  {
    id: 'e3',
    title: 'Sarasota Red Tide advisory lifted',
    source: 'FWC monitoring feed',
    date: '2026-05-01',
    angle: 'Outdoor-dining season = mosquito/ant season — service promo',
  },
];

function EventCard({ event }) {
  const d = new Date(event.date + 'T12:00:00');
  const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="bg-white border-hairline border-zinc-200 rounded-sm p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-13 font-medium text-ink-primary truncate">{event.title}</div>
          <div className="text-11 text-ink-tertiary mt-0.5 u-nums">{dateLabel}</div>
        </div>
        <Badge tone="neutral">{event.source.split('·')[0].trim().slice(0, 14)}</Badge>
      </div>
      <div className="text-12 text-ink-secondary leading-snug">{event.angle}</div>
      <div className="flex justify-end gap-2 mt-1">
        <Button variant="ghost" size="sm" disabled title="Wire-up pending">Dismiss</Button>
        <Button variant="primary" size="sm" disabled title="Wire-up pending">
          <Sparkles size={12} strokeWidth={1.75} className="mr-1" />
          Draft newsletter
        </Button>
      </div>
    </div>
  );
}

function QuickActions() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Card className="cursor-pointer hover:bg-zinc-50 transition-colors">
        <CardBody>
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={18} strokeWidth={1.75} className="text-zinc-900" />
            <span className="text-14 font-medium text-ink-primary">Draft from event</span>
          </div>
          <div className="text-12 text-ink-tertiary">
            Pick an upcoming SWFL event and let Claude draft the newsletter body from it.
          </div>
          <div className="mt-3">
            <Badge tone="neutral">Coming soon</Badge>
          </div>
        </CardBody>
      </Card>

      <Card className="cursor-pointer hover:bg-zinc-50 transition-colors">
        <CardBody>
          <div className="flex items-center gap-2 mb-2">
            <FileText size={18} strokeWidth={1.75} className="text-zinc-900" />
            <span className="text-14 font-medium text-ink-primary">Compose manually</span>
          </div>
          <div className="text-12 text-ink-tertiary">
            Start a blank draft in the existing composer.
          </div>
          <Link
            to="/admin/communications?tab=newsletter"
            className="inline-block mt-3 text-12 font-medium text-zinc-900 underline underline-offset-2"
          >
            Open composer →
          </Link>
        </CardBody>
      </Card>

      <Card className="cursor-pointer hover:bg-zinc-50 transition-colors">
        <CardBody>
          <div className="flex items-center gap-2 mb-2">
            <Upload size={18} strokeWidth={1.75} className="text-zinc-900" />
            <span className="text-14 font-medium text-ink-primary">Import subscribers</span>
          </div>
          <div className="text-12 text-ink-tertiary">
            Bulk import from a CSV (one-time migration from Beehiiv, etc.).
          </div>
          <Link
            to="/admin/communications?tab=newsletter"
            className="inline-block mt-3 text-12 font-medium text-zinc-900 underline underline-offset-2"
          >
            Go to subscribers →
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}

function PostStatusBadge({ status }) {
  const map = {
    draft: { tone: 'neutral', label: 'Draft' },
    scheduled: { tone: 'strong', label: 'Scheduled' },
    published: { tone: 'strong', label: 'Published' },
    failed: { tone: 'alert', label: 'Failed' },
  };
  const cfg = map[status] || map.draft;
  return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
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
      {posts.map((p) => (
        <div
          key={p.id}
          className="bg-white border-hairline border-zinc-200 rounded-sm px-3 py-2.5 flex items-center gap-3"
        >
          <div className="flex-1 min-w-0">
            <div className="text-13 font-medium text-ink-primary truncate">{p.subject || p.title || '(untitled)'}</div>
            <div className="text-11 text-ink-tertiary mt-0.5 u-nums flex items-center gap-2 flex-wrap">
              {p.sentAt && <span>Sent {new Date(p.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
              {p.openRate != null && <span>· {(p.openRate * 100).toFixed(0)}% open</span>}
              {p.subscriberCount != null && <span>· {p.subscriberCount} recipients</span>}
            </div>
          </div>
          <PostStatusBadge status={p.status || 'draft'} />
        </div>
      ))}
    </div>
  );
}

export default function NewsletterPage() {
  const flagReady = useFeatureFlag('newsletter-v1');
  const [stats, setStats] = useState({ subscribers: null, lastOpenRate: null, scheduledCount: null });
  const [recentPosts, setRecentPosts] = useState([]);
  const [loadingPosts, setLoadingPosts] = useState(true);

  useEffect(() => {
    let ignore = false;
    adminFetch('/admin/newsletter/subscribers?limit=1')
      .then((d) => { if (!ignore) setStats((s) => ({ ...s, subscribers: d.total ?? d.counts?.active ?? null })); })
      .catch(() => {});
    adminFetch('/admin/newsletter/posts?limit=5')
      .then((d) => { if (!ignore) { setRecentPosts(d.posts || []); setLoadingPosts(false); } })
      .catch(() => { if (!ignore) setLoadingPosts(false); });
    return () => { ignore = true; };
  }, []);

  if (!flagReady) {
    return (
      <div>
        <h1 className="text-28 font-normal tracking-h1 text-ink-primary mb-5">Newsletter</h1>
        <Card>
          <CardBody>
            <div className="text-14 text-ink-primary mb-1">Not available</div>
            <div className="text-13 text-ink-tertiary">
              The Newsletter dashboard is in limited rollout. Enable the <code>newsletter-v1</code> flag to continue.
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div>
      {/* Title + Create */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-28 font-normal tracking-h1 text-ink-primary">Newsletter</h1>
          <div className="text-13 text-ink-tertiary mt-1">
            Draft from local SWFL events, publish, distribute.
          </div>
        </div>
        <Link
          to="/admin/communications?tab=newsletter"
          className="inline-flex items-center gap-1.5 h-10 px-3 rounded-full bg-zinc-900 text-white text-12 font-medium uppercase tracking-label u-focus-ring hover:bg-zinc-800 no-underline"
        >
          <Plus size={14} strokeWidth={2} aria-hidden />
          New draft
        </Link>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
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
          hint="Three ways to get a draft going"
        />
        <QuickActions />
      </div>

      {/* Upcoming events queue — placeholder data until agent + RSS land */}
      <div className="mb-6">
        <SectionHeader
          title="Upcoming events worth writing about"
          hint="Agent-surfaced SWFL events. Event discovery is Phase 2."
          action={<Badge tone="neutral">Preview</Badge>}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {SAMPLE_EVENTS.map((e) => <EventCard key={e.id} event={e} />)}
        </div>
      </div>

      {/* Recent posts */}
      <div className="mb-6">
        <SectionHeader
          title="Recent posts"
          action={(
            <Link
              to="/admin/communications?tab=newsletter&subtab=history"
              className="text-12 font-medium text-zinc-900 underline underline-offset-2"
            >
              View all →
            </Link>
          )}
        />
        <RecentPosts posts={recentPosts} loading={loadingPosts} />
      </div>

      {/* Sub-page tiles — Automations + Events queue stubs */}
      <div className="mb-6">
        <SectionHeader title="Manage" hint="Sub-sections land in follow-up PRs" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Card>
            <CardBody>
              <div className="flex items-center gap-2 mb-2">
                <Zap size={18} strokeWidth={1.75} className="text-zinc-900" />
                <span className="text-14 font-medium text-ink-primary">Automations</span>
                <Badge tone="neutral">Preview</Badge>
              </div>
              <div className="text-12 text-ink-tertiary">
                Automated flows like Referral Nudge, Payment Failed, New Appointment Booked. Ships after the agent-discovery PR.
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="flex items-center gap-2 mb-2">
                <Mail size={18} strokeWidth={1.75} className="text-zinc-900" />
                <span className="text-14 font-medium text-ink-primary">Distribution channels</span>
                <Badge tone="neutral">Preview</Badge>
              </div>
              <div className="text-12 text-ink-tertiary">
                Connect IG, Facebook, LinkedIn so a published newsletter auto-posts a teaser. Ships with the Blog Content Engine integration.
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
