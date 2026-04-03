import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { COLORS as B, FONTS, BUTTON_BASE, HALFTONE_PATTERN, HALFTONE_SIZE } from '../theme';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const SAND = '#FDF6EC';
const SAND_DARK = '#F5EBD7';

// =========================================================================
// SERVICE DETAIL CONTENT — from Waves sales decks
// =========================================================================
const SERVICE_DETAILS = {
  lawn: {
    header: 'Full-Service Lawn Care, Defined.',
    subheader: 'WaveGuard Lawn Care — 6–12 Applications/Year',
    sections: [
      { title: 'Turf Monitoring & Diagnostics', text: "Each service visit includes detailed turf health assessments — visual inspections, root-zone checks, and, when needed, lab testing — to detect pests, diseases, and nutrient or stress issues early. Findings guide adjustments to fertility programs, fungicide use, and cultural practices to maintain optimal turf vigor and resilience." },
      { title: 'Fertilization Program', text: "A precise fertilization schedule, applied 4–6 times per year, delivers balanced, slow-release nutrients for steady growth. Controlled-release nitrogen minimizes leaching, while phosphorus and potassium levels are adjusted based on season and soil data. Chelated micronutrients and biostimulants enhance nutrient uptake and stress tolerance." },
      { title: 'Weed Management (Pre/Post-Emergent)', text: "An integrated weed management program applies selective pre-emergent herbicides to prevent annual weed germination, in addition to targeted post-emergent treatments for escapes or perennials. Herbicide choices and timing are adjusted seasonally based on turf type, climate, and resistance management practices." },
      { title: 'Soil Conditioning & pH Balancing', text: "Soil chemistry is annually tested to monitor CEC, pH, and nutrient levels. Based on results, pH is adjusted with lime, sulfur, or other amendments, and micronutrients like iron, manganese, and zinc are applied to maintain optimal root-zone conditions." },
      { title: 'Disease Prevention (Fungicides)', text: "Preventive fungicide applications are integrated into the management program based on disease forecasting models, environmental data (temperature, humidity, leaf wetness), and turf species susceptibility. These treatments protect against major turf pathogens such as Rhizoctonia, Pythium, and Dollar Spot, prioritizing proactive suppression rather than reactive control." },
      { title: 'Lawn Insect & Turf Pest Control', text: "Pest control applications are timed to pest life cycles and environmental cues, targeting chinch bugs, sod webworms, mole crickets, armyworms, and fire ants. An IPM approach blends biological, chemical, and cultural controls, with product rotation to prevent resistance." },
      { title: 'Core/Liquid Aeration', text: "Performed once annually — typically in spring or fall — using mechanical coring or liquid aeration technologies to relieve soil compaction, enhance oxygen exchange, and stimulate microbial activity. This improves root penetration, nutrient mobility, and water infiltration." },
      { title: 'Weed-Free Landscape Bed Perimeter', text: "Selective spot applications of contact or systemic herbicides along turf and hardscape interfaces to maintain a clean, defined perimeter. Treatments are calibrated for ornamental safety." },
      { title: 'Iron / Greening Touch-Up', text: "Applied during nitrogen blackout or restriction periods, this chelated iron and micronutrient blend supports chlorophyll production, color uniformity, and turf vigor without promoting excessive top growth." },
      { title: 'Irrigation Maintenance & Watering Optimization', text: "Regular inspection and calibration of sprinkler systems to ensure even coverage and proper pressure. Seasonal adjustments align with ET rates, rainfall, and turf-specific needs." },
    ],
    extras: [
      { title: 'Lawn Restoration & Aeration', text: "We relieve soil compaction, boost root growth, fill in thin areas, and remove thatch that traps pests and disease — essential for restoring stressed lawns in our coastal climate." },
      { title: 'Lawn Nutrition & Disease Control', text: "We deliver the right nutrients at the right time and treat fungal threats like brown patch and dollar spot before they spread." },
      { title: 'Shrub & Ornamental Plant Care', text: "We use proactive monitoring and treatment to control pests and diseases, keeping your shrubs healthy, strong, and well-shaped year-round." },
    ],
  },
  pest: {
    header: 'Full-Service Pest Control, Defined.',
    sections: [
      { title: 'Pest Control', sub: 'Targeted protection for your home.', text: "Our expert pest control treatments target ants, roaches, and other invaders — scientifically formulated, seasonally timed, and engineered for household safety." },
      { title: 'Bed Bug Control', sub: 'Fast, effective relief from bed bugs.', text: "We combine professional-grade chemistry with expert inspection and monitoring to achieve total bed bug removal, start to finish." },
      { title: 'Mosquito Control', sub: 'Bite-free yards start here.', text: "Our mosquito control program targets breeding sites through larviciding, precision fogging, and habitat reduction — delivering lasting population suppression." },
      { title: 'Termite Protection', sub: 'Stop termites before they cause damage.', text: "Our termite control targets colonies at the source through advanced baiting and barrier technologies, ensuring durable structural defense." },
      { title: 'Rodent Control & Removal', sub: 'Remove rodents for good.', text: "Using integrated trapping, baiting, and exclusion methods, we eliminate rodent activity and establish long-term prevention against re-infestation." },
    ],
  },
  treeShrub: {
    header: 'Tree & Shrub Care — 6–8 Applications/Year',
    intro: "Our Shrub and Tree Care program provides comprehensive maintenance designed to promote the long-term health, beauty, and vitality of ornamental plants, trees, and palms. Through proactive monitoring and precise treatments, we address nutrient deficiencies, pest infestations, and disease pressures before they impact plant performance.",
    services: [
      { title: 'Root Zone Fertilization', text: 'Enhances plant and palm growth and color through targeted nutrient delivery.' },
      { title: 'Insect and Mite Control', text: 'Provides year-round protection against damaging pests such as scale, aphids, and mites.' },
      { title: 'Disease Control', text: 'Treats and prevents a wide range of tree, shrub, and palm diseases, including bud rot and leaf spot.' },
      { title: 'Horticultural Oil', text: 'Controls insects in their overwintering or larval stages for cleaner, healthier foliage.' },
      { title: 'Hort Fertilization', text: 'Balances essential nutrients like magnesium, manganese, and potassium to strengthen foliage and improve overall vigor.' },
      { title: 'Systemic and Foliar Treatments', text: 'Utilize precision applications to protect canopy health and sustain long-term vitality.' },
      { title: 'Professional Monitoring and Pruning', text: 'Ensures proper canopy structure, early pest detection, and balanced plant growth.' },
    ],
  },
};

const PERKS = [
  '10-30% Off Any Service',
  'Free Annual Termite Inspection',
  'Priority Scheduling',
  'Unlimited Callbacks',
  '24-Hour Response Time',
  '15% Off Any One-Time Treatment',
  'Waves Loyalty Access',
  'Digital Service Reports & Photos',
  'Waves App Access',
];

const REVIEWS = [
  {
    text: "We recently engaged Waves for our pest control needs. We had been using a well known competitor but their service was poor \u2014 many times we had to have them address shoddy work. Adam provided an extensive overview of his services and quoted a vastly more competitive rate.",
    name: 'Lakewood Ranch customer',
    location: 'Lakewood Ranch',
  },
  {
    text: "The Waves team was thorough, on-time and provided a great pest control service. I was using one of the big brands and was not satisfied. I will be using Waves for quarterly service from now on!",
    name: 'Jennifer',
    location: 'Bradenton',
  },
  {
    text: "My fiance and I live in Parrish, she and I along with two dogs were attacked by Africanized Killer bees. Waves responded quickly and handled the situation professionally.",
    name: 'Parrish customer',
    location: 'Parrish',
  },
];

const LOCATIONS = [
  { name: 'Lakewood Ranch', address: '13649 Luxe Ave #110, Bradenton, FL 34211', phone: '(941) 318-7612', tel: '+19413187612' },
  { name: 'Parrish', address: '5155 115th Dr E, Parrish, FL 34219', phone: '(941) 297-2817', tel: '+19412972817' },
  { name: 'Sarasota', address: '1450 Pine Warbler PL, Sarasota, FL 34240', phone: '(941) 297-2606', tel: '+19412972606' },
  { name: 'Venice', address: '1978 S Tamiami Trl #10, Venice, FL 34293', phone: '(941) 297-3337', tel: '+19412973337' },
];

const FAQ_CATEGORIES = [
  {
    category: 'Price & Value', questions: [
      { q: "Why is your price different from the big national brands?", a: "We're not a franchise charging you for a corporate office in Tennessee. Every dollar goes to better products, trained techs, and actual time on your property. The big brands rush through in 8 minutes — our techs spend 30-45 minutes on a standard visit because we're treating your specific lawn and pest issues, not running a conveyor belt." },
      { q: "Can I just do quarterly pest and skip the lawn/mosquito?", a: "Absolutely. But here's the thing — bundling saves you real money. Adding lawn care to your pest plan unlocks Silver (10% off everything). Add mosquito and you're at Gold (15% off). Most customers save $200-400/year by bundling vs. buying services separately." },
      { q: "Can you match my current provider's price?", a: "We don't price-match because we don't cut corners to hit a number. What we do is show you exactly what you're getting — every product, every visit, logged in your portal. Most customers who switch to us from a big brand were paying less but getting far less. One customer in Lakewood Ranch told us their old company didn't even spray inside." },
    ],
  },
  {
    category: 'Safety & Products', questions: [
      { q: "What chemicals do you use? Are they safe for my dog/kids?", a: "All products are EPA-registered and applied by licensed Florida technicians following exact label rates. For interior pest, we primarily use Alpine WSG (dinotefuran) and gel baits — very targeted, minimal exposure. Re-entry time is 30 minutes after it dries. We text you before and after every visit so you know exactly when it's safe to let pets out." },
      { q: "I have a koi pond / vegetable garden — will treatments affect it?", a: "Great question — we flag features like that in your property preferences. Our techs adjust application zones to avoid water features and edible gardens. We use targeted spot treatments near sensitive areas instead of broadcast sprays." },
      { q: "Do you use organic products?", a: "We use an IPM (Integrated Pest Management) approach — the minimum effective product for the situation. For lawn care, we incorporate biostimulants, humic acids, and micronutrients alongside conventional fertilizers. For pest control, we use baits and targeted applications rather than heavy broadcast sprays. If you have a strong preference for organic-only, let us know and we'll customize." },
    ],
  },
  {
    category: 'Scheduling & Service', questions: [
      { q: "Do I need to be home for every visit?", a: "Nope — about 80% of our services are exterior-only. For interior pest (typically quarterly), we coordinate access through your portal. You can leave a gate code, garage code, or lockbox info in your property preferences. You get a text when your tech is on the way and another when service is complete." },
      { q: "What if I need to skip a visit or go on vacation?", a: "Just let us know through the portal or text us. We'll reschedule around your travel. Your monthly rate stays the same since it's averaged over 12 months — skipping one visit doesn't change your billing." },
      { q: "How quickly can you start?", a: "Usually within 3-5 business days of accepting your estimate. For urgent pest issues (stinging insects, major infestations), we can often get a tech out same-day or next-day." },
    ],
  },
  {
    category: 'Billing & Commitment', questions: [
      { q: "Is there a contract? What if I want to cancel?", a: "No long-term contracts. Your WaveGuard plan bills monthly and you can cancel anytime through your portal or by texting us. No cancellation fees — we earn your business every visit." },
      { q: "Why is there an initial pest control fee?", a: "The first visit is a full property inspection + heavy treatment — takes 45-60 minutes compared to a normal 25-30 minute quarterly. We're establishing a baseline, hitting every entry point, treating the full interior and exterior. After that, quarterly visits maintain what we set up." },
      { q: "How does billing work?", a: "Simple: your card is charged on the 1st of each month, automatically. You get a receipt in your portal. No surprises, no price increases without notice. If you ever have a billing question, text us at (941) 318-7612 and we'll sort it out same day." },
    ],
  },
  {
    category: 'Results & Guarantees', questions: [
      { q: "What if pests come back between visits?", a: "That's what WaveGuard is for. Unlimited callbacks between scheduled visits — no charge. If you see ants, roaches, or anything else between quarterly treatments, text us and we'll send a tech back out. Most callbacks are handled within 24-48 hours." },
      { q: "How long until I see results on my lawn?", a: "Most customers see noticeable improvement within 2-3 visits (6-8 weeks). Weed reduction is usually visible after the first application. Full turf density takes one growing season — about 6-8 months. We track your lawn health metrics in the portal so you can see the progress over time." },
      { q: "My last lawn company burned my grass.", a: "That's usually from over-application or wrong product for the turf type. We start every lawn program with a full assessment — grass type confirmation, soil pH test, thatch measurement, irrigation check. Every product application is logged in your portal with the tech's notes. If we ever cause damage, we fix it — that's part of the guarantee." },
    ],
  },
  {
    category: 'SWFL-Specific', questions: [
      { q: "Do you treat for no-see-ums?", a: "Our mosquito barrier treatment significantly reduces no-see-um populations since they breed in similar areas. For heavy no-see-um pressure (especially near mangroves or tidal areas), we can add targeted treatments to your program." },
      { q: "What about during hurricane season?", a: "We monitor weather and proactively reschedule when tropical weather approaches. After a storm, we prioritize pest callbacks since flooding and debris cause pest surges. Your WaveGuard callbacks cover post-storm treatments at no extra charge." },
      { q: "My HOA requires a lawn care provider — do you work with HOAs?", a: "Yes. We provide your HOA with proof of service, licensed applicator info, and product safety data sheets. Many of our Lakewood Ranch customers are in HOA communities." },
    ],
  },
];

const TEAM = [
  { name: 'Adam Benetti', role: 'Founder' },
  { name: 'Virginia Gelser', role: 'Office Manager' },
  { name: 'Jose Alvarado', role: 'Technician' },
  { name: 'Jacob Heaton', role: 'Technician' },
];

const ALL_SERVICES = [
  { key: 'lawn', label: 'Lawn Care', emoji: '🌿' },
  { key: 'pest', label: 'Pest Control', emoji: '🐛' },
  { key: 'mosquito', label: 'Mosquito Control', emoji: '🦟' },
  { key: 'treeShrub', label: 'Tree & Shrub Care', emoji: '🌳' },
  { key: 'termite', label: 'Termite Protection', emoji: '🏠' },
];

// =========================================================================
// COMPONENTS
// =========================================================================
function ServiceDropdown({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderRadius: 16, overflow: 'hidden', border: `1px solid ${SAND_DARK}`, marginBottom: 10, background: '#fff' }}>
      <div onClick={() => setOpen(!open)} style={{
        padding: '14px 16px', cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: open ? B.blueSurface : '#fff',
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{title}</span>
        <span style={{ fontSize: 16, color: B.grayMid, transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▾</span>
      </div>
      {open && <div style={{ padding: '0 16px 16px' }}>{children}</div>}
    </div>
  );
}

function DetailSection({ title, sub, text }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: B.red, fontFamily: FONTS.heading }}>{title}</div>
      {sub && <div style={{ fontSize: 12, fontStyle: 'italic', color: B.grayDark, marginTop: 1 }}>{sub}</div>}
      <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginTop: 4, fontFamily: FONTS.body }}>{text}</div>
    </div>
  );
}

function PerksTable({ tier }) {
  return (
    <div style={{ borderRadius: 14, overflow: 'hidden', border: `2px solid ${B.wavesBlue}33` }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 90px 90px',
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`, color: '#fff',
        padding: '12px 14px', alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/waves-logo.png" alt="" style={{ height: 20 }} />
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: FONTS.heading }}>Perk</span>
        </div>
        <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, fontFamily: FONTS.heading }}>WaveGuard</div>
        <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, fontFamily: FONTS.heading, opacity: 0.7 }}>Non-Member</div>
      </div>
      {PERKS.map((perk, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: '1fr 90px 90px',
          padding: '10px 14px', alignItems: 'center',
          background: i % 2 === 0 ? '#fff' : B.blueSurface,
          borderTop: `1px solid ${SAND_DARK}`,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: B.navy, fontFamily: FONTS.heading }}>{perk}</span>
          <div style={{ textAlign: 'center', fontSize: 16, color: B.green }}>✅</div>
          <div style={{ textAlign: 'center', fontSize: 16, color: B.red }}>❌</div>
        </div>
      ))}
      <div style={{ padding: '12px 14px', background: B.blueSurface, borderTop: `1px solid ${SAND_DARK}` }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: B.wavesBlue, fontFamily: FONTS.heading, textAlign: 'center' }}>
          Your estimate includes WaveGuard {tier} — all perks included automatically.
        </div>
      </div>
    </div>
  );
}

function FAQCategory({ category, questions }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: B.wavesBlue, fontFamily: FONTS.ui, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>{category}</div>
      {questions.map((faq, i) => <FAQItem key={i} q={faq.q} a={faq.a} />)}
    </div>
  );
}

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${SAND_DARK}` }}>
      <div onClick={() => setOpen(!open)} style={{
        padding: '14px 0', cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, paddingRight: 12 }}>{q}</span>
        <span style={{ fontSize: 16, color: B.grayMid, transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s', flexShrink: 0 }}>▾</span>
      </div>
      {open && (
        <div style={{ paddingBottom: 14, fontSize: 14, color: B.grayDark, lineHeight: 1.65, fontFamily: FONTS.body }}>{a}</div>
      )}
    </div>
  );
}

// Pulse keyframes injected once
const pulseStyleId = 'waves-pulse-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(pulseStyleId)) {
  const style = document.createElement('style');
  style.id = pulseStyleId;
  style.textContent = `
    @keyframes wavesPulse {
      0%, 100% { box-shadow: 0 2px 8px rgba(168, 59, 52, 0.3); }
      50% { box-shadow: 0 2px 20px rgba(168, 59, 52, 0.55); }
    }
  `;
  document.head.appendChild(style);
}

// =========================================================================
// MAIN PAGE
// =========================================================================
export default function EstimateViewPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [declined, setDeclined] = useState(false);
  const reviewsRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/estimates/${token}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  const handleAccept = async () => {
    setAccepting(true);
    try {
      const res = await fetch(`${API_BASE}/estimates/${token}/accept`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
      const result = await res.json();
      if (result.onboardingToken) navigate(`/onboard/${result.onboardingToken}`, { replace: true });
    } catch (e) { console.error(e); }
    setAccepting(false);
  };

  const handleDecline = async () => {
    await fetch(`${API_BASE}/estimates/${token}/decline`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    setDeclined(true);
  };

  // Loading state
  if (loading) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#fff', fontSize: 16, fontFamily: FONTS.body }}>Loading your estimate...</div>
    </div>
  );

  // Error state
  if (!data || !data.estimate) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>😕</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: B.navy, marginTop: 8 }}>Estimate not found</div>
        <a href="tel:+19413187612" style={{ ...BUTTON_BASE, marginTop: 16, padding: '10px 20px', background: B.red, color: '#fff', textDecoration: 'none', display: 'inline-flex' }}>Call (941) 318-7612</a>
      </div>
    </div>
  );

  // Expired state
  if (data.expired) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONTS.body }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>⏰</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: B.navy, marginTop: 8 }}>This estimate has expired</div>
        <div style={{ fontSize: 14, color: B.grayDark, marginTop: 6 }}>Contact us for a fresh quote.</div>
        <a href="tel:+19413187612" style={{ ...BUTTON_BASE, marginTop: 16, padding: '10px 20px', background: B.red, color: '#fff', textDecoration: 'none', display: 'inline-flex' }}>Call (941) 318-7612</a>
      </div>
    </div>
  );

  // Declined state
  if (declined) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONTS.body }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>👋</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: B.navy, marginTop: 8 }}>Sorry to see you go</div>
        <div style={{ fontSize: 14, color: B.grayDark, marginTop: 6, lineHeight: 1.6 }}>If you change your mind, we're always here. No pressure.</div>
        <a href="tel:+19413187612" style={{ ...BUTTON_BASE, marginTop: 16, padding: '10px 20px', background: B.wavesBlue, color: '#fff', textDecoration: 'none', display: 'inline-flex' }}>Changed your mind? Call us</a>
      </div>
    </div>
  );

  // ---- Main estimate view ----
  const e = data.estimate;
  const ed = e.data || {};
  const recurring = ed.recurring || {};
  const oneTime = ed.oneTime || {};
  const totals = ed.totals || {};
  const property = ed.property || {};
  const services = recurring.services || [];
  const otItems = [...(oneTime.items || []), ...(oneTime.specItems || [])];
  const fmt = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Detect which services are included
  const svcNames = services.map(s => s.name.toLowerCase());
  const hasLawn = svcNames.some(n => n.includes('lawn'));
  const hasPest = svcNames.some(n => n.includes('pest'));
  const hasMosquito = svcNames.some(n => n.includes('mosquito'));
  const hasTS = svcNames.some(n => n.includes('tree') || n.includes('shrub'));
  const hasTermite = svcNames.some(n => n.includes('termite'));

  const includedKeys = [];
  if (hasLawn) includedKeys.push('lawn');
  if (hasPest) includedKeys.push('pest');
  if (hasMosquito) includedKeys.push('mosquito');
  if (hasTS) includedKeys.push('treeShrub');
  if (hasTermite) includedKeys.push('termite');

  const missingServices = ALL_SERVICES.filter(s => !includedKeys.includes(s.key));

  const firstName = (e.customerName || '').split(' ')[0] || 'there';
  const monthlyTotal = Number(e.monthlyTotal) || 0;
  const preDiscountMonthly = recurring.savings > 0 ? monthlyTotal + (recurring.savings / 12) : 0;
  const dailyCost = (monthlyTotal / 30).toFixed(2);

  return (
    <div style={{ minHeight: '100vh', background: SAND, fontFamily: FONTS.body, paddingBottom: 80 }}>

      {/* ============================================================= */}
      {/* 1. HERO SECTION                                                */}
      {/* ============================================================= */}
      <div style={{
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        padding: '28px 20px 48px', textAlign: 'center', color: '#fff',
        position: 'relative',
      }}>
        <img src="/waves-logo.png" alt="Waves" style={{ height: 44, marginBottom: 12 }} />

        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FONTS.heading, lineHeight: 1.3, maxWidth: 380, margin: '0 auto' }}>
          Hey {firstName}, here's your custom plan.
        </div>

        <div style={{ fontSize: 14, color: B.blueLight, marginTop: 8, fontWeight: 600 }}>{e.address}</div>

        {(property.homeSqFt || property.lotSqFt) && (
          <div style={{ fontSize: 13, color: B.blueLight, marginTop: 4 }}>
            {property.homeSqFt ? `${Number(property.homeSqFt).toLocaleString()} sq ft home` : ''}
            {property.homeSqFt && property.lotSqFt ? ' · ' : ''}
            {property.lotSqFt ? `${Number(property.lotSqFt).toLocaleString()} sq ft lot` : ''}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          {recurring.savings > 0 && preDiscountMonthly > 0 && (
            <div style={{ fontSize: 16, color: '#ffffff88', textDecoration: 'line-through', fontFamily: FONTS.ui }}>
              {fmt(preDiscountMonthly)}/mo
            </div>
          )}
          <div style={{ fontSize: 42, fontWeight: 800, fontFamily: FONTS.ui, lineHeight: 1.1 }}>
            {fmt(monthlyTotal)}<span style={{ fontSize: 16, fontWeight: 400, opacity: 0.8 }}>/mo</span>
          </div>
        </div>

        {recurring.savings > 0 && e.tier && (
          <div style={{ fontSize: 14, color: B.green, fontWeight: 700, marginTop: 6 }}>
            You save {fmt(recurring.savings / 12)}/mo with {e.tier}
          </div>
        )}

        <div style={{ fontSize: 13, color: '#ffffffcc', marginTop: 6 }}>
          That's just ${dailyCost}/day for complete home protection
        </div>

        {e.tier && (
          <div style={{
            display: 'inline-block', marginTop: 12, padding: '6px 16px', borderRadius: 20,
            background: `${B.yellow}25`, color: B.yellow, fontSize: 13, fontWeight: 700,
            fontFamily: FONTS.heading,
          }}>
            WaveGuard {e.tier}
          </div>
        )}

        {/* Wave SVG bottom edge */}
        <div style={{
          position: 'absolute', bottom: -1, left: 0, right: 0, height: 24,
          background: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 60'%3E%3Cpath d='M0,20 C200,50 400,0 600,30 C800,55 1000,5 1200,20 L1200,60 L0,60Z' fill='%23FDF6EC'/%3E%3C/svg%3E") no-repeat bottom`,
          backgroundSize: '100% 100%',
        }} />
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '0 16px 40px' }}>

        {/* ============================================================= */}
        {/* 2. SERVICE LINE ITEMS                                          */}
        {/* ============================================================= */}
        <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginTop: 16, border: `1px solid ${SAND_DARK}` }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 12 }}>Your Services</div>
          {services.map((s, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', padding: '10px 0',
              borderBottom: i < services.length - 1 ? `1px solid ${SAND_DARK}` : 'none',
            }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: B.navy }}>{s.name}</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: B.green, fontFamily: FONTS.ui }}>{fmt(s.mo)}/mo</span>
            </div>
          ))}
          {recurring.discount > 0 && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', padding: '10px 0',
              borderTop: `1px solid ${SAND_DARK}`, marginTop: 6,
            }}>
              <span style={{ fontSize: 14, color: B.green, fontWeight: 600 }}>WaveGuard {e.tier} discount</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: B.green, fontFamily: FONTS.ui }}>-{fmt(recurring.savings / 12)}/mo</span>
            </div>
          )}
          <div style={{
            display: 'flex', justifyContent: 'space-between', padding: '12px 0 0',
            borderTop: `2px solid ${SAND_DARK}`, marginTop: 6,
          }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>Monthly Total</span>
            <span style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.ui }}>{fmt(monthlyTotal)}/mo</span>
          </div>
        </div>

        {/* One-time services */}
        {otItems.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginTop: 12, border: `1px solid ${SAND_DARK}` }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>One-Time Services</div>
            {otItems.map((item, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', padding: '8px 0',
                borderBottom: i < otItems.length - 1 ? `1px solid ${SAND_DARK}` : 'none',
              }}>
                <span style={{ fontSize: 14, color: B.grayDark }}>{item.name}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.ui }}>${Math.round(item.price)}</span>
              </div>
            ))}
          </div>
        )}

        {/* ============================================================= */}
        {/* 3. HOW IT WORKS — 3 steps                                      */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, textAlign: 'center', marginBottom: 16 }}>
            How It Works
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[
              { emoji: '📋', num: '1', title: 'Accept Your Estimate', desc: 'Tap the button below. Takes 10 seconds.' },
              { emoji: '🏡', num: '2', title: 'Quick Setup', desc: 'Add your card, set property preferences, confirm your first visit. 2 minutes.' },
              { emoji: '🌊', num: '3', title: 'Wave Goodbye to Pests', desc: 'Your dedicated tech handles the rest. Track everything in your portal.' },
            ].map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                {/* Step number column with dotted connector */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 44 }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%', background: '#fff',
                    border: `2px solid ${B.wavesBlue}33`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 22, fontWeight: 800, color: B.wavesBlue, fontFamily: FONTS.ui,
                  }}>
                    {step.num}
                  </div>
                  {i < 2 && (
                    <div style={{
                      width: 2, height: 32, borderLeft: `2px dotted ${B.wavesBlue}44`,
                    }} />
                  )}
                </div>
                {/* Content card */}
                <div style={{
                  background: '#fff', borderRadius: 16, padding: '14px 16px', flex: 1,
                  border: `1px solid ${SAND_DARK}`, marginBottom: i < 2 ? 0 : 0,
                }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                    {step.emoji} {step.title}
                  </div>
                  <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.65, marginTop: 4, fontFamily: FONTS.body }}>
                    {step.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ============================================================= */}
        {/* 4. WHAT'S INCLUDED — expandable dropdowns                      */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 12 }}>What's Included</div>

          {hasLawn && (
            <ServiceDropdown title="🌿 Lawn Care Program">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 2 }}>{SERVICE_DETAILS.lawn.header}</div>
              <div style={{ fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginBottom: 14 }}>{SERVICE_DETAILS.lawn.subheader}</div>
              {SERVICE_DETAILS.lawn.sections.map((s, i) => <DetailSection key={i} title={s.title} text={s.text} />)}
              <div style={{ borderTop: `1px solid ${SAND_DARK}`, marginTop: 10, paddingTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Additional Services</div>
                {SERVICE_DETAILS.lawn.extras.map((s, i) => <DetailSection key={i} title={s.title} text={s.text} />)}
              </div>
            </ServiceDropdown>
          )}

          {hasPest && (
            <ServiceDropdown title="🐛 Pest Control">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 14 }}>{SERVICE_DETAILS.pest.header}</div>
              {SERVICE_DETAILS.pest.sections.map((s, i) => <DetailSection key={i} title={s.title} sub={s.sub} text={s.text} />)}
            </ServiceDropdown>
          )}

          {hasMosquito && (
            <ServiceDropdown title="🦟 Mosquito Control">
              <DetailSection
                title="Mosquito Control"
                sub="Bite-free yards start here."
                text="Our mosquito control program targets breeding sites through larviciding, precision fogging, and habitat reduction — delivering lasting population suppression. Barrier treatments are applied to all foliage, fence lines, and standing water areas around your property perimeter."
              />
            </ServiceDropdown>
          )}

          {hasTS && (
            <ServiceDropdown title="🌳 Tree & Shrub Care">
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>{SERVICE_DETAILS.treeShrub.header}</div>
              <div style={{ fontSize: 13, color: '#455A64', lineHeight: 1.65, marginBottom: 14, fontFamily: FONTS.body }}>{SERVICE_DETAILS.treeShrub.intro}</div>
              {SERVICE_DETAILS.treeShrub.services.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: B.green, fontSize: 14, flexShrink: 0, marginTop: 1 }}>✓</span>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 700, color: B.navy }}>{s.title}:</span>{' '}
                    <span style={{ fontSize: 13, color: '#455A64' }}>{s.text}</span>
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 11, color: B.grayMid, fontStyle: 'italic', marginTop: 8 }}>*Available as an additional add-on service</div>
            </ServiceDropdown>
          )}

          {hasTermite && (
            <ServiceDropdown title="🏠 Termite Protection">
              <DetailSection
                title="Termite Protection"
                sub="Stop termites before they cause damage."
                text="Our termite control targets colonies at the source through advanced baiting and barrier technologies, ensuring durable structural defense. We use Trelona ATBS and Sentricon systems — the most effective bait station platforms available — with quarterly monitoring included."
              />
            </ServiceDropdown>
          )}
        </div>

        {/* ============================================================= */}
        {/* 5. ALSO AVAILABLE section                                      */}
        {/* ============================================================= */}
        {missingServices.length > 0 && (
          <div style={{ marginTop: 32 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 12 }}>
              Also Available — Add to Your Plan
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {missingServices.slice(0, 2).map((svc, i) => (
                <div key={i} style={{
                  background: '#fff', borderRadius: 16, padding: '16px 18px',
                  border: `1px solid ${SAND_DARK}`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                      {svc.emoji} {svc.label}
                    </div>
                    <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>Ask us to add this to your plan</div>
                  </div>
                  <a
                    href={`sms:+19413187612?body=${encodeURIComponent(`Hi! I'd like to add ${svc.label} to my estimate for ${e.address}.`)}`}
                    style={{
                      ...BUTTON_BASE, padding: '8px 16px', fontSize: 12,
                      background: B.wavesBlue, color: '#fff', textDecoration: 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Text Us
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============================================================= */}
        {/* 6. PERKS THAT ACTUALLY MATTER — comparison table               */}
        {/* ============================================================= */}
        {e.tier && (
          <div style={{ marginTop: 32 }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4, textAlign: 'center' }}>
              Perks That Actually Matter.
            </div>
            <div style={{ fontSize: 13, color: '#455A64', textAlign: 'center', marginBottom: 14, lineHeight: 1.5, fontFamily: FONTS.body }}>
              {hasLawn
                ? 'When turf issues arise, WaveGuard delivers prompt, data-driven diagnostics and precise treatment applications — ensuring efficient, stress-free restoration and long-term lawn health.'
                : 'When pest activity occurs, WaveGuard ensures rapid, efficient response and resolution — minimizing disruption and maintaining control with simplicity and precision.'}
            </div>
            <PerksTable tier={e.tier} />
          </div>
        )}

        {/* ============================================================= */}
        {/* 7. REVIEWS CAROUSEL                                            */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ textAlign: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
              Don't just take our word for it 🌟
            </div>
            <div style={{ fontSize: 14, color: B.yellow, marginTop: 4 }}>
              4.9 ★★★★★ <span style={{ color: B.grayMid, fontSize: 12 }}>on Google</span>
            </div>
          </div>
          <div
            ref={reviewsRef}
            style={{
              display: 'flex', gap: 14, overflowX: 'auto', scrollSnapType: 'x mandatory',
              WebkitOverflowScrolling: 'touch', paddingBottom: 8,
              msOverflowStyle: 'none', scrollbarWidth: 'none',
            }}
          >
            {REVIEWS.map((r, i) => (
              <div key={i} style={{
                minWidth: 280, maxWidth: 320, flexShrink: 0, scrollSnapAlign: 'start',
                background: '#fff', borderRadius: 16, padding: 18,
                border: `1px solid ${SAND_DARK}`,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
              }}>
                <div style={{ fontSize: 16, color: B.yellow, marginBottom: 8 }}>★★★★★</div>
                <div style={{
                  fontSize: 13, color: B.grayDark, lineHeight: 1.65, fontFamily: FONTS.body,
                  display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  "{r.text}"
                </div>
                <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                  — {r.name}
                </div>
                <div style={{ fontSize: 12, color: B.grayMid }}>{r.location}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ============================================================= */}
        {/* 8. MEET YOUR WAVES TEAM                                        */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ textAlign: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
              Local Expertise. Real People.
            </div>
            <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.65, marginTop: 6, fontFamily: FONTS.body, maxWidth: 420, margin: '6px auto 0' }}>
              Waves is a family-owned lawn and pest company serving Southwest Florida. We combine modern technology with old-school accountability — every customer gets a dedicated tech, transparent pricing, and real results.
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            {['✅ 100% Guaranteed', '📋 No Contracts', '⭐ 5-Star Rated'].map((badge, i) => (
              <div key={i} style={{
                padding: '8px 14px', borderRadius: 20, background: '#fff',
                border: `1px solid ${SAND_DARK}`, fontSize: 12, fontWeight: 700,
                color: B.navy, fontFamily: FONTS.heading,
              }}>
                {badge}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
            {TEAM.map((t, i) => {
              const initials = t.name.split(' ').map(n => n[0]).join('');
              return (
                <div key={i} style={{ textAlign: 'center', minWidth: 70 }}>
                  <div style={{
                    width: 52, height: 52, borderRadius: '50%',
                    background: `linear-gradient(135deg, ${B.wavesBlue}, ${B.blueDeeper})`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontSize: 18, fontWeight: 800, fontFamily: FONTS.ui,
                    margin: '0 auto 6px',
                  }}>
                    {initials}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: B.grayMid }}>{t.role}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ============================================================= */}
        {/* 9. LOCATIONS GRID                                              */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, textAlign: 'center', marginBottom: 14 }}>
            Fast, Local Service Near You
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {LOCATIONS.map((loc, i) => (
              <div key={i} style={{
                background: '#fff', borderRadius: 16, padding: 14,
                border: `1px solid ${SAND_DARK}`,
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>
                  {loc.name}
                </div>
                <div style={{ fontSize: 11, color: B.grayDark, lineHeight: 1.5, marginBottom: 6, fontFamily: FONTS.body }}>
                  {loc.address}
                </div>
                <a href={`tel:${loc.tel}`} style={{
                  fontSize: 12, fontWeight: 700, color: B.wavesBlue, textDecoration: 'none', fontFamily: FONTS.heading,
                }}>
                  {loc.phone}
                </a>
              </div>
            ))}
          </div>
        </div>

        {/* ============================================================= */}
        {/* 10. FAQ ACCORDION                                              */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, textAlign: 'center', marginBottom: 4 }}>
            Questions? We've Got Answers.
          </div>
          <div style={{ fontSize: 13, color: B.grayDark, textAlign: 'center', marginBottom: 16, lineHeight: 1.5 }}>
            Real questions from SWFL homeowners — answered by your Waves team.
          </div>
          <div style={{ background: '#fff', borderRadius: 16, padding: '12px 18px', border: `1px solid ${SAND_DARK}` }}>
            {FAQ_CATEGORIES.map((cat, i) => <FAQCategory key={i} category={cat.category} questions={cat.questions} />)}
          </div>
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <div style={{ fontSize: 13, color: B.grayDark }}>Still have a question?</div>
            <a href="sms:+19413187612?body=Hi%2C%20I%20have%20a%20question%20about%20my%20Waves%20estimate" style={{
              ...BUTTON_BASE, padding: '10px 20px', fontSize: 13, marginTop: 6,
              background: B.red, color: '#fff', textDecoration: 'none', display: 'inline-flex',
            }}>💬 Text Us — (941) 318-7612</a>
          </div>
        </div>

        {/* ============================================================= */}
        {/* 11. FINAL CTA                                                  */}
        {/* ============================================================= */}
        <div style={{ marginTop: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 16 }}>
            Ready to protect your home?
          </div>

          {e.status !== 'accepted' ? (
            <>
              <button onClick={handleAccept} disabled={accepting} style={{
                ...BUTTON_BASE, width: '100%', padding: 18, fontSize: 17,
                background: B.red, color: '#fff', opacity: accepting ? 0.7 : 1,
                boxShadow: `0 4px 15px ${B.red}40`,
              }}>
                {accepting ? 'Processing...' : 'Accept Estimate'}
              </button>

              <a href={`sms:+19413187612?body=${encodeURIComponent(`Hi, I have a question about my Waves estimate for ${e.address}`)}`} style={{
                ...BUTTON_BASE, width: '100%', padding: 14, fontSize: 14, marginTop: 10,
                background: 'transparent', color: B.wavesBlue, border: `1.5px solid ${B.wavesBlue}`,
                textDecoration: 'none', display: 'flex',
              }}>
                I Have Questions
              </a>

              <div onClick={handleDecline} style={{
                textAlign: 'center', marginTop: 14, fontSize: 12, color: B.grayMid, cursor: 'pointer',
              }}>
                No thanks, decline this estimate
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: 24, background: '#E8F5E9', borderRadius: 14 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: B.green, marginBottom: 8 }}>{'✅'} Estimate Accepted!</div>
              <div style={{ fontSize: 14, color: B.grayDark, marginBottom: 16 }}>Check your texts for the onboarding link.</div>
              <div style={{ borderTop: '1px solid #C8E6C9', paddingTop: 16 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: B.navy, marginBottom: 4 }}>Ready to get started?</div>
                <div style={{ fontSize: 13, color: B.grayDark, marginBottom: 12 }}>Book your first appointment — pick a time that works for you.</div>
                <a href={`/book/${token}?city=${encodeURIComponent(e.serviceCity || e.city || '')}`} style={{
                  display: 'inline-block', padding: '12px 28px', borderRadius: 10,
                  background: B.wavesBlue, color: '#fff', fontSize: 15, fontWeight: 700,
                  textDecoration: 'none',
                }}>{'📅'} Book Your Appointment</a>
              </div>
            </div>
          )}

          {e.expiresAt && (
            <div style={{ textAlign: 'center', fontSize: 11, color: B.grayMid, marginTop: 12 }}>
              Estimate valid until {new Date(e.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </div>
          )}
        </div>

        {/* ============================================================= */}
        {/* 12. FOOTER                                                     */}
        {/* ============================================================= */}
        <div style={{ textAlign: 'center', marginTop: 32, paddingTop: 20, borderTop: `1px solid ${SAND_DARK}` }}>
          <img src="/waves-logo.png" alt="" style={{ height: 28, opacity: 0.6, marginBottom: 6 }} />
          <div style={{ fontSize: 12, color: B.grayMid }}>Family-owned, SWFL-based</div>
          <div style={{ fontSize: 13, color: B.wavesBlue, fontWeight: 600, marginTop: 4 }}>Wave Goodbye to Pests! 🌊</div>
          <div style={{ fontSize: 12, color: B.grayMid, marginTop: 8 }}>
            <a href="tel:+19413187612" style={{ color: B.wavesBlue, fontWeight: 600, textDecoration: 'none' }}>(941) 318-7612</a>
          </div>
        </div>
      </div>

      {/* ============================================================= */}
      {/* 13. STICKY BOTTOM BAR                                          */}
      {/* ============================================================= */}
      {e.status !== 'accepted' && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 1000,
          background: `${B.blueDeeper}ee`,
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          padding: '10px 16px', paddingBottom: 'max(10px, env(safe-area-inset-bottom))',
        }}>
          <div style={{
            maxWidth: 560, margin: '0 auto',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 20, fontWeight: 800, color: '#fff', fontFamily: FONTS.ui }}>
                  {fmt(monthlyTotal)}<span style={{ fontSize: 12, fontWeight: 400, opacity: 0.7 }}>/mo</span>
                </span>
                {e.tier && (
                  <span style={{
                    padding: '3px 10px', borderRadius: 12,
                    background: `${B.yellow}25`, color: B.yellow,
                    fontSize: 10, fontWeight: 700, fontFamily: FONTS.heading,
                  }}>
                    {e.tier}
                  </span>
                )}
              </div>
              <div style={{ display: 'none' }}>
                {/* Show on mobile via media query alternative: inline for small screens */}
              </div>
            </div>
            <button onClick={handleAccept} disabled={accepting} style={{
              ...BUTTON_BASE, padding: '12px 24px', fontSize: 14,
              background: B.red, color: '#fff', opacity: accepting ? 0.7 : 1,
              animation: 'wavesPulse 2s ease-in-out infinite',
              whiteSpace: 'nowrap',
            }}>
              {accepting ? 'Processing...' : 'Accept Estimate'}
            </button>
          </div>
          <div style={{
            textAlign: 'center', marginTop: 4, fontSize: 11, color: '#ffffff88',
          }}>
            or text us: <a href="sms:+19413187612" style={{ color: B.blueLight, textDecoration: 'none', fontWeight: 600 }}>(941) 318-7612</a>
          </div>
        </div>
      )}
    </div>
  );
}
