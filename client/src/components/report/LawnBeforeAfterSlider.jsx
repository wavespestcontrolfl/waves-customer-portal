import { useState } from 'react';

// Before/after slider on the simple web lawn report (GATE_REPORT_WEB_SLIDER,
// owner 2026-10-20, idea 2b): the same spot photographed at the last visit and
// at this visit. The server pairs by shot key at the same property and sends a
// pair only when both photos exist, so every pair here is a real like-for-like.
//
// The control is a native range input stretched over the photos and made
// invisible: keyboard (arrow keys, Home, End, Page keys), touch and mouse drag
// and screen readers all come from the browser, and there is no pixel math to
// break under the web page's CSS zoom. Vertical swipes still scroll the page.
// Sizes are the print document's (the web page scales them by its zoom), kept
// at or above the 9.5 floor that reads 14px on screen.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const INK = '#04395E';
const MUTED = '#3F4A65';

export function sliderDayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export function usableSliderPairs(slider) {
  return (Array.isArray(slider?.pairs) ? slider.pairs : [])
    .filter((pair) => pair && pair.before?.url && pair.after?.url && typeof pair.label === 'string' && pair.label);
}

const SHEET = `
.lbas-frame{position:relative;width:100%;aspect-ratio:4/3;overflow:hidden;border-radius:10px;background:#F7F8F9;border:1px solid #E7E2D7;box-sizing:border-box;touch-action:pan-y;-webkit-user-select:none;user-select:none}
.lbas-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.lbas-line{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 0 1px rgba(4,57,94,.35);pointer-events:none}
.lbas-knob{position:absolute;top:50%;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:#fff;border:2px solid ${INK};box-sizing:border-box;display:flex;align-items:center;justify-content:center;pointer-events:none}
.lbas-input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:ew-resize;touch-action:pan-y}
.lbas-input:focus-visible~.lbas-knob{outline:3px solid #F5B301;outline-offset:2px}
.lbas-tag{position:absolute;bottom:6px;padding:2px 6px;border-radius:6px;background:rgba(4,57,94,.88);color:#fff;font-size:10px;line-height:1.3;pointer-events:none}
`;

function Pair({ pair, onFailed }) {
  const [pos, setPos] = useState(50);
  const beforeDay = sliderDayLabel(pair.before.date);
  const afterDay = sliderDayLabel(pair.after.date);
  return (
    <figure style={{ margin: '0 0 10px' }} data-testid="lawn-slider-pair" data-shot={pair.key}>
      <figcaption style={{ fontSize: 11, fontWeight: 700, color: INK, margin: '0 0 4px' }}>{pair.label}</figcaption>
      <div className="lbas-frame">
        <img className="lbas-img" src={pair.after.url} alt={`${pair.label}, this visit`} onError={onFailed} />
        <img
          className="lbas-img"
          src={pair.before.url}
          alt={`${pair.label}, last visit`}
          onError={onFailed}
          style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        />
        <span className="lbas-tag" style={{ left: 6 }}>Last visit{beforeDay ? <><br />{beforeDay}</> : null}</span>
        <span className="lbas-tag" style={{ right: 6, textAlign: 'right' }}>This visit{afterDay ? <><br />{afterDay}</> : null}</span>
        <input
          className="lbas-input"
          type="range"
          min={0}
          max={100}
          step={2}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label={`Compare the ${pair.label.toLowerCase()} at the last visit and at this visit`}
          aria-valuetext={`Last visit photo shown across ${pos} percent of the width`}
          data-testid="lawn-slider-input"
        />
        <span className="lbas-line" aria-hidden="true" style={{ left: `${pos}%` }} />
        <span className="lbas-knob" aria-hidden="true" style={{ left: `${pos}%` }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />
          </svg>
        </span>
      </div>
    </figure>
  );
}

// `header` is the document's own section heading and `cardProps` its card
// attributes, so the slider reads as one more section of the report.
export default function LawnBeforeAfterSlider({ slider, header = null, cardProps = {} }) {
  const [failed, setFailed] = useState(() => new Set());
  const pairs = usableSliderPairs(slider).filter((pair) => !failed.has(pair.key));
  if (!pairs.length) return null;
  return (
    <div {...cardProps} data-testid="lawn-slider" className="doc-keep">
      <style>{SHEET}</style>
      {header}
      <p style={{ margin: '0 0 8px', fontSize: 11, lineHeight: 1.5, color: MUTED }}>
        Slide to compare the same part of your lawn at your last visit and at this visit.
      </p>
      {pairs.map((pair) => (
        <Pair
          key={pair.key}
          pair={pair}
          onFailed={() => setFailed((prev) => new Set(prev).add(pair.key))}
        />
      ))}
    </div>
  );
}
