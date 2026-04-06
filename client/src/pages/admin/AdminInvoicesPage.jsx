import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', blue: '#2563eb', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });
const sInput = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

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
          <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 700, color: D.white }}>Invoices</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>Waves-branded invoices with service recap and tap-to-pay</div>
        </div>
      </div>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)', gap: 10, marginBottom: 20 }}>
          {[
            { label: 'Total', value: stats.total, color: D.white },
            { label: 'Paid', value: stats.paid, color: D.green },
            { label: 'Outstanding', value: stats.outstanding, color: D.amber },
            { label: 'Overdue', value: stats.overdue, color: D.red },
            { label: 'Collected', value: `$${stats.totalCollected?.toLocaleString()}`, color: D.green },
            { label: 'Outstanding $', value: `$${stats.totalOutstanding?.toLocaleString()}`, color: D.amber },
          ].map(s => (
            <div key={s.label} style={{ ...sCard, marginBottom: 0, textAlign: 'center', padding: isMobile ? 12 : 20 }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: isMobile ? 14 : 18, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}` }}>
        {[{ key: 'list', label: 'All Invoices' }, { key: 'create', label: 'Create Invoice' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
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

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '50' });
    if (filter) params.set('status', filter);
    const data = await adminFetch(`/admin/invoices?${params}`).catch(() => ({ invoices: [] }));
    setInvoices(data.invoices || []);
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

  const domain = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <select value={filter} onChange={e => setFilter(e.target.value)} style={{ ...sInput, width: 160 }}>
          <option value="">All Status</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="viewed">Viewed</option>
          <option value="paid">Paid</option>
          <option value="overdue">Overdue</option>
        </select>
      </div>

      {invoices.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No invoices yet</div>
      ) : invoices.map(inv => {
        const lineItems = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : (inv.line_items || []);
        return (
          <div key={inv.id} style={{ ...sCard, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'flex-start', marginBottom: 8, flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 8 : 0 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{inv.invoice_number}</span>
                  <span style={sBadge(`${STATUS_COLORS[inv.status]}22`, STATUS_COLORS[inv.status])}>
                    {inv.status}
                  </span>
                  {inv.waveguard_tier && <span style={sBadge(`${D.amber}22`, D.amber)}>{inv.waveguard_tier}</span>}
                </div>
                <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>
                  {inv.first_name} {inv.last_name} -- {inv.title || lineItems[0]?.description || 'Service'}
                </div>
              </div>
              <div style={{ textAlign: isMobile ? 'left' : 'right' }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: inv.status === 'paid' ? D.green : D.white }}>
                  ${parseFloat(inv.total).toFixed(2)}
                </div>
                <div style={{ fontSize: 10, color: D.muted }}>
                  {inv.service_date ? new Date(inv.service_date + 'T12:00:00').toLocaleDateString() : new Date(inv.created_at).toLocaleDateString()}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {inv.status === 'draft' && <button onClick={() => handleSend(inv.id)} style={sBtn(D.teal, D.white)}>Send SMS</button>}
              {(inv.status === 'sent' || inv.status === 'viewed') && <button onClick={() => handleSend(inv.id)} style={sBtn(D.blue, D.white)}>Resend</button>}
              {inv.status !== 'paid' && inv.status !== 'void' && (
                <button onClick={() => { navigator.clipboard.writeText(`${domain}/pay/${inv.token}`); showToast('Pay link copied'); }} style={sBtn(D.border, D.muted)}>Copy Link</button>
              )}
              {inv.status !== 'paid' && inv.status !== 'void' && <button onClick={() => handleVoid(inv.id)} style={sBtn('transparent', D.red)}>Void</button>}
              {inv.view_count > 0 && <span style={{ fontSize: 10, color: D.muted }}>{inv.view_count} views</span>}
              {inv.sms_sent_at && <span style={{ fontSize: 10, color: D.muted }}>SMS: {new Date(inv.sms_sent_at).toLocaleString()}</span>}
            </div>
          </div>
        );
      })}
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

  const addLineItem = () => setLineItems([...lineItems, { description: '', quantity: 1, unit_price: 0 }]);
  const removeLineItem = (i) => setLineItems(lineItems.filter((_, idx) => idx !== i));
  const updateLineItem = (i, field, value) => {
    const updated = [...lineItems];
    updated[i] = { ...updated[i], [field]: field === 'description' ? value : parseFloat(value) || 0 };
    setLineItems(updated);
  };

  const subtotal = lineItems.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);
  const tierDiscount = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.20 }[selectedCustomer?.waveguard_tier] || 0;
  const discountAmt = subtotal * tierDiscount;
  const afterDiscount = subtotal - discountAmt;
  const tax = afterDiscount * 0.07;
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
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>New Invoice</div>

          {/* Customer Search */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Customer</label>
            {selectedCustomer ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: D.input, borderRadius: 8, padding: '10px 12px', border: `1px solid ${D.teal}`, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ color: D.white, fontWeight: 600 }}>{selectedCustomer.first_name} {selectedCustomer.last_name}</span>
                  <span style={{ color: D.muted, fontSize: 12, marginLeft: 8 }}>{selectedCustomer.phone}</span>
                  {selectedCustomer.waveguard_tier && <span style={{ ...sBadge(`${D.amber}22`, D.amber), marginLeft: 8 }}>{selectedCustomer.waveguard_tier}</span>}
                </div>
                <button onClick={() => { setSelectedCustomer(null); setSelectedService(null); setCustomerQuery(''); }} style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 16 }}>x</button>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <input value={customerQuery} onChange={e => setCustomerQuery(e.target.value)} placeholder="Search by name, phone, or email..." style={sInput} />
                {customers.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, zIndex: 10, maxHeight: 200, overflow: 'auto', marginTop: 4 }}>
                    {customers.map(c => (
                      <div key={c.id} onClick={() => { setSelectedCustomer(c); setCustomers([]); setCustomerQuery(''); }}
                        style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 13 }}>
                        <span style={{ color: D.white }}>{c.first_name} {c.last_name}</span>
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
              }} style={sInput}>
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
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                <input value={item.description} onChange={e => updateLineItem(i, 'description', e.target.value)}
                  placeholder="Service description" style={{ ...sInput, flex: isMobile ? '1 1 100%' : 3 }} />
                <input type="number" value={item.quantity} onChange={e => updateLineItem(i, 'quantity', e.target.value)}
                  min="1" style={{ ...sInput, flex: isMobile ? '0 0 60px' : 0.5, textAlign: 'center' }} />
                <div style={{ position: 'relative', flex: 1 }}>
                  <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: D.muted, fontSize: 13 }}>$</span>
                  <input type="number" value={item.unit_price || ''} onChange={e => updateLineItem(i, 'unit_price', e.target.value)}
                    placeholder="0.00" step="0.01" style={{ ...sInput, paddingLeft: 22 }} />
                </div>
                {lineItems.length > 1 && (
                  <button onClick={() => removeLineItem(i)} style={{ background: 'none', border: 'none', color: D.red, cursor: 'pointer', fontSize: 16 }}>x</button>
                )}
              </div>
            ))}
            <button onClick={addLineItem} style={{ ...sBtn('transparent', D.teal), padding: '6px 12px', fontSize: 12 }}>+ Add line item</button>
          </div>

          {/* Notes */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Notes (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Internal or customer-facing notes" style={{ ...sInput, resize: 'vertical' }} />
          </div>

          {/* Send toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <input type="checkbox" checked={sendAfterCreate} onChange={e => setSendAfterCreate(e.target.checked)} id="send-toggle" />
            <label htmlFor="send-toggle" style={{ fontSize: 13, color: D.text }}>Send via SMS immediately after creating</label>
          </div>

          <button onClick={handleCreate} disabled={saving} style={{ ...sBtn(D.green, D.white), width: '100%', padding: 14, opacity: saving ? 0.5 : 1 }}>
            {saving ? 'Creating...' : sendAfterCreate ? 'Create & Send Invoice' : 'Create Draft'}
          </button>
        </div>
      </div>

      {/* Right — Preview */}
      <div style={{ position: isMobile ? 'relative' : 'sticky', top: 20, alignSelf: 'start' }}>
        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Preview</div>

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
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: D.muted, marginBottom: 4 }}>
              <span>Tax (7%)</span><span>${tax.toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: D.white, marginTop: 8, paddingTop: 8, borderTop: `2px solid ${D.teal}` }}>
              <span>Total</span><span>${total.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
