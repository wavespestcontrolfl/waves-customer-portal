/**
 * Horizontal track frequency slider — AppSumo-style.
 *
 * Visual model: a horizontal rail with a filled color segment from the
 * left edge to the active position, a circular handle at that position,
 * and labeled stops underneath. Click any stop to jump.
 *
 * Discrete 3-stop slider (not continuous) — engine supports exactly
 * Quarterly / Bi-monthly / Monthly pest frequencies. Default position
 * is Quarterly (leftmost). Left = less frequent + cheaper; right =
 * more frequent + pricier — matches the "less vs more" mental model
 * customers already have.
 *
 * Keyboard accessible: arrow keys shift selection; Home/End jump to
 * ends. Tab focus lands on the container and individual stops are
 * buttons for assistive tech.
 */
import { useCallback } from 'react';

const W = {
  blue: '#065A8C', blueBright: '#009CDE', blueDeeper: '#1B2C5B',
  yellow: '#FFD700', navy: '#0F172A',
  textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', offWhite: '#F1F5F9', border: '#CBD5E1', borderLight: '#E2E8F0',
};

export default function FrequencySlider({ frequencies, selected, onChange }) {
  if (!frequencies || frequencies.length === 0) return null;

  const n = frequencies.length;
  const idx = Math.max(0, frequencies.findIndex((f) => f.key === selected));
  const active = frequencies[idx];

  // Position of each stop along the rail as a 0..1 fraction.
  // At n=3, stops are at 0%, 50%, 100%.
  const fractionFor = (i) => (n === 1 ? 0 : i / (n - 1));
  const fillPercent = fractionFor(idx) * 100;

  const pickByIndex = useCallback((i) => {
    const clamped = Math.max(0, Math.min(frequencies.length - 1, i));
    onChange(frequencies[clamped].key);
  }, [frequencies, onChange]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); pickByIndex(idx - 1); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); pickByIndex(idx + 1); }
    else if (e.key === 'Home') { e.preventDefault(); pickByIndex(0); }
    else if (e.key === 'End') { e.preventDefault(); pickByIndex(frequencies.length - 1); }
  }, [idx, frequencies.length, pickByIndex]);

  return (
    <div
      role="group"
      aria-label="Service frequency"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        background: W.white, borderRadius: 16, padding: '22px 20px 14px',
        border: `1px solid ${W.border}`, marginBottom: 16,
        outline: 'none',
      }}
    >
      <div style={{
        fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14,
      }}>
        How often?
      </div>

      {/* Rail wrapper — relative anchor for the fill + handle + labels. */}
      <div style={{ position: 'relative', padding: '14px 12px 6px' }}>
        {/* Inactive rail */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 12, right: 12, top: '50%',
            height: 4, marginTop: -2,
            background: W.borderLight, borderRadius: 999,
          }}
        />
        {/* Active fill */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 12, top: '50%',
            height: 4, marginTop: -2,
            width: `calc((100% - 24px) * ${fillPercent / 100})`,
            background: W.blueBright, borderRadius: 999,
            transition: 'width 180ms ease',
          }}
        />

        {/* Stop buttons — absolute-positioned along the rail */}
        {frequencies.map((f, i) => {
          const isActive = i === idx;
          return (
            <button
              key={f.key}
              type="button"
              aria-label={`${f.label} frequency`}
              aria-pressed={isActive}
              onClick={() => pickByIndex(i)}
              style={{
                position: 'absolute',
                left: `calc(12px + (100% - 24px) * ${fractionFor(i)})`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: isActive ? 26 : 14,
                height: isActive ? 26 : 14,
                borderRadius: '50%',
                background: isActive ? W.blueBright : W.white,
                border: `2px solid ${isActive ? W.blueBright : W.border}`,
                boxShadow: isActive ? '0 2px 8px rgba(0,156,222,0.35)' : 'none',
                cursor: 'pointer',
                padding: 0,
                transition: 'all 180ms ease',
              }}
            />
          );
        })}
      </div>

      {/* Labels row — positioned under each stop */}
      <div style={{ position: 'relative', height: 32, marginTop: 2 }}>
        {frequencies.map((f, i) => {
          const isActive = i === idx;
          // Edge labels get flush alignment so they don't overflow off the rail.
          const isFirst = i === 0;
          const isLast = i === n - 1;
          const transform = isFirst ? 'translateX(0)' : isLast ? 'translateX(-100%)' : 'translateX(-50%)';
          const leftCalc = isFirst
            ? '12px'
            : isLast
              ? 'calc(100% - 12px)'
              : `calc(12px + (100% - 24px) * ${fractionFor(i)})`;
          return (
            <div
              key={f.key}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: leftCalc,
                transform,
                fontSize: 14,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? W.navy : W.textCaption,
                whiteSpace: 'nowrap',
                transition: 'color 180ms ease',
              }}
            >
              {f.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
