import { useState, useEffect, useCallback } from 'react';

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
const sBtn = (bg, color, isMobile) => ({ padding: isMobile ? '12px 18px' : '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: isMobile ? 14 : 13, fontWeight: 600, cursor: 'pointer', minHeight: isMobile ? 44 : undefined });
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
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 700, color: D.heading }}>Invoices</div>
        </div>
      </div>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)', gap: 10, marginBottom: 20 }}>
          {[
            { label: 'Total', value: stats.total, color: D.heading },
            { label: 'Paid', value: stats.paid, color: D.green },
            { label: 'Outstanding', value: stats.outstanding, color: D.amber },
            { label: 'Overdue', value: stats.overdue, color: D.red },
            { label: 'Collected', value: `$${stats.totalCollected?.toLocaleString()}`, color: D.green },
            { label: 'Outstanding $', value: `$${stats.totalOutstanding?.toLocaleString()}`, color: D.amber },
          ].map(s => (
            <div key={s.label} style={{ ...sCard, marginBottom: 0, textAlign: 'center', padding: isMobile ? 12 : 20 }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: isMobile ? 16 : 18, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}` }}>
        {[{ key: 'list', label: 'All Invoices' }, { key: 'create', label: 'Create Invoice' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: isMobile ? '14px 20px' : '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
            fontSize: isMobile ? 14 : 13, fontWeight: 500, minHeight: isMobile ? 44 : undefined,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'list' && <InvoiceList showToast={showToast} onRefresh={loadStats} isMobile={isMobile} />}
      {tab === 'create' && <CreateInvoice showToast={showToast} onCreated={() => { loadStats(); setTab('list'); }} isMobile={isMobile} />}

      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>OK</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ── Invoice List ──
function InvoiceList({ showToast, onRefresh, isMobile }) {
  const [invoices, setInvoices] = useState([]);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [batchSending, setBatchSending] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '50' });
    // Server-side: only forward filters that map to an exact status value
    if (filter === 'overdue' || filter === 'draft') params.set('status', filter);
    const data = await adminFetch(`/admin/invoices?${params}`).catch(() => ({ invoices: [] }));
    let rows = data.invoices || [];
    if (filter === 'unpaid') {
      rows = rows.filter(i => i.status !== 'paid' && i.status !== 'void');
    } else if (filter === 'paid_this_month') {
      const now = new Date();
      rows = rows.filter(i => {
        if (i.status !== 'paid' || !i.paid_at) return false;
        const d = new Date(i.paid_at);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      });
    }
    setInvoices(rows);
    setSelected(new Set());
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const handleSend = async (id) => {
    await adminFetch(`/admin/invoices/${id}/send`, { method: 'POST' });
    showToast('Invoice sent via SMS');
    load(); onRefresh();
  };

  const handleVoid = async (id) => {
    if (!confirm('Void this invoice?')) return;
    await adminFetch(`/admin/invoices/${id}/void`, { method: 'POST' });
    showToast('Invoice voided');
    load(); onRefresh();
  };

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const sendableInvoices = invoices.filter(i => i.status === 'draft' || i.status === 'sent' || i.status === 'viewed');
  const selectAllSendable = () => setSelected(new Set(sendableInvoices.map(i => i.id)));
  const clearSelection = () => setSelected(new Set());
  const handleBatchSend = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`Send ${ids.length} invoice${ids.length === 1 ? '' : 's'} via SMS?`)) return;
    setBatchSending(true);
    try {
      const result = await adminFetch('/admin/invoices/batch/send', {
        method: 'POST', body: JSON.stringify({ invoiceIds: ids }),
      });
      showToast(`Sent ${result.sent_count} of ${result.total}${result.failed_count ? ` (${result.failed_count} failed)` : ''}`);
      clearSelection(); load(); onRefresh();
    } catch (err) {
      showToast(`Batch send failed: ${err.message}`);
    } finally { setBatchSending(false); }
  };

  const domain = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {[
          { key: '', label: 'All' },
          { key: 'overdue', label: 'Overdue' },
          { key: 'unpaid', label: 'Unpaid' },
          { key: 'paid_this_month', label: 'Paid this month' },
          { key: 'draft', label: 'Draft' },
        ].map(f => {
          const active = filter === f.key;
          return (
            <button
              key={f.key || 'all'}
              onClick={() => setFilter(f.key)}
              style={{
                padding: isMobile ? '12px 14px' : '6px 12px', borderRadius: 6,
                border: `1px solid ${active ? D.teal : D.border}`,
                background: active ? D.teal : D.card, color: active ? D.white : D.text,
                fontSize: isMobile ? 14 : 12, fontWeight: 500, cursor: 'pointer',
                minHeight: isMobile ? 44 : undefined,
              }}
            >{f.label}</button>
          );
        })}
        {sendableInvoices.length > 0 && (
          <button onClick={selectAllSendable} style={{ ...sBtn(D.border, D.text, isMobile), padding: isMobile ? '12px 14px' : '6px 12px', fontSize: isMobile ? 14 : 12 }}>
            Select all sendable ({sendableInvoices.length})
          </button>
        )}
      </div>

      {invoices.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No invoices yet</div>
      ) : invoices.map(inv => {
        const lineItems = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : (inv.line_items || []);
        const canSelect = inv.status === 'draft' || inv.status === 'sent' || inv.status === 'viewed';
        const isSelected = selected.has(inv.id);

        // Aging — derived from due_date for unpaid invoices
        let agingChip = null;
        if (inv.due_date && inv.status !== 'paid' && inv.status !== 'void' && inv.status !== 'draft') {
          const due = new Date(inv.due_date + 'T23:59:59');
          const diffDays = Math.floor((Date.now() - due.getTime()) / 86400000);
          if (diffDays > 0) {
            const tone = diffDays >= 30 ? D.red : diffDays >= 15 ? D.amber : D.muted;
            agingChip = { text: `${diffDays}d overdue`, color: tone };
          } else if (diffDays >= -3) {
            agingChip = { text: diffDays === 0 ? 'Due today' : `Due in ${-diffDays}d`, color: D.amber };
          }
        }

        const cardOnFile = inv.card_on_file && inv.card_on_file.last_four ? inv.card_on_file : null;
        const reminderCount = inv.sms_reminder_count || 0;
        return (
          <div key={inv.id} style={{ ...sCard, marginBottom: 8, borderColor: isSelected ? D.teal : D.border }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'flex-start', marginBottom: 8, flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 8 : 0 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flex: 1 }}>
                {canSelect && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(inv.id)}
                    style={{ marginTop: 4, width: 18, height: 18, cursor: 'pointer', accentColor: D.teal }}
                  />
                )}
                <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{inv.invoice_number}</span>
                  <span style={sBadge(`${STATUS_COLORS[inv.status]}22`, STATUS_COLORS[inv.status])}>
                    {inv.status}
                  </span>
                  {inv.waveguard_tier && <span style={sBadge(`${D.amber}22`, D.amber)}>{inv.waveguard_tier}</span>}
                  {agingChip && <span style={sBadge(`${agingChip.color}22`, agingChip.color)}>{agingChip.text}</span>}
                </div>
                <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>
                  {inv.first_name} {inv.last_name} -- {inv.title || lineItems[0]?.description || 'Service'}
                </div>
                </div>
              </div>
              <div style={{ textAlign: isMobile ? 'left' : 'right' }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: inv.status === 'paid' ? D.green : D.heading }}>
                  ${parseFloat(inv.total).toFixed(2)}
                </div>
                <div style={{ fontSize: 11, color: D.muted }}>
                  {inv.service_date ? new Date(inv.service_date + 'T12:00:00').toLocaleDateString() : new Date(inv.created_at).toLocaleDateString()}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {inv.status === 'draft' && <button onClick={() => handleSend(inv.id)} style={sBtn(D.teal, D.white, isMobile)}>Send SMS</button>}
              {(inv.status === 'sent' || inv.status === 'viewed') && <button onClick={() => handleSend(inv.id)} style={sBtn(D.blue, D.white, isMobile)}>Resend</button>}
              {inv.status !== 'paid' && inv.status !== 'void' && (
                <button onClick={() => { navigator.clipboard.writeText(`${domain}/pay/${inv.token}`); showToast('Pay link copied'); }} style={sBtn(D.border, D.muted, isMobile)}>Copy Link</button>
              )}
              {inv.status !== 'paid' && inv.status !== 'void' && (
                <button
                  onClick={() => { window.location.href = `waves-tap://charge?invoice_id=${inv.id}&amount=${Math.round(Number(inv.total) * 100)}`; }}
                  style={sBtn(D.purple, D.white, isMobile)}
                  title="Open Waves Tech app to tap customer's card/phone"
                >Charge in person</button>
              )}
              {inv.status !== 'paid' && inv.status !== 'void' && <button onClick={() => handleVoid(inv.id)} style={sBtn('transparent', D.red, isMobile)}>Void</button>}
              {inv.status !== 'paid' && inv.status !== 'void' && inv.status !== 'draft' && (
                <button onClick={() => setExpanded(expanded === inv.id ? null : inv.id)} style={sBtn(D.border, D.muted, isMobile)}>
                  {expanded === inv.id ? '▾ Hide' : '▸ Follow-ups'}
                </button>
              )}
              {inv.view_count > 0 && <span style={{ fontSize: 11, color: D.muted }}>{inv.view_count} views</span>}
              {reminderCount > 0 && (
                <span style={{ fontSize: 11, color: D.amber }} title="SMS reminders sent so far">
                  ↩ {reminderCount} reminder{reminderCount === 1 ? '' : 's'}
                </span>
              )}
              {inv.status === 'paid' && (inv.payment_method || inv.card_brand) && (
                <span style={{ fontSize: 11, color: D.green }} title="Paid via">
                  ✓ {inv.card_brand ? `${inv.card_brand}` : (inv.payment_method || 'paid')}
                  {inv.card_last_four ? ` •${inv.card_last_four}` : ''}
                  {inv.payment_method && inv.payment_method !== 'card' ? ` (${inv.payment_method.replace('_', ' ')})` : ''}
                </span>
              )}
              {cardOnFile && inv.status !== 'paid' && inv.status !== 'void' && (
                <span style={{ fontSize: 11, color: D.teal }} title="Default card on file for this customer">
                  💳 {cardOnFile.brand || 'Card'} •{cardOnFile.last_four}
                </span>
              )}
              {inv.sms_sent_at && <span style={{ fontSize: 11, color: D.muted }}>SMS: {new Date(inv.sms_sent_at).toLocaleString()}</span>}
            </div>

            {expanded === inv.id && (
              <FollowupPanel invoiceId={inv.id} showToast={showToast} isMobile={isMobile} />
            )}
          </div>
        );
      })}

      {selected.size > 0 && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: D.heading, color: D.white, borderRadius: 10, padding: '12px 20px',
          display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.3)', zIndex: 50,
        }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{selected.size} selected</span>
          <button onClick={handleBatchSend} disabled={batchSending} style={{ ...sBtn(D.teal, D.white, isMobile), opacity: batchSending ? 0.6 : 1 }}>
            {batchSending ? 'Sending…' : `Send ${selected.size} via SMS`}
          </button>
          <button onClick={clearSelection} style={sBtn('transparent', D.white, isMobile)}>Clear</button>
        </div>
      )}
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
            <label htmlFor="send-toggle" style={{ fontSize: 13, color: D.text }}>Send via SMS immediately after creating</label>
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
