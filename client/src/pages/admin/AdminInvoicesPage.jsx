import { useState, useEffect, useCallback, useRef } from 'react';
import { launchTapToPay } from '../../lib/tapToPay';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal/blue/purple fold to zinc-900. Semantic green/amber/red preserved.
// STATUS_COLORS folds cleanly — sent/viewed were both #0A7EC2 in V1, stay identical post-fold.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', purple: '#18181B', blue: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', input: '#FFFFFF', heading: '#09090B', inputBorder: '#D4D4D8' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sBtn = (bg, color, isMobile) => ({ padding: isMobile ? '12px 18px' : '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: isMobile ? 14 : 13, fontWeight: 600, cursor: 'pointer', minHeight: isMobile ? 44 : undefined, textTransform: 'uppercase', letterSpacing: '0.04em' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });
const sInput = (isMobile) => ({ width: '100%', padding: isMobile ? '12px 14px' : '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: isMobile ? 16 : 13, outline: 'none', boxSizing: 'border-box', minHeight: isMobile ? 44 : undefined });

const STATUS_COLORS = { draft: D.muted, sent: D.blue, viewed: D.teal, paid: D.green, overdue: D.red, void: D.muted };

export default function AdminInvoicesPage() {
  const [tab, setTab] = useState('list');
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState('');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const loadStats = useCallback(async () => {
    const s = await adminFetch('/admin/invoices/stats').catch(() => null);
    setStats(s);
  }, []);
  useEffect(() => { loadStats(); }, [loadStats]);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: isMobile ? '8px 4px 24px' : '0' }}>
      {/* Header — title + round add button (mirrors attached UI) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: isMobile ? '16px 16px 12px' : '4px 0 16px' }}>
        <h1 style={{ fontSize: isMobile ? 32 : 28, fontWeight: 700, color: D.heading, margin: 0, letterSpacing: '-0.01em' }}>Invoices</h1>
        <button
          onClick={() => setTab(tab === 'create' ? 'list' : 'create')}
          aria-label={tab === 'create' ? 'Back to invoices' : 'Create invoice'}
          style={{
            width: 44, height: 44, borderRadius: '50%', border: 'none',
            background: D.heading, color: D.white, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 24, fontWeight: 300, lineHeight: 1,
          }}
        >
          {tab === 'create' ? '×' : '+'}
        </button>
      </div>

      {tab === 'list' && <InvoiceList showToast={showToast} onRefresh={loadStats} isMobile={isMobile} stats={stats} />}
      {tab === 'create' && <CreateInvoice showToast={showToast} onCreated={() => { loadStats(); setTab('list'); }} isMobile={isMobile} />}

      <div style={{
        position: 'fixed',
        bottom: isMobile ? 'calc(72px + env(safe-area-inset-bottom, 0px))' : 20,
        right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>OK</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ── Filter pill with dropdown ──
function FilterPill({ label, value, options, onChange, isMobile }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const current = options.find(o => o.key === value) || options[0];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '10px 16px', borderRadius: 999,
          border: `1px solid ${D.border}`, background: D.card, color: D.text,
          fontSize: 14, fontWeight: 400, cursor: 'pointer',
          minHeight: 40, display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ color: D.muted }}>{label}</span>
        <span style={{ fontWeight: 700, color: D.heading }}>{current.label}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20,
          background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,0.08)', minWidth: 180, overflow: 'hidden',
        }}>
          {options.map(o => (
            <button
              key={o.key}
              onClick={() => { onChange(o.key); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: isMobile ? '12px 14px' : '10px 14px',
                border: 'none', background: o.key === value ? '#F4F4F5' : D.card,
                color: D.heading, fontSize: 14, cursor: 'pointer',
                fontWeight: o.key === value ? 600 : 400,
              }}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Invoice List (mirrors attached UI) ──
function InvoiceList({ showToast, onRefresh, isMobile, stats }) {
  const [invoices, setInvoices] = useState([]);
  const [filter, setFilter] = useState('all');
  const [datePeriod, setDatePeriod] = useState('all');
  const [sort, setSort] = useState('newest');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [batchSending, setBatchSending] = useState(false);
  const [receiptModalInvoice, setReceiptModalInvoice] = useState(null);
  const sendReceiptEnabled = useFeatureFlag('ff_invoice_send_receipt', true);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '100' });
    if (filter === 'overdue' || filter === 'draft') params.set('status', filter);
    if (filter === 'archived') params.set('archived', 'only');
    const data = await adminFetch(`/admin/invoices?${params}`).catch(() => ({ invoices: [] }));
    let rows = data.invoices || [];
    if (filter === 'unpaid') {
      rows = rows.filter(i => i.status !== 'paid' && i.status !== 'void');
    } else if (filter === 'paid') {
      rows = rows.filter(i => i.status === 'paid');
    } else if (filter === 'needs_receipt') {
      rows = rows.filter(i => i.status === 'paid' && !i.receipt_sent_at);
    }
    setInvoices(rows);
    setSelected(new Set());
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const handleSend = async (id) => {
    const res = await adminFetch(`/admin/invoices/${id}/send`, { method: 'POST' });
    const channels = [res?.sms?.ok && 'SMS', res?.email?.ok && 'email'].filter(Boolean);
    showToast(channels.length ? `Invoice sent (${channels.join(' + ')})` : 'Invoice send failed');
    load(); onRefresh();
  };

  const handleVoid = async (id) => {
    if (!confirm('Void this invoice?')) return;
    await adminFetch(`/admin/invoices/${id}/void`, { method: 'POST' });
    showToast('Invoice voided');
    load(); onRefresh();
  };

  const handleArchive = async (id) => {
    if (!confirm('Archive this voided invoice? It stays accessible under the Archived filter.')) return;
    const res = await adminFetch(`/admin/invoices/${id}/archive`, { method: 'POST' });
    if (res?.error) { showToast(res.error); return; }
    showToast('Invoice archived');
    load(); onRefresh();
  };

  const handleUnarchive = async (id) => {
    await adminFetch(`/admin/invoices/${id}/unarchive`, { method: 'POST' });
    showToast('Invoice restored');
    load(); onRefresh();
  };

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  // Under the Needs-receipt filter the selection target flips from
  // "invoices we can send" to "paid invoices that still owe a receipt".
  const receiptMode = filter === 'needs_receipt';
  const BATCH_RECEIPT_MAX = 25;
  const sendableInvoices = receiptMode
    ? invoices.filter(i => i.status === 'paid' && !i.receipt_sent_at)
    : invoices.filter(i => i.status === 'draft' || i.status === 'sent' || i.status === 'viewed');
  const selectAllSendable = () => setSelected(new Set(sendableInvoices.slice(0, receiptMode ? BATCH_RECEIPT_MAX : sendableInvoices.length).map(i => i.id)));
  const clearSelection = () => setSelected(new Set());
  const handleBatchSend = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (receiptMode) {
      if (ids.length > BATCH_RECEIPT_MAX) {
        showToast(`Pick at most ${BATCH_RECEIPT_MAX} receipts per batch`);
        return;
      }
      if (!confirm(`Send ${ids.length} receipt${ids.length === 1 ? '' : 's'} via SMS + email?`)) return;
    } else if (!confirm(`Send ${ids.length} invoice${ids.length === 1 ? '' : 's'} via SMS + email?`)) return;
    setBatchSending(true);
    try {
      const endpoint = receiptMode ? '/admin/invoices/batch/send-receipts' : '/admin/invoices/batch/send';
      const result = await adminFetch(endpoint, {
        method: 'POST', body: JSON.stringify({ invoiceIds: ids }),
      });
      const noun = receiptMode ? 'receipt' : 'invoice';
      showToast(`Sent ${result.sent_count} of ${result.total} ${noun}${result.total === 1 ? '' : 's'}${result.failed_count ? ` (${result.failed_count} failed)` : ''}`);
      clearSelection(); load(); onRefresh();
    } catch (err) {
      showToast(`Batch send failed: ${err.message}`);
    } finally { setBatchSending(false); }
  };

  const domain = typeof window !== 'undefined' ? window.location.origin : '';

  // Derive display status: overdue when unpaid + past due
  const getDisplayStatus = (inv) => {
    if (inv.status === 'paid') return { key: 'paid', label: 'Paid', color: D.green };
    if (inv.status === 'void') return { key: 'void', label: 'Void', color: D.muted };
    if (inv.status === 'draft') return { key: 'draft', label: 'Draft', color: D.muted };
    if (inv.due_date) {
      const due = new Date(inv.due_date + 'T23:59:59');
      if (Date.now() > due.getTime()) return { key: 'overdue', label: 'Overdue', color: D.red };
    }
    if (inv.status === 'overdue') return { key: 'overdue', label: 'Overdue', color: D.red };
    if (inv.status === 'viewed') return { key: 'viewed', label: 'Viewed', color: D.text };
    return { key: 'sent', label: 'Sent', color: D.text };
  };

  const getRowDate = (inv) => {
    const s = inv.service_date ? inv.service_date + 'T12:00:00' : inv.created_at;
    return new Date(s);
  };

  // Date-period filter
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const periodFloor = (() => {
    if (datePeriod === 'today') return startOfToday;
    if (datePeriod === '7d') return new Date(startOfToday.getTime() - 7 * 86400000);
    if (datePeriod === '30d') return new Date(startOfToday.getTime() - 30 * 86400000);
    if (datePeriod === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
    return null;
  })();

  const q = query.trim().toLowerCase();
  let rows = invoices.filter(inv => {
    if (periodFloor && getRowDate(inv) < periodFloor) return false;
    if (!q) return true;
    const hay = [
      inv.invoice_number, inv.first_name, inv.last_name,
      inv.title, `${inv.first_name || ''} ${inv.last_name || ''}`,
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });

  rows = [...rows].sort((a, b) => {
    if (sort === 'oldest') return getRowDate(a) - getRowDate(b);
    if (sort === 'amount_high') return parseFloat(b.total) - parseFloat(a.total);
    if (sort === 'amount_low') return parseFloat(a.total) - parseFloat(b.total);
    return getRowDate(b) - getRowDate(a);
  });

  // Group by day — date header matches "Saturday, April 18, 2026"
  const groups = [];
  const groupMap = new Map();
  for (const inv of rows) {
    const d = getRowDate(inv);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!groupMap.has(key)) {
      const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const g = { key, label, items: [] };
      groupMap.set(key, g);
      groups.push(g);
    }
    groupMap.get(key).items.push(inv);
  }

  const rowPad = isMobile ? '18px 16px' : '16px 18px';

  return (
    <div>
      {/* Search */}
      <div style={{ padding: isMobile ? '4px 16px 12px' : '4px 0 12px' }}>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', color: D.muted, fontSize: 16, pointerEvents: 'none' }}>⌕</span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search"
            style={{
              width: '100%', padding: '14px 18px 14px 44px',
              background: D.card, border: `1px solid ${D.border}`,
              borderRadius: 999, fontSize: 16, color: D.text,
              outline: 'none', boxSizing: 'border-box', minHeight: 48,
            }}
          />
        </div>
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 10, padding: isMobile ? '4px 16px 16px' : '4px 0 16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <FilterPill
          label="Filter"
          value={filter}
          onChange={setFilter}
          isMobile={isMobile}
          options={[
            { key: 'all', label: 'All' },
            { key: 'overdue', label: 'Overdue' },
            { key: 'unpaid', label: 'Unpaid' },
            { key: 'paid', label: 'Paid' },
            { key: 'needs_receipt', label: 'Needs receipt' },
            { key: 'draft', label: 'Draft' },
            { key: 'archived', label: 'Archived' },
          ]}
        />
        <FilterPill
          label="Date"
          value={datePeriod}
          onChange={setDatePeriod}
          isMobile={isMobile}
          options={[
            { key: 'all', label: 'All' },
            { key: 'today', label: 'Today' },
            { key: '7d', label: 'Last 7 days' },
            { key: '30d', label: 'Last 30 days' },
            { key: 'month', label: 'This month' },
          ]}
        />
        <FilterPill
          label="Sort"
          value={sort}
          onChange={setSort}
          isMobile={isMobile}
          options={[
            { key: 'newest', label: 'Newest' },
            { key: 'oldest', label: 'Oldest' },
            { key: 'amount_high', label: 'Amount ↓' },
            { key: 'amount_low', label: 'Amount ↑' },
          ]}
        />
        {sendableInvoices.length > 0 && (
          <button onClick={selectAllSendable} style={{
            padding: '10px 16px', borderRadius: 999, border: `1px solid ${D.border}`,
            background: D.card, color: D.muted, fontSize: 13, cursor: 'pointer',
          }}>
            {receiptMode
              ? `Select ${Math.min(sendableInvoices.length, BATCH_RECEIPT_MAX)} to receipt`
              : `Select sendable (${sendableInvoices.length})`}
          </button>
        )}
        {stats && !isMobile && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: D.muted }}>
            {stats.paid} paid · {stats.outstanding} outstanding · {stats.overdue} overdue
          </span>
        )}
      </div>

      {/* List */}
      {rows.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: D.muted, fontSize: 15 }}>No invoices match</div>
      ) : (
        <div style={{ background: D.card, borderTop: `1px solid ${D.border}`, borderBottom: `1px solid ${D.border}` }}>
          {groups.map(g => (
            <div key={g.key}>
              <div style={{
                padding: isMobile ? '16px 16px 10px' : '16px 18px 10px',
                fontSize: 15, fontWeight: 700, color: D.heading,
                borderBottom: `1px solid ${D.border}`,
              }}>{g.label}</div>
              {g.items.map(inv => {
                const lineItems = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : (inv.line_items || []);
                const canSelect = receiptMode
                  ? (inv.status === 'paid' && !inv.receipt_sent_at)
                  : (inv.status === 'draft' || inv.status === 'sent' || inv.status === 'viewed');
                const isSelected = selected.has(inv.id);
                const display = getDisplayStatus(inv);
                const isOpen = expanded === inv.id;
                const cardOnFile = inv.card_on_file && inv.card_on_file.last_four ? inv.card_on_file : null;
                return (
                  <div key={inv.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                    <button
                      onClick={() => setExpanded(isOpen ? null : inv.id)}
                      style={{
                        width: '100%', textAlign: 'left', border: 'none',
                        background: isSelected ? '#FAFAFA' : D.card,
                        padding: rowPad, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: 12,
                      }}
                    >
                      {canSelect && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(inv.id)}
                          onClick={e => e.stopPropagation()}
                          style={{ width: 18, height: 18, cursor: 'pointer', accentColor: D.heading }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 17, fontWeight: 700, color: D.heading, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {inv.first_name} {inv.last_name}
                        </div>
                        <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
                          #{inv.invoice_number}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 17, fontWeight: 700, color: D.heading, fontFamily: "'JetBrains Mono', monospace" }}>
                          ${parseFloat(inv.total).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: display.color, marginTop: 4 }}>
                          {display.label}
                        </div>
                      </div>
                      <span aria-hidden style={{ color: D.muted, fontSize: 18, marginLeft: 4, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                    </button>

                    {isOpen && (
                      <div style={{ padding: isMobile ? '0 16px 18px' : '0 18px 18px', background: '#FAFAFA', borderTop: `1px solid ${D.border}` }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '14px 0', fontSize: 13, color: D.muted }}>
                          <span>{inv.title || lineItems[0]?.description || 'Service'}</span>
                          {inv.waveguard_tier && <span style={sBadge(`${D.amber}22`, D.amber)}>{inv.waveguard_tier}</span>}
                          {cardOnFile && inv.status !== 'paid' && inv.status !== 'void' && (
                            <span>💳 {cardOnFile.brand || 'Card'} •{cardOnFile.last_four} on file</span>
                          )}
                        </div>

                        <InvoiceTimeline invoice={inv} />

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {inv.status === 'draft' && <button onClick={() => handleSend(inv.id)} style={sBtn(D.heading, D.white, isMobile)} title="Send invoice via SMS + email">Send</button>}
                          {(inv.status === 'sent' || inv.status === 'viewed') && <button onClick={() => handleSend(inv.id)} style={sBtn(D.heading, D.white, isMobile)} title="Resend invoice via SMS + email">Resend</button>}
                          {inv.status !== 'paid' && inv.status !== 'void' && (
                            <button onClick={() => { navigator.clipboard.writeText(`${domain}/pay/${inv.token}`); showToast('Pay link copied'); }} style={sBtn(D.card, D.text, isMobile)}>Copy Link</button>
                          )}
                          {inv.status !== 'paid' && inv.status !== 'void' && (
                            <button
                              onClick={async () => {
                                try { await launchTapToPay(inv.id); }
                                catch (e) { showToast(`Tap to Pay failed: ${e.message}`); }
                              }}
                              style={sBtn(D.heading, D.white, isMobile)}
                              title="Open Waves Tech app to tap customer's card/phone"
                            >Charge in person</button>
                          )}
                          {inv.status !== 'void' && inv.token && (
                            <a
                              href={inv.status === 'paid' ? `${API_BASE}/receipt/${inv.token}/pdf` : `${API_BASE}/pay/${inv.token}/invoice.pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ ...sBtn(D.card, D.text, isMobile), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                              title={inv.status === 'paid' ? 'Download the receipt PDF' : 'Download the invoice PDF'}
                            >
                              Download PDF
                            </a>
                          )}
                          {inv.status !== 'paid' && inv.status !== 'void' && <button onClick={() => handleVoid(inv.id)} style={sBtn('transparent', D.red, isMobile)}>Void</button>}
                          {inv.status === 'void' && !inv.archived_at && (
                            <button onClick={() => handleArchive(inv.id)} style={sBtn(D.heading, D.white, isMobile)} title="Tuck this voided invoice out of the default list">Archive</button>
                          )}
                          {inv.archived_at && (
                            <button onClick={() => handleUnarchive(inv.id)} style={sBtn('transparent', D.text, isMobile)} title="Restore to the default list">Unarchive</button>
                          )}
                          {sendReceiptEnabled && inv.status === 'paid' && (
                            <button
                              onClick={() => setReceiptModalInvoice(inv)}
                              style={sBtn(inv.receipt_sent_at ? D.card : D.heading, inv.receipt_sent_at ? D.text : D.white, isMobile)}
                              title={inv.receipt_sent_at ? 'Resend receipt + log another touch' : 'Email + SMS the receipt and close the service'}
                            >
                              {inv.receipt_sent_at ? 'Resend receipt' : 'Send receipt'}
                            </button>
                          )}
                        </div>

                        {inv.status !== 'paid' && inv.status !== 'void' && inv.status !== 'draft' && (
                          <FollowupPanel invoiceId={inv.id} showToast={showToast} isMobile={isMobile} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div style={{
          position: 'fixed',
          bottom: isMobile ? 'calc(72px + env(safe-area-inset-bottom, 0px))' : 20,
          left: '50%', transform: 'translateX(-50%)',
          background: D.heading, color: D.white, borderRadius: 10, padding: '12px 20px',
          display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.3)', zIndex: 50,
        }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{selected.size} selected</span>
          <button onClick={handleBatchSend} disabled={batchSending} style={{ ...sBtn(D.white, D.heading, isMobile), opacity: batchSending ? 0.6 : 1 }}>
            {batchSending
              ? 'Sending…'
              : receiptMode
                ? `Send ${selected.size} receipt${selected.size === 1 ? '' : 's'}`
                : `Send ${selected.size}`}
          </button>
          <button onClick={clearSelection} style={sBtn('transparent', D.white, isMobile)}>Clear</button>
        </div>
      )}

      {receiptModalInvoice && (
        <SendReceiptModal
          invoice={receiptModalInvoice}
          isMobile={isMobile}
          onClose={() => setReceiptModalInvoice(null)}
          onSent={() => { setReceiptModalInvoice(null); showToast('Receipt sent'); load(); onRefresh(); }}
          onError={(msg) => showToast(msg)}
        />
      )}
    </div>
  );
}

// ── Invoice activity timeline ──
// Reconstructed entirely from invoice row columns — no dedicated events table.
// Newest event on top so the current state is the first thing you read.
function buildInvoiceTimeline(inv) {
  const events = [];
  if (inv.sent_at || inv.sms_sent_at) {
    events.push({ kind: 'sent', at: inv.sent_at || inv.sms_sent_at, label: 'Invoice sent', detail: 'SMS + email', color: D.text });
  }
  if (inv.viewed_at) {
    const count = Number(inv.view_count) || 0;
    events.push({
      kind: 'viewed',
      at: inv.viewed_at,
      label: 'Customer opened the invoice',
      detail: count > 1 ? `${count} total views` : null,
      color: D.text,
    });
  }
  const reminderCount = Number(inv.sms_reminder_count) || 0;
  if (inv.last_reminder_at && reminderCount > 0) {
    events.push({
      kind: 'reminder',
      at: inv.last_reminder_at,
      label: reminderCount === 1 ? 'Reminder sent' : `Reminder sent (${reminderCount} total)`,
      color: D.amber,
    });
  }
  if (inv.paid_at) {
    const method = [inv.card_brand || inv.payment_method, inv.card_last_four ? `•${inv.card_last_four}` : null].filter(Boolean).join(' ');
    events.push({
      kind: 'paid',
      at: inv.paid_at,
      label: `Paid $${parseFloat(inv.total).toFixed(2)}`,
      detail: method || null,
      color: D.green,
      emphasis: true,
    });
  }
  if (inv.receipt_sent_at) {
    events.push({
      kind: 'receipt',
      at: inv.receipt_sent_at,
      label: 'Receipt sent',
      detail: inv.receipt_memo ? `“${inv.receipt_memo}”` : null,
      color: D.green,
    });
  }
  if (inv.status === 'void') {
    events.push({ kind: 'void', at: inv.updated_at, label: 'Voided', color: D.muted });
  }
  if (inv.archived_at) {
    events.push({ kind: 'archived', at: inv.archived_at, label: 'Archived', color: D.muted });
  }
  return events.sort((a, b) => new Date(b.at) - new Date(a.at));
}

function formatTimelineWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today at ${timeStr}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${timeStr}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

function InvoiceTimeline({ invoice }) {
  const events = buildInvoiceTimeline(invoice);
  if (events.length === 0) return null;
  return (
    <div style={{ margin: '4px 0 16px', paddingTop: 12, borderTop: `1px solid ${D.border}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: D.muted, textTransform: 'uppercase', marginBottom: 12 }}>
        Activity
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {events.map((e, i) => (
          <div key={`${e.kind}-${i}`} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{
              width: 8, height: 8, borderRadius: 999, background: e.color,
              marginTop: 6, flexShrink: 0,
              boxShadow: e.emphasis ? `0 0 0 3px ${e.color}22` : undefined,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: D.heading, fontWeight: e.emphasis ? 700 : 500, lineHeight: 1.3 }}>
                {e.label}
              </div>
              {e.detail && (
                <div style={{ fontSize: 13, color: D.muted, marginTop: 2, lineHeight: 1.35, wordBreak: 'break-word' }}>
                  {e.detail}
                </div>
              )}
              <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                {formatTimelineWhen(e.at)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Send Receipt Modal ──
// Per-invoice action for paid invoices. Memo is ephemeral (stored on the
// invoice row as receipt_memo for audit) — not a customer preference.
function SendReceiptModal({ invoice, isMobile, onClose, onSent, onError }) {
  const [memo, setMemo] = useState('');
  const [sendEmail, setSendEmail] = useState(!!invoice.email);
  const [sendSms, setSendSms] = useState(!!invoice.phone);
  const [sending, setSending] = useState(false);

  const hasEmail = !!invoice.email;
  const hasPhone = !!invoice.phone;
  const anyChannel = sendEmail || sendSms;

  const handleSend = async () => {
    if (!anyChannel || sending) return;
    const via = sendEmail && sendSms ? 'both' : sendEmail ? 'email' : 'sms';
    setSending(true);
    try {
      const res = await adminFetch(`/admin/invoices/${invoice.id}/send-receipt`, {
        method: 'POST',
        body: JSON.stringify({ memo: memo.trim() || undefined, via }),
      });
      if (!res.ok) {
        const detail = [res.email?.error, res.sms?.error].filter(Boolean).join(' · ') || 'Send failed';
        onError(`Receipt send failed: ${detail}`);
      } else {
        onSent();
      }
    } catch (err) {
      onError(`Receipt send failed: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 400,
        display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center',
        padding: isMobile ? 0 : 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card, borderRadius: isMobile ? '16px 16px 0 0' : 14,
          width: '100%', maxWidth: 440, padding: isMobile ? '24px 20px 28px' : 28,
          boxShadow: '0 20px 60px rgba(0,0,0,0.28)',
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 700, color: D.heading, marginBottom: 4 }}>
          Send receipt & close
        </div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 20 }}>
          Invoice #{invoice.invoice_number} · ${parseFloat(invoice.total).toFixed(2)} · {invoice.first_name} {invoice.last_name}
        </div>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: D.text, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Optional memo
        </label>
        <textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value.slice(0, 400))}
          placeholder="e.g. Left a spare trap in the garage — rebait in 2 weeks."
          rows={3}
          style={{ ...sInput(isMobile), resize: 'vertical', minHeight: 72, fontFamily: 'inherit' }}
        />
        <div style={{ fontSize: 11, color: D.muted, textAlign: 'right', marginTop: 4, marginBottom: 18 }}>
          {memo.length}/400
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: hasEmail ? 'pointer' : 'not-allowed', opacity: hasEmail ? 1 : 0.5 }}>
            <input type="checkbox" checked={sendEmail && hasEmail} disabled={!hasEmail} onChange={(e) => setSendEmail(e.target.checked)} style={{ width: 16, height: 16, accentColor: D.heading }} />
            <span style={{ fontSize: 14, color: D.text }}>
              Email {invoice.email ? <span style={{ color: D.muted }}>· {invoice.email}</span> : <span style={{ color: D.muted, fontStyle: 'italic' }}>· no email on file</span>}
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: hasPhone ? 'pointer' : 'not-allowed', opacity: hasPhone ? 1 : 0.5 }}>
            <input type="checkbox" checked={sendSms && hasPhone} disabled={!hasPhone} onChange={(e) => setSendSms(e.target.checked)} style={{ width: 16, height: 16, accentColor: D.heading }} />
            <span style={{ fontSize: 14, color: D.text }}>
              SMS {invoice.phone ? <span style={{ color: D.muted }}>· {invoice.phone}</span> : <span style={{ color: D.muted, fontStyle: 'italic' }}>· no phone on file</span>}
            </span>
          </label>
        </div>

        {invoice.receipt_sent_at && (
          <div style={{ marginTop: 14, padding: '10px 12px', background: '#FEF3C7', border: `1px solid ${D.amber}`, borderRadius: 8, fontSize: 12, color: D.text, lineHeight: 1.45 }}>
            A receipt was already sent on {new Date(invoice.receipt_sent_at).toLocaleString()}. Sending again logs a second touch.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} disabled={sending} style={sBtn('transparent', D.text, isMobile)}>Cancel</button>
          <button
            onClick={handleSend}
            disabled={!anyChannel || sending}
            style={{ ...sBtn(D.heading, D.white, isMobile), opacity: (!anyChannel || sending) ? 0.5 : 1 }}
          >
            {sending ? 'Sending…' : 'Send receipt'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create Invoice ──
function CreateInvoice({ showToast, onCreated, isMobile }) {
  const [customerQuery, setCustomerQuery] = useState('');
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [serviceRecords, setServiceRecords] = useState([]);
  const [selectedService, setSelectedService] = useState(null);
  const [lineItems, setLineItems] = useState([{ description: '', quantity: 1, unit_price: 0 }]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [sendAfterCreate, setSendAfterCreate] = useState(true);
  const [serviceSearchIdx, setServiceSearchIdx] = useState(null);
  const [serviceResults, setServiceResults] = useState([]);

  // Customer search
  useEffect(() => {
    if (customerQuery.length < 2) { setCustomers([]); return; }
    const t = setTimeout(() => {
      adminFetch(`/admin/invoices/customers/search?q=${encodeURIComponent(customerQuery)}`)
        .then(d => setCustomers(d.customers || []))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [customerQuery]);

  // Load service records when customer selected
  useEffect(() => {
    if (!selectedCustomer) { setServiceRecords([]); return; }
    adminFetch(`/admin/invoices/service-records/${selectedCustomer.id}`)
      .then(d => setServiceRecords(d.records || []))
      .catch(() => {});
  }, [selectedCustomer]);

  // Service library search for active line item
  useEffect(() => {
    if (serviceSearchIdx === null) { setServiceResults([]); return; }
    const q = lineItems[serviceSearchIdx]?.description || '';
    if (q.length < 2) { setServiceResults([]); return; }
    const t = setTimeout(() => {
      adminFetch(`/admin/services?search=${encodeURIComponent(q)}&is_active=true&limit=10`)
        .then(d => setServiceResults(d.services || []))
        .catch(() => setServiceResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [serviceSearchIdx, lineItems]);

  const pickService = (i, svc) => {
    const updated = [...lineItems];
    updated[i] = {
      ...updated[i],
      description: svc.name,
      unit_price: Number(svc.base_price) || updated[i].unit_price || 0,
    };
    setLineItems(updated);
    setServiceSearchIdx(null);
    setServiceResults([]);
  };

  const addLineItem = () => setLineItems([...lineItems, { description: '', quantity: 1, unit_price: 0 }]);
  const removeLineItem = (i) => setLineItems(lineItems.filter((_, idx) => idx !== i));
  const updateLineItem = (i, field, value) => {
    const updated = [...lineItems];
    updated[i] = { ...updated[i], [field]: field === 'description' ? value : parseFloat(value) || 0 };
    setLineItems(updated);
  };

  const subtotal = lineItems.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);
  const tierDiscount = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.18 }[selectedCustomer?.waveguard_tier] || 0;
  const discountAmt = subtotal * tierDiscount;
  const afterDiscount = subtotal - discountAmt;
  const isCommercial = selectedCustomer?.property_type === 'commercial' || selectedCustomer?.property_type === 'business';
  const taxRate = isCommercial ? 0.07 : 0;
  const tax = afterDiscount * taxRate;
  const total = afterDiscount + tax;

  const handleCreate = async () => {
    if (!selectedCustomer) { showToast('Select a customer'); return; }
    if (!lineItems.some(i => i.description && i.unit_price > 0)) { showToast('Add at least one line item'); return; }
    setSaving(true);

    try {
      const body = {
        customerId: selectedCustomer.id,
        serviceRecordId: selectedService?.id || null,
        lineItems: lineItems.filter(i => i.description && i.unit_price > 0).map(i => ({
          ...i, amount: i.quantity * i.unit_price,
        })),
        notes: notes || null,
      };

      const invoice = await adminFetch('/admin/invoices', { method: 'POST', body: JSON.stringify(body) });

      if (sendAfterCreate && invoice.id) {
        await adminFetch(`/admin/invoices/${invoice.id}/send`, { method: 'POST' });
        showToast(`Invoice created & sent: ${invoice.invoice_number}`);
      } else {
        showToast(`Invoice created: ${invoice.invoice_number} (draft)`);
      }
      onCreated();
    } catch (e) { showToast(`Error: ${e.message}`); }
    setSaving(false);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 320px', gap: 16 }}>
      {/* Left — Form */}
      <div>
        <div style={sCard}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>New Invoice</div>

          {/* Customer Search */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Customer</label>
            {selectedCustomer ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: D.input, borderRadius: 8, padding: '10px 12px', border: `1px solid ${D.teal}`, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ color: D.heading, fontWeight: 600 }}>{selectedCustomer.first_name} {selectedCustomer.last_name}</span>
                  <span style={{ color: D.muted, fontSize: 12, marginLeft: 8 }}>{selectedCustomer.phone}</span>
                  {selectedCustomer.waveguard_tier && <span style={{ ...sBadge(`${D.amber}22`, D.amber), marginLeft: 8 }}>{selectedCustomer.waveguard_tier}</span>}
                </div>
                <button onClick={() => { setSelectedCustomer(null); setSelectedService(null); setCustomerQuery(''); }} style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 18, padding: isMobile ? '10px 12px' : '4px 8px', minHeight: isMobile ? 44 : undefined, minWidth: isMobile ? 44 : undefined }}>x</button>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <input value={customerQuery} onChange={e => setCustomerQuery(e.target.value)} placeholder="Search by name, phone, or email..." style={sInput(isMobile)} />
                {customers.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, zIndex: 10, maxHeight: 200, overflow: 'auto', marginTop: 4 }}>
                    {customers.map(c => (
                      <div key={c.id} onClick={() => { setSelectedCustomer(c); setCustomers([]); setCustomerQuery(''); }}
                        style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 13 }}>
                        <span style={{ color: D.heading }}>{c.first_name} {c.last_name}</span>
                        <span style={{ color: D.muted, marginLeft: 8 }}>{c.phone}</span>
                        {c.waveguard_tier && <span style={{ ...sBadge(`${D.amber}22`, D.amber), marginLeft: 8 }}>{c.waveguard_tier}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Link to Service Record */}
          {serviceRecords.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Link to Service (optional -- pulls products, photos, tech notes)</label>
              <select value={selectedService?.id || ''} onChange={e => {
                const sr = serviceRecords.find(r => r.id === e.target.value);
                setSelectedService(sr || null);
                if (sr && lineItems.length === 1 && !lineItems[0].description) {
                  setLineItems([{ description: sr.service_type, quantity: 1, unit_price: 0 }]);
                }
              }} style={sInput(isMobile)}>
                <option value="">No service linked</option>
                {serviceRecords.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.service_type} -- {new Date(r.service_date + 'T12:00:00').toLocaleDateString()} -- {r.tech_name || 'Unknown tech'}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Line Items */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 8 }}>Line Items</label>
            {lineItems.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                <div style={{ position: 'relative', flex: isMobile ? '1 1 100%' : 3 }}>
                  <input
                    value={item.description}
                    onChange={e => updateLineItem(i, 'description', e.target.value)}
                    onFocus={() => setServiceSearchIdx(i)}
                    onBlur={() => setTimeout(() => { setServiceSearchIdx(prev => (prev === i ? null : prev)); }, 150)}
                    placeholder="Search service library or type custom..."
                    style={sInput(isMobile)}
                  />
                  {serviceSearchIdx === i && serviceResults.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, zIndex: 20, maxHeight: 240, overflow: 'auto', marginTop: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
                      {serviceResults.map(svc => (
                        <div
                          key={svc.id}
                          onMouseDown={e => { e.preventDefault(); pickService(i, svc); }}
                          style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}
                        >
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ color: D.heading, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{svc.name}</div>
                            {svc.short_name && svc.short_name !== svc.name && (
                              <div style={{ color: D.muted, fontSize: 11, marginTop: 2 }}>{svc.short_name}</div>
                            )}
                          </div>
                          {svc.base_price != null && Number(svc.base_price) > 0 && (
                            <span style={{ color: D.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, whiteSpace: 'nowrap' }}>
                              ${Number(svc.base_price).toFixed(2)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <input type="number" value={item.quantity} onChange={e => updateLineItem(i, 'quantity', e.target.value)}
                  min="1" style={{ ...sInput(isMobile), flex: isMobile ? '0 0 72px' : 0.5, textAlign: 'center' }} />
                <div style={{ position: 'relative', flex: 1 }}>
                  <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: D.muted, fontSize: isMobile ? 16 : 13 }}>$</span>
                  <input type="number" value={item.unit_price || ''} onChange={e => updateLineItem(i, 'unit_price', e.target.value)}
                    placeholder="0.00" step="0.01" style={{ ...sInput(isMobile), paddingLeft: 22 }} />
                </div>
                {lineItems.length > 1 && (
                  <button onClick={() => removeLineItem(i)} style={{ background: 'none', border: 'none', color: D.red, cursor: 'pointer', fontSize: 18, padding: isMobile ? '12px 12px' : '10px 4px', minHeight: isMobile ? 44 : undefined, minWidth: isMobile ? 44 : undefined }}>x</button>
                )}
              </div>
            ))}
            <button onClick={addLineItem} style={{ ...sBtn('transparent', D.teal, isMobile), padding: isMobile ? '12px 14px' : '6px 12px', fontSize: isMobile ? 14 : 12 }}>+ Add line item</button>
          </div>

          {/* Notes */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Notes (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Internal or customer-facing notes" style={{ ...sInput(isMobile), resize: 'vertical' }} />
          </div>

          {/* Send toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <input type="checkbox" checked={sendAfterCreate} onChange={e => setSendAfterCreate(e.target.checked)} id="send-toggle" />
            <label htmlFor="send-toggle" style={{ fontSize: 13, color: D.text }}>Send via SMS + email immediately after creating</label>
          </div>

          <button onClick={handleCreate} disabled={saving} style={{ ...sBtn(D.green, D.white, isMobile), width: '100%', padding: 14, minHeight: isMobile ? 48 : undefined, opacity: saving ? 0.5 : 1 }}>
            {saving ? 'Creating...' : sendAfterCreate ? 'Create & Send Invoice' : 'Create Draft'}
          </button>
        </div>
      </div>

      {/* Right — Preview */}
      <div style={{ position: isMobile ? 'relative' : 'sticky', top: 20, alignSelf: 'start' }}>
        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Preview</div>

          {lineItems.filter(i => i.description).map((item, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: D.text, marginBottom: 6 }}>
              <span>{item.description}{item.quantity > 1 ? ` x${item.quantity}` : ''}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>${(item.quantity * item.unit_price).toFixed(2)}</span>
            </div>
          ))}

          <div style={{ borderTop: `1px solid ${D.border}`, marginTop: 12, paddingTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: D.muted, marginBottom: 4 }}>
              <span>Subtotal</span><span>${subtotal.toFixed(2)}</span>
            </div>
            {discountAmt > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: D.green, marginBottom: 4 }}>
                <span>{selectedCustomer?.waveguard_tier} -{Math.round(tierDiscount * 100)}%</span><span>-${discountAmt.toFixed(2)}</span>
              </div>
            )}
            {tax > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: D.muted, marginBottom: 4 }}>
                <span>Tax ({Math.round(taxRate * 100)}%)</span><span>${tax.toFixed(2)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: D.heading, marginTop: 8, paddingTop: 8, borderTop: `2px solid ${D.teal}` }}>
              <span>Total</span><span>${total.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Follow-up Sequence Panel (per-invoice) ──
function FollowupPanel({ invoiceId, showToast, isMobile }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await adminFetch(`/admin/invoices/${invoiceId}/followup`).catch(() => null);
    setData(d);
  }, [invoiceId]);
  useEffect(() => { load(); }, [load]);

  const act = async (path, body) => {
    setBusy(true);
    try {
      await adminFetch(`/admin/invoices/${invoiceId}/followup/${path}`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      showToast('Done');
      await load();
    } catch {
      showToast('Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div style={{ marginTop: 10, fontSize: 12, color: D.muted }}>Loading follow-up…</div>;

  const seq = data.sequence;
  const steps = data.steps || [];

  const STATUS_COLOR = {
    active: D.green, paused: D.amber, stopped: D.muted,
    completed: D.muted, autopay_hold: D.teal,
  };

  const nextStep = seq ? steps[seq.step_index] : null;

  return (
    <div style={{ marginTop: 12, padding: 12, background: '#F8FAFC', border: `1px solid ${D.border}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Automated Follow-ups
        </div>
        {seq ? (
          <span style={sBadge(`${STATUS_COLOR[seq.status] || D.muted}22`, STATUS_COLOR[seq.status] || D.muted)}>
            {seq.status.replace('_', ' ')}
          </span>
        ) : (
          <span style={sBadge(`${D.muted}22`, D.muted)}>not scheduled</span>
        )}
      </div>

      {seq && (
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 10, lineHeight: 1.6 }}>
          <div>Touches sent: <b style={{ color: D.heading }}>{seq.touches_sent}</b> of {steps.length}</div>
          {nextStep && seq.next_touch_at && seq.status === 'active' && (
            <div>Next: <b style={{ color: D.heading }}>{nextStep.label}</b> on {new Date(seq.next_touch_at).toLocaleString()}</div>
          )}
          {seq.status === 'autopay_hold' && (
            <div>On autopay hold — will release after {data.autopayFailureThreshold} failed attempts ({seq.autopay_failures_observed} so far)</div>
          )}
          {seq.status === 'paused' && seq.paused_reason && <div>Paused: {seq.paused_reason}</div>}
          {seq.status === 'stopped' && seq.stopped_reason && <div>Stopped: {seq.stopped_reason}</div>}
          {seq.last_touch_at && <div>Last touch: {new Date(seq.last_touch_at).toLocaleString()}</div>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {seq && seq.status === 'active' && (
          <>
            <button disabled={busy} onClick={() => {
              const reason = prompt('Why pause? (e.g. "customer said they\'ll pay Friday")');
              if (reason !== null) act('pause', { reason });
            }} style={sBtn(D.amber, D.white, isMobile)}>Pause</button>
            <button disabled={busy} onClick={() => {
              if (confirm('Send the next follow-up SMS right now?')) act('send-now');
            }} style={sBtn(D.teal, D.white, isMobile)}>Send Next Now</button>
            <button disabled={busy} onClick={() => {
              const reason = prompt('Why stop? (e.g. "waived", "customer disputed")');
              if (reason !== null) act('stop', { reason });
            }} style={sBtn('transparent', D.red, isMobile)}>Stop</button>
          </>
        )}
        {seq && (seq.status === 'paused' || seq.status === 'autopay_hold') && (
          <>
            <button disabled={busy} onClick={() => act('resume')} style={sBtn(D.green, D.white, isMobile)}>Resume</button>
            <button disabled={busy} onClick={() => {
              if (confirm('Send the next follow-up SMS right now?')) act('send-now');
            }} style={sBtn(D.teal, D.white, isMobile)}>Send Now</button>
          </>
        )}
      </div>
    </div>
  );
}
