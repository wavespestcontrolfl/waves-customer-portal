import { COLORS as B } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';

// =========================================================================
// Small pieces shared between PhotoId.jsx (pest v2 result) and
// PhotoIdWorkupCard.jsx (lawn/tree-shrub/palm workup, L5) — split out here
// rather than exported from PhotoId.jsx so the two files don't import each
// other (no circular module dependency).
// =========================================================================

// v2 result card (GATE_PHOTO_ID_V2, server side) — rendered only when the
// response carries a `data.v2` object. Every string a customer sees is
// either payload text verbatim or one of these two fixed tier labels —
// never composed species/diagnosis facts.
export const V2_TIER_LABEL = {
  ai_suggestion: 'AI suggestion',
  needs_more_evidence: 'Needs more evidence',
};

// tone: 'default' | 'alert' | 'accent' plus the four v2 verdict tones —
// ally/harmless/watch/call are deliberately calm and distinct from one
// another; `call` ("Worth a pro look") is NOT alarm-red (that's `alert`,
// reserved for the pest-result safety chips above).
// Verdict chip text is 14px on the light glass chip, so each tone uses a
// dark shade of its hue (≥ 4.5:1 on white): the brand green, sky and amber
// are too light to read as text at this size.
const VERDICT_TEXT = {
  ally: '#166534', // green-800
  harmless: '#075985', // sky-800
  watch: '#92400E', // amber-800
  call: B.glassNavy,
};

export function Chip({ children, tone = 'default' }) {
  const toneColor = tone === 'alert' ? B.red
    : tone === 'accent' ? B.glassNavy
    : VERDICT_TEXT[tone] || SHELL.text;
  return (
    <span data-glass="chip" style={{
      display: 'inline-flex', alignItems: 'center', padding: '5px 12px', borderRadius: 999,
      fontSize: 14, fontWeight: 700, color: toneColor,
    }}>{children}</span>
  );
}

export function ResultPhotos({ photos, unavailablePhotoIds, onPhotoUnavailable }) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return <div role="status" style={{ fontSize: 14, color: SHELL.muted }}>Original photos are unavailable. Add a new photo to your request.</div>;
  }
  const unavailable = new Set(unavailablePhotoIds || []);
  const available = photos.filter((photo) => photo?.url && !unavailable.has(photo.id));
  const unavailableCount = photos.length - available.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {available.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {available.map((photo, index) => (
            <img
              key={photo.id || `${photo.url}-${index}`}
              src={photo.url}
              alt={`Saved photo ${index + 1}`}
              onError={() => { if (photo.id) onPhotoUnavailable?.(photo.id); }}
              style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 8, border: `1px solid ${SHELL.border}` }}
            />
          ))}
        </div>
      )}
      {unavailableCount > 0 && (
        <div role="status" style={{ fontSize: 14, color: SHELL.muted, lineHeight: 1.45 }}>
          {unavailableCount === 1
            ? 'One saved photo could not be loaded.'
            : `${unavailableCount} saved photos could not be loaded.`}
        </div>
      )}
    </div>
  );
}
