import { useEffect, useRef, useState } from 'react';
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

// Only treat http(s) URLs as safe to render as a clickable source link.
function safeHttpUrl(value) {
  const s = String(value || '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
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
  onApplyHistory,
  initialProfile = null,
  initialHistory = null,
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
  const [history, setHistory] = useState(initialHistory);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyApplied, setHistoryApplied] = useState(false);
  const [historyMsg, setHistoryMsg] = useState('');

  // The property/customer context this bar is looking at. Captured when a
  // lookup starts so a slow response for one customer/property can never be
  // applied after the tech switches to another — the WDO report is a legal
  // FDACS-13645 filing, so cross-property data is the harm to prevent.
  const contextKey = `${projectId || ''}|${customerId || ''}|${propertyAddress || ''}`;
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;

  // Loading flags are owned by the LATEST request of each kind, not by the
  // context: a request whose context went stale (e.g. the tech edited the
  // address mid-lookup) must still stop its own spinner — only its RESULT is
  // dropped. Guarding the finally on context (like the result) left
  // analyzing/historyLoading stuck true after an address edit, because the
  // reset effect below deliberately ignores address changes.
  const analyzeSeqRef = useRef(0);
  const historySeqRef = useRef(0);

  // When the customer/project context changes, wipe any completed lookup so
  // its panels (with their Apply / Replace-fields buttons) can't push the
  // previous property's data into the new context's findings. The property
  // address is intentionally NOT a reset trigger here — applying suggestions
  // can itself rewrite findings.property_address — but in-flight requests are
  // still guarded on the full context (address included) above.
  const resetKey = `${projectId || ''}|${customerId || ''}`;
  useEffect(() => {
    setPhoto(null);
    setAnalyzing(false);
    setResult(null);
    setError('');
    setApplied(false);
    setSpecsApplied(false);
    setHistory(initialHistory);
    setHistoryLoading(false);
    setHistoryApplied(false);
    setHistoryMsg('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

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

  function applyHistory() {
    if (!history || !onApplyHistory) return;
    onApplyHistory(history);
    setHistoryApplied(true);
  }

  async function findHistory(refresh = false) {
    if (disabled || historyLoading) return;
    const address = String(propertyAddress || findings.property_address || '').trim();
    if (!customerId && !address) {
      setError('Pick a customer or enter the property address first.');
      return;
    }
    const startedFor = contextRef.current;
    const seq = ++historySeqRef.current;
    setHistoryLoading(true);
    setError('');
    setHistoryApplied(false);
    setHistoryMsg('');
    try {
      const res = await adminFetch('/admin/projects/wdo-history', {
        method: 'POST',
        body: {
          ...(projectId ? { project_id: projectId } : {}),
          ...(customerId ? { customer_id: customerId } : {}),
          ...(serviceRecordId ? { service_record_id: serviceRecordId } : {}),
          ...(scheduledServiceId ? { scheduled_service_id: scheduledServiceId } : {}),
          ...(address ? { property_address: address } : {}),
          ...(refresh ? { refresh: true } : {}),
        },
      });
      const data = await res.json();
      // Stale response: the tech has switched customer/property since this
      // lookup started — drop it instead of showing another property's history.
      if (contextRef.current !== startedFor) return;
      if (!res.ok) throw new Error(data?.error || 'WDO history lookup failed');
      setHistory(data.history || null);
      if (!data.history) setHistoryMsg(data.message || 'No prior treatment or permit history found — verify on site.');
    } catch (e) {
      if (contextRef.current !== startedFor) return;
      setError(e.message || 'WDO history lookup failed');
    } finally {
      // Latest-request guard, NOT a context guard: a newer lookup owns the
      // spinner; a stale-context response still ends its own.
      if (historySeqRef.current === seq) setHistoryLoading(false);
    }
  }

  const historyRows = history
    ? [
      ['Previous treatment', history.previousTreatment && history.previousTreatment !== 'unknown' ? history.previousTreatment.toUpperCase() : 'Unknown'],
      ['Notes', history.treatmentNotes],
      ['Fumigation', history.fumigation
        ? [history.fumigation.fumigant, history.fumigation.date, history.fumigation.company].filter(Boolean).join(' · ')
        : ''],
      ['Re-roof permit', history.roofPermitYear ? String(history.roofPermitYear) : ''],
      ['Permits found', history.permits?.length ? String(history.permits.length) : ''],
    ].filter(([, v]) => hasValue(v))
    : [];

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

    const startedFor = contextRef.current;
    const seq = ++analyzeSeqRef.current;
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
      // Stale response: the tech has switched customer/property since this
      // analysis started — never auto-apply another property's suggestions.
      if (contextRef.current !== startedFor) return;
      if (!res.ok) throw new Error(data?.error || 'WDO intelligence failed');
      setResult(data);
      if (data?.suggestedFindings) applySuggestions(false, data);
    } catch (e) {
      if (contextRef.current !== startedFor) return;
      setError(e.message || 'WDO intelligence failed');
    } finally {
      // Latest-request guard, NOT a context guard: a newer analyze owns the
      // spinner; a stale-context response still ends its own.
      if (analyzeSeqRef.current === seq) setAnalyzing(false);
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
        <button
          type="button"
          onClick={() => findHistory(Boolean(history))}
          disabled={disabled || historyLoading}
          title="Search county permits and listing history for prior WDO treatment (FDACS Section 4)"
          style={{
            padding: '7px 10px',
            borderRadius: 6,
            border: `1px solid ${P.border}`,
            background: P.card,
            color: P.heading,
            fontSize: 11,
            fontWeight: 800,
            cursor: disabled || historyLoading ? 'default' : 'pointer',
            opacity: disabled || historyLoading ? 0.55 : 1,
          }}
        >
          {historyLoading ? 'Searching…' : (history ? 'Refresh history' : 'Treatment history')}
        </button>
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
              {safeHttpUrl(profile.sourceUrl) ? (
                <>
                  {profile.confidence ? ' · ' : ''}
                  <a href={safeHttpUrl(profile.sourceUrl)} target="_blank" rel="noreferrer" style={{ color: P.muted }}>source</a>
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

      {historyMsg && !history && (
        <div style={{ fontSize: 11, color: P.muted }}>{historyMsg}</div>
      )}

      {historyRows.length > 0 && (
        <div style={{ border: `1px solid ${P.border}`, borderRadius: 6, background: P.card, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 900, color: P.heading, textTransform: 'uppercase' }}>
              Treatment history (Section 4)
            </span>
            {onApplyHistory && (
              <button
                type="button"
                onClick={applyHistory}
                disabled={disabled}
                style={{
                  padding: '5px 9px', borderRadius: 6, border: `1px solid ${P.accent}`,
                  background: P.accent, color: P.accentText, fontSize: 11, fontWeight: 800,
                  cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
                }}
              >
                Apply to Section 4
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {historyRows.map(([label, value]) => (
              <div key={label} style={{ fontSize: 11, color: P.text, lineHeight: 1.4 }}>
                <span style={{ color: P.muted }}>{label}: </span>
                <span style={{ fontWeight: 700 }}>{String(value)}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: P.muted, marginTop: 6 }}>
            {history.confidence ? `Confidence: ${history.confidence}` : ''}
            {safeHttpUrl(history.sources?.[0]) ? (
              <>
                {history.confidence ? ' · ' : ''}
                <a href={safeHttpUrl(history.sources[0])} target="_blank" rel="noreferrer" style={{ color: P.muted }}>source</a>
              </>
            ) : ''}
            {' · '}Auto-pulled — verify on site before filing.
          </div>
          {historyApplied && (
            <div style={{ fontSize: 11, color: P.muted, marginTop: 6 }}>Applied to Section 4 fields.</div>
          )}
        </div>
      )}
    </div>
  );
}
