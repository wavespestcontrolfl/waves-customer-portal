/* Waves Liquid Glass preview — full pipeline v2 (scene, glass, type, offer repositioning, extras).
   Idempotent: safe to inject repeatedly; self-heals via MutationObserver. */
(function () {
  const CSS = `
:root{--font-sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Inter","Helvetica Neue",Arial,sans-serif;--tp:rgba(9,16,31,.94);--ts:rgba(12,21,40,.70);--tt:rgba(12,21,40,.52);--glass-bg:rgba(255,255,255,.32);--glass-border:rgba(255,255,255,.62);--glass-blur:32px;--glass-sat:185%;--spring:cubic-bezier(.34,1.56,.64,1);--accent:10,126,194;--brand:#04395E}
html{scroll-behavior:smooth}
*:not(svg):not(path){font-family:var(--font-sans) !important;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1{font-size:clamp(2.4rem,4.5vw,3.3rem) !important;font-weight:700 !important;line-height:1.04 !important;letter-spacing:-0.035em !important;color:var(--brand) !important}
h2{font-size:clamp(1.6rem,2.6vw,2rem) !important;font-weight:600 !important;line-height:1.1 !important;letter-spacing:-0.03em !important;color:var(--brand) !important}
h3,h4{font-weight:600 !important;line-height:1.18 !important;letter-spacing:-0.02em !important;color:var(--brand) !important}
button,button *{font-weight:600 !important;letter-spacing:0 !important}
[data-type="eyebrow"]{font-size:12px !important;font-weight:700 !important;letter-spacing:.11em !important;line-height:1.2 !important;color:var(--ts) !important;text-transform:uppercase}
[data-contact],[data-contact] *{font-weight:700 !important}
#smart-cta-row{display:flex;justify-content:center;margin-top:20px}
[data-stattile] *{font-size:15px !important}
[data-stattile] [data-type="eyebrow"]{font-size:11px !important}
[data-type="metric"]{font-weight:700 !important;letter-spacing:-0.035em !important;line-height:1 !important;font-variant-numeric:tabular-nums !important;color:var(--brand) !important}
[data-type="fine"]{font-size:11.5px !important;line-height:1.45 !important;font-weight:400 !important;letter-spacing:.005em !important;color:var(--tt) !important}
[data-type="body"]{line-height:1.5 !important;letter-spacing:-0.005em !important}
[data-type="h2x"]{font-size:clamp(1.6rem,2.6vw,2rem) !important;font-weight:600 !important;line-height:1.1 !important;letter-spacing:-0.03em !important;color:var(--brand) !important}
[data-type="h3x"]{font-size:1.35rem !important;font-weight:600 !important;line-height:1.18 !important;letter-spacing:-0.02em !important;color:var(--brand) !important}
[data-type="excerpt"]{font-size:15px !important;font-weight:400 !important;line-height:1.55 !important;letter-spacing:-0.005em !important;color:hsl(216,42%,36%) !important;max-width:62ch}
[data-price-row]{display:flex !important;align-items:baseline !important;gap:.4em;flex-wrap:wrap}
[data-glass]{background:linear-gradient(135deg,rgba(255,255,255,.30),rgba(255,255,255,.08)),var(--glass-bg) !important;border:1px solid var(--glass-border) !important;backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-sat)) !important;-webkit-backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-sat)) !important;transition:transform 480ms var(--spring),box-shadow 480ms var(--spring),border-color 320ms ease,background 320ms ease !important;box-shadow:0 28px 90px rgba(4,57,94,.18),0 5px 18px rgba(4,57,94,.07),inset 0 1px 0 rgba(255,255,255,.52),inset 0 -1px 0 rgba(255,255,255,.08),inset 1px 1px 0 rgba(175,225,255,.32),inset -1px -1px 0 rgba(255,210,160,.20) !important}
[data-glass="soft"]{background:linear-gradient(135deg,rgba(255,255,255,.38),rgba(255,255,255,.15)),var(--glass-bg) !important;backdrop-filter:blur(18px) saturate(165%) !important;-webkit-backdrop-filter:blur(18px) saturate(165%) !important;box-shadow:0 8px 26px rgba(4,57,94,.08),inset 0 1px 0 rgba(255,255,255,.48),inset 1px 1px 0 rgba(175,225,255,.22),inset -1px -1px 0 rgba(255,210,160,.14) !important}
[data-glass="chip"]{background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.10)),rgba(255,255,255,.22) !important;backdrop-filter:blur(18px) saturate(170%) !important;-webkit-backdrop-filter:blur(18px) saturate(170%) !important;box-shadow:inset 0 1px 0 rgba(255,255,255,.42),0 8px 22px rgba(4,57,94,.10),inset 1px 1px 0 rgba(175,225,255,.24) !important}
[data-glass]::before{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;background:radial-gradient(280px circle at var(--mx,22%) var(--my,-8%),rgba(255,255,255,.30),rgba(255,255,255,.10) 22%,transparent 50%);opacity:0;transition:opacity 240ms ease;z-index:1}
[data-glass]:hover::before{opacity:.65}
[data-glass]::after{content:"";position:absolute;inset:1px;pointer-events:none;border-radius:inherit;background:linear-gradient(135deg,rgba(255,255,255,.42),transparent 22%,transparent 70%,rgba(255,255,255,.14));mix-blend-mode:screen;opacity:.55;z-index:1}
[data-glass="card"]:hover{transform:translateY(-4px) scale(1.016);border-color:rgba(255,255,255,.8) !important;box-shadow:0 36px 110px rgba(4,57,94,.24),0 0 44px rgba(var(--accent),.16),inset 0 1px 0 rgba(255,255,255,.62),inset 1px 1px 0 rgba(175,225,255,.4) !important}
[data-glass="card"]:hover:has(button:hover,a:hover,select:hover,input:hover,[data-glass]:hover){transform:none;border-color:var(--glass-border) !important;box-shadow:0 28px 90px rgba(4,57,94,.18),0 5px 18px rgba(4,57,94,.07),inset 0 1px 0 rgba(255,255,255,.52),inset 0 -1px 0 rgba(255,255,255,.08),inset 1px 1px 0 rgba(175,225,255,.32),inset -1px -1px 0 rgba(255,210,160,.20) !important}
[data-glass="card"]:hover:has(button:hover,a:hover,select:hover,input:hover,[data-glass]:hover)::before{opacity:0}
button:not([data-glass]):not([data-glass-accent]):not(.freq-btn):not(#mbb-btn){transition:filter .2s ease,transform .2s ease}
button:not([data-glass]):not([data-glass-accent]):not(.freq-btn):not(#mbb-btn):hover{filter:brightness(1.15);transform:translateY(-1px)}
[data-glass="chip"]:hover{transform:translateY(-1px);background:linear-gradient(135deg,rgba(255,255,255,.44),rgba(255,255,255,.16)),rgba(255,255,255,.3) !important;box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 10px 26px rgba(4,57,94,.13),0 0 22px rgba(var(--accent),.20) !important}
[data-glass="chip"]:active{transform:scale(.97)}
[data-glass="card"]:active{transform:translateY(-1px) scale(.994)}
[data-glass]:focus-visible{outline:2px solid rgba(var(--accent),.9);outline-offset:3px;box-shadow:0 0 0 5px rgba(var(--accent),.18),0 16px 48px rgba(4,57,94,.16) !important}
[data-glass-accent]{background:linear-gradient(135deg,rgba(255,222,120,.60),rgba(244,176,20,.45)),rgba(240,165,0,.38) !important;border:1px solid rgba(255,238,180,.92) !important;backdrop-filter:blur(18px) saturate(175%) !important;-webkit-backdrop-filter:blur(18px) saturate(175%) !important;box-shadow:0 12px 32px rgba(180,110,0,.28),0 0 36px rgba(240,165,0,.46),inset 0 1px 0 rgba(255,255,255,.65),inset 0 -2px 8px rgba(180,110,0,.22),inset 1px 1px 0 rgba(255,246,210,.5) !important;overflow:hidden;transition:transform 300ms var(--spring),box-shadow 300ms ease !important;position:relative}
[data-glass-accent],[data-glass-accent] *{color:#1B2C5B !important;fill:#1B2C5B}
[data-glass-accent]::before{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;background:radial-gradient(240px circle at var(--mx,25%) var(--my,-10%),rgba(255,255,255,.35),rgba(255,255,255,.12) 24%,transparent 50%);opacity:0;transition:opacity 240ms ease}
[data-glass-accent]:hover::before{opacity:.7}
[data-glass-accent]::after{content:"";position:absolute;inset:1px;pointer-events:none;border-radius:inherit;background:linear-gradient(180deg,rgba(255,255,255,.45),transparent 40%);opacity:.6}
[data-glass-accent]:hover{transform:translateY(-1px);box-shadow:0 16px 42px rgba(180,110,0,.34),0 0 52px rgba(240,165,0,.6),inset 0 1px 0 rgba(255,255,255,.75) !important}
[data-glass-accent]:active{transform:scale(.97)}
[data-glass-accent]:disabled{opacity:.55;box-shadow:0 6px 18px rgba(180,110,0,.18),inset 0 1px 0 rgba(255,255,255,.5) !important}
#cta-micro{font-size:14px !important;line-height:1.4;color:hsl(216,42%,34%) !important;font-weight:500 !important;text-align:center;margin-top:12px !important}
#hero-sub{font-size:16px;font-weight:400;line-height:1.55;letter-spacing:-0.005em;color:hsl(216,42%,32%);max-width:56ch;margin:14px 0 4px}
#price-perday{font-size:14px;font-weight:500;line-height:1.4;color:hsl(216,42%,34%);margin:6px 0 2px}
#mobile-book-bar{position:fixed;left:12px;right:12px;bottom:12px;z-index:80;display:none;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px 10px 20px;border-radius:999px;background:linear-gradient(135deg,rgba(255,255,255,.5),rgba(255,255,255,.2)),rgba(255,255,255,.4);backdrop-filter:blur(22px) saturate(180%);-webkit-backdrop-filter:blur(22px) saturate(180%);border:1px solid rgba(255,255,255,.7);box-shadow:0 12px 36px rgba(4,57,94,.24),inset 0 1px 0 rgba(255,255,255,.6)}
@media (max-width:640px){#mobile-book-bar{display:flex}}
#mbb-btn{border:1px solid rgba(255,238,180,.95);border-radius:999px;padding:11px 20px;font-weight:600;font-size:15px;color:#1B2C5B !important;background:linear-gradient(135deg,rgba(255,222,120,.9),rgba(244,176,20,.78));box-shadow:0 6px 18px rgba(180,110,0,.3),inset 0 1px 0 rgba(255,255,255,.6);cursor:pointer;white-space:nowrap}
#slot-scarcity{display:inline-flex;align-items:center;gap:8px;margin:0 0 12px;padding:8px 16px;border-radius:999px;font-size:14px;font-weight:600;color:#7A4E00;background:linear-gradient(135deg,rgba(255,230,150,.6),rgba(244,176,20,.35));border:1px solid rgba(240,165,0,.5);backdrop-filter:blur(14px) saturate(170%);-webkit-backdrop-filter:blur(14px) saturate(170%);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 6px 16px rgba(180,110,0,.15)}
#freq-buttons{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
@media (max-width:640px){#freq-buttons{flex-direction:column}}
.freq-btn{flex:1;min-width:120px;padding:13px 18px;border-radius:999px;font-size:15px;font-weight:600;color:#04395E !important;cursor:pointer;border:1px solid rgba(255,255,255,.65);background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.10)),rgba(255,255,255,.22);backdrop-filter:blur(18px) saturate(170%);-webkit-backdrop-filter:blur(18px) saturate(170%);box-shadow:inset 0 1px 0 rgba(255,255,255,.42),0 8px 22px rgba(4,57,94,.10);transition:transform .3s var(--spring),box-shadow .3s ease,background .3s ease}
.freq-btn:hover{transform:translateY(-1px)}
.freq-btn[data-active]{background:linear-gradient(135deg,rgba(255,222,120,.62),rgba(244,176,20,.46)),rgba(240,165,0,.38);border-color:rgba(255,238,180,.92);color:#1B2C5B !important;box-shadow:0 8px 22px rgba(180,110,0,.25),0 0 26px rgba(240,165,0,.35),inset 0 1px 0 rgba(255,255,255,.6)}
[data-glass] input,[data-glass] select,[data-glass] textarea{position:relative;z-index:2}
#svc-hint{font-size:13.5px;font-weight:600;color:#0A7EC2;margin-top:8px;cursor:pointer;user-select:none;display:inline-block}
#svc-hint:hover{text-decoration:underline}
.svc-hidden{display:none !important}
#guarantee-block{text-align:center;padding:26px 28px;margin:18px auto;max-width:720px}
#guarantee-block .gb-title{font-size:1.35rem;font-weight:600;letter-spacing:-0.02em;color:var(--brand);margin-bottom:8px}
#guarantee-block .gb-body{font-size:15px;line-height:1.55;color:hsl(216,42%,32%);max-width:52ch;margin:0 auto}
#guarantee-block .gb-fine{font-size:13px;font-weight:500;color:hsl(216,42%,40%);margin-top:10px}
[data-slot-selected]{background:linear-gradient(135deg,rgba(255,222,120,.62),rgba(244,176,20,.46)),rgba(240,165,0,.38) !important;border-color:rgba(255,238,180,.92) !important;box-shadow:0 8px 22px rgba(180,110,0,.25),0 0 26px rgba(240,165,0,.35),inset 0 1px 0 rgba(255,255,255,.6) !important}
.slot-priority{display:inline-flex;align-items:center;gap:5px;margin:4px 0 2px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#7A4E00;background:linear-gradient(135deg,rgba(255,230,150,.85),rgba(244,176,20,.55));border:1px solid rgba(240,165,0,.55);width:max-content}
.freq-btn{position:relative}
.freq-rec{position:absolute;top:-10px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;padding:3px 9px;border-radius:999px;background:#04395E;color:#fff !important;white-space:nowrap;box-shadow:0 4px 10px rgba(4,57,94,.3)}
#freq-buttons{margin-top:18px}
#tech-chip{display:flex;align-items:center;gap:12px;margin:2px 0 14px;padding:9px 16px 9px 10px;border-radius:999px;width:max-content;max-width:100%;font-size:14px;color:hsl(216,42%,30%);background:linear-gradient(135deg,rgba(255,255,255,.4),rgba(255,255,255,.15)),rgba(255,255,255,.3);border:1px solid rgba(255,255,255,.6);backdrop-filter:blur(16px) saturate(170%);-webkit-backdrop-filter:blur(16px) saturate(170%);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 8px 20px rgba(4,57,94,.08)}
#tech-chip .tc-avatar{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#0A7EC2,#04395E);color:#fff;font-weight:700;font-size:17px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
[data-glass].reveal-pending{opacity:0 !important;transform:translateY(16px) !important}
[data-glass].reveal-in{transition:transform .6s var(--spring),box-shadow .5s var(--spring),opacity .6s ease,border-color .3s ease !important}
.confetti-bit{position:fixed;width:9px;height:9px;border-radius:2px;pointer-events:none;z-index:200}
@media (prefers-reduced-motion:reduce){[data-glass].reveal-pending{opacity:1 !important;transform:none !important}}
#app-visual{display:flex;gap:38px;align-items:center;margin-top:20px}
@media (max-width:700px){#app-visual{flex-direction:column}}
.av-left{position:relative;flex:0 0 auto;padding:24px}
.av-glow{position:absolute;inset:-14px;background:radial-gradient(closest-side,rgba(240,165,0,.28),rgba(10,126,194,.20),transparent 75%);filter:blur(28px);z-index:0}
.av-phone{position:relative;width:264px;border-radius:38px;border:9px solid #12264A;box-shadow:0 30px 70px rgba(4,57,94,.35),inset 0 1px 0 rgba(255,255,255,.25);transform:rotate(-4deg);transition:transform .5s var(--spring);z-index:1;display:block}
#app-visual:hover .av-phone{transform:rotate(-1deg) translateY(-6px)}
.av-right{flex:1;min-width:250px}
.av-chips{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0 18px}
.av-chip{padding:10px 16px;border-radius:999px;font-size:14px;font-weight:600;color:#04395E;background:linear-gradient(135deg,rgba(255,255,255,.40),rgba(255,255,255,.14)),rgba(255,255,255,.30);border:1px solid rgba(255,255,255,.6);backdrop-filter:blur(14px) saturate(170%);-webkit-backdrop-filter:blur(14px) saturate(170%);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 6px 16px rgba(4,57,94,.08)}
#review-marquee{overflow:hidden;position:relative;margin-top:10px}
.rm-track{display:flex;gap:16px;width:max-content;animation:rmScroll 38s linear infinite}
.ps-track{display:flex;gap:44px;width:max-content;animation:rmScroll 34s linear infinite;padding:0 18px}
#proof-strip:hover .ps-track{animation-play-state:paused}
.ps-item{display:inline-flex;align-items:center;gap:9px;white-space:nowrap;font-size:14px;color:hsl(216,42%,32%)}
#review-marquee:hover .rm-track{animation-play-state:paused}
#review-marquee,#review-marquee *{font-family:Roboto,Arial,'Helvetica Neue',sans-serif !important}
.rm-card{width:340px;flex:0 0 auto;padding:16px;border-radius:8px;background:#fff;border:1px solid #dadce0;box-shadow:0 1px 3px rgba(60,64,67,.12)}
.gr-head{display:flex;align-items:center;gap:10px}
.gr-avatar{width:40px;height:40px;border-radius:50%;color:#fff !important;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:500;flex:0 0 auto}
.gr-id{display:flex;flex-direction:column;flex:1;min-width:0}
.gr-name{font-size:14px;font-weight:500;color:#202124 !important}
.gr-date{font-size:12px;color:#5f6368 !important}
.gr-stars{color:#FBBC04 !important;font-size:15px;letter-spacing:1.5px;margin:8px 0 6px}
.gr-text{font-size:14px;line-height:1.45;color:#202124 !important;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
[data-footer],[data-footer] *{color:#04395E !important}
[data-footer] svg,[data-footer] svg *{fill:#04395E !important}
[data-footer] a{font-weight:500}
[data-slot-stale]{opacity:.45 !important;pointer-events:none;filter:saturate(.5)}
.tc-photo{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:0 0 auto;box-shadow:0 2px 6px rgba(4,57,94,.25)}
#av-badge{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
@keyframes rmScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.rm-track{animation:none}[data-glass],[data-glass-accent]{transition:none !important}[data-glass]:hover,[data-glass-accent]:hover{transform:none !important}}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){[data-glass],[data-glass="soft"],[data-glass="chip"]{background:rgba(255,255,255,.93) !important}}`;

  const HERO_H1 = '{firstName}, your pest-free home plan is ready.';
  const HERO_SUB = 'We can start protecting your home as soon as tomorrow — quarterly exterior protection, interior treatment when needed, unlimited free callbacks, and a 90-day money-back guarantee.';
  const PERDAY = 'That’s about $1.07/day — less than a gas-station drink for year-round protection.';
  const SAT_H2 = 'Your price was built from your home — not somebody else’s average';
  const SAT_EX = 'We didn’t guess. We measured your home, lot, roofline, and access points so your plan fits your actual property — not a generic average.';
  const ASK_H2 = 'Still deciding? Ask anything — instant answers.';
  const ASK_EX = 'Ask about pricing, treatments, scheduling, pets, kids, or what happens after approval — straight answers in seconds.';
  const SCHED_H2 = 'Lock in your spot — openings as soon as today';
  const SCHED_EX = 'Our soonest openings — and if we’re already on your street that day, snag it and skip the line.';
  const CUST_H2 = 'It’s all included — no upsells, no nickel-and-diming';
  const CUST_EX = 'Your plan already includes the treatments most homes need. Prefer exterior-only? Adjust anytime before your visit.';
  const APP_H2 = 'Stop waiting around for service windows — watch your tech drive to your door, live';
  const APP_EX = 'Where’s the tech? Check your phone. What did we treat? Check your phone. Live GPS, photo reports, alerts you control.';
  const REV_EX = 'Real Google reviews — unedited, unfiltered, from people whose backyards look like yours.';
  const HH_EX = 'One login for the whole household — everyone in the loop, nobody playing messenger.';
  const LAWN_T = 'Add Lawn Care — save on both services';
  const LAWN_B = 'Bundling bumps you up to WaveGuard Silver: 10% off your pest control AND your lawn care, on every visit.';
  const CTA_MAIN = 'Approve my plan and schedule';
  const CTA_BOOK = 'Book my first visit';
  const MICRO = 'No long-term contract · Unlimited free callbacks · 90-day money-back guarantee';
  const B_PREMIUM = 'Premium non-repellent + repellent solutions, matched to the target pest';
  const B_PERIM = 'Protected 4× a year — full perimeter, entry points, eaves & harborage zones, every visit';
  const B_INTERIOR = 'Interior treatment included — no awkward upsell, no surprise charge';
  const B_CALLBACK = 'If pests come back, so do we — unlimited free callbacks, 100% guaranteed';
  const B_GUARANTEE = '90-day money-back guarantee — if you don’t love it, you don’t pay';
  const B_CONTRACT = 'No long-term contract — stay because it works, not because you’re trapped';
  const B_SETUP = '$99 setup disappears with annual billing — waived instantly';

  const COPY = {
    'Hello {firstName}, your estimate is ready!': HERO_H1,
    '{firstName}, your custom protection plan is ready — book it in 60 seconds.': HERO_H1,
    'YOUR ESTIMATE': 'YOUR PEST-FREE HOME PLAN',
    '· QUARTERLY PEST CONTROL': '',
    'Waves AI reviewed your property before pricing this estimate': SAT_H2,
    'Priced for your exact home — not a one-size-fits-all guess': SAT_H2,
    'Why your price is custom': SAT_H2,
    'Waves AI reviews satellite imagery, property records, and visible service areas to show the details behind your WaveGuard plan.': SAT_EX,
    'We studied your roofline, lot, and entry points before quoting — so you pay for exactly what your home needs, nothing more.': SAT_EX,
    'We measured your roofline, lot, and entry points before pricing this — you pay for your home, not your neighbor’s.': SAT_EX,
    'Ask Waves anything — instant answers': ASK_H2,
    'It knows your exact quote — ask about pricing, treatments, or scheduling and get a straight answer in seconds. No hold music, no waiting on a callback.': ASK_EX,
    'It’s already read your quote so you don’t have to — straight answers on pricing, treatments, and scheduling in seconds. Zero hold music.': ASK_EX,
    'Find a date & time that works for you': SCHED_H2,
    'Lock in your spot — openings as soon as tomorrow': SCHED_H2,
    'Included in your plan': CUST_H2,
    'Have a question before booking?': ASK_H2,
    '13649 Luxe Ave #110, Bradenton, FL 34211': 'Bradenton · Parrish · Sarasota · Venice',
    'These are the soonest open service windows we can offer. Nearby route days are marked when a tech is already close by.': SCHED_EX,
    'The soonest openings we have — when a tech is already routed near your street, grab that day and you get priority arrival.': SCHED_EX,
    "Skip parts you don't need": CUST_H2,
    'Skip parts you don’t need': CUST_H2,
    'Only pay for what your home needs': CUST_H2,
    'These are on by default. Toggle off whatever you don’t want and the price adjusts instantly.': CUST_EX,
    "These are on by default. Toggle off whatever you don't want and the price adjusts instantly.": CUST_EX,
    'You’re in control: toggle off anything you don’t need and watch the price drop instantly.': CUST_EX,
    'Your home, your call — flip off anything you don’t need and watch the price drop on the spot.': CUST_EX,
    'Watch every visit — right from your phone': APP_H2,
    'Never wonder again — watch every visit live from your phone': APP_H2,
    'Live GPS, visit reports, and alerts you control — the Waves app keeps you in the loop from booking to done.': APP_EX,
    'Know exactly when we arrive, what we did, and what it cost — live GPS, photo reports, and alerts you control.': APP_EX,
    'Customer reviews': 'See why your neighbors switched to Waves',
    'Real Google reviews from homeowners across our service area.': REV_EX,
    'Real Google reviews — unedited, from homeowners near you.': REV_EX,
    'One login for your whole household — everything in one place.': HH_EX,
    'Add Lawn Care and save more': LAWN_T,
    'Bundling lawn care with your current service can unlock the next WaveGuard pricing tier.': LAWN_B,
    'Exterior perimeter protection around entry-prone areas': B_PREMIUM,
    'Interior service support when activity is reported': B_PERIM,
    'Free re-service between recurring visits': B_CALLBACK,
    'Full-perimeter treatment: entry points, eaves & harborage zones, every visit': B_PERIM,
    '100% guaranteed — free unlimited callbacks between visits': B_CALLBACK,
    '90-day money-back guarantee — love your service or pay nothing': B_GUARANTEE,
    '$99 one-time setup — waived instantly when you pay the year up front': B_SETUP,
    'Waived when you pay the year in full up front.': 'Pay the year up front and we waive it — instantly.',
    '4 applications/year - WaveGuard Bronze': '4 applications/year · WaveGuard Home Protection',
    'Get service today!': CTA_MAIN,
    'Get protected today!': CTA_MAIN,
    'Book today!': CTA_BOOK,
    'Book my visit today!': CTA_BOOK,
    'Add Lawn Care': 'Add Lawn Care — unlock 10% off',
    'Questions? Call Waves': 'Call us — talk to a real person',
    'Questions? Text Waves!': 'Text us — fast answers',
    'How do you handle ants?': 'Is this safe for pets and kids?',
    'What happens after approval?': 'What if I still see bugs?'
  };
  const H2X = ['Find a date & time that works for you', 'Lock in your spot — openings as soon as tomorrow', SCHED_H2, "Skip parts you don't need", 'Skip parts you don’t need', 'Only pay for what your home needs', 'Included in your plan', CUST_H2];
  const H3X = ['It’s all in the Waves app', "It's all in the Waves app", LAWN_T, 'Add Lawn Care and save more'];
  const EXCERPTS = [SAT_EX, SCHED_EX, CUST_EX, APP_EX, REV_EX, HH_EX, LAWN_B, ASK_EX];
  const TINT = {
    'rgb(242, 238, 224)': 'rgba(244,239,224,.36)',
    'rgb(232, 244, 252)': 'rgba(222,240,252,.40)',
    'rgb(240, 247, 252)': 'rgba(235,246,252,.40)',
    'rgb(254, 247, 224)': 'rgba(254,247,224,.44)',
    'rgb(227, 245, 253)': 'rgba(222,242,253,.40)'
  };
  const REVIEWS = [
    ['Adam is the man. Great service and always answers the phone.', 'Jesse L.', 'Parrish', '2026-05-29'],
    ['Adam and Waves were wonderful. He helped us with an unsettling wasp problem in our rental home and made me feel so much better about everything when he was done. He was very kind and professional around kids and dogs and very thorough with his work!', 'Taryn H.', 'Bradenton', '2026-06-26'],
    ['Extremely professional and meticulous with checking locations for pest access points. Very responsive to communications before during and after. After the pests were neutralized the Wave staff returned and cleaned up everything.', 'Dan T.', 'Parrish', '2026-06-17'],
    ['I would highly recommend them! They were prompt, answered all questions, and took care of the issue immediately. They also gave great advice clean up and prevention in the future!', 'Alexis B.', 'Parrish', '2026-06-12'],
    ['They were professional, thorough, friendly. Really happy with the pest control service from Waves Pest Control. Adam was thoughtful & thorough in his assessment of the wasp situation & where the nest. He came on short notice on a Friday night!', 'Cynthia S.', 'Parrish', '2026-05-23'],
    ['When I found some unwanted wildlife in my house after hours on a Friday night, Adam came and worked diligently until the problem was resolved. Waves came to the rescue! I am so grateful for their help.', 'Brooke W.', 'Bradenton', ''],
    ['Amazing, prompt and punctual. These guys are great', 'Bill W.', 'Parrish', '2026-05-14'],
    ['Adam is great to work with! Very flexible and considerate of time and coordination of indoor and outdoor spray with family. Had a huge ghost ant infestation in the walls and lanai that were wiped out', 'Justin T.', '', '2026-05-12'],
    ['Great experience from start to finish. They fit me in on short notice and Adam did a great job explaining the process. Will definitely use them in the future.', 'Chad', '', '2026-04-27'],
    ['Professional, thorough, and very informative. They took the time to explain everything clearly and made the inspection process easy and stress-free. Highly recommend!', 'Jackie L.', '', '2026-04-09'],
    ['Adam came out within 2 hours of my call. He is very knowledgable. He was able to identify the pest problem and solve it. Mission accomplished.', 'Frances D.', '', '2026-03-20'],
    ['Adam did a great job for me taking care of the rodent problem I had in my attic. On time, successful capture at a fair price. Couldn’t ask for better service.', 'Jack L.', '', '2026-02-17']
  ];
  const AVATAR_COLORS = ['#EA4335', '#673AB7', '#4285F4', '#009688', '#FF5722', '#3F51B5', '#795548', '#0A7EC2', '#34A853', '#F4511E', '#5F6368', '#7B1FA2'];
  const G_LOGO = '<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Google"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';
  const relDate = (iso) => {
    if (!iso) return 'on Google';
    const days = (Date.now() - new Date(iso + 'T12:00:00').getTime()) / 86400e3;
    if (days < 7) return 'this week';
    if (days < 14) return 'a week ago';
    if (days < 56) return Math.round(days / 7) + ' weeks ago';
    const mo = Math.round(days / 30.4);
    return mo <= 1 ? 'a month ago' : mo + ' months ago';
  };
  const TICKER = [
    ['Adam is the man. Great service and always answers the phone.', 'Jesse L.'],
    ['Amazing, prompt and punctual. These guys are great', 'Bill W.'],
    ['Adam came out within 2 hours of my call. He is very knowledgable.', 'Frances D.'],
    ['Excellent service. Quick response time and very knowledgeable and friendly staff.', 'Manuel F.'],
    ['On time, successful capture at a fair price. Couldn’t ask for better service.', 'Jack L.'],
    ['Great experience from start to finish. They fit me in on short notice.', 'Chad'],
    ['Even on a Sunday he made time to come out and help me in a time of need.', 'Marvin M.']
  ];

  function scene() {
    const html = document.documentElement;
    html.style.background = 'radial-gradient(1100px 700px at 85% -10%, rgba(10,126,194,.40), transparent 60%), radial-gradient(900px 650px at -10% 30%, rgba(240,165,0,.16), transparent 55%), radial-gradient(1000px 900px at 75% 95%, rgba(6,90,140,.32), transparent 60%), radial-gradient(600px 400px at 40% 55%, rgba(56,170,225,.16), transparent 65%), radial-gradient(140% 120% at 50% 40%, rgba(255,255,255,0) 55%, rgba(4,57,94,.14) 100%), linear-gradient(180deg,#E0EEF9 0%,#F5FAFE 45%,#E5EFF7 100%)';
    html.style.backgroundAttachment = 'fixed';
    document.body.style.setProperty('background', 'transparent', 'important');
    if (!document.getElementById('glass-blobs')) {
      const blobs = document.createElement('div');
      blobs.id = 'glass-blobs';
      blobs.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;';
      blobs.innerHTML = [
        ['10%', '6%', '380px', 'rgba(10,126,194,.36)'],
        ['62%', '22%', '460px', 'rgba(56,170,225,.34)'],
        ['22%', '62%', '420px', 'rgba(240,165,0,.18)'],
        ['72%', '74%', '340px', 'rgba(4,57,94,.28)'],
        ['44%', '40%', '220px', 'rgba(120,200,255,.28)']
      ].map(b => '<div class="orb" style="position:absolute;left:' + b[0] + ';top:' + b[1] + ';width:' + b[2] + ';height:' + b[2] + ';border-radius:50%;background:' + b[3] + ';filter:blur(70px);will-change:transform;"></div>').join('')
        + '<div id="glass-dots" style="position:absolute;inset:-10%;background:radial-gradient(circle, rgba(4,57,94,.28) 0 1px, transparent 1.4px);background-size:24px 24px;opacity:.14;"></div>';
      document.body.prepend(blobs);
    }
    const root = document.getElementById('root');
    if (root) { root.style.position = 'relative'; root.style.zIndex = '1'; }
    if (!document.getElementById('glass-grain')) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.055"/></feComponentTransfer></filter><rect width="180" height="180" filter="url(#n)"/></svg>';
      const g = document.createElement('div');
      g.id = 'glass-grain';
      g.style.cssText = 'position:fixed;inset:0;z-index:3;pointer-events:none;background-image:url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '");background-size:180px 180px;opacity:.6;';
      document.body.appendChild(g);
    }
    let st = document.getElementById('glass-style-v2');
    if (!st) { st = document.createElement('style'); st.id = 'glass-style-v2'; document.head.appendChild(st); }
    st.textContent = CSS;
    const header = document.querySelector('header, [role="banner"]');
    if (header) {
      Object.assign(header.style, { position: 'sticky', top: '10px', zIndex: '60', margin: '10px auto 0', maxWidth: '780px', borderRadius: '999px', padding: '8px 26px' });
      header.style.setProperty('background', 'linear-gradient(135deg,rgba(255,255,255,.42),rgba(255,255,255,.15)), rgba(255,255,255,.32)', 'important');
      header.style.setProperty('-webkit-backdrop-filter', 'blur(26px) saturate(185%)', 'important');
      header.style.setProperty('backdrop-filter', 'blur(26px) saturate(185%)', 'important');
      header.style.setProperty('border', '1px solid rgba(255,255,255,.65)', 'important');
      header.style.setProperty('box-shadow', '0 14px 40px rgba(4,57,94,.16), inset 0 1px 0 rgba(255,255,255,.6), inset 1px 1px 0 rgba(175,225,255,.3)', 'important');
    }
  }

  const widest = (el) => { while (el.parentElement && el.parentElement.textContent.trim() === el.textContent.trim()) el = el.parentElement; return el; };
  const ownText = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.trim(); };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function applyAll() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const t = n.textContent.trim();
      if (has(COPY, t)) n.textContent = COPY[t];
      else if (t === 'Ask Waves' && n.parentElement && n.parentElement.closest('h2')) n.textContent = ASK_H2;
      else if (t === 'Bronze' && n.parentElement && n.parentElement.textContent.trim().indexOf('WaveGuard') === 0) n.textContent = 'Home Protection';
      else if (t.toUpperCase() === 'YOUR ESTIMATE') n.textContent = 'Your pest-free home plan';
      else if (/^· (QUARTERLY|BI-MONTHLY|MONTHLY) PEST CONTROL$/.test(t.toUpperCase())) n.textContent = '';
      else if (t === '- WaveGuard Bronze') n.textContent = ' · WaveGuard Home Protection';
      else if (/^No route near you that day yet, but here are \d+ open times for .+\.$/.test(t) || /^\d+ open times for [A-Za-z]+, .+ — pick what works:$/.test(t)) {
        const m = t.match(/(\d+) open times for ([A-Za-z]+),? (.+?)(?:\.| — pick what works:)$/);
        if (m) {
          const si = Array.from(document.querySelectorAll('input')).find(i => ((i.placeholder || '') + (i.getAttribute('aria-label') || '')).toLowerCase().includes('tuesday') || ((i.getAttribute('aria-label') || '').toLowerCase().includes('service date')));
          const qm = si && si.value && si.value.match(/\b(morning|afternoon|evening|weekend)\b/i);
          const next = qm
            ? m[1] + ' open times for ' + m[2] + ' ' + qm[1].toLowerCase() + ' (' + m[3] + ') — pick what works:'
            : m[1] + ' open times for ' + m[2] + ', ' + m[3] + ' — pick what works:';
          if (t !== next) n.textContent = next;
        }
      }
      else if (/^No route near you that day yet — here.s what.s close\.$/.test(t)) {
        n.textContent = '';
        if (n.parentElement) { let w = n.parentElement; while (w.parentElement && !w.parentElement.textContent.trim()) w = w.parentElement; w.style.setProperty('display', 'none', 'important'); }
      }
    }
    for (const el of document.querySelectorAll('#root *')) {
      if (el.closest('svg')) continue;
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const rad = parseFloat(cs.borderTopLeftRadius) || 0;
      if (bg === 'rgb(250, 248, 243)' || bg === 'rgb(250, 250, 250)') { el.style.setProperty('background', 'transparent', 'important'); }
      const m0 = bg.match(/\d+/g);
      if (el.tagName === 'BUTTON' && m0 && bg.indexOf('rgba') !== 0 && !el.hasAttribute('data-glass-accent')) {
        const lum = (0.2126 * m0[0] + 0.7152 * m0[1] + 0.0722 * m0[2]) / 255;
        if (lum < 0.35 && el.getBoundingClientRect().height >= 42) { el.setAttribute('data-glass-accent', ''); if (cs.position === 'static') el.style.position = 'relative'; }
      }
      if (!el.hasAttribute('data-glass') && !el.hasAttribute('data-glass-accent') && rad >= 8) {
        const isWhite = bg === 'rgb(255, 255, 255)';
        const tint = TINT[bg];
        if (isWhite || tint) {
          if (cs.position === 'static') el.style.position = 'relative';
          const interactive = el.tagName === 'BUTTON' || el.tagName === 'A';
          const nested = !!(el.parentElement && el.parentElement.closest('[data-glass]'));
          el.setAttribute('data-glass', interactive ? 'chip' : (nested ? 'soft' : 'card'));
          if (interactive && el.getBoundingClientRect().height <= 56) el.style.setProperty('border-radius', '999px', 'important');
          if (tint) el.style.setProperty('--glass-bg', tint);
        }
      }
      if (el.tagName === 'INPUT' && el.type === 'checkbox') {
        const track = el.parentElement;
        if (track && track.tagName === 'SPAN' && !track.style.transform) {
          track.style.setProperty('transform', 'scale(.7)');
          track.style.setProperty('transform-origin', 'right center');
        }
      }
      const own = ownText(el);
      if (!own) continue;
      const ut = own.toUpperCase();
      if (ut === 'HOW OFTEN?' || ut === 'HOW OFTEN SHOULD WE PROTECT YOUR HOME?') {
        for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) n.textContent = 'How often should we protect your home?';
        el.removeAttribute('data-type');
        el.style.setProperty('font-size', '15px', 'important');
        el.style.setProperty('font-weight', '600', 'important');
        el.style.setProperty('letter-spacing', '-0.01em', 'important');
        el.style.setProperty('text-transform', 'none', 'important');
        el.style.setProperty('color', '#04395E', 'important');
        continue;
      }
      if (ut === 'WAVES AI') {
        const card = el.closest('[data-glass]');
        if (card && (card.textContent.includes(SAT_H2) || card.textContent.includes('reviewed your property') || card.textContent.includes('roofline'))) {
          for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) n.textContent = 'Smart pricing';
        }
      }
      if (!/^H[1-6]$/.test(el.tagName) && ut === 'ASK WAVES') {
        for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) n.textContent = 'Waves AI';
      }
      if (!el.style.color && !el.closest('[data-glass-accent]')) {
        const m = cs.color.match(/\d+/g);
        if (m) {
          const [r, g, b] = m.map(Number);
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const L = (max + min) / 510;
          if ((max - min) < 46 && L > 0.30 && L < 0.76) el.style.setProperty('color', 'hsl(216, 42%, ' + Math.round(L * 78) + '%)', 'important');
        }
      }
      if (EXCERPTS.includes(own)) { el.setAttribute('data-type', 'excerpt'); continue; }
      if (!el.hasAttribute('data-type') && !el.closest('button, a') && !/^H[1-6]$/.test(el.tagName)) {
        const fs = parseFloat(cs.fontSize);
        if (H2X.includes(own)) el.setAttribute('data-type', 'h2x');
        else if (H3X.includes(own)) el.setAttribute('data-type', 'h3x');
        else if (/^\$[\d,.]+$/.test(own) && fs >= 18) { el.setAttribute('data-type', 'metric'); el.parentElement && el.parentElement.setAttribute('data-price-row', ''); }
        else if ((own === ut || cs.textTransform === 'uppercase') && own.length >= 3 && own.length <= 60 && fs <= 16 && !/[@\d]/.test(own) && /[A-Za-z]/.test(own)) el.setAttribute('data-type', 'eyebrow');
        else if (fs <= 12) el.setAttribute('data-type', 'fine');
        else if (fs >= 13 && fs <= 19) {
          el.setAttribute('data-type', 'body');
          if (parseInt(cs.fontWeight, 10) >= 700) el.style.setProperty('font-weight', '600', 'important');
        }
      }
    }
    // hides
    for (const el of document.querySelectorAll('#root *')) {
      const t = el.textContent.trim();
      if (/^\$[\d.,]+\s*\/ application$/.test(t)) widest(el).style.setProperty('display', 'none', 'important');
      if (/^✓?\s*\d+ applications per year included$/.test(t)) widest(el).style.setProperty('display', 'none', 'important');
      if (/^\d+ applications per year included — just \$[\d.]+\/day/.test(t)) widest(el).style.setProperty('display', 'none', 'important');
      if (/^That's just \$[\d.]+\/day for complete home protection\.$/.test(t) || t === '90-day money-back guarantee — love your service or pay nothing.' || t === 'Try us risk-free — 90-day money-back guarantee.') {
        const w = widest(el);
        if (w.textContent.length < 120) w.style.setProperty('display', 'none', 'important');
      }
    }
    document.querySelectorAll('[data-glass]').forEach(card => {
      const t = card.textContent.trim();
      if ((t.startsWith('+ $99') || t.startsWith('+$99')) && t.includes('WaveGuard setup')) card.style.setProperty('display', 'none', 'important');
    });
    // offer stack
    let row1 = null;
    for (const el of document.querySelectorAll('#root *')) if (el.textContent.trim() === B_PREMIUM) row1 = widest(el);
    if (row1) {
      const container = row1.parentElement;
      const addBullet = (text, before) => {
        if (container.textContent.includes(text)) return;
        const clone = row1.cloneNode(true);
        const w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        let set = false;
        while (w.nextNode()) { if (w.currentNode.textContent.trim()) { if (!set) { w.currentNode.textContent = text; set = true; } else w.currentNode.textContent = ''; } }
        if (before) container.insertBefore(clone, row1); else container.appendChild(clone);
      };
      addBullet(B_INTERIOR, false);
      addBullet(B_CALLBACK, false);
      addBullet(B_GUARANTEE, false);
      addBullet(B_CONTRACT, false);
      addBullet(B_SETUP, false);
    }
    // $/day under price row — recomputed live from the current price + frequency
    if (!document.getElementById('price-perday')) {
      const metric = document.querySelector('[data-type="metric"]');
      if (metric) {
        const row = metric.closest('[data-price-row]') || metric.parentElement;
        const d = document.createElement('div');
        d.id = 'price-perday';
        d.textContent = PERDAY;
        row.insertAdjacentElement('afterend', d);
      }
    }
    {
      const perday = document.getElementById('price-perday');
      const metric = document.querySelector('[data-type="metric"]');
      const prow = metric && (metric.closest('[data-price-row]') || metric.parentElement);
      if (perday && metric && prow) {
        const amt = parseFloat(metric.textContent.replace(/[$,]/g, ''));
        const unit = prow.textContent;
        let perYear = null;
        if (/bi-?monthly/i.test(unit)) perYear = amt * 6;
        else if (/quarter/i.test(unit)) perYear = amt * 4;
        else if (/month/i.test(unit)) perYear = amt * 12;
        if (perYear && isFinite(perYear)) {
          let tail = 'less than a gas-station drink for year-round protection.';
          if (/bi-?monthly/i.test(unit)) tail = 'less than your morning coffee for year-round protection.';
          else if (/\/mo/i.test(unit)) tail = 'a rounding error on the grocery bill — for always-on protection.';
          perday.textContent = 'That’s about $' + (perYear / 365).toFixed(2) + '/day — ' + tail;
        }
      }
    }
    // "You save …" anchor line — removed entirely (owner: one-time pricing uses a multiplier, so the anchor comparison is not real)
    for (const el of document.querySelectorAll('#root *')) {
      const t = el.textContent.trim();
      if (/^You save \$[\d.,]+(\/quarter|\/bi-monthly|\/mo) with (WaveGuard|your recurring plan)/.test(t) && t.length < 90) {
        widest(el).style.setProperty('display', 'none', 'important');
      }
    }
    // frequency-aware "Protected N× a year" bullet
    {
      const subM = document.body.textContent.match(/(\d+) applications\/year/);
      if (subM) {
        const n = subM[1];
        for (const el of document.querySelectorAll('#root *')) {
          const own = ownText(el);
          if (/^Protected \d+× a year — full perimeter/.test(own) && own.indexOf('Protected ' + n + '×') !== 0) {
            for (const nd of el.childNodes) if (nd.nodeType === 3 && nd.textContent.trim()) { nd.textContent = 'Protected ' + n + '× a year — full perimeter, entry points, eaves & harborage zones, every visit'; break; }
          }
        }
      }
    }
    // hero subline
    if (!document.getElementById('hero-sub')) {
      const h1 = document.querySelector('h1');
      if (h1) {
        const d = document.createElement('div');
        d.id = 'hero-sub';
        d.textContent = HERO_SUB;
        h1.insertAdjacentElement('afterend', d);
      }
    }
    // ask excerpt
    if (!document.getElementById('ask-excerpt')) {
      const askH2 = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.includes(ASK_H2) || h.textContent.includes('Ask Waves anything'));
      if (askH2) {
        const p = document.createElement('div');
        p.id = 'ask-excerpt';
        p.setAttribute('data-type', 'excerpt');
        p.textContent = ASK_EX;
        p.style.margin = '6px 0 14px';
        askH2.insertAdjacentElement('afterend', p);
      }
    } else { document.getElementById('ask-excerpt').textContent = ASK_EX; }
    // CTA microcopy
    if (!document.getElementById('cta-micro')) {
      const cta = Array.from(document.querySelectorAll('[data-glass-accent]')).find(b => b.textContent.includes('Approve my plan'));
      if (cta) {
        const m = document.createElement('div');
        m.id = 'cta-micro';
        cta.parentElement.insertAdjacentElement('afterend', m);
      }
    }
    const micro = document.getElementById('cta-micro');
    if (micro) micro.textContent = MICRO;
    // proof before price — continuous GBP-review ticker
    if (!document.getElementById('proof-strip')) {
      const priceCard = Array.from(document.querySelectorAll('[data-glass="card"]')).find(c => c.textContent.includes('How often should we protect your home?'));
      if (priceCard) {
        const item = (r) => '<span class="ps-item"><span style="color:#F0A500;letter-spacing:2px;font-size:13px">★★★★★</span><span style="font-style:italic">“' + r[0] + '”</span><span style="font-weight:600;color:#04395E">— ' + r[1] + '</span></span>';
        const items = TICKER.map(item).join('');
        const s = document.createElement('div');
        s.id = 'proof-strip';
        s.innerHTML = '<div class="ps-track">' + items + items + '</div>';
        s.style.cssText = 'overflow:hidden;position:relative;margin:0 0 14px;padding:12px 0;border-radius:18px;background:linear-gradient(135deg,rgba(255,255,255,.38),rgba(255,255,255,.14)),rgba(255,255,255,.30);backdrop-filter:blur(18px) saturate(170%);-webkit-backdrop-filter:blur(18px) saturate(170%);border:1px solid rgba(255,255,255,.6);box-shadow:0 8px 24px rgba(4,57,94,.10),inset 0 1px 0 rgba(255,255,255,.5);-webkit-mask-image:linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent);mask-image:linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent)';
        priceCard.parentElement.insertBefore(s, priceCard);
      }
    }
    // sticky mobile book bar
    if (!document.getElementById('mobile-book-bar')) {
      const price = (document.querySelector('[data-type="metric"]') || {}).textContent || '$98.01';
      const bar = document.createElement('div');
      bar.id = 'mobile-book-bar';
      bar.innerHTML = '<div style="font-weight:700;font-size:19px;color:#04395E;font-variant-numeric:tabular-nums">' + price + '<span style="font-weight:400;font-size:13px;color:hsl(216,42%,38%)">/quarter</span></div><button id="mbb-btn">Approve my plan →</button>';
      document.body.appendChild(bar);
      bar.querySelector('#mbb-btn').addEventListener('click', () => {
        const c = Array.from(document.querySelectorAll('[data-glass-accent]')).find(b => b.textContent.includes('Approve my plan'));
        if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    // real scarcity (renders only when true) — parse structured child elements, not concatenated text
    {
      const slotBtns = Array.from(document.querySelectorAll('button')).filter(b => /Arrival window:/.test(b.textContent));
      const parts = (b) => {
        let date = null, time = null;
        for (const el of b.querySelectorAll('*')) {
          const t = el.textContent.trim();
          if (!date && /^[A-Z][a-z]+, \w+ \d{1,2}$/.test(t)) date = t;
          if (!time && /^\d{1,2}:\d{2} [AP]M$/.test(t)) time = t;
          if (date && time) break;
        }
        return { date, time };
      };
      if (slotBtns.length) {
        const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const first = parts(slotBtns[0]);
        const dm = first.date && first.date.match(/^([A-Z][a-z]+), (\w+) (\d{1,2})$/);
        if (dm) {
          const key = dm[2] + ' ' + dm[3];
          const sameDay = slotBtns.filter(b => { const p = parts(b); return p.date && p.date.endsWith(key); });
          const times = sameDay.map(b => parts(b).time).filter(Boolean);
          if (times.length && times.length <= 2) {
            const now = new Date();
            const tom = new Date(now.getTime() + 86400000);
            const isToday = key === MONTHS[now.getMonth()] + ' ' + now.getDate();
            const isTom = key === MONTHS[tom.getMonth()] + ' ' + tom.getDate();
            const label = isToday ? 'today' : (isTom ? 'tomorrow' : 'on ' + dm[1]);
            const text = '⏳ Only ' + times.length + ' opening' + (times.length > 1 ? 's' : '') + ' ' + label + ' — ' + times.join(' & ');
            let d = document.getElementById('slot-scarcity');
            if (!d) {
              d = document.createElement('div');
              d.id = 'slot-scarcity';
              widest(slotBtns[0]).parentElement.insertBefore(d, widest(slotBtns[0]));
            }
            if (d.textContent !== text) d.textContent = text;
          } else {
            const d = document.getElementById('slot-scarcity');
            if (d) d.remove();
          }
        }
      }
    }
    // service card accordion (collapsed offer stack behind a toggle)
    const svcTitle = Array.from(document.querySelectorAll('#root *')).find(el => ownText(el) === 'Pest Control (Quarterly)');
    if (svcTitle) {
      const svcCard = svcTitle.closest('[data-glass]');
      if (svcCard) {
        if (window.__svcOpen === undefined) window.__svcOpen = false;
        const BULLET_RE = /^(Premium non-repellent|Protected \d+× a year|Interior treatment included|If pests come back|90-day money-back guarantee —|No long-term contract|\$99 setup disappears)/;
        const rows = [];
        for (const el of svcCard.querySelectorAll('*')) {
          if (BULLET_RE.test(el.textContent.trim())) { const w = widest(el); if (!rows.includes(w)) rows.push(w); }
        }
        rows.forEach(r => r.classList.toggle('svc-hidden', !window.__svcOpen));
        if (!document.getElementById('svc-hint')) {
          const h = document.createElement('div');
          h.id = 'svc-hint';
          const sub = Array.from(svcCard.querySelectorAll('*')).find(el => el.textContent.trim().startsWith('4 applications/year'));
          (sub ? widest(sub) : widest(svcTitle)).insertAdjacentElement('afterend', h);
        }
        const hint = document.getElementById('svc-hint');
        hint.textContent = window.__svcOpen ? 'Hide details ▴' : 'See everything included (7) ▾';
        if (!svcCard.hasAttribute('data-svc-bound')) {
          svcCard.setAttribute('data-svc-bound', '');
          svcCard.addEventListener('click', (e) => {
            if (!(e.target.closest('#svc-hint') || widest(svcTitle).contains(e.target))) return;
            window.__svcOpen = !window.__svcOpen;
            window.__glassClassify();
          });
        }
      }
    }
    // frequency selector -> glass buttons (horizontal desktop, vertical mobile)
    const freqSel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => /Quarterly/i.test(o.textContent)));
    if (freqSel) {
      const wrap = (freqSel.parentElement && freqSel.parentElement.children.length === 1) ? freqSel.parentElement : freqSel;
      wrap.style.setProperty('display', 'none', 'important');
      let fb = document.getElementById('freq-buttons');
      if (!fb) {
        fb = document.createElement('div');
        fb.id = 'freq-buttons';
        wrap.insertAdjacentElement('afterend', fb);
      } else if (fb.previousElementSibling !== wrap) {
        wrap.insertAdjacentElement('afterend', fb);
      }
      const opts = Array.from(freqSel.options);
      if (fb.children.length !== opts.length) {
        fb.innerHTML = '';
        opts.forEach(o => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'freq-btn';
          b.textContent = o.textContent;
          b.dataset.val = o.value;
          b.addEventListener('click', () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
            setter.call(freqSel, b.dataset.val);
            freqSel.dispatchEvent(new Event('change', { bubbles: true }));
            setTimeout(() => window.__glassClassify(), 250);
          });
          fb.appendChild(b);
        });
      }
      Array.from(fb.children).forEach(b => { if (b.dataset.val === freqSel.value) b.setAttribute('data-active', ''); else b.removeAttribute('data-active'); });
    }
    // remove the entire customize section (owner directive)
    document.querySelectorAll('[data-glass="card"]').forEach(c => {
      const t = c.textContent;
      if (t.includes('no upsells, no nickel-and-diming') || t.includes('Customize your visit') || (t.includes('Toggle off if you want to skip this.') && t.includes('Save $'))) c.style.setProperty('display', 'none', 'important');
    });
    // a selection is only valid while its slot chip is on screen — otherwise clear it
    if (window.__selSlot && !document.querySelector('[data-slot-selected]')) window.__selSlot = null;
    // gold-accent the contact CTAs to match the other primary actions
    Array.from(document.querySelectorAll('a')).forEach(a => {
      const t = a.textContent;
      if ((t.includes('talk to a real person') || t.includes('Text us — fast answers') || t.includes('Questions? Call') || t.includes('Questions? Text')) && !a.hasAttribute('data-glass-accent')) {
        a.removeAttribute('data-glass');
        a.setAttribute('data-glass-accent', '');
        if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
        a.style.setProperty('border-radius', '999px', 'important');
      }
    });
    // bolder hero contact block
    {
      let best = null;
      for (const el of document.querySelectorAll('#root *')) {
        const t = el.textContent;
        if (t.includes('@') && t.includes('USA') && t.length < 170 && (!best || el.contains(best))) best = el;
      }
      if (best && !best.hasAttribute('data-contact')) best.setAttribute('data-contact', '');
    }
    // smaller stat tiles under the satellite
    {
      const satCard2 = Array.from(document.querySelectorAll('[data-glass="card"]')).find(c => c.textContent.includes('Complexity') && c.textContent.includes('sq ft'));
      if (satCard2) {
        satCard2.querySelectorAll('[data-glass="soft"]').forEach(tile => {
          const t = tile.textContent;
          if (/^(HOME|LOT|POOL\/LANAI|COMPLEXITY)/i.test(t.trim()) && t.length < 40 && !tile.hasAttribute('data-stattile')) tile.setAttribute('data-stattile', '');
        });
      }
    }
    // lawn card: drop the leaf icon, center the CTA
    {
      const lawnCard = Array.from(document.querySelectorAll('[data-glass]')).find(c => c.textContent.includes('Add Lawn Care — save on both services'));
      if (lawnCard) {
        const leaf = Array.from(lawnCard.querySelectorAll('svg')).find(s => !s.closest('button'));
        if (leaf) {
          const wrap = (leaf.parentElement && leaf.parentElement !== lawnCard && leaf.parentElement.getBoundingClientRect().width <= 60) ? leaf.parentElement : leaf;
          wrap.style.setProperty('display', 'none', 'important');
        }
        const btn = Array.from(lawnCard.querySelectorAll('button')).find(b => b.textContent.includes('Add Lawn Care'));
        if (btn) {
          const cardR = lawnCard.getBoundingClientRect();
          const btnR = btn.getBoundingClientRect();
          if (Math.abs((btnR.left + btnR.width / 2) - (cardR.left + cardR.width / 2)) > 8) {
            btn.style.setProperty('display', 'block');
            btn.style.setProperty('margin-left', 'auto');
            btn.style.setProperty('margin-right', 'auto');
          }
        }
      }
    }
    // Hormozi CTA under Smart Pricing
    if (!document.getElementById('smart-cta')) {
      const satCard = Array.from(document.querySelectorAll('[data-glass="card"]')).find(c => c.textContent.includes('Complexity') && c.textContent.includes('sq ft') && c.textContent.includes('somebody else’s average'));
      if (satCard) {
        const row = document.createElement('div');
        row.id = 'smart-cta-row';
        row.innerHTML = '<button id="smart-cta" data-glass-accent type="button" style="position:relative;padding:14px 26px;border-radius:999px;font-size:15px;cursor:pointer">This price fits my home — lock it in →</button>';
        satCard.appendChild(row);
        row.querySelector('#smart-cta').addEventListener('click', () => {
          const c = Array.from(document.querySelectorAll('[data-glass-accent]')).find(b => b.textContent.includes('Approve my plan'));
          if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    }
    // Hormozi CTA under the reviews header
    if (!document.getElementById('reviews-cta')) {
      const revCard3 = Array.from(document.querySelectorAll('[data-glass="card"]')).find(c => c.textContent.includes('switched to Waves'));
      if (revCard3) {
        const ex = Array.from(revCard3.querySelectorAll('[data-type="excerpt"]')).find(e => e.textContent.includes('backyards look like yours'));
        if (ex) {
          const row = document.createElement('div');
          row.id = 'reviews-cta';
          row.style.cssText = 'display:flex;justify-content:flex-start;margin:14px 0 6px';
          row.innerHTML = '<button data-glass-accent type="button" style="position:relative;padding:13px 24px;border-radius:999px;font-size:15px;cursor:pointer">Join your neighbors →</button>';
          widest(ex).insertAdjacentElement('afterend', row);
          row.querySelector('button').addEventListener('click', () => {
            const c = Array.from(document.querySelectorAll('[data-glass-accent]')).find(b => b.textContent.includes('Approve my plan and schedule') || b.textContent.trim().indexOf('Approve —') === 0);
            if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
        }
      }
    }
    // "Book my first visit" belongs at the bottom of the app section
    {
      const bookBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().indexOf('Book my first visit') === 0);
      const av = document.getElementById('app-visual');
      if (bookBtn && av) {
        const appCard = av.closest('[data-glass]');
        const row = bookBtn.parentElement;
        if (appCard && row && appCard.contains(row) && appCard.lastElementChild !== row) appCard.appendChild(row);
      }
    }
    // footer: brand-blue styling + cities linked to the four GBP profiles
    {
      const fbLink = Array.from(document.querySelectorAll('a')).find(a => (a.href || '').includes('facebook.com'));
      if (fbLink) {
        let f = fbLink.parentElement;
        while (f && !f.textContent.includes('All rights reserved')) f = f.parentElement;
        if (f && !f.hasAttribute('data-footer')) f.setAttribute('data-footer', '');
      }
      const GBP = { Bradenton: 'https://g.page/r/CVRc_P5butTMEBM', Parrish: 'https://g.page/r/Ca-4KKoWwFacEBM', Sarasota: 'https://g.page/r/CRkzS6M4EpncEBM', Venice: 'https://g.page/r/CURA5pQ1KatBEBM' };
      for (const el of document.querySelectorAll('#root *')) {
        if (el.children.length === 0 && el.textContent.trim() === 'Bradenton · Parrish · Sarasota · Venice' && !el.hasAttribute('data-linked')) {
          el.setAttribute('data-linked', '');
          el.innerHTML = Object.keys(GBP).map(c => '<a href="' + GBP[c] + '" target="_blank" rel="noopener" style="color:#04395E;font-weight:500">' + c + '</a>').join(' · ');
        }
      }
    }
    // Google Play badge next to the App Store badge (unlinked for now)
    {
      const ab = document.getElementById('av-badge');
      if (ab && !ab.querySelector('[data-play]')) {
        const p = document.createElement('span');
        p.setAttribute('data-play', '');
        p.title = 'Google Play — coming soon';
        p.style.cssText = 'display:inline-flex;line-height:0';
        p.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="135" height="40" viewBox="0 0 135 40" role="img" aria-label="Get it on Google Play"><rect width="135" height="40" rx="7" fill="#000"/><rect x="0.75" y="0.75" width="133.5" height="38.5" rx="6.25" fill="none" stroke="#5A5A5A"/><g transform="translate(11 9) scale(0.92)"><path fill="#00C3FF" d="M4 3 13 12 4 21Z"/><path fill="#00E676" d="M4 3 16.5 9.8 13 12Z"/><path fill="#FFD500" d="M16.5 9.8 20.5 12 16.5 14.2Z"/><path fill="#FF3D00" d="M13 12 16.5 14.2 4 21Z"/></g><text x="40" y="17" fill="#fff" font-family="Inter,Helvetica,Arial,sans-serif" font-size="7.5" letter-spacing="0.6">GET IT ON</text><text x="39.5" y="31" fill="#fff" font-family="Inter,Helvetica,Arial,sans-serif" font-size="16" font-weight="600">Google Play</text></svg>';
        ab.appendChild(p);
      }
    }
    // slot freshness: hard 2-hour lead — stale slots disabled, stale selections cleared
    {
      const M = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };
      const now = Date.now(), lead = 2 * 3600e3;
      Array.from(document.querySelectorAll('button')).filter(b => /Arrival window:/.test(b.textContent)).forEach(b => {
        let date = null, time = null;
        for (const el of b.querySelectorAll('*')) {
          const t = el.textContent.trim();
          if (!date && /^[A-Z][a-z]+, \w+ \d{1,2}$/.test(t)) date = t;
          if (!time && /^\d{1,2}:\d{2} [AP]M$/.test(t)) time = t;
        }
        if (!date || !time) return;
        const dm = date.match(/, (\w+) (\d{1,2})$/), tm = time.match(/(\d{1,2}):(\d{2}) ([AP])M/);
        if (!dm || !tm || !(dm[1] in M)) return;
        let hh = parseInt(tm[1], 10) % 12;
        if (tm[3] === 'P') hh += 12;
        let d = new Date(new Date().getFullYear(), M[dm[1]], parseInt(dm[2], 10), hh, parseInt(tm[2], 10));
        if (d.getTime() < now - 180 * 86400e3) d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate(), hh, parseInt(tm[2], 10));
        if (d.getTime() < now + lead) {
          b.setAttribute('data-slot-stale', '');
          if (b.hasAttribute('data-slot-selected')) { b.removeAttribute('data-slot-selected'); window.__selSlot = null; }
        } else b.removeAttribute('data-slot-stale');
      });
    }
    // clean up empty leftover rows in the slot list (blanked message shells)
    {
      const sb = Array.from(document.querySelectorAll('button')).find(b => /Arrival window:/.test(b.textContent));
      if (sb && sb.parentElement) {
        Array.from(sb.parentElement.children).forEach(ch => {
          if (ch.tagName !== 'BUTTON' && ch.id !== 'slot-scarcity' && !ch.textContent.trim() && !ch.querySelector('img,svg,input')) ch.style.setProperty('display', 'none', 'important');
        });
      }
    }
    // slot-aware CTA labels (selection is simulated — see interactions(); no reserve call ever fires)
    {
      const cta = Array.from(document.querySelectorAll('[data-glass-accent]')).find(b => b.textContent.includes('Approve'));
      if (cta) {
        const label = window.__selSlot ? ('Approve — ' + window.__selSlot.dow + ' ' + window.__selSlot.time + ' ✓') : 'Approve my plan and schedule';
        if (cta.textContent.trim() !== label) {
          const w = document.createTreeWalker(cta, NodeFilter.SHOW_TEXT);
          let set = false;
          while (w.nextNode()) { if (w.currentNode.textContent.trim()) { if (!set) { w.currentNode.textContent = label; set = true; } else w.currentNode.textContent = ''; } }
        }
      }
      const mbb = document.getElementById('mbb-btn');
      if (mbb) mbb.textContent = window.__selSlot ? ('Approve ' + window.__selSlot.dow + ' ' + window.__selSlot.time + ' →') : 'Approve my plan →';
    }
    // priority tag on route-day slots (uses real route markers when present; first slot as demo otherwise)
    {
      const slotBtns = Array.from(document.querySelectorAll('button')).filter(b => /Arrival window:/.test(b.textContent));
      if (slotBtns.length && !document.querySelector('.slot-priority')) {
        const marked = slotBtns.filter(b => /nearby|route/i.test(b.textContent));
        (marked.length ? marked : [slotBtns[0]]).forEach(b => {
          const timeEl = Array.from(b.querySelectorAll('*')).find(el => /^\d{1,2}:\d{2} [AP]M$/.test(el.textContent.trim()));
          if (timeEl) { const s = document.createElement('span'); s.className = 'slot-priority'; s.textContent = '⚡ Tech nearby — priority'; timeEl.insertAdjacentElement('afterend', s); }
        });
      }
    }
    // technician chip — appears once a slot is picked, confirming who's coming and when
    {
      const oldTc = document.getElementById('tech-chip');
      if (oldTc && !oldTc.querySelector('#tc-text')) oldTc.remove();
    }
    if (!document.getElementById('tech-chip')) {
      const schedH = Array.from(document.querySelectorAll('[data-type="h2x"]')).find(x => x.textContent.includes('Lock in your spot'));
      const schedCard = schedH && schedH.closest('[data-glass]');
      if (schedCard) {
        const exEl = schedCard.querySelector('[data-type="excerpt"]');
        const d = document.createElement('div');
        d.id = 'tech-chip';
        d.innerHTML = '<img class="tc-photo" src="/adam.jpg" alt="Adam Benetti"><span id="tc-text"></span>';
        (exEl ? widest(exEl) : widest(schedH)).insertAdjacentElement('afterend', d);
      }
    }
    {
      const tc = document.getElementById('tech-chip');
      if (tc) {
        tc.style.display = window.__selSlot ? 'flex' : 'none';
        const txt = tc.querySelector('#tc-text');
        if (txt && window.__selSlot) txt.innerHTML = '<strong style="color:#04395E">Your technician: Adam — ' + window.__selSlot.dow + ' ' + window.__selSlot.time + '</strong> · Licensed &amp; insured, FL JB351547';
      }
    }
    // "Recommended" chip on the Quarterly button
    {
      const fb2 = document.getElementById('freq-buttons');
      if (fb2) {
        const qb = Array.from(fb2.children).find(b => /quarterly/i.test(b.dataset.val || b.textContent));
        if (qb && !qb.querySelector('.freq-rec')) { const r = document.createElement('span'); r.className = 'freq-rec'; r.textContent = 'Recommended'; qb.appendChild(r); }
      }
    }
    // scroll-reveal + stat count-up registration
    if (window.__revealIO) {
      document.querySelectorAll('[data-glass="card"]').forEach(c => {
        if (c.hasAttribute('data-revealed')) return;
        c.setAttribute('data-revealed', '');
        if (c.getBoundingClientRect().top > innerHeight * 0.92) { c.classList.add('reveal-pending'); window.__revealIO.observe(c); }
      });
    }
    if (window.__statIO) {
      for (const el of document.querySelectorAll('#root *')) {
        if (el.hasAttribute('data-stat')) continue;
        if (/^[\d,]+ sq ft$/.test(ownText(el))) { el.setAttribute('data-stat', ''); window.__statIO.observe(el); }
      }
    }
    // guarantee block before the call/text row — re-anchored every pass (React re-renders can strand injected nodes)
    {
      const callLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('talk to a real person') || a.textContent.includes('Questions? Call'));
      let g = document.getElementById('guarantee-block');
      if (!g && callLink) {
        g = document.createElement('div');
        g.id = 'guarantee-block';
        g.setAttribute('data-glass', 'card');
        g.style.position = 'relative';
        g.innerHTML = '<div class="gb-title">You’re covered either way</div><div class="gb-body">If pests come back between visits, we come back free. If you don’t love the service in your first 90 days, you get your money back.</div><div class="gb-fine">No long-term contract. No pressure. No risk.</div>';
      }
      const revAnchor = Array.from(document.querySelectorAll('[data-glass="card"]')).find(c => c.textContent.includes('switched to Waves'));
      if (g && revAnchor) {
        if (g.previousElementSibling !== revAnchor) revAnchor.insertAdjacentElement('afterend', g);
        g.style.removeProperty('display');
      } else if (g) {
        g.style.setProperty('display', 'none', 'important');
      }
    }
    // App section: single hero phone + glass feature chips (replaces the 4-thumbnail row)
    if (!document.getElementById('app-visual')) {
      const appH2 = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.includes('Stop waiting around') || h.textContent.includes('Watch every visit'));
      const appCard = appH2 && appH2.closest('[data-glass]');
      if (appCard) {
        const imgs = appCard.querySelectorAll('img[src*="/images/app/"]');
        if (imgs.length >= 2) {
          const badge = appCard.querySelector('a[href*="apps.apple.com"]');
          const badgeClone = badge ? badge.cloneNode(true) : null;
          let row = imgs[0].parentElement;
          while (row && row !== appCard && !row.contains(imgs[imgs.length - 1])) row = row.parentElement;
          if (row && row !== appCard) row.style.setProperty('display', 'none', 'important');
          const feat = Array.from(appCard.querySelectorAll('[data-glass]')).find(el => el.textContent.includes('Reschedule & history'));
          if (feat) feat.style.setProperty('display', 'none', 'important');
          const v = document.createElement('div');
          v.id = 'app-visual';
          v.innerHTML = '<div class="av-left"><div class="av-glow"></div><img class="av-phone" src="/images/app/app-tracking.webp" alt="Waves app live tech tracking"></div>'
            + '<div class="av-right"><div style="font-size:1.3rem;font-weight:600;letter-spacing:-.02em;color:#04395E">It’s all in the Waves app</div>'
            + '<div data-type="excerpt" style="margin-top:6px">One login for the whole household — everyone in the loop, nobody playing messenger.</div>'
            + '<div class="av-chips">' + ['Live tech tracking', 'Text your tech', 'Photo & video reports', 'Add family to alerts', 'Billing & autopay', 'Reschedule & history'].map(f => '<span class="av-chip">' + f + '</span>').join('') + '</div>'
            + '<div id="av-badge"></div></div>';
          appCard.appendChild(v);
          if (badgeClone) v.querySelector('#av-badge').appendChild(badgeClone);
        }
      }
    }
    // horizontal review marquee — Google-native card styling (no avatar, no timeframe)
    {
      const oldMq = document.getElementById('review-marquee');
      if (oldMq && (!oldMq.querySelector('.gr-head') || oldMq.querySelector('.gr-avatar'))) oldMq.remove();
    }
    if (!document.getElementById('review-marquee')) {
      const revCard = Array.from(document.querySelectorAll('[data-glass="card"]')).find(c => c.textContent.includes('switched to Waves') || c.textContent.includes('Customer reviews'));
      if (revCard) {
        const cardHtml = REVIEWS.map((r) => '<div class="rm-card"><div class="gr-head"><span class="gr-id"><span class="gr-name">' + r[1] + '</span>' + (r[2] ? '<span class="gr-date">' + r[2] + '</span>' : '') + '</span>' + G_LOGO + '</div><div class="gr-stars">★★★★★</div><div class="gr-text">' + r[0] + '</div></div>').join('');
        const mq = document.createElement('div');
        mq.id = 'review-marquee';
        mq.innerHTML = '<div class="rm-track">' + cardHtml + cardHtml + '</div>';
        revCard.appendChild(mq);
      }
    }
    // keep the original carousel hidden (it re-renders on rotation)
    const revCard2 = Array.from(document.querySelectorAll('[data-glass="card"]')).find(c => c.textContent.includes('switched to Waves') || c.textContent.includes('Customer reviews'));
    if (revCard2) {
      Array.from(revCard2.children).forEach(ch => {
        if (ch.id === 'review-marquee') return;
        if (ch.textContent.includes('“') || /Review group/.test(ch.textContent) || ch.querySelector('button[aria-label^="Review group"]')) ch.style.setProperty('display', 'none', 'important');
      });
    }
  }

  function interactions() {
    if (!window.__glassMove) {
      window.__glassMove = true;
      let raf = 0, lastEvt = null;
      document.addEventListener('pointermove', (e) => {
        lastEvt = e;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const t = lastEvt.target instanceof Element ? lastEvt.target.closest('[data-glass],[data-glass-accent]') : null;
          if (t) {
            const r = t.getBoundingClientRect();
            t.style.setProperty('--mx', ((lastEvt.clientX - r.left) / r.width * 100) + '%');
            t.style.setProperty('--my', ((lastEvt.clientY - r.top) / r.height * 100) + '%');
          }
          window.__glassPx = (lastEvt.clientX / innerWidth - .5);
          window.__glassPy = (lastEvt.clientY / innerHeight - .5);
          if (window.__glassPar) window.__glassPar();
        });
      }, { passive: true });
    }
    if (!window.__glassParallax) {
      window.__glassParallax = true;
      window.__glassPx = 0; window.__glassPy = 0;
      const apply = () => {
        const b = document.getElementById('glass-blobs');
        if (!b) return;
        const sy = window.scrollY;
        const orbs = b.querySelectorAll('.orb');
        orbs.forEach((c, i) => {
          const f = 0.015 + i * 0.012;
          const drift = Math.sin(sy / 900 + i * 1.7) * 24;
          c.style.transform = 'translate(' + ((window.__glassPx * -46 * (i + 1) / orbs.length) + drift) + 'px, ' + (sy * f + window.__glassPy * -34 * (i + 1) / orbs.length) + 'px)';
        });
      };
      window.__glassPar = apply;
      window.addEventListener('scroll', () => requestAnimationFrame(apply), { passive: true });
    }
    if (!window.__glassObs) {
      window.__glassObs = true;
      let pending = false;
      new MutationObserver((muts) => {
        if (muts.some(m => m.addedNodes.length) && !pending) {
          pending = true;
          setTimeout(() => { pending = false; window.__glassClassify(); }, 150);
        }
      }).observe(document.getElementById('root'), { childList: true, subtree: true });
    }
    // Slot selection SIMULATION — capture-phase intercept so React never sees the click (no reserve POST)
    if (!window.__slotSim) {
      window.__slotSim = true;
      document.addEventListener('click', (e) => {
        const btn = e.target.closest ? e.target.closest('button') : null;
        if (!btn || !/Arrival window:/.test(btn.textContent)) return;
        e.preventDefault();
        e.stopPropagation();
        const was = btn.hasAttribute('data-slot-selected');
        document.querySelectorAll('[data-slot-selected]').forEach(b => b.removeAttribute('data-slot-selected'));
        if (!was) {
          btn.setAttribute('data-slot-selected', '');
          let date = null, time = null;
          for (const el of btn.querySelectorAll('*')) {
            const t = el.textContent.trim();
            if (!date && /^[A-Z][a-z]+, \w+ \d{1,2}$/.test(t)) date = t;
            if (!time && /^\d{1,2}:\d{2} [AP]M$/.test(t)) time = t;
          }
          window.__selSlot = (date && time) ? { dow: date.split(',')[0], time } : null;
        } else window.__selSlot = null;
        window.__glassClassify();
      }, true);
    }
    // Reveal + stat observers
    if (!window.__revealIO) {
      window.__revealIO = new IntersectionObserver((ents) => {
        ents.forEach(en => { if (en.isIntersecting) { en.target.classList.add('reveal-in'); en.target.classList.remove('reveal-pending'); window.__revealIO.unobserve(en.target); } });
      }, { threshold: 0.06 });
    }
    if (!window.__statIO) {
      window.__statIO = new IntersectionObserver((ents) => {
        ents.forEach(en => {
          if (!en.isIntersecting) return;
          const el = en.target;
          window.__statIO.unobserve(el);
          if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          const node = Array.from(el.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
          if (!node) return;
          const m = node.textContent.trim().match(/^([\d,]+) sq ft$/);
          if (!m) return;
          const target = parseInt(m[1].replace(/,/g, ''), 10);
          const t0 = performance.now();
          const step = (now) => {
            const p = Math.min(1, (now - t0) / 900);
            node.textContent = Math.round(target * (0.15 + 0.85 * p * p)).toLocaleString() + ' sq ft';
            if (p < 1) requestAnimationFrame(step); else node.textContent = target.toLocaleString() + ' sq ft';
          };
          requestAnimationFrame(step);
        });
      }, { threshold: 0.5 });
    }
    // Success confetti on Approve (demo of the booking-confirmation moment)
    if (!window.__confetti) {
      window.__confetti = true;
      document.addEventListener('click', (e) => {
        const btn = e.target.closest ? e.target.closest('[data-glass-accent], #mbb-btn') : null;
        if (!btn || !/Approve/.test(btn.textContent)) return;
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const r = btn.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const colors = ['#F0A500', '#FFD666', '#0A7EC2', '#04395E', '#7CC7F0'];
        for (let i = 0; i < 26; i++) {
          const b = document.createElement('div');
          b.className = 'confetti-bit';
          b.style.background = colors[i % colors.length];
          b.style.left = cx + 'px';
          b.style.top = cy + 'px';
          if (i % 3 === 0) b.style.borderRadius = '50%';
          document.body.appendChild(b);
          const ang = Math.random() * Math.PI * 2, v = 60 + Math.random() * 160;
          b.animate([
            { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
            { transform: 'translate(' + Math.cos(ang) * v + 'px,' + (Math.sin(ang) * v - 90) + 'px) rotate(' + (Math.random() * 540 - 270) + 'deg)', opacity: 0 }
          ], { duration: 900 + Math.random() * 400, easing: 'cubic-bezier(.16,.8,.4,1)' }).onfinish = () => b.remove();
        }
      }, true);
    }
  }

  window.__glassClassify = applyAll;
  window.__glassSell = applyAll;
  scene();
  applyAll();
  interactions();
  if (!window.__glassTick) window.__glassTick = setInterval(() => { try { window.__glassClassify(); } catch (e) { /* noop */ } }, 60000);
})();
