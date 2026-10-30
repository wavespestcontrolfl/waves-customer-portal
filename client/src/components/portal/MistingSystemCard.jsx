// The Home-tab misting system card: next mist, last refill (or install date)
// and the next misting service visit for a customer with an automatic mosquito
// misting system. Presentational only — PortalPage's DashboardTab owns the read
// (GET /api/misting-system) and renders this only when a system came back, so
// the whole card stays dark behind GATE_MOSQUITO_MISTING on the server.
//
// Every date and time is ET (client/src/lib/timezone), never the device zone.
// No prices, no product names, no buttons. Looks like the "At a glance" card.
import Icon from '../Icon';
import { COLORS as B, CUSTOMER_SECTION_LABEL } from '../../theme-brand';
import { addETDays, etDateString, formatETDateOnly, formatETTime } from '../../lib/timezone';

const DEFAULT_CARD = { background: '#FFFFFF', border: '1px solid #E7E2D7', borderRadius: 16, position: 'relative' };

// toLocaleTimeString puts a narrow no-break space before AM/PM on newer ICU.
const clock = (date) => formatETTime(date).replace(/\s/g, ' ');

// "19:30" -> "7:30 PM" (the stored mist times are already ET wall clock).
function hhmmLabel(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function dailyLine(mistTimes) {
  const labels = (mistTimes || []).map(hhmmLabel).filter(Boolean);
  if (!labels.length) return null;
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `Daily at ${list}`;
}

function nextMistLabel(nextMistAt, now) {
  if (!nextMistAt) return '—';
  const at = new Date(nextMistAt);
  if (Number.isNaN(at.getTime())) return '—';
  const day = etDateString(at);
  if (day === etDateString(now)) return `Today at ${clock(at)}`;
  if (day === etDateString(addETDays(now, 1))) return `Tomorrow at ${clock(at)}`;
  return `${formatETDateOnly(day, { weekday: 'short', month: 'short', day: 'numeric' })} at ${clock(at)}`;
}

export default function MistingSystemCard({ system, now = new Date(), cardStyle = DEFAULT_CARD, muted = '#64748B' }) {
  if (!system) return null;
  const thisYear = etDateString(now).slice(0, 4);
  // A date from another year says so, so "Oct 12" never reads as the wrong one.
  const shortDate = (value) => formatETDateOnly(value, {
    month: 'short', day: 'numeric', ...(String(value).slice(0, 4) !== thisYear ? { year: 'numeric' } : {}),
  });
  const rows = [
    { label: 'Next mist', value: nextMistLabel(system.nextMistAt, now), sub: dailyLine(system.mistTimes) },
    system.lastRefillOn
      ? { label: 'Last refill', value: shortDate(system.lastRefillOn) }
      : { label: 'Installed', value: system.installedOn ? shortDate(system.installedOn) : '—' },
    { label: 'Next check', value: system.nextCheckOn ? formatETDateOnly(system.nextCheckOn, { weekday: 'short', month: 'short', day: 'numeric' }) : '—' },
  ];
  return (
    <section data-glass="card" data-testid="misting-system-card" style={{ ...cardStyle, padding: 20 }}>
      <div data-glass="chip" style={CUSTOMER_SECTION_LABEL}><Icon name="droplet" size={14} strokeWidth={2} />Your misting system</div>
      <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
        {rows.map((item) => (
          <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'baseline', borderBottom: '1px solid #E7E2D7', paddingBottom: 10 }}>
            <div>
              <div style={{ fontSize: 14, color: muted }}>{item.label}</div>
              {item.sub && <div style={{ fontSize: 14, color: '#475569', marginTop: 1 }}>{item.sub}</div>}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: B.glassNavy, textAlign: 'right' }}>{item.value}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, fontSize: 14, color: muted, lineHeight: 1.45 }}>
        These are the mist times we set at your last visit. If you change them in the misting app, the app's times are the ones that run.
      </div>
    </section>
  );
}
