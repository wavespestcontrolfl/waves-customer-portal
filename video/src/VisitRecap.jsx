import { AbsoluteFill, Sequence, Audio, Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

export const RECAP_FPS = 30;
// Beat frames: intro / where / found+did / working / [progress] / next / outro.
// The before/after "progress" beat only renders when BOTH a before and an after
// clip exist, so the total length is media-dependent — recapDuration + Root's
// calculateMetadata keep the composition duration in sync.
const hasProgress = (media = []) => Boolean((media || []).find((m) => m.role === 'before') && (media || []).find((m) => m.role === 'after'));
function beatFrames(media = []) {
  return hasProgress(media)
    ? [90, 210, 180, 150, 150, 120, 90]
    : [90, 210, 180, 150, 120, 90];
}
export const recapDuration = (media = []) => beatFrames(media).reduce((a, b) => a + b, 0);

const C = {
  blue: '#009CDE', blueDeep: '#0E2148', blueMid: '#13346B', blueLight: '#E3F5FD',
  green: '#16A34A', orange: '#F59E0B', white: '#FFFFFF', ink: '#0B1B3B', mist: '#F4F8FB',
};
const FONT = '"Helvetica Neue", "Segoe UI", Arial, sans-serif';

const useEnter = (delay = 0, y = 50) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 200, mass: 0.8 } });
  return { opacity: p, transform: `translateY(${interpolate(p, [0, 1], [y, 0])}px)` };
};
const Eyebrow = ({ children, color = C.blue, delay = 0 }) => (
  <div style={{ ...useEnter(delay, 24), fontFamily: FONT, fontWeight: 800, fontSize: 30, letterSpacing: 6, textTransform: 'uppercase', color }}>{children}</div>
);
const Title = ({ children, color = C.ink, size = 84, delay = 6 }) => (
  <div style={{ ...useEnter(delay), fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.04, color, letterSpacing: -1 }}>{children}</div>
);
const Body = ({ children, color = '#3F4A65', size = 40, delay = 14 }) => (
  <div style={{ ...useEnter(delay), fontFamily: FONT, fontWeight: 500, fontSize: size, lineHeight: 1.35, color }}>{children}</div>
);
const Pad = ({ children, bg }) => (
  <AbsoluteFill style={{ background: bg, padding: '160px 90px', justifyContent: 'center', gap: 28 }}>{children}</AbsoluteFill>
);
const Wordmark = ({ color = C.white }) => (
  <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 38, letterSpacing: 8, color }}>WAVES <span style={{ fontWeight: 500, letterSpacing: 4, opacity: 0.7 }}>PEST CONTROL</span></div>
);

// ── media helpers — clips/photos slotted by tech tag (role), else animated fallback
const pickMedia = (media, roles) => (media || []).find((m) => roles.includes(m.role));
const MediaFill = ({ item }) => (
  <AbsoluteFill>
    {item.type === 'video'
      ? <OffthreadVideo src={item.src} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      : <Img src={item.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(8,16,40,.25) 30%, rgba(8,16,40,.85))' }} />
  </AbsoluteFill>
);
const MediaBeat = ({ item, eyebrow, caption }) => (
  <AbsoluteFill>
    <MediaFill item={item} />
    <AbsoluteFill style={{ padding: '0 80px 150px', justifyContent: 'flex-end', gap: 14 }}>
      <Eyebrow color={C.white} delay={4}>{eyebrow}</Eyebrow>
      <Title color={C.white} size={70} delay={10}>{caption}</Title>
    </AbsoluteFill>
  </AbsoluteFill>
);

// ── Beat 1: intro ──────────────────────────────────────────────────────────────
const Intro = ({ name, date }) => (
  <AbsoluteFill style={{ background: `linear-gradient(165deg, ${C.blueDeep}, ${C.blueMid} 60%, ${C.blue})`, padding: '160px 90px', justifyContent: 'center', gap: 30 }}>
    <div style={{ position: 'absolute', top: 120, left: 90 }}><Wordmark /></div>
    <Eyebrow color={C.blue} delay={4}>Your protection update</Eyebrow>
    <Title color={C.white} size={104} delay={10}>Hey {name},</Title>
    <Body color="#CFE8FA" size={46} delay={20}>here’s what we did at your home today.</Body>
    <div style={{ ...useEnter(30, 20), fontFamily: FONT, fontWeight: 700, fontSize: 36, color: C.blue }}>{date}</div>
  </AbsoluteFill>
);

// ── Beat 2: where we protected (real treating/area clip, else animated barrier) ──
const Barrier = ({ defense }) => {
  const frame = useCurrentFrame();
  const perimeter = (defense?.items || []).find((i) => i.key === 'perimeter_shield');
  const active = perimeter ? perimeter.status === 'active' : true;
  const nodes = (defense?.items || []).filter((i) => i.key !== 'perimeter_shield' && i.key !== 'pressure').slice(0, 4);
  const POS = { front_entry: [270, 410], lanai: [430, 290], pool_equipment_pad: [110, 290], garage: [150, 150] };
  const place = (key, i) => POS[key] || [270 + Math.cos(i) * 150, 290 + Math.sin(i) * 110];
  const NCOLOR = { active: C.green, clear: C.green, watched: C.orange };
  return (
    <svg viewBox="0 0 540 540" width="780" height="780" style={{ margin: '0 auto' }}>
      {[70, 120, 168, 212].map((r, i) => {
        const p = interpolate(frame, [10 + i * 7, 34 + i * 7], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const pulse = 1 + 0.012 * Math.sin((frame - i * 6) / 14);
        return <ellipse key={i} cx="270" cy="290" rx={r * 1.18 * pulse} ry={r * pulse} fill="none" stroke={C.blue} strokeWidth="3.5" strokeOpacity={(0.9 - i * 0.18) * p} strokeDasharray={active ? undefined : '8 9'} />;
      })}
      <polygon points="270,196 224,238 316,238" fill={C.blueDeep} />
      <rect x="232" y="238" width="76" height="54" rx="6" fill={C.blueDeep} />
      <rect x="262" y="262" width="16" height="30" rx="2" fill={C.white} />
      {nodes.map((n, i) => {
        const [x, y] = place(n.key, i);
        const p = spring({ frame: frame - (40 + i * 9), fps: 30, config: { damping: 120 } });
        const col = NCOLOR[n.status] || C.blue;
        return (
          <g key={n.key} opacity={p} transform={`translate(${x} ${y}) scale(${0.6 + 0.4 * p})`}>
            <circle r="14" fill={C.white} stroke={col} strokeWidth="5" /><circle r="5" fill={col} />
            <text x="0" y="36" textAnchor="middle" fontFamily={FONT} fontWeight="700" fontSize="22" fill={C.ink}>{n.label}</text>
          </g>
        );
      })}
    </svg>
  );
};
const WhereWeProtected = ({ pestReportV2, media }) => {
  const clip = pickMedia(media, ['treating', 'area']);
  if (clip) return <MediaBeat item={clip} eyebrow="What we did" caption={clip.caption || 'Protecting your home'} />;
  return (
    <AbsoluteFill style={{ background: C.mist, padding: '120px 70px', justifyContent: 'flex-start', gap: 6 }}>
      <div style={{ marginTop: 30 }}><Eyebrow delay={2}>Where we protected</Eyebrow></div>
      <Title size={66} delay={8}>{pestReportV2.defense?.summary?.includes('strong') ? 'Your home is protected' : 'Barrier active around your home'}</Title>
      <Barrier defense={pestReportV2.defense} />
    </AbsoluteFill>
  );
};

// ── Beat 3: what we found & did (real pest clip, else text) ──────────────────────
const FoundAndDid = ({ pestReportV2, media }) => {
  const clip = pickMedia(media, ['pest']);
  const bug = (pestReportV2.bugFiles || [])[0];
  if (clip) return <MediaBeat item={clip} eyebrow="What we found" caption={clip.caption || (bug ? `${bug.suspectLabel} — handled` : 'Caught on camera')} />;
  return (
    <Pad bg={C.white}>
      <Eyebrow color={C.orange} delay={2}>What we found &amp; did</Eyebrow>
      {bug ? (
        <>
          <Title size={88} delay={8}>{bug.suspectLabel}</Title>
          <Body size={40} delay={16}>{bug.whereSeen ? `Spotted at the ${bug.whereSeen.toLowerCase()}.` : ''} {bug.whyItMatters}</Body>
          <div style={{ ...useEnter(30, 20), marginTop: 18, display: 'flex', alignItems: 'center', gap: 18 }}>
            <span style={{ background: C.green, color: C.white, fontFamily: FONT, fontWeight: 800, fontSize: 34, padding: '14px 28px', borderRadius: 999 }}>Treated</span>
            <span style={{ fontFamily: FONT, fontWeight: 500, fontSize: 32, color: '#3F4A65' }}>{bug.whatWeDid}</span>
          </div>
        </>
      ) : (
        // "All clear" only when the protection status is actually good — bugFiles
        // can be empty while the status is still watch/action with a next step.
        pestReportV2.status?.tone === 'good'
          ? <Title size={80} delay={8}>No pest activity today — all clear.</Title>
          : (
            <>
              <Title size={64} delay={8}>{pestReportV2.statusSummary || 'Here’s what we’re keeping an eye on.'}</Title>
              {pestReportV2.primaryMove?.title ? <Body size={36} delay={18}>Your next step: {pestReportV2.primaryMove.title}</Body> : null}
            </>
          )
      )}
    </Pad>
  );
};

// ── Beat 4: it's working ─────────────────────────────────────────────────────────
const ItsWorking = ({ pestReportV2 }) => {
  const frame = useCurrentFrame();
  const down = (pestReportV2.pressureReceipt?.stats || []).find((s) => /pressure down/i.test(s.label));
  const metric = pestReportV2.supportingMetric;
  const big = down ? `−${String(down.value).replace(/[-−]/g, '')}` : (metric?.score != null ? metric.score : '✓');
  const pop = spring({ frame: frame - 8, fps: 30, config: { damping: 12, mass: 1.2 } });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${C.green}, #0E7A3A 70%, ${C.blueDeep})`, padding: '160px 90px', justifyContent: 'center', gap: 18 }}>
      <Eyebrow color="#BBF7D0" delay={2}>It’s working</Eyebrow>
      <div style={{ transform: `scale(${0.4 + 0.6 * pop})`, opacity: interpolate(pop, [0, 1], [0, 1]), fontFamily: FONT, fontWeight: 900, fontSize: 240, color: C.white, lineHeight: 1, letterSpacing: -4 }}>{big}</div>
      <Title color={C.white} size={56} delay={22}>{down
        ? 'Pest pressure, down since you started.'
        : (metric?.label ? `Pressure is ${metric.label.toLowerCase()} and holding.` : 'Your protection is active and holding.')}</Title>
    </AbsoluteFill>
  );
};

// ── Beat 5: what's next ──────────────────────────────────────────────────────────
const WhatsNext = ({ pestReportV2 }) => {
  const f = pestReportV2.forecast;
  const top = (f?.pests || [])[0];
  // Honest wording from the pest's actual trend (not always "rising").
  const trendWord = top?.trend === 'up' ? 'pressure rising' : top?.trend === 'down' ? 'pressure easing' : 'steady this month';
  const trendColor = top?.trend === 'down' ? C.green : top?.trend === 'up' ? C.orange : '#CFE8FA';
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${C.blueDeep}, ${C.blueMid})`, padding: '160px 90px', justifyContent: 'center', gap: 22 }}>
      <Eyebrow color={C.blue} delay={2}>What’s coming{f?.monthName ? ` in ${f.monthName}` : ''}</Eyebrow>
      {top ? (
        <div style={{ ...useEnter(10, 30) }}>
          <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 64, color: C.white }}>{top.label}</div>
          <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: 34, color: trendColor, textTransform: 'capitalize' }}>{top.level} · {trendWord}</div>
        </div>
      ) : null}
      <Body color="#CFE8FA" size={40} delay={24}>{f?.headline || 'We’ll keep your barrier strong through the season.'}</Body>
      <div style={{ ...useEnter(34, 20), marginTop: 16, fontFamily: FONT, fontWeight: 700, fontSize: 38, color: C.white }}>We’ve got it handled — see you next visit.</div>
    </AbsoluteFill>
  );
};

const Outro = () => (
  <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, ${C.blueMid}, ${C.blueDeep})`, justifyContent: 'center', alignItems: 'center', gap: 36 }}>
    <div style={useEnter(4, 30)}><Wordmark /></div>
    <Title color={C.white} size={66} delay={12}>See activity? Just text us.</Title>
    <div style={{ ...useEnter(24, 20), fontFamily: FONT, fontWeight: 600, fontSize: 34, color: C.blue }}>Tap to share your protection</div>
  </AbsoluteFill>
);

// ── Beat: before / after progress (only when both clips exist) ───────────────────
const BeforeAfterBeat = ({ before, after }) => {
  const e0 = useEnter(8, 30);
  const e1 = useEnter(14, 30);
  const cols = [{ m: before, label: 'Before', e: e0 }, { m: after, label: 'After', e: e1 }];
  return (
    <AbsoluteFill style={{ background: C.ink, padding: '120px 60px', justifyContent: 'center', gap: 22 }}>
      <Eyebrow color={C.blue} delay={2}>Your progress</Eyebrow>
      <div style={{ display: 'flex', gap: 18 }}>
        {cols.map((col, i) => (
          <div key={i} style={{ ...col.e, flex: 1 }}>
            <div style={{ width: '100%', aspectRatio: '3 / 4', borderRadius: 16, overflow: 'hidden', background: '#000' }}>
              {col.m.type === 'video'
                ? <OffthreadVideo src={col.m.src} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <Img src={col.m.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </div>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 36, color: C.white, marginTop: 12, textAlign: 'center' }}>{col.label}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const VisitRecap = ({ data, media = [], music = false }) => {
  const p = data.pestReportV2;
  const before = (media || []).find((m) => m.role === 'before');
  const after = (media || []).find((m) => m.role === 'after');
  const frames = beatFrames(media);
  // Best-shot: one clip per beat (first match wins; recency/relevance ordering is
  // applied server-side in getMediaForRecap). Each beat self-falls-back to the
  // animated version when no matching clip exists.
  const nodes = [
    <Intro name={data.customerName} date={data.serviceDate} />,
    <WhereWeProtected pestReportV2={p} media={media} />,
    <FoundAndDid pestReportV2={p} media={media} />,
    <ItsWorking pestReportV2={p} />,
    ...(before && after ? [<BeforeAfterBeat before={before} after={after} />] : []),
    <WhatsNext pestReportV2={p} />,
    <Outro />,
  ];
  let cursor = 0;
  return (
    <AbsoluteFill style={{ background: C.blueDeep }}>
      {music ? <Audio src={staticFile('music.mp3')} volume={0.4} /> : null}
      {nodes.map((node, i) => {
        const from = cursor;
        cursor += frames[i];
        return <Sequence key={i} from={from} durationInFrames={frames[i]}>{node}</Sequence>;
      })}
    </AbsoluteFill>
  );
};
