/**
 * Waves service-report showcase — marketing section for the post-visit pest
 * report. Mirrors AppShowcaseCard's two-column layout FLIPPED: the app card
 * leads with the phone on the left and copy on the right (phone stacking
 * first on mobile), so this section puts the copy on the LEFT and the visual
 * on the RIGHT, with the copy stacking first on mobile. The visual is a
 * stylized report mock built in plain JSX (no images) whose centerpiece is
 * the tech-recorded recap video block — the report's strongest proof point.
 */
import { estimateCard } from './cardStyles';
import { W } from './tokens';


const REPORT_FEATURES = [
  'Recap video from your tech',
  'Photo & product log',
  'Pest pressure trend',
  'Re-entry timers',
];

// Stylized report-phone mock: a rounded "report page" card with a header,
// the "Watch today's service" recap-video block (dark 16:9 frame + play
// button), and a thin pest-pressure trend line underneath — just enough to
// read as "the report has a video".
function ReportMock() {
  return (
    <div
      role="img"
      aria-label="Preview of the Waves service report with a recap video from your tech and a pest pressure trend"
      style={{
        width: 264, maxWidth: '100%',
        background: W.white, borderRadius: 22,
        border: '1px solid #DCEAF3', padding: 16,
        boxShadow: '0 24px 55px rgba(4,57,94,.28), 0 4px 12px rgba(15,23,42,.12)',
      }}
    >
      {/* Report header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{
          width: 26, height: 26, borderRadius: 8, background: W.blueDeeper,
          color: W.white, fontSize: 13, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          W
        </span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2, color: W.blueDeeper }}>Your service report</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: W.textCaption }}>Visit complete · Waves Pest Control</div>
        </div>
      </div>

      {/* Recap video block */}
      <div style={{
        fontSize: 11, fontWeight: 700, color: W.blueDark,
        textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8,
      }}>
        Watch today&rsquo;s service
      </div>
      <div style={{
        position: 'relative', aspectRatio: '16 / 9', borderRadius: 12,
        background: 'linear-gradient(135deg, #16294E 0%, #0B1B3A 55%, #1B2C5B 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12), 0 6px 16px rgba(4,57,94,.22)',
      }}>
        <span style={{
          width: 46, height: 46, borderRadius: '50%',
          background: 'rgba(255,255,255,.16)', border: '1.5px solid rgba(255,255,255,.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" style={{ display: 'block', marginLeft: 2 }}>
            <path fill="#FFFFFF" d="M8 5.5v13l11-6.5z" />
          </svg>
        </span>
        <span style={{
          position: 'absolute', right: 8, bottom: 8,
          fontSize: 11, fontWeight: 700, color: W.white,
          background: 'rgba(4,57,94,.65)', borderRadius: 6, padding: '2px 7px',
          letterSpacing: '0.04em',
        }}>
          0:52
        </span>
      </div>
      <div style={{ marginTop: 7, fontSize: 11, fontWeight: 600, color: W.textBody, lineHeight: 1.35 }}>
        Your tech walks you through exactly what was done today.
      </div>

      {/* Pest pressure trend line */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        marginTop: 11, padding: '8px 12px', borderRadius: 10,
        background: W.blueLight, border: '1px solid #CDEBFA',
      }}>
        <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke={W.green} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flex: '0 0 auto' }}>
          <path d="M3 7l7 7 4-4 7 7" />
          <path d="M15 17h6v-6" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 700, color: W.green, lineHeight: 1.2 }}>
          Pest pressure trending down
        </span>
      </div>
    </div>
  );
}

export default function ReportShowcaseCard() {
  return (
    <section style={estimateCard()}>
      <div style={{
        fontSize: 12, fontWeight: 700, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8,
      }}>
        The Waves report
      </div>
      <h2 style={{
        fontSize: 24, fontWeight: 500, lineHeight: 1.2,
        color: W.blueDeeper, margin: '0 0 8px',
      }}>
        Every visit ends with proof &mdash; see exactly what we did
      </h2>
      <p style={{ fontSize: 14, color: W.textCaption, margin: '0 0 16px', lineHeight: 1.5 }}>
        Minutes after we finish, your service report lands with photo evidence,
        re-entry timers, your pest pressure trend &mdash; and a recap video
        recorded by your tech before leaving your property.
      </p>

      {/* Copy LEFT / visual RIGHT — the flip of AppShowcaseCard's phone-left
          layout. Copy renders first in the DOM so it also stacks first on
          mobile (the app card stacks its phone first). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 26, marginTop: 8 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', color: W.navyDeep }}>
            No more &ldquo;did they even show up?&rdquo;
          </div>
          <p style={{ fontSize: 14, color: W.textBody, margin: '8px 0 0', lineHeight: 1.5 }}>
            Every treatment is documented while your tech is still in the
            driveway &mdash; what was found, what was applied, and when it&rsquo;s
            safe for kids and pets to head back outside.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '16px 0 0' }}>
            {/* data-glass-accent renders these as the same gold pills as the
                AI slot-search chips (owner 2026-07-07); the inline styles
                remain the non-glass fallback. */}
            {REPORT_FEATURES.map((label) => (
              <span
                key={label}
                data-glass-accent=""
                style={{
                  padding: '8px 14px', borderRadius: 999,
                  fontSize: 14, fontWeight: 700, color: W.navyDeep,
                  background: W.white, border: '1px solid #DCEAF3',
                  boxShadow: '0 2px 8px rgba(4,57,94,.08)',
                }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <div style={{ flex: '0 0 auto', margin: '8px auto' }}>
          <ReportMock />
        </div>
      </div>
    </section>
  );
}
