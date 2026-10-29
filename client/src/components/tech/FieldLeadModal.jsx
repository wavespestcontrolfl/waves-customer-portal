import { useState } from 'react';
import { useFieldPortalClass } from './fieldPortal';
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

const API = import.meta.env.VITE_API_URL || '/api';

const SERVICE_TYPES = ['Pest', 'Lawn', 'Termite', 'Mosquito', 'Tree & Shrub', 'Other'];

// GATE_COMMISSION_SOLD_BY (owner 2026-10-29, D5 part 3b-1): a "Neighbor" flag for a new customer,
// and the visit id so the server can check the truck GPS. Both exist only while the gate is on.
const EMPTY_PROSPECT = { firstName: '', lastName: '', phone: '', address: '', city: '', zip: '' };
const PROSPECT_FIELDS = [
  ['firstName', 'First name', 'given-name'],
  ['lastName', 'Last name', 'family-name'],
  ['phone', 'Phone', 'tel'],
  ['address', 'Address', 'street-address'],
  ['city', 'City', 'address-level2'],
  ['zip', 'ZIP', 'postal-code'],
];
const prospectInputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 4, border: '1px solid #d6d3d1',
  fontSize: 14, color: '#1c1917', marginBottom: 10, background: '#fff', boxSizing: 'border-box',
};

// Gate off: exactly the body the modal always sent.
function buildLeadBody({ neighbor, neighborEnabled, service, serviceType, notes, urgency, prospect }) {
  const base = { leadServiceType: serviceType, notes, urgency };
  if (neighbor) return { ...base, prospect };
  const body = { customerId: service?.customer_id || service?.customerId, ...base };
  return neighborEnabled ? { ...body, scheduledServiceId: service?.id } : body;
}

function prospectProblem(neighbor, prospect) {
  if (!neighbor) return '';
  const missing = ['firstName', 'phone', 'address', 'zip'].some((key) => !prospect[key].trim());
  return missing ? 'First name, phone, address and ZIP are required' : '';
}

// The customer card, or with the gate on a choice between this visit and a Neighbor.
function LeadWho({ neighborEnabled, mode, onMode, prospect, onProspect, customerName, address }) {
  return (
    <>
      {neighborEnabled && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {[['visit', 'This visit'], ['neighbor', 'Neighbor']].map(([key, label]) => (
            <button key={key} type="button" onClick={() => onMode(key)} aria-pressed={mode === key} style={{
              flex: 1, padding: '8px 0', borderRadius: 4, fontSize: 13, fontWeight: 500,
              border: mode === key ? 'none' : '1px solid #d6d3d1', cursor: 'pointer',
              background: mode === key ? '#1c1917' : '#fff',
              color: mode === key ? '#fff' : '#57534e',
            }}>{label}</button>
          ))}
        </div>
      )}
      {neighborEnabled && mode === 'neighbor' ? (
        <div style={{ marginBottom: 6 }}>
          {PROSPECT_FIELDS.map(([key, label, autoComplete]) => (
            <input
              key={key} aria-label={label} placeholder={label} autoComplete={autoComplete}
              inputMode={key === 'phone' ? 'tel' : undefined}
              value={prospect[key]} onChange={e => onProspect(p => ({ ...p, [key]: e.target.value }))}
              style={prospectInputStyle}
            />
          ))}
        </div>
      ) : (
        /* Customer info */
        <div style={{ background: '#fafaf9', border: '0.5px solid #e7e5e4', borderRadius: 6, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: '#1c1917' }}>{customerName}</div>
          {address && <div style={{ fontSize: 13, color: '#57534e', marginTop: 2 }}>{address}</div>}
        </div>
      )}
    </>
  );
}

export default function FieldLeadModal({ service, onClose, onSubmit }) {
  const fieldPortalClass = useFieldPortalClass();
  const isMobile = useIsMobile();
  const dialogRef = useModalFocus(true, onClose);
  const [serviceType, setServiceType] = useState('');
  const [notes, setNotes] = useState('');
  const [urgency, setUrgency] = useState('normal');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const neighborEnabled = useFeatureFlag('commission_sold_by', false);
  const [mode, setMode] = useState('visit');
  const [prospect, setProspect] = useState(EMPTY_PROSPECT);

  const customerName = service?.customerName || `${service?.first_name || ''} ${service?.last_name || ''}`.trim() || 'Unknown';
  const address = service?.address || service?.address_line1 || '';

  const handleSubmit = async () => {
    if (!serviceType) { setError('Please select a service type'); return; }
    const neighbor = neighborEnabled && mode === 'neighbor';
    const problem = prospectProblem(neighbor, prospect);
    if (problem) { setError(problem); return; }
    setSubmitting(true);
    setError('');
    try {
      const token = getAdminAuthToken();
      const r = await fetch(`${API}/tech/field-lead`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildLeadBody({ neighbor, neighborEnabled, service, serviceType, notes, urgency, prospect })),
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
    <div ref={dialogRef} className={fieldPortalClass || undefined} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Flag Opportunity" style={{
      position: 'fixed', inset: 0, zIndex: 9999, fontFamily: '"Roboto", system-ui, sans-serif',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(28,25,23,0.45)',
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: isMobile ? 0 : 6, width: isMobile ? '100%' : '90%', maxWidth: isMobile ? 'none' : 420,
          height: isMobile ? '100%' : undefined, maxHeight: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)',
          boxShadow: '0 20px 60px rgba(28,25,23,0.18)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, padding: '16px 24px' }}>
          <h3 style={{ margin: 0, fontSize: 18, color: '#1c1917' }}>Flag Opportunity</h3>
          <button aria-label="Close" onClick={onClose} style={{ minWidth: 44, minHeight: 44, background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#78716c' }}>&times;</button>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>&#10003;</div>
            <div style={{ fontSize: 16, color: '#1c1917', fontWeight: 500 }}>Lead submitted!</div>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 24px' }}>
            <LeadWho
              neighborEnabled={neighborEnabled} mode={mode} onMode={setMode} prospect={prospect} onProspect={setProspect}
              customerName={customerName} address={address}
            />

            {/* Service type */}
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#57534e', marginBottom: 6 }}>Service Type</label>
            <select
              value={serviceType} onChange={e => setServiceType(e.target.value)}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 4, border: '1px solid #d6d3d1',
                fontSize: 14, color: '#1c1917', marginBottom: 14, background: '#fff',
              }}
            >
              <option value="">Select service...</option>
              {SERVICE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            {/* Notes */}
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#57534e', marginBottom: 6 }}>Notes</label>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="What did you observe?"
              rows={3}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 4, border: '1px solid #d6d3d1',
                fontSize: 14, color: '#1c1917', marginBottom: 14, resize: 'vertical', fontFamily: 'inherit',
              }}
            />

            {/* Urgency */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              {['normal', 'high'].map(u => (
                <button key={u} onClick={() => setUrgency(u)} style={{
                  flex: 1, padding: '8px 0', borderRadius: 4, fontSize: 13, fontWeight: 500,
                  border: urgency === u ? 'none' : '1px solid #d6d3d1', cursor: 'pointer',
                  background: urgency === u ? '#1c1917' : '#fff',
                  color: urgency === u ? '#fff' : '#57534e',
                }}>
                  {u === 'high' ? 'Urgent' : 'Normal'}
                </button>
              ))}
            </div>


            </div>
            <div style={{ flexShrink: 0, padding: '14px 24px 24px' }}>
            {error && <div role="alert" style={{ color: '#a32d2d', fontSize: 13, marginBottom: 12 }}>{error}</div>}
            <button
              onClick={handleSubmit} disabled={submitting}
              style={{
                width: '100%', padding: 14, borderRadius: 4, border: 'none',
                background: '#1c1917', color: '#fff', fontSize: 15, fontWeight: 500,
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
