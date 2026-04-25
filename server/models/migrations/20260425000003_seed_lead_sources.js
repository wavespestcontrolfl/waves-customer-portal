// Seed `lead_sources` with the 25 production Twilio numbers + their
// attribution metadata so the new dashboard call/lead-source panels can
// JOIN call_log.to_phone → lead_sources.twilio_phone_number and surface
// human-readable source labels (e.g. "GBP — Sarasota").
//
// Idempotent: each row is upserted by twilio_phone_number — re-running
// the migration will not create duplicates and will refresh metadata
// (name/notes/SID) on existing rows.

const ROWS = [
  // ── Main hub + main-site city pages ─────────────────────────────
  {
    name: 'Main Site (wavespestcontrol.com)',
    source_type: 'main_site',
    channel: 'organic',
    twilio_phone_number: '+19412975749',
    twilio_phone_sid: 'PN16f236878a99f27e36b0e153f8be98aa',
    domain: 'wavespestcontrol.com',
    landing_page_url: 'https://wavespestcontrol.com',
    cost_type: 'free',
  },
  {
    name: 'Main Site — North Port page',
    source_type: 'main_site',
    channel: 'organic',
    twilio_phone_number: '+19412402066',
    twilio_phone_sid: 'PNe9256f42cd61247c32852d38297a9b31',
    domain: 'wavespestcontrol.com',
    landing_page_url: 'https://wavespestcontrol.com/pest-control-north-port-fl/',
    cost_type: 'free',
  },

  // ── Google Business Profile listings ────────────────────────────
  // gbp_location_id values pulled from server/config/locations.js so
  // dashboard panels can deep-link back to the right GBP.
  {
    name: 'GBP — Lakewood Ranch',
    source_type: 'gbp',
    channel: 'organic',
    twilio_phone_number: '+19413187612',
    twilio_phone_sid: 'PN0040f38868dd9d9cdba92ccae2ab239a',
    gbp_location_id: '11325506936615341094',
    cost_type: 'free',
  },
  {
    name: 'GBP — Sarasota',
    source_type: 'gbp',
    channel: 'organic',
    twilio_phone_number: '+19412972606',
    twilio_phone_sid: 'PNfe2e60e5ca41ea65a7574b9df1168ac0',
    gbp_location_id: '2262372053807555721',
    cost_type: 'free',
  },
  {
    name: 'GBP — Venice',
    source_type: 'gbp',
    channel: 'organic',
    twilio_phone_number: '+19412973337',
    twilio_phone_sid: 'PN7708056fb5a11b11bb2f30eb3c644208',
    gbp_location_id: '9775694678945206688',
    cost_type: 'free',
  },
  {
    name: 'GBP — Parrish',
    source_type: 'gbp',
    channel: 'organic',
    twilio_phone_number: '+19412972817',
    twilio_phone_sid: 'PN6ca156221e130182872a4ae674844fbf',
    gbp_location_id: '3749219908465956526',
    cost_type: 'free',
  },

  // ── Pest control spoke sites (11) ───────────────────────────────
  spoke('+19412838194', 'PNb5a59c14d67565601f50efd4a6160538', 'bradentonflexterminator.com', 'pest'),
  spoke('+19413265011', 'PN3777e53038275810206c961c64a21dd5', 'bradentonflpestcontrol.com',  'pest'),
  spoke('+19412972671', 'PN56d1d797f36ef0a5a0b13770ab25c530', 'sarasotaflpestcontrol.com',  'pest'),
  spoke('+19412135203', 'PN2ad79848c06bb30c8460d11fbaf30940', 'palmettoexterminator.com',   'pest'),
  spoke('+19412943355', 'PN3e1da7e099c45e0aa869ca6cde5eb91d', 'palmettoflpestcontrol.com',  'pest'),
  spoke('+19419098995', 'PNeb93b0f35c1489b1e702054a5ca87cf0', 'parrishexterminator.com',    'pest'),
  spoke('+19412535279', 'PN156798905dd717123bb818f41bc0ff71', 'parrishpestcontrol.com',     'pest'),
  spoke('+19413187765', 'PN1d0b7a07ff18ca6f31d75bc86935d4d5', 'sarasotaflexterminator.com', 'pest'),
  spoke('+19412998937', 'PN401d1fa403daf50919f1766d856951f8', 'veniceexterminator.com',     'pest'),
  spoke('+19412411388', 'PN08e0d814516e374320813cb270aa6671', 'veniceflpestcontrol.com',    'pest'),
  spoke('+19412589109', 'PNaada7fb89b37c9371d35624e97562c6c', 'northportflpestcontrol.com', 'pest'),

  // ── Lawn care spoke sites (5) ───────────────────────────────────
  spoke('+19413041850', 'PN071256d8fabda329be677e38cd27d252', 'bradentonfllawncare.com', 'lawn'),
  spoke('+19412691692', 'PNbd6191520ff2f3784f1938b1c1778275', 'sarasotafllawncare.com',  'lawn'),
  spoke('+19412077456', 'PN71cee0a62ed116f934d0d20f86db4519', 'parrishfllawncare.com',   'lawn'),
  spoke('+19414131227', 'PN0b5a738c188bcb9665eb2f06088c0a5b', 'venicelawncare.com',      'lawn'),
  spoke('+19412413824', 'PNfeb06049b36b7bf3c53b98ff1387761f', 'waveslawncare.com',       'lawn'),

  // ── Paid ─────────────────────────────────────────────────────────
  // Newly purchased; webhook still needs to be wired on the Twilio side
  // before inbound calls will land in call_log. The seed row is in place
  // so attribution lights up the moment routing is configured.
  {
    name: 'Google Ads — Pest (call-extension)',
    source_type: 'google_ads',
    channel: 'paid',
    twilio_phone_number: '+19412691697',
    twilio_phone_sid: 'PN2b33299302e2e48e99a54fa57acc1353',
    cost_type: 'paid',
    notes: 'Webhook not yet configured on Twilio — calls will not appear in call_log until /voice handler is wired.',
  },

  // ── Offline / brand ──────────────────────────────────────────────
  {
    name: 'Vehicle Decal',
    source_type: 'vehicle',
    channel: 'direct',
    twilio_phone_number: '+19412412459',
    twilio_phone_sid: 'PNb5026fba35c0dfdf311e083ae3f726bb',
    cost_type: 'free',
    notes: 'Magnetic decal on Waves van — direct-response from being seen on the road.',
  },

  // ── Dormant ──────────────────────────────────────────────────────
  // Number is provisioned but not published anywhere in the repo, on the
  // 16 spoke homepages, or in the chat widget fallback. Kept in registry
  // so it isn't accidentally re-bought, but is_active=false so it doesn't
  // skew attribution dashboards.
  {
    name: 'AI Agent (unused — not published)',
    source_type: 'ai_agent',
    channel: 'direct',
    twilio_phone_number: '+18559260203',
    twilio_phone_sid: 'PNdf0e4ebbe249f7e2fdb16b2ac8d2eade',
    cost_type: 'free',
    is_active: false,
    notes: 'Dormant. Not published on any spoke, not in ChatWidget fallback, not in any route handler. Audit confirmed 0 references in repo source as of 2026-04-25.',
  },
];

// Spoke-site row factory. Service-line lives in the name string per the
// "no service_line column" decision — the dashboard parses on the
// "Spoke Pest"/"Spoke Lawn" prefix.
function spoke(twilioPhone, sid, domain, line) {
  const lineLabel = line === 'lawn' ? 'Spoke Lawn' : 'Spoke Pest';
  return {
    name: `${lineLabel} — ${domain}`,
    source_type: 'spoke_site',
    channel: 'organic',
    twilio_phone_number: twilioPhone,
    twilio_phone_sid: sid,
    domain,
    landing_page_url: `https://${domain}`,
    cost_type: 'free',
  };
}

exports.up = async function up(knex) {
  // Up-front guard: schema must already exist (created in
  // 20260401000095_lead_attribution.js). If it doesn't, refuse loudly
  // rather than silently no-op.
  if (!(await knex.schema.hasTable('lead_sources'))) {
    throw new Error('lead_sources table missing — run 20260401000095_lead_attribution first.');
  }

  for (const row of ROWS) {
    const existing = await knex('lead_sources')
      .where({ twilio_phone_number: row.twilio_phone_number })
      .first();

    if (existing) {
      // Refresh metadata in place. Preserve cost columns the operator
      // may have edited via the admin UI (monthly_cost, cost_per_lead,
      // setup_cost) — this seed only owns identity + label fields.
      await knex('lead_sources')
        .where({ id: existing.id })
        .update({
          name: row.name,
          source_type: row.source_type,
          channel: row.channel,
          twilio_phone_sid: row.twilio_phone_sid,
          domain: row.domain ?? existing.domain,
          landing_page_url: row.landing_page_url ?? existing.landing_page_url,
          gbp_location_id: row.gbp_location_id ?? existing.gbp_location_id,
          notes: row.notes ?? existing.notes,
          is_active: row.is_active ?? existing.is_active,
          updated_at: knex.fn.now(),
        });
    } else {
      await knex('lead_sources').insert(row);
    }
  }
};

// Intentionally non-destructive: if an operator built dashboards / cost
// records on top of these rows, dropping them via a `down` would orphan
// that data. Roll back by deleting specific rows manually if needed.
exports.down = async function down() {};
