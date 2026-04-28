import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal folded to zinc-900. Semantic green/amber/red preserved.
const D = {
  bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7',
  teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B',
  text: '#27272A', muted: '#71717A', heading: '#09090B',
};

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sLabel = { fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1 };
const sMono = { fontFamily: "'JetBrains Mono', monospace" };

function statusColor(status) {
  if (status === 'critical') return D.red;
  if (status === 'warning') return D.amber;
  if (status === 'idle') return D.muted;
  return D.green;
}

function statusLabel(status) {
  if (status === 'critical') return 'CRITICAL';
  if (status === 'warning') return 'DEGRADED';
  if (status === 'idle') return 'IDLE';
  return 'HEALTHY';
}

function pct(n) {
  return `${Math.round((n || 0) * 100)}%`;
}

function formatRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

export default function ToolHealthPage() {
  const [data, setData] = useState(null);
  const [hours, setHours] = useState(24);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState({});

  const load = useCallback(() => {
    adminFetch(`/admin/tool-health?hours=${hours}`)
      .then(d => { setData(d); setErr(null); })
      .catch(e => setErr(e.message));
  }, [hours]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (err) return <div style={{ padding: 40, color: D.red }}>Failed to load: {err}</div>;
  if (!data) return <div style={{ padding: 40, color: D.muted }}>Loading tool health...</div>;

  const { overallStatus, summary, agents, contexts, recentErrors, alerts } = data;

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>Tool Health</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {[1, 24, 24 * 7].map(h => (
            <button key={h} onClick={() => setHours(h)} style={{
              padding: '6px 12px', border: `1px solid ${D.border}`, borderRadius: 6,
              background: hours === h ? D.teal : D.card, color: hours === h ? '#fff' : D.text,
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>{h === 1 ? '1h' : h === 24 ? '24h' : '7d'}</button>
          ))}
          <button onClick={load} style={{
            padding: '6px 12px', border: 'none', borderRadius: 6, background: D.teal, color: '#fff',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>Refresh</button>
        </div>
      </div>

      {/* Status bar */}
      <div style={{
        ...sCard,
        background: statusColor(overallStatus),
        color: '#fff',
        display: 'flex', alignItems: 'center', gap: 20, padding: 24,
      }}>
        <div>
          <div style={{ fontSize: 10, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 1 }}>Overall Status</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{statusLabel(overallStatus)}</div>
        </div>
        <div style={{ display: 'flex', gap: 28, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <Metric label="Total calls" value={summary.total.toLocaleString()} />
          <Metric label="Success rate" value={pct(1 - summary.errorRate)} />
          <Metric label="Failures" value={summary.failed.toLocaleString()} />
          <Metric label="Circuit trips" value={summary.circuitOpenCount} />
          <Metric label="Avg duration" value={summary.avgDurationMs ? `${summary.avgDurationMs}ms` : '—'} />
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Active Alerts</div>
          {alerts.map((a, i) => (
            <div key={i} style={{
              padding: '10px 14px', marginBottom: 8,
              background: a.severity === 'critical' ? '#FDECEA' : '#FEF7E0',
              borderLeft: `4px solid ${a.severity === 'critical' ? D.red : D.amber}`,
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{a.title}</div>
              <div style={{ fontSize: 12, color: D.text, marginTop: 2 }}>{a.detail}</div>
            </div>
          ))}
        </div>
      )}

      {/* Agent health cards */}
      <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 10 }}>Agent Health</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, marginBottom: 24 }}>
        {agents.map(a => (
          <div key={a.source} style={{
            ...sCard, marginBottom: 0,
            borderLeft: `4px solid ${statusColor(a.status)}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: D.heading }}>{a.label}</div>
              <div style={{
                ...sLabel, color: statusColor(a.status), fontWeight: 700,
              }}>{statusLabel(a.status)}</div>
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
              <div>
                <div style={sLabel}>Calls</div>
                <div style={{ ...sMono, fontSize: 18, fontWeight: 700, color: D.heading }}>{a.total}</div>
              </div>
              <div>
                <div style={sLabel}>Errors</div>
                <div style={{ ...sMono, fontSize: 18, fontWeight: 700, color: a.failed > 0 ? D.red : D.muted }}>{a.failed}</div>
              </div>
              <div>
                <div style={sLabel}>Avg</div>
                <div style={{ ...sMono, fontSize: 18, fontWeight: 700, color: D.heading }}>
                  {a.avgDurationMs ? `${a.avgDurationMs}ms` : '—'}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: D.muted, marginTop: 8 }}>
              Last call {formatRelative(a.lastCallAt)}
            </div>
          </div>
        ))}
      </div>

      {/* Contexts breakdown */}
      <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 10 }}>
        Tools by Context
      </div>
      {contexts.length === 0 && (
        <div style={{ ...sCard, color: D.muted, fontSize: 13 }}>No tool activity in the selected window.</div>
      )}
      {contexts.map(ctx => {
        const key = ctx.context;
        // auto-expand contexts with any failures; collapsed by default otherwise
        const isOpen = expanded[key] !== undefined ? expanded[key] : ctx.failed > 0;
        const statusFor = ctx.failed > 0
          ? (ctx.errorRate >= 0.2 ? 'critical' : 'warning')
          : 'ok';
        return (
          <div key={key} style={sCard}>
            <div
              onClick={() => setExpanded(e => ({ ...e, [key]: !isOpen }))}
              style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
            >
              <div style={{ width: 10, height: 10, borderRadius: 5, background: statusColor(statusFor) }} />
              <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, flex: 1 }}>{key}</div>
              <div style={{ ...sMono, fontSize: 12, color: D.muted }}>
                {ctx.toolsUsed} tools · {ctx.total} calls · {ctx.failed} failed ({pct(ctx.errorRate)})
              </div>
              <div style={{ color: D.muted, fontSize: 12 }}>{isOpen ? '▾' : '▸'}</div>
            </div>
            {isOpen && (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 14 }}>
                <thead>
                  <tr>
                    {['Tool', 'Source', 'Calls', 'Failed', 'Error rate', 'Avg'].map(h => (
                      <th key={h} style={{ fontSize: 10, color: D.muted, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 1, padding: '8px 10px', borderBottom: `1px solid ${D.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ctx.tools
                    .slice()
                    .sort((a, b) => b.failed - a.failed || b.total - a.total)
                    .map(t => (
                    <tr key={`${t.toolName}-${t.source}`}>
                      <td style={{ padding: '8px 10px', fontSize: 13, color: D.heading, fontWeight: 600 }}>{t.toolName}</td>
                      <td style={{ padding: '8px 10px', fontSize: 12, color: D.muted }}>{t.source}</td>
                      <td style={{ padding: '8px 10px', ...sMono, fontSize: 13, color: D.text }}>{t.total}</td>
                      <td style={{ padding: '8px 10px', ...sMono, fontSize: 13, color: t.failed > 0 ? D.red : D.muted }}>{t.failed}</td>
                      <td style={{ padding: '8px 10px', ...sMono, fontSize: 13, color: t.errorRate >= 0.2 ? D.red : t.errorRate > 0 ? D.amber : D.muted }}>{pct(t.errorRate)}</td>
                      <td style={{ padding: '8px 10px', ...sMono, fontSize: 13, color: D.text }}>{t.avgDurationMs ? `${t.avgDurationMs}ms` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      {/* Recent errors */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, marginTop: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>Recent Errors</div>
        {recentErrors.length > 0 && (
          <div style={{ ...sMono, fontSize: 12, color: D.muted }}>{recentErrors.length}</div>
        )}
      </div>
      <div style={{ ...sCard, padding: 0 }}>
        {recentErrors.length === 0 && (
          <div style={{ color: D.muted, fontSize: 13, padding: 20 }}>No errors in the selected window.</div>
        )}
        {recentErrors.map((e, i) => (
          <RecentErrorRow key={e.id} err={e} isLast={i === recentErrors.length - 1} />
        ))}
      </div>

      <div style={{ textAlign: 'center', fontSize: 11, color: D.muted, padding: 20 }}>
        Updated {formatRelative(data.generatedAt)} · auto-refreshes every 30s
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function RecentErrorRow({ err, isLast }) {
  const [open, setOpen] = useState(false);
  const msg = err.errorMessage || '(no message)';
  const canExpand = msg.length > 120 || msg.includes('\n');

  return (
    <div
      onClick={() => canExpand && setOpen(o => !o)}
      style={{
        padding: '7px 14px',
        borderBottom: isLast ? 'none' : `1px solid ${D.border}`,
        display: 'grid', gridTemplateColumns: '80px 170px 1fr', columnGap: 14, alignItems: 'start',
        cursor: canExpand ? 'pointer' : 'default',
      }}
    >
      <div style={{ fontSize: 11, color: D.muted, lineHeight: '18px' }}>{formatRelative(err.at)}</div>
      <div style={{ lineHeight: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: D.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err.toolName}</span>
          {err.circuitOpen && (
            <span title="Circuit breaker is open" style={{
              fontSize: 9, padding: '1px 5px', background: '#FDECEA', color: D.red,
              borderRadius: 3, fontWeight: 700, letterSpacing: 0.4,
            }}>OPEN</span>
          )}
        </div>
        <div style={{ fontSize: 10, color: D.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {err.context || err.source}
        </div>
      </div>
      <div style={{
        fontSize: 12, color: D.text, fontFamily: "'JetBrains Mono', monospace",
        lineHeight: '18px',
        display: '-webkit-box', WebkitBoxOrient: 'vertical',
        WebkitLineClamp: open ? 'unset' : 2,
        overflow: 'hidden',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {msg}
      </div>
    </div>
  );
}
