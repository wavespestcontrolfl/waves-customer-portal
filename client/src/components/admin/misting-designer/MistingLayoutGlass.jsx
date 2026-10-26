// The glass look of the misting layout designer: frosted panels that float over the satellite photo.
// White at 16% with a 1px white 38% border, a 14px blur with saturation, white text with a soft shadow.
// From the lg breakpoint the panels sit on the photo (title and tools top left, counts and legend top right,
// controls bottom left). Below it they stack under the photo as solid cards (tools, then the controls, then the counts), because a phone-sized photo has
// no room to spare. Nothing is ever anchored lower than the photo's bottom 44 of 960 px (4.6% of its height):
// that strip is where Google prints its attribution. The slots that hold the panels let taps through (the photo is
// a tracing surface and a slot's box is bigger than its panels); only a panel takes a tap.
import { MAP_HEIGHT } from '../../tech/treatmentZoneSpray';

// The attribution strip, in physical map pixels, as a share of the photo's height (rounded up).
const ATTRIBUTION_PX = 44;
const ATTRIBUTION_PCT = `${Math.ceil((ATTRIBUTION_PX / MAP_HEIGHT) * 1000) / 10}%`;

// White 16% over a thin navy tint (18%): the tint keeps the white text readable where the photo under a panel is
// bright (a roof, a road).
const GLASS = [
  'pointer-events-auto rounded-[14px] border border-white/[0.38] px-3 py-2.5 text-white',
  'bg-[linear-gradient(rgba(10,25,50,0.18),rgba(10,25,50,0.18)),linear-gradient(rgba(255,255,255,0.16),rgba(255,255,255,0.16))]',
  'shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-[14px] backdrop-saturate-[1.4]',
  '[text-shadow:0_1px_2px_rgba(0,0,0,0.45)]',
  'max-lg:bg-zinc-800 max-lg:backdrop-blur-none',
].join(' ');

const GLASS_BUTTON = [
  'min-h-11 rounded-full border border-white/[0.45] bg-white/[0.14] px-3 text-14 font-medium text-white',
  '[text-shadow:0_1px_2px_rgba(0,0,0,0.45)] hover:bg-white/25',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffd700]',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'aria-pressed:border-white/80 aria-pressed:bg-[rgba(0,156,222,0.75)]',
].join(' ');

export function GlassPanel({ className = '', children, ...rest }) {
  return <div {...rest} className={`${GLASS} ${className}`}>{children}</div>;
}

export function GlassButton({ className = '', ...props }) {
  return <button type="button" {...props} className={`${GLASS_BUTTON} ${className}`} />;
}

export const GLASS_SELECT = 'min-h-11 rounded-xs border border-white/[0.45] bg-white px-2 text-14 text-zinc-900 [text-shadow:none]';

/** The photo with its panels. `frame` is the photo block; the three slots hold the panels. */
export function GlassStage({ frame, topLeft, topRight, bottomLeft }) {
  return (
    <div
      data-testid="layout-stage"
      className="relative mx-auto flex flex-col gap-2 overflow-hidden rounded-xs bg-zinc-900 max-lg:p-2 lg:block"
      // Short windows: the 4:3 photo is no wider than the room the dialog leaves for it, but never so small that the
      // tool column stops fitting; the dialog scrolls instead.
      style={{ maxWidth: 'max(720px, calc((100dvh - 300px) * 4 / 3))' }}
    >
      {frame}
      <div className="flex flex-col gap-2 max-lg:order-1 lg:pointer-events-none lg:absolute lg:left-3 lg:top-3 lg:z-10 lg:max-h-[calc(100%-96px)] lg:items-start lg:overflow-y-auto">{topLeft}</div>
      <div
        className="flex flex-col gap-2 max-lg:order-3 lg:pointer-events-none lg:absolute lg:right-3 lg:top-3 lg:z-10 lg:w-[236px] lg:overflow-y-auto"
        style={{ maxHeight: `calc(100% - ${ATTRIBUTION_PCT} - 24px)` }}
      >
        {topRight}
      </div>
      <div
        className="max-lg:order-2 lg:pointer-events-none lg:absolute lg:left-3 lg:z-10 lg:max-w-[calc(100%-24px)]"
        style={{ bottom: `calc(${ATTRIBUTION_PCT} + 10px)` }}
      >
        {bottomLeft}
      </div>
    </div>
  );
}

export function GlassTitle({ title, note }) {
  return (
    <GlassPanel className="lg:max-w-[300px]">
      <div className="text-16 font-medium">{title}</div>
      <div className="text-14">{note}</div>
    </GlassPanel>
  );
}

// A 12 px legend swatch (8 px plus a 2 px border).
const SWATCH = { boxSizing: 'content-box', width: 8, height: 8 };
const dot = (style) => <i aria-hidden="true" className="mr-2 inline-block shrink-0 rounded-full align-middle" style={{ ...SWATCH, ...style }} />;

export function GlassLegend() {
  return (
    <GlassPanel data-testid="layout-legend" className="grid gap-1 text-14">
      <span>{dot({ background: '#0b6fb8', border: '2px solid #fff' })}Nozzle (number = walking order)</span>
      <span>{dot({ background: '#f59e0b', border: '2px solid #92400e' })}Near water or no-mist zone</span>
      <span>
        <svg aria-hidden="true" viewBox="0 0 24 12" width="24" height="12" className="mr-1 inline-block align-middle">
          <line x1="1" y1="6" x2="14" y2="6" stroke="#7dd3fc" strokeWidth="3" strokeLinecap="round" />
          <polygon points="23,6 13,1 13,11" fill="#7dd3fc" />
        </svg>
        Arrow = spray direction
      </span>
      <span>{dot({ background: '#b87333', border: '2px solid #fff' })}Riser</span>
      <span>{dot({ background: '#1d4ed8', borderRadius: 2, border: '2px solid #fff' })}Pump</span>
      <span>{dot({ background: 'rgba(220,38,38,0.35)', border: '2px dashed #dc2626' })}No-mist zone</span>
    </GlassPanel>
  );
}
