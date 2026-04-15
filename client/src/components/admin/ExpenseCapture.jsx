import React, { useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';

/**
 * ExpenseCapture
 *
 * Inline expense/receipt capture for a scheduled_service. Uploads a photo of
 * the receipt, posts the expense row. Used inside the completion modal or
 * standalone on a stop detail screen.
 *
 * Props:
 *   scheduledServiceId  — UUID
 *   customerId          — UUID (optional)
 *   technicianId        — UUID (optional)
 *   onSaved             — (expenseRow) => void
 *   dark                — boolean (default true)
 */
export default function ExpenseCapture({ scheduledServiceId, customerId, technicianId, onSaved, dark = true }) {
  const P = dark
    ? { bg: '#1e293b', border: '#334155', text: '#e2e8f0', muted: '#94a3b8', accent: '#0ea5e9', input: '#0f1923' }
    : { bg: '#fff', border: '#cbd5e1', text: '#0f172a', muted: '#64748b', accent: '#0A7EC2', input: '#f8fafc' };

  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('company_card');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const input = {
    width: '100%', background: P.input, color: P.text, border: `1px solid ${P.border}`,
    borderRadius: 8, padding: '8px 10px', fontSize: 13, boxSizing: 'border-box',
  };
  const label = { display: 'block', fontSize: 12, fontWeight: 600, color: P.text, marginBottom: 4 };

  async function handleSave() {
    if (!amount || Number(amount) <= 0) return setError('Enter an amount');
    if (!scheduledServiceId) return setError('Missing job reference');
    setUploading(true);
    setError(null);
    try {
      let receipt_s3_key = null;
      if (file) {
        const fd = new FormData();
        fd.append('receipt', file);
        const up = await adminFetch('/admin/job-expenses/receipt-upload', {
          method: 'POST',
          body: fd,
          headers: {}, // let browser set multipart boundary
        });
        const upData = await up.json();
        if (!up.ok) throw new Error(upData?.error || 'Upload failed');
        receipt_s3_key = upData.receipt_s3_key;
      }

      const r = await adminFetch('/admin/job-expenses', {
        method: 'POST',
        body: JSON.stringify({
          scheduled_service_id: scheduledServiceId,
          customer_id: customerId || null,
          technician_id: technicianId || null,
          amount: Number(amount),
          description: description || 'Job expense',
          vendor_name: vendor || null,
          payment_method: paymentMethod,
          receipt_s3_key,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || 'Save failed');

      setSaved(true);
      setAmount(''); setDescription(''); setVendor(''); setFile(null);
      if (onSaved) onSaved(data.expense);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ background: P.bg, border: `1px solid ${P.border}`, borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: P.text, marginBottom: 10 }}>Add Receipt / Expense</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={label}>Amount *</label>
          <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} style={input} placeholder="0.00" />
        </div>
        <div>
          <label style={label}>Payment Method</label>
          <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} style={input}>
            <option value="company_card">Company card</option>
            <option value="personal_card">Personal card (reimburse)</option>
            <option value="cash">Cash</option>
            <option value="check">Check</option>
          </select>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <label style={label}>Vendor</label>
        <input type="text" value={vendor} onChange={e => setVendor(e.target.value)} style={input} placeholder="Home Depot, Site One, etc." />
      </div>

      <div style={{ marginTop: 10 }}>
        <label style={label}>Description</label>
        <input type="text" value={description} onChange={e => setDescription(e.target.value)} style={input} placeholder="What was purchased" />
      </div>

      <div style={{ marginTop: 10 }}>
        <label style={label}>Receipt Photo</label>
        <input type="file" accept="image/*,.pdf" capture="environment"
          onChange={e => setFile(e.target.files?.[0] || null)}
          style={{ ...input, padding: 6 }} />
        {file && <div style={{ fontSize: 11, color: P.muted, marginTop: 4 }}>{file.name} · {(file.size / 1024).toFixed(0)} KB</div>}
      </div>

      {error && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{error}</div>}
      {saved && <div style={{ fontSize: 12, color: '#10b981', marginTop: 8 }}>Saved ✓</div>}

      <button
        onClick={handleSave} disabled={uploading}
        style={{
          marginTop: 12, width: '100%', padding: '10px 12px', borderRadius: 8,
          background: uploading ? P.muted : P.accent, color: '#fff',
          border: 'none', fontSize: 13, fontWeight: 700, cursor: uploading ? 'default' : 'pointer',
        }}
      >
        {uploading ? 'Saving…' : 'Save Expense'}
      </button>
    </div>
  );
}
