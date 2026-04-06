const express = require('express');
const router = express.Router();
const xml2js = require('xml2js');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

const cache = {};
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchWithCache(key, url) {
  const now = Date.now();
  if (cache[key] && (now - cache[key].ts) < CACHE_TTL) return cache[key].data;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const parsed = await xml2js.parseStringPromise(text, { explicitArray: false });
    cache[key] = { data: parsed, ts: now };
    return parsed;
  } catch { return null; }
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

function extractImage(item) {
  // Try media:content, media:thumbnail, enclosure, or content:encoded img
  if (item['media:content']?.$?.url) return item['media:content'].$.url;
  if (item['media:thumbnail']?.$?.url) return item['media:thumbnail'].$.url;
  if (item.enclosure?.$?.url && item.enclosure.$.type?.startsWith('image')) return item.enclosure.$.url;
  // Try to find first img in content
  const content = item['content:encoded'] || item.description || '';
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/);
  if (imgMatch) return imgMatch[1];
  return null;
}

function parseItems(channel) {
  if (!channel) return [];
  const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  return items;
}

// =========================================================================
// Keyword filter for relevance
// =========================================================================
const RELEVANT_KEYWORDS = /\b(lawn|turf|grass|pest|mosquito|termite|ant|roach|spider|weed|fungus|fertiliz|irrigat|landscape|garden|palm|tree|shrub|insect|rodent|flea|tick|chinch|mole cricket|fire ant|whitefly|scale|mildew|herbicide|pesticide|ipm|sod|thatch|aerat|drought|florida.friendly|red tide|hurricane|storm|flood|water restrict)/i;

const EXCLUDE_KEYWORDS = /\b(4-h|youth|cooking|nutrition|career|volunteer|obituar|crime|arrest|murder|robbery|theft|political|election|vote|basketball|football|soccer|baseball|golf tournament)/i;

// =========================================================================
// GET /api/feed/blog — Waves blog
// =========================================================================
router.get('/blog', async (req, res, next) => {
  try {
    const data = await fetchWithCache('blog', 'https://www.wavespestcontrol.com/feed/');
    const items = parseItems(data?.rss?.channel);

    const posts = items.slice(0, 6).map(item => ({
      title: item.title || '',
      link: item.link || '',
      pubDate: item.pubDate || '',
      description: stripHtml(item.description || '').slice(0, 200),
      image: extractImage(item),
      category: Array.isArray(item.category) ? item.category[0] : (item.category || 'Blog'),
      source: 'blog',
      sourceName: 'Waves Blog',
    }));

    res.json({ posts });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/feed/newsletter — Beehiiv newsletter
// =========================================================================
router.get('/newsletter', async (req, res, next) => {
  try {
    const data = await fetchWithCache('newsletter', 'https://rss.beehiiv.com/feeds/PKlbF8uD3m.xml');
    const items = parseItems(data?.rss?.channel);

    const posts = items.slice(0, 6).map(item => ({
      title: item.title || '',
      link: item.link || '',
      pubDate: item.pubDate || '',
      description: stripHtml(item.description || '').slice(0, 200),
      image: extractImage(item),
      source: 'newsletter',
      sourceName: 'Waves Newsletter',
    }));

    res.json({ posts });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/feed/experts — UF/IFAS Extension
// =========================================================================
router.get('/experts', async (req, res, next) => {
  try {
    const [sarasota, manatee] = await Promise.all([
      fetchWithCache('ifas_sarasota', 'https://blogs.ifas.ufl.edu/sarasotaco/feed/'),
      fetchWithCache('ifas_manatee', 'https://blogs.ifas.ufl.edu/manateeco/feed/'),
    ]);

    const allItems = [
      ...parseItems(sarasota?.rss?.channel).map(i => ({ ...i, _source: 'UF/IFAS Sarasota' })),
      ...parseItems(manatee?.rss?.channel).map(i => ({ ...i, _source: 'UF/IFAS Manatee' })),
    ];

    // Filter for relevant content
    const relevant = allItems.filter(item => {
      const text = `${item.title || ''} ${stripHtml(item.description || '')}`;
      return RELEVANT_KEYWORDS.test(text) && !EXCLUDE_KEYWORDS.test(text);
    });

    // Sort by date desc
    relevant.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

    const posts = relevant.slice(0, 4).map(item => ({
      title: item.title || '',
      link: item.link || '',
      pubDate: item.pubDate || '',
      description: stripHtml(item.description || '').slice(0, 180),
      image: extractImage(item),
      source: 'ifas',
      sourceName: item._source,
    }));

    res.json({ posts });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/feed/local — Local SWFL news (filtered)
// =========================================================================
router.get('/local', async (req, res, next) => {
  try {
    const data = await fetchWithCache('mysuncoast', 'https://www.mysuncoast.com/news/local/rss/');
    const items = parseItems(data?.rss?.channel);

    const relevant = items.filter(item => {
      const text = `${item.title || ''} ${stripHtml(item.description || '')}`;
      return RELEVANT_KEYWORDS.test(text) && !EXCLUDE_KEYWORDS.test(text);
    });

    const posts = relevant.slice(0, 3).map(item => ({
      title: item.title || '',
      link: item.link || '',
      pubDate: item.pubDate || '',
      description: stripHtml(item.description || '').slice(0, 150),
      image: extractImage(item),
      source: 'local',
      sourceName: 'MySuncoast',
    }));

    res.json({ posts });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/feed/alerts — Seasonal alerts + RSS urgent items
// =========================================================================
router.get('/alerts', async (req, res, next) => {
  try {
    const month = new Date().getMonth();

    const SEASONAL_ALERTS = {
      0: [{ type: 'seasonal', icon: '🌿', title: 'Winter Weed Season', desc: 'Dollar weed and clover are active. Your tech is watching for them.' }],
      1: [{ type: 'urgent', icon: '🐜', title: 'Termite Swarm Season Begins', desc: 'If you see flying insects near windows, call us immediately.' }],
      2: [
        { type: 'urgent', icon: '🐜', title: 'Peak Termite Swarm Month', desc: 'Peak swarm month in Manatee & Sarasota counties.' },
        { type: 'seasonal', icon: '🌱', title: 'Spring Green-Up Starting', desc: 'St. Augustine is waking up. Great time to start a lawn program.' },
      ],
      3: [
        { type: 'seasonal', icon: '🦟', title: 'Mosquito Season Ramping Up', desc: 'April through October is active season. Chinch bug activity begins in St. Augustine.' },
      ],
      4: [
        { type: 'urgent', icon: '🌧️', title: 'Rainy Season Approaching', desc: 'Expect increased mosquito pressure and fungus risk.' },
      ],
      5: [{ type: 'urgent', icon: '⚠️', title: 'Fertilizer Blackout Started', desc: 'Manatee and Sarasota counties restrict nitrogen June 1 – Sept 30. Your lawn program adjusts automatically.' }],
      6: [{ type: 'info', icon: '☀️', title: 'Peak Summer', desc: 'Rainy season is here. Mosquito and pest pressure are at their highest.' }],
      7: [{ type: 'info', icon: '☀️', title: 'August Heat', desc: 'Peak pest activity. Keep irrigation running early AM only.' }],
      8: [{ type: 'seasonal', icon: '🌀', title: 'Hurricane Season Active', desc: 'Monitor storms and keep your property clear of debris.' }],
      9: [{ type: 'seasonal', icon: '🍂', title: 'Fall Recovery Season', desc: 'Best time to assess lawn health after summer stress.' }],
      10: [{ type: 'seasonal', icon: '🏠', title: 'Pre-Winter Prep', desc: 'Termite awareness for holiday home sales season.' }],
      11: [{ type: 'info', icon: '🌿', title: 'Winter Weed Prevention Active', desc: 'Lawn growth slows but doesn\'t stop in SWFL.' }],
    };

    const alerts = (SEASONAL_ALERTS[month] || []).map(a => ({
      ...a, date: new Date().toISOString(),
    }));

    res.json({ alerts });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/feed/monthly-tip — SWFL homeowner tip
// =========================================================================
router.get('/monthly-tip', async (req, res, next) => {
  const month = new Date().getMonth();
  const TIPS = {
    0: { title: 'January Lawn Check', tip: "Even though growth slows in winter, keep mowing at 4 inches. Taller grass shades out winter weeds. And don't skip irrigation completely — your lawn still needs about 0.5 inches per week." },
    1: { title: 'Pre-Spring Prep', tip: "February is your last chance for pre-emergent before spring weeds explode. If you're on our lawn program, we've got this covered. Also a great time to sharpen your mower blades." },
    2: { title: 'Spring Is Here', tip: "Time to bump irrigation back up. Your St. Augustine wants 1 inch per week split into 2-3 waterings. Early morning only — never after 10 AM. Evening watering invites fungus." },
    3: { title: 'Spring Irrigation Check', tip: "Walk your zones this weekend. Look for heads spraying the sidewalk, dry spots, and that one zone that turns your yard into a swamp. Your tech can flag issues during your next visit." },
    4: { title: 'Hurricane Prep Starts Now', tip: "Hurricane prep starts now, not in August. Trim dead palm fronds, clear your yard of anything that becomes a projectile, and make sure your drainage isn't blocked." },
    5: { title: 'Fertilizer Blackout Season', tip: "Fertilizer blackout season started June 1 in Sarasota and Manatee counties. No nitrogen until October 1. Don't worry — your Waves lawn program switches to micronutrients, iron, and targeted weed control." },
    6: { title: 'Summer Survival Mode', tip: "Your lawn is stressed. Water deeply but less frequently. Mow high (4+ inches). Don't panic about brown spots — summer dormancy is normal for St. Augustine during extreme heat." },
    7: { title: 'Late Summer Fungus Watch', tip: "Large patch fungus starts showing up when night temps drop below 75°F. Watch for circular brown patches. If you spot one, text us a photo — early treatment is key." },
    8: { title: 'Post-Storm Checklist', tip: "After any tropical system: check for standing water (mosquito breeding), inspect bait stations, photograph any tree/landscape damage. We'll do a full property check on your next visit." },
    9: { title: 'Fall Recovery Time', tip: "October is the best month to start a lawn program in SWFL. Summer stress is fading, growth is steady, and pre-emergent goes down before winter weeds arrive. If you know a neighbor thinking about it, now's the time." },
    10: { title: 'Holiday Hosting Prep', tip: "Guests coming for Thanksgiving? Book a one-time pest treatment now if you're not on a quarterly plan. Nobody wants to explain the palmetto bug to the in-laws." },
    11: { title: 'Year-End Lawn Review', tip: "December is a great time to walk your property with fresh eyes. Note any bare spots, drainage issues, or areas that struggled this year. Share them with your tech — they'll build it into your spring plan." },
  };

  const tip = TIPS[month] || TIPS[0];
  res.json({ ...tip, month: new Date().toLocaleString('en-US', { month: 'long' }) });
});

// =========================================================================
// GET /api/feed/faq — Static FAQ data
// =========================================================================
router.get('/faq', async (req, res) => {
  res.json({ categories: FAQ_DATA });
});

const FAQ_DATA = [
  {
    category: 'Pest Control', icon: '🐜',
    questions: [
      { q: 'Is it safe for my pets after you spray?', a: 'Yes — once the product dries (usually 30-60 minutes), it\'s safe for pets and kids. We use targeted, EPA-registered products applied by licensed technicians. If you have concerns about a specific product, just ask your tech.' },
      { q: 'How long should I stay off the lawn after treatment?', a: 'Give it about an hour to dry. Once it\'s dry, you\'re good. We\'ll always let you know if a specific treatment needs longer.' },
      { q: 'Do I need to be home when you come?', a: 'Nope. Most of our services are exterior-only. If we need interior access, we\'ll coordinate with you ahead of time. Just make sure gates are unlocked and pets are secured.' },
      { q: 'What if I see bugs between visits?', a: 'Text us a photo! Some activity between quarterly treatments is normal — especially after heavy rain. If it\'s unusual, we\'ll come back at no extra charge. That\'s the Waves guarantee.' },
      { q: 'What\'s the difference between German and American roaches?', a: 'German roaches are small (half inch), light brown, and live INSIDE — kitchens and bathrooms. They\'re a sanitation issue. American roaches (palmetto bugs) are big, dark, and mostly outdoor creatures that wander inside. Different bugs, different treatments.' },
      { q: 'Are your products safe for kids?', a: 'Absolutely. We use targeted applications in specific areas — we\'re not carpet-bombing your yard. All our products are EPA-registered and applied according to label directions by licensed professionals.' },
    ],
  },
  {
    category: 'Lawn Care', icon: '🌱',
    questions: [
      { q: 'Why does my St. Augustine have brown patches?', a: 'Usually one of three things: large patch fungus (circular patches, cool/wet weather), chinch bugs (sunny edges, hot/dry weather), or drought stress. Text us a photo and we can usually diagnose it from that.' },
      { q: 'How much should I water my lawn in summer?', a: 'About 1 inch per week, split into 2-3 waterings. Always early morning (before 10 AM). Evening watering is the #1 cause of fungus in SWFL lawns. Your irrigation controller is your best friend.' },
      { q: 'What\'s thatch and why does it matter?', a: 'Thatch is the layer of dead grass between the soil and the green blades. Under half an inch is fine. Over that, water and nutrients can\'t reach the roots, and pests love hiding in it. We measure it at every lawn visit.' },
      { q: 'Why can\'t you fertilize in summer?', a: 'Sarasota and Manatee counties ban nitrogen fertilizer from June 1 to September 30 to protect waterways. Your Waves lawn program automatically switches to iron, micronutrients, and targeted weed control during these months.' },
      { q: 'When will I see results from the lawn program?', a: 'Most customers see noticeable improvement in 60-90 days. Full transformation takes 6-12 months depending on starting condition. We track your progress with lawn health scores so you can see the numbers improve.' },
      { q: 'Should I mow before or after your visit?', a: 'Either works, but if you can wait 24-48 hours after we treat, that gives products time to absorb. Don\'t stress about it though — our products are designed to work with normal mowing schedules.' },
    ],
  },
  {
    category: 'Mosquitoes', icon: '🦟',
    questions: [
      { q: 'How long does the mosquito barrier last?', a: 'Our barrier treatment lasts 21-30 days depending on weather. Heavy rain can reduce effectiveness, which is why monthly treatments during peak season (April-October) are key.' },
      { q: 'Will the treatment kill butterflies and bees?', a: 'We apply to resting areas where mosquitoes hide — undersides of leaves, fence lines, shrub beds. We avoid blooming flowers. The products we use are targeted and break down quickly in sunlight.' },
      { q: 'What can I do between treatments to reduce mosquitoes?', a: 'Empty any standing water weekly — saucers, bird baths, gutters, that random bucket. Mosquitoes can breed in a bottle cap of water. Also keep your grass mowed — tall grass harbors mosquitoes.' },
    ],
  },
  {
    category: 'Termites', icon: '🐜',
    questions: [
      { q: 'How do I know if I have termites?', a: 'Look for: mud tubes on your foundation, hollow-sounding wood, discarded wings near windows, or tiny pellets (drywood frass). If you see any of these, call us immediately — early detection saves thousands.' },
      { q: 'What are those flying bugs near my windows in spring?', a: 'Probably termite swarmers. They come out February through May in SWFL, usually after rain. They\'re attracted to light. Wings fall off quickly. If you see them, we need to inspect your property.' },
      { q: 'How often should bait stations be checked?', a: 'We check monitoring stations quarterly. Active bait stations get checked monthly until the colony is eliminated. The Sentricon system we use is the #1 termite baiting system in the country.' },
      { q: 'Do I need a WDO inspection to sell my house?', a: 'In Florida, the buyer\'s lender almost always requires a WDO (Wood Destroying Organism) inspection. We can do this — it\'s a separate service from ongoing monitoring. Reports are good for one year.' },
    ],
  },
  {
    category: 'Billing & Service', icon: '💳',
    questions: [
      { q: 'How does WaveGuard bundling save me money?', a: 'The more services you bundle, the bigger the discount: Bronze (1 service) = no discount, Silver (2 services) = 10% off, Gold (3) = 15% off, Platinum (4+) = 20% off everything. The discount applies to ALL your recurring services, not just the new one.' },
      { q: 'Can I pause my service?', a: 'Yes — life happens. Text us and we can pause for up to 60 days. Just know that pest and lawn issues don\'t pause, so you may need a restart treatment when you come back.' },
      { q: 'What\'s your cancellation policy?', a: 'No contracts, no cancellation fees. We earn your business every month. If you want to cancel, just text us. We\'ll ask why (feedback helps us improve), but we won\'t make it difficult.' },
    ],
  },
];

// =========================================================================
// GET /api/feed/weather — Local weather + pest pressure
// =========================================================================
router.get('/weather', async (req, res, next) => {
  try {
    const now = Date.now();
    if (cache.weather && (now - cache.weather.ts) < CACHE_TTL) {
      return res.json(cache.weather.data);
    }

    const pointRes = await fetch('https://api.weather.gov/points/27.4217,-82.4065', {
      headers: { 'User-Agent': 'WavesCustomerPortal/1.0 (waves@wavespestcontrol.com)' },
    });

    if (!pointRes.ok) return res.json(buildFallbackWeather());

    const pointData = await pointRes.json();
    const forecastUrl = pointData.properties?.forecast;
    if (!forecastUrl) return res.json(buildFallbackWeather());

    const forecastRes = await fetch(forecastUrl, {
      headers: { 'User-Agent': 'WavesCustomerPortal/1.0 (waves@wavespestcontrol.com)' },
    });
    if (!forecastRes.ok) return res.json(buildFallbackWeather());

    const forecastData = await forecastRes.json();
    const periods = forecastData.properties?.periods || [];
    const today = periods[0] || {};
    const tonight = periods[1] || {};

    const temp = today.temperature || 85;
    const humidity = today.relativeHumidity?.value || 70;
    const wind = today.windSpeed || '5 mph';
    const shortForecast = today.shortForecast || 'Partly Cloudy';
    const nightTemp = tonight.temperature || 72;

    const result = {
      location: 'Lakewood Ranch, FL',
      temp, nightTemp, humidity, wind,
      forecast: shortForecast,
      detailedForecast: today.detailedForecast || '',
      isDaytime: today.isDaytime !== false,
      pestPressure: {
        mosquito: calcMosquitoPressure(temp, humidity, shortForecast),
        fungus: calcFungusPressure(temp, humidity, nightTemp),
        chinch: calcChinchPressure(temp, humidity),
      },
      irrigationRecommendation: calcIrrigation(temp, shortForecast, humidity),
      updatedAt: new Date().toISOString(),
    };

    cache.weather = { data: result, ts: now };
    res.json(result);
  } catch (err) { next(err); }
});

function calcMosquitoPressure(temp, humidity, forecast) {
  let score = 0;
  if (temp >= 80) score += 3; else if (temp >= 70) score += 2; else score += 1;
  if (humidity >= 75) score += 3; else if (humidity >= 60) score += 2; else score += 1;
  if (/rain|storm|shower/i.test(forecast)) score += 2;
  if (score >= 7) return { level: 'HIGH', color: '#E53935', advice: 'Peak mosquito activity — avoid standing water, barrier treatment is critical' };
  if (score >= 5) return { level: 'MODERATE', color: '#FF9800', advice: 'Moderate mosquito activity — empty saucers and bird baths after rain' };
  return { level: 'LOW', color: '#4CAF50', advice: 'Low mosquito pressure — great conditions to enjoy the lanai' };
}

function calcFungusPressure(temp, humidity, nightTemp) {
  let score = 0;
  if (temp >= 65 && temp <= 80) score += 2;
  if (nightTemp >= 60 && nightTemp <= 75) score += 2;
  if (humidity >= 75) score += 3; else if (humidity >= 60) score += 1;
  if (score >= 5) return { level: 'HIGH', color: '#E53935', advice: 'High fungus risk — avoid evening irrigation, watch for brown patches' };
  if (score >= 3) return { level: 'MODERATE', color: '#FF9800', advice: 'Moderate fungus risk — water only in early morning' };
  return { level: 'LOW', color: '#4CAF50', advice: 'Low fungus pressure — conditions are favorable for healthy turf' };
}

function calcChinchPressure(temp, humidity) {
  let score = 0;
  if (temp >= 90) score += 3; else if (temp >= 80) score += 2;
  if (humidity < 60) score += 2;
  if (score >= 4) return { level: 'HIGH', color: '#E53935', advice: 'Peak chinch bug season — watch sunny spots for yellowing edges' };
  if (score >= 2) return { level: 'MODERATE', color: '#FF9800', advice: 'Monitor sunny lawn edges for early chinch bug signs' };
  return { level: 'LOW', color: '#4CAF50', advice: 'Low chinch bug risk this period' };
}

function calcIrrigation(temp, forecast, humidity) {
  if (/rain|storm|shower/i.test(forecast)) return { inches: '0.00', note: 'Rain expected — skip irrigation today' };
  if (temp >= 90 && humidity < 60) return { inches: '0.75', note: 'Hot and dry — water deeply in early morning' };
  if (temp >= 85) return { inches: '0.50', note: 'Warm day — standard watering, early morning only' };
  if (temp >= 75) return { inches: '0.35', note: 'Mild conditions — light watering if needed' };
  return { inches: '0.25', note: 'Cool day — reduce irrigation to prevent overwatering' };
}

function buildFallbackWeather() {
  const month = new Date().getMonth();
  const isSummer = month >= 5 && month <= 9;
  return {
    location: 'Lakewood Ranch, FL', temp: isSummer ? 89 : 78, nightTemp: isSummer ? 75 : 62,
    humidity: isSummer ? 80 : 60, wind: '8 mph',
    forecast: isSummer ? 'Scattered Thunderstorms' : 'Partly Sunny',
    detailedForecast: '', isDaytime: true,
    pestPressure: {
      mosquito: isSummer ? { level: 'HIGH', color: '#E53935', advice: 'Peak mosquito season' } : { level: 'MODERATE', color: '#FF9800', advice: 'Moderate activity' },
      fungus: { level: 'MODERATE', color: '#FF9800', advice: 'Monitor for large patch' },
      chinch: isSummer ? { level: 'HIGH', color: '#E53935', advice: 'Watch sunny spots' } : { level: 'LOW', color: '#4CAF50', advice: 'Low risk' },
    },
    irrigationRecommendation: isSummer ? { inches: '0.50', note: 'Standard summer watering' } : { inches: '0.35', note: 'Mild conditions' },
    updatedAt: new Date().toISOString(),
  };
}

module.exports = router;
