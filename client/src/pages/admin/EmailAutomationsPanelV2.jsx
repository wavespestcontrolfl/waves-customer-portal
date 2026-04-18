// client/src/pages/admin/EmailAutomationsPanelV2.jsx
// Monochrome V2 of EmailAutomationsPanel. Strict 1:1 on endpoints + state:
//   GET  /admin/email-automations/automations
//   GET  /admin/email-automations/stats
//   GET  /admin/email-automations/log?limit=50
//   POST /admin/email-automations/trigger        { automationKey, customerId }
//   PUT  /admin/email-automations/automations/:key  { enabled }
//   GET  /admin/customers?search=...&limit=10
// alert-fg reserved for: Failed automation status row + Beehiiv-not-configured banner.
import { useState, useEffect, useCallback } from 'react';
import {
  Badge, Button, Card, CardBody, Input, Switch,
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

function timeAgo(d) {
  if (!d) return '';
  const mins = Math.floor((Date.now() - new Date(d)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function EmailAutomationsPanelV2() {
  const [tab, setTab] = useState('send');
  const [automations, setAutomations] = useState([]);
  const [log, setLog] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [beehiivConfigured, setBeehiivConfigured] = useState(false);
  const [toast, setToast] = useState('');

  const loadData = useCallback(async () => {
    const [autoData, statsData, logData] = await Promise.all([
      adminFetch('/admin/email-automations/automations').catch(() => ({ automations: [] })),
      adminFetch('/admin/email-automations/stats').catch(() => null),
      adminFetch('/admin/email-automations/log?limit=50').catch(() => ({ log: [] })),
    ]);
    setAutomations(autoData.automations || []);
    setBeehiivConfigured(autoData.beehiivConfigured);
    setStats(statsData);
    setLog(logData.log || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  if (loading) return <div className="p-10 text-center text-ink-tertiary text-13">Loading email automations…</div>;

  const TABS = [
    { key: 'send', label: 'Send to Customer' },
    { key: 'automations', label: 'Automations' },
    { key: 'log', label: 'Activity Log' },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-start mb-4 gap-3 flex-wrap">
        <div>
          <div className="text-22 tracking-tight text-ink-primary">Email Automations</div>
          <div className="text-13 text-ink-tertiary mt-1 flex items-center gap-2 flex-wrap">
            <span>Beehiiv + SMS — manual triggers</span>
            {beehiivConfigured
              ? <Badge tone="strong">Beehiiv Connected</Badge>
              : <Badge tone="alert">Beehiiv Not Configured</Badge>}
          </div>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-5">
          {[
            { label: 'Total Sent', value: stats.total },
            { label: 'Last 24h', value: stats.last24h },
            { label: 'Last 7d', value: stats.last7d },
            { label: 'Success', value: stats.success },
            { label: 'Customers Reached', value: stats.uniqueCustomers },
          ].map((s) => (
            <div key={s.label} className="bg-white border-hairline border-zinc-200 rounded-md p-3 text-center">
              <div className="text-22 font-mono u-nums text-ink-primary">{s.value}</div>
              <div className="text-10 uppercase tracking-label text-ink-tertiary mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tab pills */}
      <div className="flex gap-1 mb-5 bg-white border-hairline rounded-md p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'h-8 px-4 rounded-sm text-12 uppercase tracking-label transition-colors',
              tab === t.key
                ? 'bg-zinc-900 text-white'
                : 'text-ink-secondary hover:bg-zinc-50',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'send' && <SendTabV2 automations={automations} showToast={showToast} onSent={loadData} />}
      {tab === 'automations' && <AutomationsTabV2 automations={automations} showToast={showToast} onUpdate={loadData} />}
      {tab === 'log' && <LogTabV2 log={log} onRefresh={loadData} />}

      {/* Toast */}
      <div
        className={cn(
          'fixed bottom-5 right-5 bg-white border-hairline border-zinc-900 rounded-md px-4 py-2',
          'flex items-center gap-2 shadow-lg z-[300] text-12 transition-all pointer-events-none',
          toast ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0',
        )}
      >
        <span className="text-ink-primary">✓</span>
        <span className="text-ink-secondary">{toast}</span>
      </div>
    </div>
  );
}

// ── Send Tab ────────────────────────────────────────────────────────

function SendTabV2({ automations, showToast, onSent }) {
  const [search, setSearch] = useState('');
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [selectedAuto, setSelectedAuto] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);

  const doSearch = async (q) => {
    setSearch(q);
    if (q.length < 2) { setCustomers([]); return; }
    setSearching(true);
    try {
      const d = await adminFetch(`/admin/customers?search=${encodeURIComponent(q)}&limit=10`);
      setCustomers(d.customers || []);
    } catch { setCustomers([]); }
    setSearching(false);
  };

  const handleSend = async () => {
    if (!selectedCustomer || !selectedAuto) { showToast('Select a customer and automation'); return; }
    setSending(true);
    setResult(null);
    try {
      const r = await adminFetch('/admin/email-automations/trigger', {
        method: 'POST',
        body: JSON.stringify({ automationKey: selectedAuto, customerId: selectedCustomer.id }),
      });
      setResult(r);
      if (r.success) showToast(`Sent "${automations.find((a) => a.key === selectedAuto)?.name}" to ${selectedCustomer.firstName}`);
      else showToast(r.error || 'Failed');
      onSent();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
      setResult({ error: e.message });
    }
    setSending(false);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
      {/* Left: customer search */}
      <Card>
        <CardBody>
          <div className="text-13 font-medium text-ink-primary mb-3">1. Select Customer</div>
          <Input
            value={search}
            onChange={(e) => doSearch(e.target.value)}
            placeholder="Search by name, phone, or email…"
          />
          {searching && <div className="text-12 text-ink-tertiary mt-2">Searching…</div>}

          <div className="mt-2 max-h-[300px] overflow-y-auto">
            {customers.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { setSelectedCustomer(c); setCustomers([]); setSearch(`${c.firstName} ${c.lastName}`); }}
                className={cn(
                  'w-full text-left p-2.5 rounded-sm mb-1 border-hairline transition-colors',
                  selectedCustomer?.id === c.id
                    ? 'bg-zinc-50 border-zinc-900'
                    : 'bg-white border-transparent hover:bg-zinc-50',
                )}
              >
                <div className="text-13 font-medium text-ink-primary">{c.firstName} {c.lastName}</div>
                <div className="text-11 text-ink-tertiary flex items-center gap-1.5 flex-wrap mt-0.5">
                  {c.phone && <span>{c.phone}</span>}
                  {c.email && <span>· {c.email}</span>}
                  {c.pipelineStage && <Badge tone="neutral">{c.pipelineStage}</Badge>}
                </div>
              </button>
            ))}
          </div>

          {selectedCustomer && (
            <div className="mt-3 p-3 bg-zinc-50 rounded-md border-hairline border-zinc-900">
              <div className="text-13 font-medium text-ink-primary">
                Selected: {selectedCustomer.firstName} {selectedCustomer.lastName}
              </div>
              <div className="text-12 text-ink-tertiary mt-1">
                {selectedCustomer.email || 'No email'} · {selectedCustomer.phone || 'No phone'}
              </div>
              {!selectedCustomer.email && (
                <div className="text-12 text-alert-fg mt-1">No email — Beehiiv will be skipped</div>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Right: pick automation */}
      <Card>
        <CardBody>
          <div className="text-13 font-medium text-ink-primary mb-3">2. Pick Automation & Send</div>

          <div className="grid gap-2 mb-4">
            {automations.filter((a) => a.enabled).map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setSelectedAuto(a.key)}
                className={cn(
                  'text-left p-3 rounded-sm border-hairline transition-colors',
                  selectedAuto === a.key
                    ? 'bg-zinc-50 border-zinc-900'
                    : 'bg-white border-zinc-300 hover:bg-zinc-50',
                )}
              >
                <div className="flex justify-between items-start gap-2 flex-wrap">
                  <div className="text-13 font-medium text-ink-primary">{a.name}</div>
                  <div className="flex gap-1 flex-wrap">
                    {a.smsTemplate && <Badge tone="strong">+ SMS</Badge>}
                    {a.tags?.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}
                  </div>
                </div>
                <div className="text-12 text-ink-tertiary mt-1">{a.description}</div>
              </button>
            ))}
          </div>

          <Button
            variant="primary"
            onClick={handleSend}
            disabled={sending || !selectedCustomer || !selectedAuto}
            className="w-full"
          >
            {sending ? 'Sending…' : `Send ${automations.find((a) => a.key === selectedAuto)?.name || 'Automation'}`}
          </Button>

          {result && (
            <div
              className={cn(
                'mt-3 p-3 rounded-md border-hairline',
                result.success ? 'bg-zinc-50 border-zinc-900' : 'bg-alert-bg border-alert-fg',
              )}
            >
              <div className={cn('text-13 font-medium', result.success ? 'text-ink-primary' : 'text-alert-fg')}>
                {result.success ? '✓ Sent successfully' : `✗ ${result.error || 'Failed'}`}
              </div>
              {result.beehiiv && !result.beehiiv.error && (
                <div className="text-12 text-ink-tertiary mt-1">
                  Beehiiv: subscribed + tagged [{result.beehiiv.tags?.join(', ')}]
                </div>
              )}
              {result.beehiiv?.skipped && (
                <div className="text-12 text-ink-tertiary mt-1">Beehiiv: {result.beehiiv.skipped}</div>
              )}
              {result.sms?.sent && (
                <div className="text-12 text-ink-tertiary mt-1">SMS: sent to {result.sms.to}</div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ── Automations Tab ─────────────────────────────────────────────────

function AutomationsTabV2({ automations, showToast, onUpdate }) {
  const toggleAuto = async (key, enabled) => {
    try {
      await adminFetch(`/admin/email-automations/automations/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      showToast(`${key} ${enabled ? 'enabled' : 'disabled'}`);
      onUpdate();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  return (
    <div className="grid gap-2">
      {automations.map((a) => (
        <Card key={a.key}>
          <CardBody>
            <div className={cn('flex items-start gap-4', !a.enabled && 'opacity-50')}>
              <div className="flex-1">
                <div className="flex justify-between items-center mb-1 gap-3 flex-wrap">
                  <div className="text-14 font-medium text-ink-primary">{a.name}</div>
                  <Switch checked={a.enabled} onChange={(v) => toggleAuto(a.key, v)} />
                </div>
                <div className="text-13 text-ink-tertiary mb-2">{a.description}</div>
                <div className="flex gap-1.5 flex-wrap mb-2">
                  <Badge tone="neutral">Manual trigger</Badge>
                  {a.tags?.map((t) => <Badge key={t} tone="neutral">tag: {t}</Badge>)}
                  {a.smsTemplate && <Badge tone="strong">+ SMS</Badge>}
                </div>
                <div className="flex gap-4 text-12 text-ink-tertiary flex-wrap">
                  <span>Total: <span className="font-mono u-nums text-ink-primary font-medium">{a.totalRuns}</span></span>
                  <span>Success: <span className="font-mono u-nums text-ink-primary font-medium">{a.successCount}</span></span>
                  <span>Last 7d: <span className="font-mono u-nums text-ink-primary font-medium">{a.last7Days}</span></span>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

// ── Log Tab ─────────────────────────────────────────────────────────

function LogTabV2({ log, onRefresh }) {
  const statusTone = { success: 'strong', partial: 'neutral', failed: 'alert' };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-13 font-medium text-ink-primary">Recent Sends</div>
        <Button variant="secondary" size="sm" onClick={onRefresh}>Refresh</Button>
      </div>
      {log.length === 0 ? (
        <Card><CardBody><div className="p-10 text-center text-ink-tertiary text-13">No automations sent yet</div></CardBody></Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Customer</TH>
                    <TH>Automation</TH>
                    <TH>Status</TH>
                    <TH>Beehiiv</TH>
                    <TH>SMS</TH>
                    <TH>Time</TH>
                  </TR>
                </THead>
                <TBody>
                  {log.map((l) => {
                    const bh = l.beehiiv_result
                      ? (typeof l.beehiiv_result === 'string' ? JSON.parse(l.beehiiv_result) : l.beehiiv_result)
                      : null;
                    const sms = l.sms_result
                      ? (typeof l.sms_result === 'string' ? JSON.parse(l.sms_result) : l.sms_result)
                      : null;
                    return (
                      <TR key={l.id}>
                        <TD>
                          <div className="text-13 font-medium text-ink-primary">{l.first_name} {l.last_name}</div>
                          <div className="text-11 text-ink-tertiary">{l.customer_email}</div>
                        </TD>
                        <TD>{l.automation_name || l.automation_key}</TD>
                        <TD><Badge tone={statusTone[l.status] || 'neutral'}>{l.status}</Badge></TD>
                        <TD className="text-11 text-ink-tertiary">
                          {bh?.subscriberId ? '✓ Enrolled' : bh?.skipped ? 'Skipped' : bh?.error ? '✗ Error' : '—'}
                        </TD>
                        <TD className="text-11 text-ink-tertiary">
                          {sms?.sent ? `✓ ${sms.to}` : sms?.error ? '✗ Error' : '—'}
                        </TD>
                        <TD className="text-11 text-ink-tertiary font-mono u-nums">{timeAgo(l.created_at)}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
