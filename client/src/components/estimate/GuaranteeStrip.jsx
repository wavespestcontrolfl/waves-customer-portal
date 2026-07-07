/**
 * Footer strip — cancel anytime, satisfaction guarantee, license number.
 * License falls back to the Waves FDACS number when no server-provided
 * estimate license is present.
 */
import { WAVES_FL_LICENSE_LINE, normalizeFdacsLicense } from '../../constants/business';
import { W } from './tokens';


export default function GuaranteeStrip({ licenseNumber }) {
  const licenseDetail = licenseNumber
    ? `FL License #${normalizeFdacsLicense(licenseNumber)}`
    : WAVES_FL_LICENSE_LINE;
  const items = [
    { label: 'Cancel anytime', detail: 'no long-term contract' },
    { label: 'Satisfaction guaranteed', detail: 'we come back free' },
    { label: 'Licensed & insured', detail: licenseDetail },
  ];

  return (
    <div style={{
      marginTop: 32, padding: '24px 16px',
      background: W.offWhite, borderTop: `1px solid ${W.borderLight}`,
      borderRadius: 12,
    }}>
      <div style={{
        display: 'grid',
        // Always three across — including phones (owner directive).
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
      }}>
        {items.map((it) => (
          <div key={it.label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: W.blueDeeper }}>{it.label}</div>
            <div style={{ fontSize: 12, color: W.textCaption, marginTop: 2 }}>{it.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
