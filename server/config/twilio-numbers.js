const TWILIO_NUMBERS = {
  // ── Location Lines ──────────────────────────────────────────
  locations: {
    // The 'bradenton' GBP line is branded "Waves Pest Control Lakewood
    // Ranch" on Google but is the Bradenton office (13649 Luxe Ave).
    'bradenton': { number: '+19413187612', formatted: '(941) 318-7612', label: 'Lakewood Ranch GBP — Bradenton office (Pest)' },
    'parrish': { number: '+19412972817', formatted: '(941) 297-2817', label: 'Parrish (Pest)' },
    'sarasota': { number: '+19412972606', formatted: '(941) 297-2606', label: 'Sarasota (Pest)' },
    'venice': { number: '+19412973337', formatted: '(941) 297-3337', label: 'Venice (Pest)' },
  },

  // Main Waves company line (general). Default outbound / caller-ID
  // fallback when a customer has no resolved location. Tied to the
  // Lakewood Ranch (9040 Town Center) mailing address but is the general
  // company number, not a GBP office line.
  mainLine: { number: '+19412975749', formatted: '(941) 297-5749', label: 'Waves Main Line' },

  // ── Pest Control Domain Tracking ────────────────────────────
  domainTracking: [
    { number: '+19412975749', formatted: '(941) 297-5749', domain: 'wavespestcontrol.com', area: 'General', location: 'bradenton', page: 'main site' },
    { number: '+19413187612', formatted: '(941) 318-7612', domain: 'wavespestcontrol.com', area: 'Bradenton', location: 'bradenton', page: '/pest-control-bradenton-fl/' },
    { number: '+19412972606', formatted: '(941) 297-2606', domain: 'wavespestcontrol.com', area: 'Sarasota', location: 'sarasota', page: '/pest-control-sarasota-fl/' },
    { number: '+19412838194', formatted: '(941) 283-8194', domain: 'bradentonflexterminator.com', area: 'Bradenton', location: 'bradenton' },
    { number: '+19413265011', formatted: '(941) 326-5011', domain: 'bradentonflpestcontrol.com', area: 'Bradenton', location: 'bradenton' },
    { number: '+19412972671', formatted: '(941) 297-2671', domain: 'sarasotaflpestcontrol.com', area: 'Sarasota', location: 'sarasota' },
    { number: '+19412135203', formatted: '(941) 213-5203', domain: 'palmettoexterminator.com', area: 'Palmetto', location: 'parrish' },
    { number: '+19412943355', formatted: '(941) 294-3355', domain: 'palmettoflpestcontrol.com', area: 'Palmetto', location: 'parrish' },
    { number: '+19419098995', formatted: '(941) 909-8995', domain: 'parrishexterminator.com', area: 'Parrish', location: 'parrish' },
    { number: '+19412535279', formatted: '(941) 253-5279', domain: 'parrishpestcontrol.com', area: 'Parrish', location: 'parrish' },
    { number: '+19413187765', formatted: '(941) 318-7765', domain: 'sarasotaflexterminator.com', area: 'Sarasota', location: 'sarasota' },
    { number: '+19412998937', formatted: '(941) 299-8937', domain: 'veniceexterminator.com', area: 'Venice', location: 'venice' },
    { number: '+19412411388', formatted: '(941) 241-1388', domain: 'veniceflpestcontrol.com', area: 'Venice', location: 'venice' },
    { number: '+19412589109', formatted: '(941) 258-9109', domain: 'northportflpestcontrol.com', area: 'North Port / Port Charlotte', location: 'venice' },
    { number: '+19412402066', formatted: '(941) 240-2066', domain: 'wavespestcontrol.com', area: 'North Port', location: 'venice', page: '/pest-control-north-port-fl/' },
  ],

  // ── Lawn Care Domain Tracking ───────────────────────────────
  lawnDomainTracking: [
    { number: '+19413041850', formatted: '(941) 304-1850', domain: 'bradentonfllawncare.com', area: 'Bradenton', location: 'bradenton' },
    { number: '+19412691692', formatted: '(941) 269-1692', domain: 'sarasotafllawncare.com', area: 'Sarasota', location: 'sarasota' },
    { number: '+19412077456', formatted: '(941) 207-7456', domain: 'parrishfllawncare.com', area: 'Parrish', location: 'parrish' },
    { number: '+19414131227', formatted: '(941) 413-1227', domain: 'venicelawncare.com', area: 'Venice', location: 'venice' },
    { number: '+19412413824', formatted: '(941) 241-3824', domain: 'waveslawncare.com', area: 'General', location: 'bradenton' },
  ],

  // ── Other ───────────────────────────────────────────────────
  tracking: {
    vanWrap: { number: '+19412412459', formatted: '(941) 241-2459', label: 'Van Tracking Number' },
  },

  tollFree: { number: '+18559260203', formatted: '(855) 926-0203', label: 'Customer Chat' },

  // ── Paid Campaign Tracking ───────────────────────────────────
  // `type` is per-entry (NOT a hardcoded literal) so each paid line maps to
  // its own ad platform — Google Ads vs Facebook Ads — for lead-source
  // attribution. Defaults to 'google_ads' when omitted (back-compat).
  paidTracking: {
    googleAdsPest: {
      number: '+19412691697',
      formatted: '(941) 269-1697',
      label: 'Google Ads — Pest',
      location: 'bradenton',
      type: 'google_ads',
    },
    facebookAdsPest: {
      number: '+19418775491',
      formatted: '(941) 877-5491',
      label: 'Facebook Ads — Pest',
      location: 'bradenton',
      type: 'facebook',
    },
  },

  // ── GBP Call Tracking ────────────────────────────────────────
  // One dedicated number per Google Business Profile, wired to the GBP
  // "Call" button (set as the profile's primary number). Lets us tell a
  // GBP-sourced call apart from an organic city-page (website) call, which
  // the shared location number cannot. The website + citations stay on the
  // real location number (the NAP anchor Google checks against citations) —
  // untouched. All route to /voice, so every GBP call lands in call_log
  // stamped location='GBP — <City>' / numberType='gbp_tracking'.
  gbpTracking: {
    bradenton: { number: '+19413521572', formatted: '(941) 352-1572', label: 'GBP — Bradenton', location: 'bradenton', area: 'Bradenton' },
    parrish: { number: '+19413840224', formatted: '(941) 384-0224', label: 'GBP — Parrish', location: 'parrish', area: 'Parrish' },
    sarasota: { number: '+19414910407', formatted: '(941) 491-0407', label: 'GBP — Sarasota', location: 'sarasota', area: 'Sarasota' },
    venice: { number: '+19414774880', formatted: '(941) 477-4880', label: 'GBP — Venice', location: 'venice', area: 'Venice' },
  },

  // ── Unassigned ──────────────────────────────────────────────
  unassigned: [],

  // ── Helpers ─────────────────────────────────────────────────

  get portalNumbers() {
    const nums = Object.values(this.locations).map(l => l.number);
    this.domainTracking.forEach(d => nums.push(d.number));
    this.lawnDomainTracking.forEach(d => nums.push(d.number));
    Object.values(this.gbpTracking).forEach(g => nums.push(g.number));
    nums.push(this.tracking.vanWrap.number);
    nums.push(this.tollFree.number);
    return [...new Set(nums)];
  },

  get allNumbers() {
    return [
      ...Object.entries(this.locations).map(([id, l]) => ({ ...l, type: 'location', locationId: id })),
      ...this.domainTracking.map(d => ({ ...d, type: 'pest_domain' })),
      ...this.lawnDomainTracking.map(d => ({ ...d, type: 'lawn_domain' })),
      ...Object.entries(this.paidTracking).map(([id, p]) => ({ ...p, type: p.type || 'google_ads', trackingId: id })),
      ...Object.entries(this.gbpTracking).map(([id, g]) => ({ ...g, type: 'gbp_tracking', locationId: g.location, gbpProfileId: id })),
      { ...this.tracking.vanWrap, type: 'van_tracking' },
      { ...this.tollFree, type: 'customer_chat' },
      ...this.unassigned.map(u => ({ ...u, type: 'unassigned', label: 'Unassigned' })),
    ];
  },

  findByNumber(phoneNumber) {
    // Location lines
    for (const [locId, loc] of Object.entries(this.locations)) {
      if (loc.number === phoneNumber) return { ...loc, type: 'location', locationId: locId };
    }
    // Pest domain tracking
    const domain = this.domainTracking.find(d => d.number === phoneNumber);
    if (domain) return { ...domain, type: 'domain_tracking', locationId: domain.location };
    // Lawn domain tracking
    const lawn = this.lawnDomainTracking.find(d => d.number === phoneNumber);
    if (lawn) return { ...lawn, type: 'domain_tracking', locationId: lawn.location };
    // Paid campaign tracking
    for (const [id, paid] of Object.entries(this.paidTracking)) {
      if (paid.number === phoneNumber) return { ...paid, type: paid.type || 'google_ads', trackingId: id, locationId: paid.location };
    }
    // GBP call tracking
    for (const [id, gbp] of Object.entries(this.gbpTracking)) {
      if (gbp.number === phoneNumber) return { ...gbp, type: 'gbp_tracking', locationId: gbp.location, gbpProfileId: id };
    }
    // Van wrap
    if (this.tracking.vanWrap.number === phoneNumber) return { ...this.tracking.vanWrap, type: 'van_tracking' };
    // Toll-free / customer chat
    if (this.tollFree.number === phoneNumber) return { ...this.tollFree, type: 'location', locationId: 'bradenton' };
    // Unassigned — still handle
    const unassigned = this.unassigned.find(u => u.number === phoneNumber);
    if (unassigned) return { ...unassigned, type: 'location', locationId: 'bradenton' };
    return null;
  },

  getOutboundNumber(customerLocationId) {
    return this.locations[customerLocationId]?.number || this.mainLine.number;
  },

  getLeadSourceFromNumber(phoneNumber) {
    const domain = this.domainTracking.find(d => d.number === phoneNumber);
    if (domain) return { source: 'domain_website', domain: domain.domain, area: domain.area };
    const lawn = this.lawnDomainTracking.find(d => d.number === phoneNumber);
    if (lawn) return { source: 'domain_website', domain: lawn.domain, area: lawn.area };
    for (const [, paid] of Object.entries(this.paidTracking)) {
      if (paid.number === phoneNumber) {
        return { source: paid.type === 'facebook' ? 'facebook' : 'google_ads', domain: null, area: paid.label };
      }
    }
    for (const [, gbp] of Object.entries(this.gbpTracking)) {
      if (gbp.number === phoneNumber) return { source: 'google_business_profile', domain: null, area: gbp.area };
    }
    if (this.tracking.vanWrap.number === phoneNumber) return { source: 'van_wrap', domain: null, area: null };
    for (const [, loc] of Object.entries(this.locations)) {
      if (loc.number === phoneNumber) return { source: 'location_direct', domain: null, area: loc.label };
    }
    return { source: 'unknown', domain: null, area: null };
  },
};

module.exports = TWILIO_NUMBERS;
