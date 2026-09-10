import { useState } from 'react';
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import { getAdminAuthToken } from '../../lib/adminAuth';

const API = import.meta.env.VITE_API_URL || '/api';

const SERVICE_TYPES = ['Pest', 'Lawn', 'Termite', 'Mosquito', 'Tree & Shrub', 'Other'];

export default function FieldLeadModal({ service, onClose, onSubmit }) {
  const isMobile = useIsMobile();
  const dialogRef = useModalFocus(true, onClose);
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
      const token = getAdminAuthToken();
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

  return createPortal(
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Flag Opportunity" style={{
      position: 'fixed', inset: 0, zIndex: 9999, fontFamily: '"DM Sans", Inter, system-ui, sans-serif',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.5)',
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: isMobile ? 0 : 16, width: isMobile ? '100%' : '90%', maxWidth: isMobile ? 'none' : 420,
          height: isMobile ? '100%' : undefined, maxHeight: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, padding: '16px 24px' }}>
          <h3 style={{ margin: 0, fontSize: 18, color: '#1e293b' }}>Flag Opportunity</h3>
          <button aria-label="Close" onClick={onClose} style={{ minWidth: 44, minHeight: 44, background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#94a3b8' }}>&times;</button>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>&#10003;</div>
            <div style={{ fontSize: 16, color: '#10b981', fontWeight: 600 }}>Lead submitted!</div>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 24px' }}>
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


            </div>
            <div style={{ flexShrink: 0, padding: '14px 24px 24px' }}>
            {error && <div role="alert" style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}
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
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
