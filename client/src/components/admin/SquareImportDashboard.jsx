import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 16 };
const sBtn = (bg, disabled) => ({
  padding: '10px 20px', background: disabled ? D.border : bg, color: D.white, border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
  transition: 'all 0.2s',
});
const sStat = { textAlign: 'center', flex: 1, minWidth: 100 };

function ProgressBar({ value, max, color = D.teal }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ background: D.input, borderRadius: 6, height: 8, overflow: 'hidden', marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 6, transition: 'width 0.3s' }} />
    </div>
  );
}

export default function SquareImportDashboard() {
  const [status, setStatus] = useState(null);
  const [running, setRunning] = useState(false);
  const [currentPhase, setCurrentPhase] = useState(null);
  const [results, setResults] = useState(null);
  const [errors, setErrors] = useState([]);
  const [showErrors, setShowErrors] = useState(false);
  const [toast, setToast] = useState('');
  const [subReport, setSubReport] = useState(null);
  const [showSubReport, setShowSubReport] = useState(false);

  const loadStatus = useCallback(() => {
    adminFetch('/admin/square-import/status').then(setStatus).catch(() => setToast('Failed to load status'));
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const loadSubReport = () => {
    adminFetch('/admin/square-import/subscription-report')
      .then(data => { setSubReport(data); setShowSubReport(true); })
      .catch(() => setToast('Failed to load subscription report'));
  };

  const runPhase = async (endpoint, label) => {
    if (running) return;
    setRunning(true);
    setCurrentPhase(label);
    setResults(null);
    setErrors([]);
    setToast('');
    try {
      const res = await adminFetch(`/admin/square-import/${endpoint}`, { method: 'POST' });
      setResults(res);
      if (res.errors?.length) setErrors(res.errors);
      setToast(`${label} complete`);
      loadStatus();
    } catch (err) {
      setToast(`${label} failed: ${err.message}`);
      setErrors([{ phase: label, error: err.message }]);
    } finally {
      setRunning(false);
      setCurrentPhase(null);
    }
  };

  const phases = [
    { key: 'customers', label: 'Customers', icon: 'U' },
    { key: 'history', label: 'History', icon: 'H' },
    { key: 'bookings', label: 'Bookings', icon: 'B' },
    { key: 'invoices', label: 'Invoices', icon: 'I' },
    { key: 'payments', label: 'Payments', icon: 'P' },
  ];

  return (
    <div style={{ color: D.text, maxWidth: 900, margin: '0 auto' }}>
      {toast && (
        <div style={{ background: toast.includes('fail') ? D.red + '22' : D.green + '22', border: `1px solid ${toast.includes('fail') ? D.red : D.green}`,
          borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, color: toast.includes('fail') ? D.red : D.green }}>
          {toast}
          <span onClick={() => setToast('')} style={{ float: 'right', cursor: 'pointer', fontWeight: 700 }}>x</span>
        </div>
      )}

      {/* Import Status Card */}
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Import Status</div>
        {status ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 16 }}>
              <div style={sStat}>
                <div style={{ fontSize: 28, fontWeight: 700, color: D.teal }}>{status.totalCustomers}</div>
                <div style={{ fontSize: 11, color: D.muted }}>Total Customers</div>
              </div>
              <div style={sStat}>
                <div style={{ fontSize: 28, fontWeight: 700, color: D.green }}>{status.withSquareId}</div>
                <div style={{ fontSize: 11, color: D.muted }}>With Square ID</div>
              </div>
              <div style={sStat}>
                <div style={{ fontSize: 28, fontWeight: 700, color: D.amber }}>{status.withHistory}</div>
                <div style={{ fontSize: 11, color: D.muted }}>With History</div>
              </div>
              <div style={sStat}>
                <div style={{ fontSize: 28, fontWeight: 700, color: D.purple }}>{status.totalRecords}</div>
                <div style={{ fontSize: 11, color: D.muted }}>Total Records</div>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: D.muted, marginBottom: 2 }}>
                <span>Square ID Coverage</span>
                <span>{status.completeness}%</span>
              </div>
              <ProgressBar value={status.withSquareId} max={status.totalCustomers} color={D.green} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: D.muted, marginBottom: 2 }}>
                <span>History Coverage</span>
                <span>{status.historyCompleteness}%</span>
              </div>
              <ProgressBar value={status.withHistory} max={status.withSquareId} color={D.amber} />
            </div>

            {status.missingHistory > 0 && (
              <div style={{ fontSize: 12, color: D.amber, marginTop: 8 }}>
                {status.missingHistory} customers with Square ID but no service records
              </div>
            )}

            {/* Subscription + Refund stats row */}
            {(status.activeSubscriptions > 0 || status.mrr > 0 || status.totalRefunds > 0) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, padding: '12px 0', borderTop: `1px solid ${D.border}` }}>
                <div style={sStat}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: D.green }}>{status.activeSubscriptions}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>Active Subs</div>
                </div>
                <div style={sStat}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: D.green }}>${status.mrr?.toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>MRR</div>
                </div>
                <div style={sStat}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: D.red }}>{status.totalRefunds}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>Refunds</div>
                </div>
                <div style={sStat}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: D.amber }}>{status.noShowCount}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>No-Shows</div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12, fontSize: 11, color: D.muted }}>
              <span>Service Records: {status.totalServiceRecords}</span>
              <span>Payments: {status.totalPayments}</span>
              <span>Scheduled: {status.totalScheduled}</span>
              <span>Invoices: {status.totalInvoices}</span>
            </div>
          </>
        ) : (
          <div style={{ color: D.muted, fontSize: 13 }}>Loading status...</div>
        )}
      </div>

      {/* Full Import Button */}
      <div style={{ ...sCard, textAlign: 'center', padding: 28 }}>
        <button
          onClick={() => runPhase('full', 'Full Import')}
          disabled={running}
          style={{ ...sBtn(D.green, running), fontSize: 16, padding: '14px 40px', borderRadius: 10 }}
        >
          {running && currentPhase === 'Full Import' ? 'Importing...' : 'Full Import from Square'}
        </button>
        <div style={{ fontSize: 11, color: D.muted, marginTop: 8 }}>
          Runs all 8 phases: Customers, History, Bookings, Invoices, Payments, Subscriptions, Refunds, Totals
        </div>
      </div>

      {/* Individual Phase Buttons */}
      <div style={sCard}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Individual Phases</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {phases.map(p => (
            <button
              key={p.key}
              onClick={() => runPhase(p.key, p.label)}
              disabled={running}
              style={sBtn(D.teal, running)}
            >
              {running && currentPhase === p.label ? `${p.label}...` : p.label}
            </button>
          ))}
          <button
            onClick={() => runPhase('subscriptions', 'Subscriptions')}
            disabled={running}
            style={sBtn(D.green, running)}
          >
            {running && currentPhase === 'Subscriptions' ? 'Syncing...' : 'Subscriptions'}
          </button>
          <button
            onClick={() => runPhase('refunds', 'Refunds')}
            disabled={running}
            style={sBtn(D.red, running)}
          >
            {running && currentPhase === 'Refunds' ? 'Sweeping...' : 'Refunds'}
          </button>
          <button
            onClick={() => runPhase('recalculate', 'Recalculate')}
            disabled={running}
            style={sBtn(D.purple, running)}
          >
            {running && currentPhase === 'Recalculate' ? 'Calculating...' : 'Recalculate'}
          </button>
          <button
            onClick={() => runPhase('cleanup', 'Cleanup')}
            disabled={running}
            style={sBtn(D.amber, running)}
          >
            {running && currentPhase === 'Cleanup' ? 'Cleaning...' : 'Cleanup Data'}
          </button>
        </div>
      </div>

      {/* Running Indicator */}
      {running && (
        <div style={{ ...sCard, borderColor: D.teal }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: D.teal, animation: 'pulse 1.5s infinite' }} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Running: {currentPhase}</span>
          </div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
            This may take several minutes for large datasets. Do not close this page.
          </div>
        </div>
      )}

      {/* Results Summary */}
      {results && !running && (
        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: D.green }}>Results</div>
          {results.phases ? (
            // Full import results
            <div>
              <div style={{ fontSize: 12, color: D.muted, marginBottom: 8 }}>Completed in {results.elapsed}</div>
              {Object.entries(results.phases).map(([phase, data]) => (
                <div key={phase} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${D.border}22`, fontSize: 13 }}>
                  <span style={{ textTransform: 'capitalize', fontWeight: 500 }}>{phase}</span>
                  <span style={{ color: data.error ? D.red : D.green }}>
                    {data.error ? `Error: ${data.error}` :
                      phase === 'customers' ? `${data.created || 0} created, ${data.updated || 0} updated, ${data.notesParsed || 0} notes` :
                      phase === 'history' ? `${data.totalServices || 0} services, ${data.totalPayments || 0} payments` :
                      phase === 'subscriptions' ? `${data.activeSubscriptions || 0} active, MRR $${data.mrr || 0}` :
                      phase === 'refunds' ? `${data.totalChecked || 0} checked, ${data.refundsFound || 0} refunds` :
                      `${data.created || 0} created, ${data.skipped || 0} skipped`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            // Single phase results
            <div style={{ fontSize: 13 }}>
              {results.created !== undefined && <div>Created: <b>{results.created}</b></div>}
              {results.updated !== undefined && <div>Updated: <b>{results.updated}</b></div>}
              {results.skipped !== undefined && <div>Skipped: <b>{results.skipped}</b></div>}
              {results.totalFetched !== undefined && <div>Fetched from Square: <b>{results.totalFetched}</b></div>}
              {results.totalServices !== undefined && <div>Services created: <b>{results.totalServices}</b></div>}
              {results.totalPayments !== undefined && <div>Payments created: <b>{results.totalPayments}</b></div>}
              {results.processed !== undefined && <div>Customers processed: <b>{results.processed}/{results.total}</b></div>}
              {results.deduped !== undefined && <div>Duplicates removed: <b>{results.deduped}</b></div>}
              {results.descFixed !== undefined && <div>Descriptions fixed: <b>{results.descFixed}</b></div>}
              {results.activeSubscriptions !== undefined && <div>Active subscriptions: <b>{results.activeSubscriptions}</b></div>}
              {results.mrr !== undefined && <div>MRR: <b>${results.mrr}</b></div>}
              {results.notesParsed !== undefined && <div>Notes parsed: <b>{results.notesParsed}</b></div>}
              {results.refundsFound !== undefined && <div>Refunds found: <b>{results.refundsFound}</b></div>}
              {results.cardDetailsAdded !== undefined && <div>Card details added: <b>{results.cardDetailsAdded}</b></div>}
              {results.totalChecked !== undefined && <div>Payments checked: <b>{results.totalChecked}</b></div>}
            </div>
          )}
        </div>
      )}

      {/* Subscription Verification */}
      <div style={sCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.green }}>Subscription Verification</div>
          <button onClick={loadSubReport} disabled={running} style={sBtn(D.green, running)}>
            {showSubReport ? 'Refresh' : 'Load Report'}
          </button>
        </div>
        {showSubReport && subReport && (
          <>
            <div style={{ display: 'flex', gap: 20, marginBottom: 14, padding: '10px 0', borderBottom: `1px solid ${D.border}` }}>
              <div style={sStat}>
                <div style={{ fontSize: 22, fontWeight: 700, color: D.green }}>{subReport.count}</div>
                <div style={{ fontSize: 11, color: D.muted }}>Active Subscribers</div>
              </div>
              <div style={sStat}>
                <div style={{ fontSize: 22, fontWeight: 700, color: D.green }}>${subReport.mrr?.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: D.muted }}>Monthly (MRR)</div>
              </div>
              <div style={sStat}>
                <div style={{ fontSize: 22, fontWeight: 700, color: D.teal }}>${subReport.arr?.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: D.muted }}>Annual (ARR)</div>
              </div>
            </div>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${D.border}`, color: D.muted, textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px' }}>Name</th>
                    <th style={{ padding: '6px 8px' }}>Tier</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Monthly Rate</th>
                    <th style={{ padding: '6px 8px' }}>Since</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center' }}>Card</th>
                  </tr>
                </thead>
                <tbody>
                  {subReport.subscribers?.map((s, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${D.border}22` }}>
                      <td style={{ padding: '6px 8px', fontWeight: 500 }}>{s.name}</td>
                      <td style={{ padding: '6px 8px', color: D.teal }}>{s.tier}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: D.green }}>${s.monthly_rate}</td>
                      <td style={{ padding: '6px 8px', color: D.muted }}>{s.start_date || '—'}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'center' }}>{s.has_card ? 'Yes' : <span style={{ color: D.red }}>No</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Post-Import Verification */}
      {results && !running && results.phases && (
        <div style={{ ...sCard, border: `1px solid ${D.green}44` }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: D.green }}>Post-Import Verification</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <div style={sStat}>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.teal }}>
                {(results.phases.customers?.created || 0) + (results.phases.customers?.updated || 0)}
              </div>
              <div style={{ fontSize: 11, color: D.muted }}>Customers Synced</div>
            </div>
            <div style={sStat}>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.amber }}>
                {results.phases.customers?.notesParsed || 0}
              </div>
              <div style={{ fontSize: 11, color: D.muted }}>Notes Parsed</div>
            </div>
            <div style={sStat}>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.green }}>
                {results.phases.subscriptions?.activeSubscriptions || 0}
              </div>
              <div style={{ fontSize: 11, color: D.muted }}>Active Subs</div>
            </div>
            <div style={sStat}>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.green }}>
                ${results.phases.subscriptions?.mrr || 0}
              </div>
              <div style={{ fontSize: 11, color: D.muted }}>MRR</div>
            </div>
            <div style={sStat}>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.red }}>
                {results.phases.refunds?.refundsFound || 0}
              </div>
              <div style={{ fontSize: 11, color: D.muted }}>Refunds Found</div>
            </div>
            <div style={sStat}>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.purple }}>
                {results.phases.refunds?.cardDetailsAdded || 0}
              </div>
              <div style={{ fontSize: 11, color: D.muted }}>Card Details</div>
            </div>
          </div>
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div style={sCard}>
          <div
            onClick={() => setShowErrors(!showErrors)}
            style={{ fontSize: 14, fontWeight: 600, color: D.red, cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
          >
            <span>Errors ({errors.length})</span>
            <span style={{ fontSize: 12 }}>{showErrors ? 'Hide' : 'Show'}</span>
          </div>
          {showErrors && (
            <div style={{ marginTop: 10, maxHeight: 300, overflowY: 'auto' }}>
              {errors.slice(0, 50).map((err, i) => (
                <div key={i} style={{ fontSize: 11, padding: '4px 0', borderBottom: `1px solid ${D.border}22`, color: D.muted }}>
                  <span style={{ color: D.red }}>{err.phase || err.name || err.squareId || err.bookingId || err.paymentId || err.invoiceId || 'Error'}</span>
                  {': '}{err.error || err.message || JSON.stringify(err)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </div>
  );
}
