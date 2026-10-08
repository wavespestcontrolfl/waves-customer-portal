const db = require('../models/db');
const RULES = require('../config/reschedule-rules');
const logger = require('./logger');
const { getHourlyRainOutlook } = require('./weather-forecast');

const { etDateString, etParts, addETDays } = require('../utils/datetime-et');

const HQ = { lat: 27.4217, lng: -82.4065 };

// Tomorrow's Eastern calendar date. The server clock is UTC; service dates
// and windows are Eastern (Codex #6119 r2).
const etTomorrow = () => etDateString(addETDays(new Date(), 1));

class ForecastAnalyzer {
  async analyzeTomorrow() {
    const tomorrowStr = etTomorrow();

    const services = await db('scheduled_services')
      .where('scheduled_date', tomorrowStr)
      .whereIn('status', ['pending', 'confirmed'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.city', 'customers.zip', 'customers.waveguard_tier');

    if (!services.length) return { date: tomorrowStr, services: [], needsReschedule: [], canProceed: [], caution: [] };

    // Hourly forecast at HQ from the shared reader: NWS, Open-Meteo when
    // NWS fails (weather-forecast.js). Fail open: no forecast, no flags.
    let forecast = null;
    try {
      const hours = await getHourlyRainOutlook(HQ.lat, HQ.lng);
      forecast = (hours || []).map((h) => ({
        datetime: new Date(h.startTime),
        // The hour's Eastern date and clock hour: every comparison below
        // uses these, never the Date's server-local (UTC) parts.
        et_date: etDateString(new Date(h.startTime)),
        et_hour: etParts(new Date(h.startTime)).hour,
        temp_f: h.temperatureF,
        wind_speed_mph: h.windMph || 0,
        rain_probability_pct: h.rainChance || 0,
        rain_mm: 0, // the hourly forecast carries no amount
        short_forecast: h.shortForecast,
      }));
    } catch (e) { logger.error(`Forecast fetch failed: ${e.message}`); }

    const results = services.map(service => this.analyzeServiceWeather(service, forecast || []));

    return {
      date: tomorrowStr,
      overallConditions: { summary: this.buildSummary(forecast || [], tomorrowStr) },
      services: results,
      needsReschedule: results.filter(r => r.recommendation === 'RESCHEDULE'),
      canProceed: results.filter(r => r.recommendation === 'GO'),
      caution: results.filter(r => r.recommendation === 'CAUTION'),
    };
  }

  analyzeServiceWeather(service, forecast) {
    const serviceType = this.classifyServiceType(service.service_type);
    const sensitivity = RULES.serviceSensitivity[serviceType] || { weather_sensitive: false };

    if (!sensitivity.weather_sensitive) {
      return {
        serviceId: service.id, customerId: service.customer_id,
        customerName: `${service.first_name} ${service.last_name}`,
        customerPhone: service.phone, serviceType: service.service_type,
        tier: service.waveguard_tier,
        recommendation: 'GO', issues: [], canSplit: false, splitNote: '',
      };
    }

    const windowStart = parseInt((service.window_start || '08:00').split(':')[0]);
    const windowEnd = parseInt((service.window_end || '17:00').split(':')[0]);

    const tomorrowStr = etTomorrow();
    const serviceHours = forecast.filter(h => (
      h.et_date === tomorrowStr && h.et_hour >= windowStart && h.et_hour <= windowEnd
    ));

    const issues = [];
    let recommendation = 'GO';

    // Rain check
    if (sensitivity.needs_rain_free && serviceHours.length > 0) {
      const maxRainProb = Math.max(...serviceHours.map(h => h.rain_probability_pct));
      if (maxRainProb > RULES.weather.rain.reschedule_if_rain_prob_above) {
        issues.push({ type: 'rain', severity: 'reschedule', detail: `${maxRainProb}% rain probability during service window. Needs ${sensitivity.rain_free_hours}h rain-free.` });
        recommendation = 'RESCHEDULE';
      } else if (maxRainProb > RULES.weather.rain.caution_if_rain_prob_above) {
        issues.push({ type: 'rain', severity: 'caution', detail: `${maxRainProb}% rain chance. Monitor conditions.` });
        if (recommendation !== 'RESCHEDULE') recommendation = 'CAUTION';
      }
    }

    // Wind check
    if (sensitivity.wind_sensitive && serviceHours.length > 0) {
      const maxWind = Math.max(...serviceHours.map(h => h.wind_speed_mph));
      const threshold = sensitivity.max_wind_mph || RULES.weather.wind.hold_spray_mph;
      if (maxWind > threshold) {
        issues.push({ type: 'wind', severity: 'reschedule', detail: `Wind ${maxWind} mph exceeds ${threshold} mph drift threshold.` });
        recommendation = 'RESCHEDULE';
      } else if (maxWind > RULES.weather.wind.caution_spray_mph) {
        issues.push({ type: 'wind', severity: 'caution', detail: `Wind ${maxWind} mph — use caution, larger droplet nozzles.` });
        if (recommendation !== 'RESCHEDULE') recommendation = 'CAUTION';
      }
    }

    let canSplit = false, splitNote = '';
    if (recommendation === 'RESCHEDULE' && sensitivity.can_split) {
      canSplit = true;
      splitNote = serviceType === 'pest_exterior'
        ? 'Interior pest treatment can proceed. Reschedule exterior only.'
        : 'Granular fertilizer can proceed (rain helps). Reschedule liquid spray.';
    }

    return {
      serviceId: service.id, customerId: service.customer_id,
      customerName: `${service.first_name} ${service.last_name}`,
      customerPhone: service.phone, serviceType: service.service_type,
      tier: service.waveguard_tier,
      window: `${service.window_start || '08:00'} - ${service.window_end || '17:00'}`,
      recommendation, issues, canSplit, splitNote,
    };
  }

  classifyServiceType(str) {
    const s = (str || '').toLowerCase();
    if (s.includes('mosquito')) return 'mosquito';
    if (s.includes('termite') && (s.includes('bait') || s.includes('monitor'))) return 'termite_bait';
    if (s.includes('rodent') || s.includes('rat')) return 'rodent';
    if (s.includes('tree') && s.includes('inject')) return 'tree_injection';
    if (s.includes('tree') || s.includes('shrub')) return 'tree_shrub_spray';
    if ((s.includes('lawn') || s.includes('turf')) && s.includes('granular')) return 'lawn_granular';
    if (s.includes('lawn') || s.includes('turf')) return 'lawn_spray';
    if (s.includes('pest') && s.includes('interior')) return 'pest_interior';
    return 'pest_exterior';
  }

  // `etDate` = the Eastern calendar date ('YYYY-MM-DD') to summarize.
  buildSummary(forecast, etDate) {
    const hours = forecast.filter(h => h.et_date === etDate);
    if (!hours.length) return 'Forecast unavailable.';
    // Rounded: the Open-Meteo backup carries unrounded readings.
    const hi = Math.round(Math.max(...hours.map(h => h.temp_f)));
    const lo = Math.round(Math.min(...hours.map(h => h.temp_f)));
    const maxWind = Math.max(...hours.map(h => h.wind_speed_mph));
    const maxRain = Math.max(...hours.map(h => h.rain_probability_pct));
    return `${lo}-${hi}°F, wind up to ${maxWind} mph, ${maxRain}% max rain chance. ${maxRain > 80 ? 'Rain likely.' : maxRain > 50 ? 'Rain possible.' : 'Mostly dry.'}`;
  }
}

module.exports = new ForecastAnalyzer();
