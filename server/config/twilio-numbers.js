const TWILIO_NUMBERS = {
  // ── Location Lines ──────────────────────────────────────────
  locations: {
    'lakewood-ranch': { number: '+19413187612', formatted: '(941) 318-7612', label: 'Lakewood Ranch — HQ (Pest)', isMainLine: true },
    'parrish': { number: '+19412972817', formatted: '(941) 297-2817', label: 'Parrish (Pest)' },
    'sarasota': { number: '+19412972606', formatted: '(941) 297-2606', label: 'Sarasota (Pest)' },
    'venice': { number: '+19412973337', formatted: '(941) 297-3337', label: 'Venice (Pest)' },
  },

  // ── Pest Control Domain Tracking ────────────────────────────
  domainTracking: [
    { number: '+19412975749', formatted: '(941) 297-5749', domain: 'wavespestcontrol.com', area: 'General', location: 'lakewood-ranch', page: 'main site' },
    { number: '+19413187612', formatted: '(941) 318-7612', domain: 'wavespestcontrol.com', area: 'Bradenton', location: 'lakewood-ranch', page: '/pest-control-bradenton-fl/' },
    { number: '+19412972606', formatted: '(941) 297-2606', domain: 'wavespestcontrol.com', area: 'Sarasota', location: 'sarasota', page: '/pest-control-sarasota-fl/' },
    { number: '+19412838194', formatted: '(941) 283-8194', domain: 'bradentonflexterminator.com', area: 'Bradenton', location: 'lakewood-ranch' },
    { number: '+19413265011', formatted: '(941) 326-5011', domain: 'bradentonflpestcontrol.com', area: 'Bradenton', location: 'lakewood-ranch' },
    { number: '+19412972671', formatted: '(941) 297-2671', domain: 'sarasotaflpestcontrol.com', area: 'Sarasota', location: 'sarasota' },
    { number: '+19412135203', formatted: '(941) 213-5203', domain: 'palmettoexterminator.com', area: 'Palmetto', location: 'parrish' },
    { number: '+19412943355', formatted: '(941) 294-3355', domain: 'palmettoflpestcontrol.com', area: 'Palmetto', location: 'parrish' },
    { number: '+19419098995', formatted: '(941) 909-8995', domain: 'parrishexterminator.com', area: 'Parrish', location: 'parrish' },
    { number: '+19412972817', formatted: '(941) 297-2817', domain: 'parrishpestcontrol.com', area: 'Parrish', location: 'parrish' },
    { number: '+19413187765', formatted: '(941) 318-7765', domain: 'sarasotaflexterminator.com', area: 'Sarasota', location: 'sarasota' },
    { number: '+19412998937', formatted: '(941) 299-8937', domain: 'veniceexterminator.com', area: 'Venice', location: 'venice' },
    { number: '+19412973337', formatted: '(941) 297-3337', domain: 'veniceflpestcontrol.com', area: 'Venice', location: 'venice' },
    { number: '+19412589109', formatted: '(941) 258-9109', domain: 'portcharlotteflpestcontrol.com', area: 'Port Charlotte', location: 'venice' },
    { number: '+19412402066', formatted: '(941) 240-2066', domain: 'wavespestcontrol.com', area: 'North Port', location: 'venice', page: '/pest-control-north-port-fl/' },
  ],

  // ── Lawn Care Domain Tracking ───────────────────────────────
  lawnDomainTracking: [
    { number: '+19413041850', formatted: '(941) 304-1850', domain: 'bradentonfllawncare.com', area: 'Bradenton', location: 'lakewood-ranch' },
    { number: '+19412691692', formatted: '(941) 269-1692', domain: 'sarasotafllawncare.com', area: 'Sarasota', location: 'sarasota' },
    { number: '+19412077456', formatted: '(941) 207-7456', domain: 'parrishfllawncare.com', area: 'Parrish', location: 'parrish' },
    { number: '+19414131227', formatted: '(941) 413-1227', domain: 'venicelawncare.com', area: 'Venice', location: 'venice' },
    { number: '+19412413824', formatted: '(941) 241-3824', domain: 'waveslawncare.com', area: 'General', location: 'lakewood-ranch' },
  ],

  // ── Other ───────────────────────────────────────────────────
  tracking: {
    vanWrap: { number: '+19412412459', formatted: '(941) 241-2459', label: 'Van Tracking Number' },
  },

  tollFree: { number: '+18559260203', formatted: '(855) 926-0203', label: 'Customer Chat' },

  // ── Unassigned ──────────────────────────────────────────────
  unassigned: [
    { number: '+19412535279', formatted: '(941) 253-5279' },
    { number: '+19412411388', formatted: '(941) 241-1388' },
  ],

  // ── Helpers ─────────────────────────────────────────────────

  get portalNumbers() {
    const nums = Object.values(this.locations).map(l => l.number);
    this.domainTracking.forEach(d => nums.push(d.number));
    this.lawnDomainTracking.forEach(d => nums.push(d.number));
    nums.push(this.tracking.vanWrap.number);
    nums.push(this.tollFree.number);
    return [...new Set(nums)];
  },

  get allNumbers() {
    return [
      ...Object.entries(this.locations).map(([id, l]) => ({ ...l, type: 'location', locationId: id })),
      ...this.domainTracking.map(d => ({ ...d, type: 'pest_domain' })),
      ...this.lawnDomainTracking.map(d => ({ ...d, type: 'lawn_domain' })),
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
    // Van wrap
    if (this.tracking.vanWrap.number === phoneNumber) return { ...this.tracking.vanWrap, type: 'van_tracking' };
    // Toll-free / customer chat
    if (this.tollFree.number === phoneNumber) return { ...this.tollFree, type: 'location', locationId: 'lakewood-ranch' };
    // Unassigned — still handle
    const unassigned = this.unassigned.find(u => u.number === phoneNumber);
    if (unassigned) return { ...unassigned, type: 'location', locationId: 'lakewood-ranch' };
    return null;
  },

  getOutboundNumber(customerLocationId) {
    return this.locations[customerLocationId]?.number || this.locations['lakewood-ranch'].number;
  },

  getLeadSourceFromNumber(phoneNumber) {
    const domain = this.domainTracking.find(d => d.number === phoneNumber);
    if (domain) return { source: 'domain_website', domain: domain.domain, area: domain.area };
    const lawn = this.lawnDomainTracking.find(d => d.number === phoneNumber);
    if (lawn) return { source: 'domain_website', domain: lawn.domain, area: lawn.area };
    if (this.tracking.vanWrap.number === phoneNumber) return { source: 'van_wrap', domain: null, area: null };
    for (const [, loc] of Object.entries(this.locations)) {
      if (loc.number === phoneNumber) return { source: 'location_direct', domain: null, area: loc.label };
    }
    return { source: 'unknown', domain: null, area: null };
  },
};

module.exports = TWILIO_NUMBERS;
