/**
 * FAWN Weather Service
 *
 * Fetches current + trailing weather data from the Florida Automated
 * Weather Network for SWFL stations (Myakka River, Manatee County).
 * Used by lawn assessments, treatment outcomes, content engine, and
 * seasonal expectation displays.
 */

const logger = require('./logger');

const FAWN_URL = 'https://fawn.ifas.ufl.edu/controller.php/lastObservation/summary/';
const STATION_NAMES = ['manatee', 'myakka', 'sarasota', 'arcadia'];

// Cache for 15 minutes to avoid hammering FAWN
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

const FawnWeather = {

  /**
   * Get current FAWN observation for nearest SWFL station.
   * Returns: { temp_f, humidity_pct, rainfall_in, soil_temp_f, station, timestamp }
   */
  async getCurrent() {
    if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

    try {
      const res = await fetch(FAWN_URL);
      if (!res.ok) throw new Error(`FAWN HTTP ${res.status}`);

      const data = await res.json();
      const station = (data || []).find(s =>
        STATION_NAMES.some(n => (s.StationName || '').toLowerCase().includes(n))
      ) || data?.[0];

      if (!station) throw new Error('No FAWN station found');

      _cache = {
        temp_f: parseFloat(station.AirTemp_Avg || station.t2m_avg) || null,
        humidity_pct: parseFloat(station.RelHum_Avg || station.rh_avg) || null,
        rainfall_in: parseFloat(station.Rain_Tot || station.rain_sum) || null,
        soil_temp_f: parseFloat(station.SoilTemp4_Avg || station.ts4_avg) || null,
        wind_mph: parseFloat(station.Wind_Avg || station.ws_avg) || null,
        station: station.StationName || 'FAWN SWFL',
        timestamp: new Date().toISOString(),
      };
      _cacheTime = Date.now();

      return _cache;
    } catch (err) {
      logger.error(`[fawn-weather] Fetch failed: ${err.message}`);
      return _cache || {
        temp_f: null, humidity_pct: null, rainfall_in: null,
        soil_temp_f: null, station: 'unavailable', timestamp: new Date().toISOString(),
        error: err.message,
      };
    }
  },

  /**
   * Get weather snapshot formatted for lawn_assessments columns.
   */
  async getAssessmentWeather() {
    const w = await FawnWeather.getCurrent();
    return {
      fawn_temp_f: w.temp_f,
      fawn_humidity_pct: w.humidity_pct,
      fawn_rainfall_7d: w.rainfall_in, // FAWN returns daily total; will be enhanced with 7-day accumulation later
      fawn_soil_temp_f: w.soil_temp_f,
      fawn_station: w.station,
    };
  },

  /**
   * Get seasonal context for customer-facing display.
   * Returns human-readable explanation of current conditions.
   */
  getSeasonalContext(month, weather) {
    const m = month || (new Date().getMonth() + 1);
    const temp = weather?.temp_f || weather?.fawn_temp_f;
    const soil = weather?.soil_temp_f || weather?.fawn_soil_temp_f;
    const rain = weather?.rainfall_in || weather?.fawn_rainfall_7d;

    let seasonName, explanation, expectation;

    if (m >= 5 && m <= 9) {
      seasonName = 'Summer peak season';
      explanation = 'This is prime growing season for St. Augustine grass in Southwest Florida.';
      expectation = 'Expect the highest scores of the year. Rapid growth means more mowing but also faster recovery from treatments.';
      if (temp && temp > 95) explanation += ` Current temps of ${Math.round(temp)}°F may cause some heat stress — this is normal.`;
    } else if (m >= 3 && m <= 4) {
      seasonName = 'Spring green-up';
      explanation = 'Your lawn is transitioning out of dormancy. Green-up typically takes 4-6 weeks.';
      expectation = 'Scores will improve rapidly over the next few visits as the turf fills in. Some patchiness is normal during this transition.';
      if (soil && soil < 65) explanation += ` Soil temp is ${Math.round(soil)}°F — full green-up starts above 65°F.`;
    } else if (m >= 10 && m <= 11) {
      seasonName = 'Fall transition';
      explanation = 'Growth is slowing as temperatures cool. This is the ideal window for fall pre-emergent applications.';
      expectation = 'Slight score decreases are normal. Focus shifts from growth to root strength and weed prevention.';
    } else {
      seasonName = 'Winter dormancy';
      explanation = 'St. Augustine grass naturally slows or goes semi-dormant in SWFL winters.';
      expectation = 'Lower scores are completely normal and expected. Your lawn will bounce back in spring.';
      if (temp && temp < 50) explanation += ` At ${Math.round(temp)}°F, some browning is expected — this is not damage.`;
    }

    if (rain != null && rain < 0.1 && m >= 3 && m <= 10) {
      explanation += ' Rainfall has been low — if you have irrigation, ensure it\'s running 2-3 times per week.';
    }

    return {
      seasonName,
      explanation,
      expectation,
      month: m,
      weather: { temp_f: temp, soil_temp_f: soil, rainfall_in: rain },
    };
  },

  /**
   * Get pest/disease pressure signals for the current month.
   */
  getPressureSignals(month) {
    const m = month || (new Date().getMonth() + 1);
    const signals = [];

    if (m >= 4 && m <= 9) signals.push({ type: 'chinch_bug', level: 'high', note: 'Peak chinch bug pressure — monitor sunny areas' });
    if (m >= 5 && m <= 10) signals.push({ type: 'sod_webworm', level: 'moderate', note: 'Sod webworm active — look for notched grass blades' });
    if (m >= 6 && m <= 9) signals.push({ type: 'gray_leaf_spot', level: 'high', note: 'Gray leaf spot risk elevated with humidity >80%' });
    if (m >= 5 && m <= 8) signals.push({ type: 'large_patch', level: 'moderate', note: 'Large patch (Rhizoctonia) may appear in shaded areas' });
    if (m >= 3 && m <= 5) signals.push({ type: 'dollar_weed', level: 'high', note: 'Dollar weed spreading — pre/post emergent window' });
    if (m >= 10 && m <= 2) signals.push({ type: 'annual_bluegrass', level: 'high', note: 'Poa annua germination — pre-emergent critical' });
    if (m >= 5 && m <= 8) signals.push({ type: 'nitrogen_blackout', level: 'regulatory', note: 'Sarasota/Manatee county nitrogen blackout in effect' });

    return signals;
  },
};

module.exports = FawnWeather;
