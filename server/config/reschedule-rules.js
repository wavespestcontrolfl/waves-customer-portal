const RESCHEDULE_RULES = {
  weather: {
    wind: {
      hold_spray_mph: 15,
      caution_spray_mph: 10,
      hold_granular_mph: 25,
    },
    rain: {
      herbicide_rain_free_hours: 4,
      insecticide_rain_free_hours: 2,
      fungicide_rain_free_hours: 2,
      pre_emergent_rain_free_hours: 0,
      fertilizer_granular_rain_free_hours: 0,
      fertilizer_liquid_rain_free_hours: 4,
      reschedule_if_rain_prob_above: 80,
      caution_if_rain_prob_above: 60,
      reschedule_if_rain_mm_above: 10,
      ignore_if_rain_mm_below: 2,
      hold_if_currently_raining: true,
      resume_after_rain_stops_minutes: 30,
    },
    lightning: {
      hold_if_lightning_within_miles: 10,
      resume_after_last_strike_minutes: 30,
    },
    temperature: {
      prefer_morning_if_above_f: 92,
      reduced_efficacy_below_f: 50,
    },
  },

  serviceSensitivity: {
    'lawn_spray': { weather_sensitive: true, needs_rain_free: true, rain_free_hours: 4, wind_sensitive: true, max_wind_mph: 15, can_split: true },
    'lawn_granular': { weather_sensitive: false, needs_rain_free: false, wind_sensitive: false, can_do_in_rain: true },
    'pest_exterior': { weather_sensitive: true, needs_rain_free: true, rain_free_hours: 2, wind_sensitive: true, max_wind_mph: 15, can_split: true },
    'pest_interior': { weather_sensitive: false, needs_rain_free: false, wind_sensitive: false },
    'mosquito': { weather_sensitive: true, needs_rain_free: true, rain_free_hours: 2, wind_sensitive: true, max_wind_mph: 12 },
    'termite_bait': { weather_sensitive: false, needs_rain_free: false },
    'rodent': { weather_sensitive: false, needs_rain_free: false },
    'tree_shrub_spray': { weather_sensitive: true, needs_rain_free: true, rain_free_hours: 3, wind_sensitive: true, max_wind_mph: 12 },
    'tree_injection': { weather_sensitive: false, needs_rain_free: false },
  },

  tierPriority: { 'Platinum': 1, 'Gold': 2, 'Silver': 3, 'Bronze': 4, 'None': 5 },
  urgencyDays: { critical: 14, high: 7, normal: 0 },

  escalation: {
    customer_response_timeout_hours: 8,
    followup_after_no_response_hours: 24,
    escalate_to_phone_after_attempts: 2,
    escalate_to_adam_after_reschedules: 3,
    max_auto_reschedules_per_service: 3,
  },
};

module.exports = RESCHEDULE_RULES;
