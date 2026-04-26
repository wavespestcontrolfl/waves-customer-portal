// client/src/pages/admin/CommunicationsTabsV2.jsx
// Monochrome V2 of the Templates and CSR Coach tabs used inside CommunicationsPageV2.
// Strict 1:1 with V1 on endpoints, state, and behavior — chrome only.
//
// Endpoints preserved:
//   GET  /admin/sms-templates
//   PUT  /admin/sms-templates/:id
//   GET  /admin/csr/overview?days=30
//   GET  /admin/csr/follow-up-tasks
//   PUT  /admin/csr/follow-up-tasks/:id
//   GET  /admin/csr/weekly-recommendation
//   GET  /admin/csr/leaderboard
//   GET  /admin/csr/lead-quality?days=30
//
// Dual exports: SmsTemplatesTabV2 (Templates tab) +
// CSRCoachTabV2 (CSR Coach tab). Both consumed by CommunicationsPageV2.
//
// Audit focus:
// - SmsTemplates PUT: editing a template that's referenced by an
//   active automation sequence — confirm the change applies to
//   future sends only (no retroactive rewrite of already-sent SMS
//   bodies in the log).
// - is_active toggle: turning off a template that an automation
//   relies on — does the automation gracefully skip, or does it
//   error? Either is OK; silent skip without operator notice is not.
// - Follow-up tasks PUT: marking a task complete is the operator's
//   primary action. Confirm optimistic UI rolls back on PUT failure
//   instead of leaving a lie in the queue.
// - CSR leaderboard PII: surfaces individual CSR call/SMS counts.
//   Should be operator-only (Waves + management); confirm no
//   tech-portal leak.
// - Weekly recommendation: AI-generated coaching summary. Cache it
//   so refresh doesn't re-run Claude; confirm there's a cache key
//   tied to the week boundary (not just a per-render call).
// - Lead-quality breakdown: at scale, /lead-quality?days=30 may
//   return many records. Confirm reasonable bounded response size.
import { useState, useEffect } from 'react';
import {
  Badge, Button, Card, CardBody, Switch, Textarea,
  Table, THead, TBody, TR, TH, TD, cn,
} from '../../components/ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// ── SMS Templates Tab ───────────────────────────────────────────────

export function SmsTemplatesTabV2() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    adminFetch('/admin/sms-templates')
      .then((d) => { setTemplates(d.templates || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async (id) => {
    setSaving(true);
    try {
      await adminFetch(`/admin/sms-templates/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ body: editBody }),
      });
      setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, body: editBody } : t)));
      setEditing(null);
    } catch { alert('Save failed'); }
    setSaving(false);
  };

  const toggleActive = async (t) => {
    await adminFetch(`/admin/sms-templates/${t.id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !t.is_active }),
    });
    setTemplates((prev) => prev.map((x) => (x.id === t.id ? { ...x, is_active: !x.is_active } : x)));
  };

  const categories = [...new Set(templates.map((t) => t.category))];
  const filtered = filter === 'all' ? templates : templates.filter((t) => t.category === filter);

  if (loading) return <div className="p-10 text-center text-ink-tertiary text-13">Loading templates…</div>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-13 text-ink-secondary">
          <span className="font-mono u-nums text-ink-primary">{filtered.length}</span> SMS Templates
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'min-h-[44px] md:min-h-0 md:h-7 px-3 py-2 md:py-0 inline-flex items-center rounded-xs text-14 md:text-11 normal-case md:uppercase tracking-normal md:tracking-label border-hairline transition-colors',
              filter === 'all'
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'bg-white text-ink-secondary border-zinc-300 hover:bg-zinc-50',
            )}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(c)}
              className={cn(
                'min-h-[44px] md:min-h-0 md:h-7 px-3 py-2 md:py-0 inline-flex items-center rounded-xs text-14 md:text-11 normal-case md:uppercase tracking-normal md:tracking-label border-hairline transition-colors capitalize',
                filter === c
                  ? 'bg-zinc-900 text-white border-zinc-900'
                  : 'bg-white text-ink-secondary border-zinc-300 hover:bg-zinc-50',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {filtered.map((t) => (
          <Card key={t.id}>
            <CardBody>
              <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-13 font-medium text-ink-primary">{t.name}</span>
                  <Badge tone="neutral" className="capitalize">{t.category}</Badge>
                  {t.is_internal && <Badge tone="neutral">Internal</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={t.is_active} onChange={() => toggleActive(t)} />
                  {editing === t.id ? (
                    <>
                      <Button variant="primary" size="sm" onClick={() => handleSave(t.id)} disabled={saving}>
                        {saving ? '…' : 'Save'}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => { setEditing(t.id); setEditBody(t.body); }}>
                      Edit
                    </Button>
                  )}
                </div>
              </div>

              {editing === t.id ? (
                <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={4} />
              ) : (
                <div className="text-12 text-ink-secondary leading-relaxed whitespace-pre-wrap">{t.body}</div>
              )}

              {t.variables && (
                <div className="mt-2 flex gap-1 flex-wrap">
                  {(typeof t.variables === 'string' ? JSON.parse(t.variables) : t.variables).map((v) => (
                    <span key={v} className="text-10 px-1.5 py-0.5 rounded-xs bg-zinc-50 text-ink-tertiary border-hairline font-mono">
                      {`{${v}}`}
                    </span>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── CSR Coach Tab ───────────────────────────────────────────────────

export function CSRCoachTabV2() {
  const [overview, setOverview] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [weeklyRec, setWeeklyRec] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [leadQuality, setLeadQuality] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminFetch('/admin/csr/overview?days=30').catch(() => null),
      adminFetch('/admin/csr/follow-up-tasks').catch(() => null),
      adminFetch('/admin/csr/weekly-recommendation').catch(() => null),
      adminFetch('/admin/csr/leaderboard').catch(() => null),
      adminFetch('/admin/csr/lead-quality?days=30').catch(() => null),
    ]).then(([ov, tk, wr, lb, lq]) => {
      setOverview(ov);
      setTasks(tk);
      setWeeklyRec(wr);
      setLeaderboard(lb);
      setLeadQuality(lq);
      setLoading(false);
    });
  }, []);

  const handleTaskUpdate = async (taskId, status) => {
    await adminFetch(`/admin/csr/follow-up-tasks/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    const tk = await adminFetch('/admin/csr/follow-up-tasks');
    setTasks(tk);
  };

  if (loading) return <div className="p-10 text-center text-ink-tertiary text-13">Loading CSR Coach…</div>;

  const csrs = overview?.csrStats || [];
  const rateAlert = (r) => r < 40;
  const scoreAlert = (s) => s < 9;

  return (
    <div className="flex flex-col gap-4">
      {/* Team Overview */}
      <Card>
        <CardBody>
          <div className="text-13 font-medium text-ink-primary mb-3">Team Overview (Last 30 Days)</div>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>CSR</TH>
                  <TH className="text-right">Calls</TH>
                  <TH className="text-right">1st-Call Book %</TH>
                  <TH className="text-right">Avg Score</TH>
                  <TH className="text-right">Follow-Up %</TH>
                </TR>
              </THead>
              <TBody>
                {csrs.map((c) => (
                  <TR key={c.name}>
                    <TD>{c.name}</TD>
                    <TD className="text-right font-mono u-nums">{c.calls}</TD>
                    <TD className={cn('text-right font-mono u-nums', rateAlert(c.firstCallBookingRate) && 'text-alert-fg')}>
                      {c.firstCallBookingRate}%
                    </TD>
                    <TD className={cn('text-right font-mono u-nums', scoreAlert(c.avgScore) && 'text-alert-fg')}>
                      {c.avgScore}/15
                    </TD>
                    <TD className={cn('text-right font-mono u-nums', rateAlert(c.followUpRate) && 'text-alert-fg')}>
                      {c.followUpRate}%
                    </TD>
                  </TR>
                ))}
                {overview?.teamTotals && (
                  <TR className="border-t-2 border-zinc-300">
                    <TD className="font-medium">Team</TD>
                    <TD className="text-right font-mono u-nums font-medium">{overview.teamTotals.calls}</TD>
                    <TD className="text-right font-mono u-nums font-medium">{overview.teamTotals.bookingRate}%</TD>
                    <TD className="text-right font-mono u-nums font-medium">{overview.teamTotals.avgScore}/15</TD>
                    <TD className="text-right text-ink-tertiary">—</TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </div>
        </CardBody>
      </Card>

      {/* Weekly Team Focus */}
      {weeklyRec?.recommendation && (
        <Card>
          <CardBody>
            <div className="text-13 font-medium text-ink-primary mb-2">This Week's Team Focus</div>
            <div className="p-3 bg-zinc-50 rounded-md mb-3 border-l-[3px] border-l-zinc-900">
              <div className="text-13 text-ink-primary leading-relaxed mb-1.5">{weeklyRec.recommendation}</div>
              {weeklyRec.dataPoint && <div className="text-12 text-ink-tertiary mb-0.5">{weeklyRec.dataPoint}</div>}
              {weeklyRec.estimatedImpact && <div className="text-12 text-ink-secondary">{weeklyRec.estimatedImpact}</div>}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigator.clipboard?.writeText(weeklyRec.recommendation)}
            >
              Copy to Group Chat
            </Button>
          </CardBody>
        </Card>
      )}

      {/* Lead Quality */}
      {leadQuality && (
        <Card>
          <CardBody>
            <div className="text-13 font-medium text-ink-primary mb-1">Lead Quality vs CSR Performance</div>
            <div className="text-12 text-ink-tertiary mb-3">Lost calls breakdown (last 30 days):</div>
            {(leadQuality.lossReasons || []).map((r, i) => {
              const reasonLabels = {
                bad_lead: "Bad leads (CSR couldn't save)",
                csr_missed_script: 'CSR missed script',
                pricing: 'Price objection unhandled',
                no_availability: 'No availability',
                customer_shopping: 'Customer shopping',
                after_hours: 'After hours',
                no_answer: 'No answer',
              };
              const isCsr = r.reason === 'csr_missed_script' || r.reason === 'pricing';
              return (
                <div key={i} className="flex items-center gap-3 mb-1.5">
                  <div className="flex-1 h-4 bg-zinc-100 rounded-xs overflow-hidden">
                    <div
                      className={cn('h-full rounded-xs', isCsr ? 'bg-alert-fg' : 'bg-zinc-400')}
                      style={{ width: `${r.pct}%`, minWidth: r.pct > 0 ? 4 : 0 }}
                    />
                  </div>
                  <span className={cn('text-12 w-[250px] text-right', isCsr ? 'text-alert-fg' : 'text-ink-secondary')}>
                    {reasonLabels[r.reason] || r.reason}
                  </span>
                  <span className="text-12 font-mono u-nums text-ink-tertiary w-9 text-right">{r.pct}%</span>
                </div>
              );
            })}
            {overview?.fixableLossCount > 0 && (
              <div className="mt-3 p-3 bg-alert-bg rounded-md border-l-[3px] border-l-alert-fg">
                <span className="text-13 text-alert-fg font-medium">
                  {overview.fixableLossCount} fixable CSR errors = ~${overview.fixableRevenue?.toLocaleString()}/mo in lost bookings
                </span>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Follow-Up Tasks */}
      <Card>
        <CardBody>
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <div className="text-13 font-medium text-ink-primary">Follow-Up Tasks</div>
            <div className="text-12 text-ink-tertiary">
              Pending: <span className="font-mono u-nums text-ink-secondary">{tasks?.pending || 0}</span>
              <span className="mx-2">·</span>
              Overdue: <span className={cn('font-mono u-nums', tasks?.overdue > 0 ? 'text-alert-fg' : 'text-ink-tertiary')}>{tasks?.overdue || 0}</span>
            </div>
          </div>

          {(tasks?.tasks || []).length === 0 ? (
            <div className="p-5 text-center text-ink-tertiary text-13">No pending follow-up tasks</div>
          ) : (
            (tasks?.tasks || []).slice(0, 10).map((t) => {
              const isOverdue = t.status === 'pending' && new Date(t.deadline) < new Date();
              return (
                <div
                  key={t.id}
                  className={cn(
                    'p-3 bg-zinc-50 rounded-md mb-2 border-l-[3px]',
                    isOverdue ? 'border-l-alert-fg' : 'border-l-zinc-400',
                  )}
                >
                  <div className="flex justify-between items-start mb-1 gap-2 flex-wrap">
                    <div className={cn('text-13 font-medium', isOverdue ? 'text-alert-fg' : 'text-ink-primary')}>
                      {isOverdue ? 'OVERDUE' : 'DUE'}: {t.assigned_to} — {t.task_type?.replace(/_/g, ' ')}
                      {t.first_name && ` ${t.first_name} ${t.last_name || ''}`}
                    </div>
                    <span className="text-10 text-ink-tertiary font-mono u-nums">
                      {new Date(t.deadline).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="text-12 text-ink-secondary mb-2 leading-relaxed">{t.recommended_action}</div>
                  <div className="flex gap-1.5">
                    <Button variant="primary" size="sm" onClick={() => handleTaskUpdate(t.id, 'completed')}>
                      Mark Done
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => handleTaskUpdate(t.id, 'in_progress')}>
                      Reassign
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardBody>
      </Card>

      {/* Bonus Leaderboard */}
      {leaderboard && (
        <Card>
          <CardBody>
            <div className="text-13 font-medium text-ink-primary mb-0.5">Bonus Leaderboard</div>
            <div className="text-12 text-ink-tertiary mb-3">Period: {leaderboard.periodLabel}</div>
            {(leaderboard.categories || []).map((cat, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-zinc-50 rounded-md mb-1.5">
                <div className="flex-1">
                  <div className="text-13 text-ink-primary font-medium">
                    {cat.category}: {cat.winner || 'TBD'}
                  </div>
                  <div className="text-12 text-ink-secondary">{cat.value}</div>
                </div>
                <div className="text-14 font-medium font-mono u-nums text-ink-primary">
                  ${cat.bonus}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
