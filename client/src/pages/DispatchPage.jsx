// client/src/pages/DispatchPage.jsx
import { useState, useEffect } from 'react';
import RoutePanel from '../components/dispatch/RoutePanel';
import TechMatchPanel from '../components/dispatch/TechMatchPanel';
import CSRPanel from '../components/dispatch/CSRPanel';
import RevenuePanel from '../components/dispatch/RevenuePanel';
import InsightsPanel from '../components/dispatch/InsightsPanel';

const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };

const TABS = [
  { id: 'routes', label: 'Route + Dispatch' },
  { id: 'match', label: 'Tech Matching' },
  { id: 'csr', label: 'CSR Booking' },
  { id: 'revenue', label: 'Revenue Score' },
  { id: 'insights', label: 'Insights' },
];

export default function DispatchPage() {
  const [tab, setTab] = useState('routes');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  async function syncSheets() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await fetch('/api/sheets/sync-jobs', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` } });
      const data = await res.json();
      setSyncMsg(data.mock ? `Mock data loaded (${data.synced} jobs)` : `Synced ${data.synced} jobs from Sheets`);
    } catch {
      setSyncMsg('Sync failed — using cached data');
    }
    setSyncing(false);
  }

  useEffect(() => { syncSheets(); }, []);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: D.white }}>Dispatch AI</div>
          <div style={{ fontSize: 13, color: D.muted }}>Route optimization · Tech matching · CSR booking</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{
              padding: '6px 12px', borderRadius: 8, border: `1px solid ${D.border}`,
              background: D.bg, color: D.text, fontSize: 13,
            }}
          />
          <button
            onClick={syncSheets}
            disabled={syncing}
            style={{
              padding: '6px 14px', borderRadius: 8, border: `1px solid ${D.border}`,
              background: 'transparent', color: D.muted, fontSize: 13, cursor: 'pointer',
              opacity: syncing ? 0.5 : 1,
            }}
          >
            {syncing ? 'Syncing...' : '↻ Sync Sheets'}
          </button>
        </div>
      </div>
      {syncMsg && <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>{syncMsg}</div>}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
              background: tab === t.id ? D.teal : 'transparent',
              color: tab === t.id ? D.white : D.muted,
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Panel */}
      <div>
        {tab === 'routes'   && <RoutePanel date={date} />}
        {tab === 'match'    && <TechMatchPanel />}
        {tab === 'csr'      && <CSRPanel />}
        {tab === 'revenue'  && <RevenuePanel date={date} />}
        {tab === 'insights' && <InsightsPanel />}
      </div>
    </div>
  );
}
