// Quiet advisory rendered under a date/time picker: the day's 2–3 cheapest
// start hours by drive-time detour (useBestTimes). Deliberately NOT an
// alert — neutral zinc, no amber — because unlike SlotConflictNotice it
// suggests rather than warns. Tapping a chip only fills the time fields
// (never submits); without onPick the chips are display-only text (fixed
// targets like the drag-drop confirm). The chip matching the currently
// picked start renders selected/inert either way. Renders nothing when
// there are no times (including while the server gate is off).

function fmtTime(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmm || '';
  const h = parseInt(m[1], 10);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function bestTimeLabel(slot) {
  const detour = Math.round(Number(slot.detourMinutes) || 0);
  return `${fmtTime(slot.start)} · ${detour > 0 ? `+${detour} min drive` : 'no detour'}`;
}

export default function BestTimeHint({ bestTimes, onPick, currentStart, style }) {
  if (!bestTimes?.length) return null;
  const interactive = typeof onPick === 'function';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
      fontSize: 12, color: '#71717A',
      ...style,
    }}>
      <span>Best times this day:</span>
      {bestTimes.slice(0, 3).map((slot) => {
        const current = currentStart && String(currentStart).slice(0, 5) === String(slot.start).slice(0, 5);
        const chipStyle = {
          padding: '3px 8px', borderRadius: 6, fontSize: 12,
          border: `1px solid ${current ? '#A1A1AA' : '#D4D4D8'}`,
          background: current ? '#F4F4F5' : 'transparent',
          color: current ? '#18181B' : '#52525B',
        };
        if (!interactive || current) {
          return (
            <span key={slot.start} style={chipStyle}>
              {bestTimeLabel(slot)}
            </span>
          );
        }
        return (
          <button
            key={slot.start}
            type="button"
            onClick={() => onPick(slot)}
            style={{ ...chipStyle, cursor: 'pointer' }}
          >
            {bestTimeLabel(slot)}
          </button>
        );
      })}
    </div>
  );
}
