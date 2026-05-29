import { useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';

const DEFAULT_COLORS = {
  card: '#FFFFFF',
  bg: '#F4F4F5',
  border: '#E4E4E7',
  heading: '#09090B',
  text: '#27272A',
  muted: '#71717A',
  accent: '#18181B',
  accentText: '#FFFFFF',
  red: '#991B1B',
};

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function compactFileName(file) {
  if (!file?.name) return 'Selected photo';
  return file.name.length > 34 ? `${file.name.slice(0, 30)}...` : file.name;
}

const SPEC_FIELDS = [
  ['yearBuilt', 'Year built'],
  ['constructionMaterial', 'Construction'],
  ['foundationType', 'Foundation'],
  ['roofType', 'Roof'],
  ['stories', 'Stories'],
  ['squareFootage', 'Living area (sq ft)'],
];

export default function WdoIntelligenceBar({
  projectId,
  customerId,
  serviceRecordId,
  scheduledServiceId,
  propertyAddress,
  findings = {},
  onApplySuggestions,
  onApplyProfile,
  initialProfile = null,
  onEvidencePhotoSelected,
  disabled = false,
  palette,
}) {
  const P = { ...DEFAULT_COLORS, ...(palette || {}) };
  const [photo, setPhoto] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const [specsApplied, setSpecsApplied] = useState(false);

  // Profile comes from the latest analyze result, or the cached project profile.
  const profile = result?.propertyProfile || initialProfile || null;
  const specRows = profile
    ? SPEC_FIELDS.map(([key, label]) => [label, profile[key]]).filter(([, v]) => hasValue(v))
    : [];

  function applyProfile() {
    if (!profile || !onApplyProfile) return;
    onApplyProfile(profile);
    setSpecsApplied(true);
  }

  function handlePhotoChange(e) {
    const file = e.target.files?.[0] || null;
    e.target.value = '';
    setPhoto(file);
    setApplied(false);
    if (file && onEvidencePhotoSelected) onEvidencePhotoSelected(file);
  }

  function applySuggestions(overwrite = false, source = result) {
    if (!source?.suggestedFindings || !onApplySuggestions) return;
    onApplySuggestions(source.suggestedFindings, { overwrite });
    setApplied(true);
  }

  async function analyze() {
    if (disabled || analyzing) return;
    const address = String(propertyAddress || findings.property_address || '').trim();
    if (!customerId && !address) {
      setError('Pick a customer or enter the property address first.');
      return;
    }

    setAnalyzing(true);
    setError('');
    setApplied(false);
    try {
      const fd = new FormData();
      if (projectId) fd.append('project_id', projectId);
      if (customerId) fd.append('customer_id', customerId);
      if (serviceRecordId) fd.append('service_record_id', serviceRecordId);
      if (scheduledServiceId) fd.append('scheduled_service_id', scheduledServiceId);
      if (address) fd.append('property_address', address);
      fd.append('findings', JSON.stringify(findings || {}));
      if (photo) fd.append('previous_treatment_photo', photo);

      const res = await adminFetch('/admin/projects/wdo-intelligence', {
        method: 'POST',
        body: fd,
        headers: {},
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'WDO intelligence failed');
      setResult(data);
      if (data?.suggestedFindings) applySuggestions(false, data);
    } catch (e) {
      setError(e.message || 'WDO intelligence failed');
    } finally {
      setAnalyzing(false);
    }
  }

  const suggestedCount = result?.suggestedFindings
    ? Object.values(result.suggestedFindings).filter(hasValue).length
    : 0;

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        border: `1px solid ${P.border}`,
        background: P.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 900, color: P.heading, textTransform: 'uppercase', letterSpacing: 0 }}>
            WDO Intelligence
          </div>
          <div style={{ fontSize: 11, color: P.muted, marginTop: 2 }}>
            Property scope, home facts, and previous-treatment evidence.
          </div>
        </div>
        <button
          type="button"
          onClick={analyze}
          disabled={disabled || analyzing}
          style={{
            flexShrink: 0,
            padding: '7px 10px',
            borderRadius: 6,
            border: `1px solid ${P.accent}`,
            background: disabled || analyzing ? P.muted : P.accent,
            color: P.accentText,
            fontSize: 11,
            fontWeight: 900,
            cursor: disabled || analyzing ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {analyzing ? 'Analyzing...' : 'Analyze'}
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '7px 10px',
            borderRadius: 6,
            border: `1px solid ${P.border}`,
            background: P.card,
            color: P.heading,
            fontSize: 11,
            fontWeight: 800,
            cursor: disabled || analyzing ? 'default' : 'pointer',
            opacity: disabled || analyzing ? 0.55 : 1,
          }}
        >
          Prior treatment photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={disabled || analyzing}
            onChange={handlePhotoChange}
            style={{ display: 'none' }}
          />
        </label>
        {photo && (
          <span style={{ fontSize: 11, color: P.muted }}>
            {compactFileName(photo)}
          </span>
        )}
        {result && suggestedCount > 0 && (
          <button
            type="button"
            onClick={() => applySuggestions(true)}
            disabled={disabled || analyzing}
            style={{
              padding: '7px 10px',
              borderRadius: 6,
              border: `1px solid ${P.border}`,
              background: P.card,
              color: P.heading,
              fontSize: 11,
              fontWeight: 800,
              cursor: disabled || analyzing ? 'default' : 'pointer',
            }}
          >
            Replace fields
          </button>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 11, color: P.red }}>
          {error}
        </div>
      )}
      {applied && (
        <div style={{ fontSize: 11, color: P.muted }}>
          Suggestions applied to blank WDO fields.
        </div>
      )}
      {result?.propertySummary && (
        <div style={{ fontSize: 11, color: P.text, lineHeight: 1.45 }}>
          {result.propertySummary}
        </div>
      )}
      {result?.reviewNotes?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {result.reviewNotes.map((note, idx) => (
            <div key={`${note}-${idx}`} style={{ fontSize: 11, color: P.muted }}>
              {note}
            </div>
          ))}
        </div>
      )}

      {specRows.length > 0 && (
        <div style={{ border: `1px solid ${P.border}`, borderRadius: 6, background: P.card, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 900, color: P.heading, textTransform: 'uppercase' }}>
              Property specs
            </span>
            {onApplyProfile && (
              <button
                type="button"
                onClick={applyProfile}
                disabled={disabled}
                style={{
                  padding: '5px 9px', borderRadius: 6, border: `1px solid ${P.accent}`,
                  background: P.accent, color: P.accentText, fontSize: 11, fontWeight: 800,
                  cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
                }}
              >
                Apply to report
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
            {specRows.map(([label, value]) => (
              <div key={label} style={{ fontSize: 11, color: P.text }}>
                <span style={{ color: P.muted }}>{label}: </span>
                <span style={{ fontWeight: 700 }}>{String(value)}</span>
              </div>
            ))}
          </div>
          {(profile.sourceUrl || profile.confidence) && (
            <div style={{ fontSize: 10, color: P.muted, marginTop: 6 }}>
              {profile.confidence ? `Confidence: ${profile.confidence}` : ''}
              {profile.sourceUrl ? (
                <>
                  {profile.confidence ? ' · ' : ''}
                  <a href={profile.sourceUrl} target="_blank" rel="noreferrer" style={{ color: P.muted }}>source</a>
                </>
              ) : ''}
              {' · '}Auto-pulled — verify on site.
            </div>
          )}
          {specsApplied && (
            <div style={{ fontSize: 11, color: P.muted, marginTop: 6 }}>Specs applied to the report fields.</div>
          )}
        </div>
      )}
    </div>
  );
}
