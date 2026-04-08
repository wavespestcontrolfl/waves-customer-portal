import { useState } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';

const SERVICE_TYPES = ['Pest', 'Lawn', 'Termite', 'Mosquito', 'Tree & Shrub', 'Other'];

export default function FieldLeadModal({ service, onClose, onSubmit }) {
  const [serviceType, setServiceType] = useState('');
  const [notes, setNotes] = useState('');
  const [urgency, setUrgency] = useState('normal');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const customerName = service?.customerName || `${service?.first_name || ''} ${service?.last_name || ''}`.trim() || 'Unknown';
  const address = service?.address || service?.address_line1 || '';

  const handleSubmit = async () => {
    if (!serviceType) { setError('Please select a service type'); return; }
    setSubmitting(true);
    setError('');
    try {
      const token = localStorage.getItem('adminToken');
      const r = await fetch(`${API}/tech/field-lead`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: service?.customer_id || service?.customerId,
          leadServiceType: serviceType,
          notes,
          urgency,
        }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Failed'); }
      setSuccess(true);
      if (onSubmit) onSubmit();
      setTimeout(() => onClose(), 1500);
    } catch (err) {
      setError(err.message);
    }
    setSubmitting(false);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.5)',
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, width: '90%', maxWidth: 420,
          padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 18, color: '#1e293b' }}>Flag Opportunity</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#94a3b8' }}>&times;</button>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>&#10003;</div>
            <div style={{ fontSize: 16, color: '#10b981', fontWeight: 600 }}>Lead submitted!</div>
          </div>
        ) : (
          <>
            {/* Customer info */}
            <div style={{ background: '#f1f5f9', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>{customerName}</div>
              {address && <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{address}</div>}
            </div>

            {/* Service type */}
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Service Type</label>
            <select
              value={serviceType} onChange={e => setServiceType(e.target.value)}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1',
                fontSize: 14, color: '#1e293b', marginBottom: 14, background: '#fff',
              }}
            >
              <option value="">Select service...</option>
              {SERVICE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            {/* Notes */}
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Notes</label>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="What did you observe?"
              rows={3}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1',
                fontSize: 14, color: '#1e293b', marginBottom: 14, resize: 'vertical', fontFamily: 'inherit',
              }}
            />

            {/* Urgency */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              {['normal', 'high'].map(u => (
                <button key={u} onClick={() => setUrgency(u)} style={{
                  flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  border: urgency === u ? 'none' : '1px solid #cbd5e1', cursor: 'pointer',
                  background: urgency === u ? (u === 'high' ? '#ef4444' : '#0ea5e9') : '#fff',
                  color: urgency === u ? '#fff' : '#64748b',
                }}>
                  {u === 'high' ? 'Urgent' : 'Normal'}
                </button>
              ))}
            </div>

            {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}

            <button
              onClick={handleSubmit} disabled={submitting}
              style={{
                width: '100%', padding: 14, borderRadius: 10, border: 'none',
                background: '#0ea5e9', color: '#fff', fontSize: 15, fontWeight: 700,
                cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? 'Submitting...' : 'Submit Lead'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
