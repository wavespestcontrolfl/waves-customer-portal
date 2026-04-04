const TWILIO_NUMBERS = {
  locations: {
    'lakewood-ranch': { number: '+19413187612', formatted: '(941) 318-7612', label: 'Lakewood Ranch — HQ', isMainLine: true },
    'parrish': { number: '+19412972817', formatted: '(941) 297-2817', label: 'Parrish' },
    'sarasota': { number: '+19412972606', formatted: '(941) 297-2606', label: 'Sarasota' },
    'venice': { number: '+19412973337', formatted: '(941) 297-3337', label: 'Venice' },
  },

  domainTracking: [
    { number: '+19412838194', formatted: '(941) 283-8194', domain: 'bradentonflexterminator.com', area: 'Bradenton', location: 'lakewood-ranch' },
    { number: '+19413265011', formatted: '(941) 326-5011', domain: 'bradentonflpestcontrol.com', area: 'Bradenton', location: 'lakewood-ranch' },
    { number: '+19412135203', formatted: '(941) 213-5203', domain: 'palmettoexterminator.com', area: 'Palmetto', location: 'parrish' },
    { number: '+19412943355', formatted: '(941) 294-3355', domain: 'palmettoflpestcontrol.com', area: 'Palmetto', location: 'parrish' },
    { number: '+19419098995', formatted: '(941) 909-8995', domain: 'parrishexterminator.com', area: 'Parrish', location: 'parrish' },
    { number: '+19413187765', formatted: '(941) 318-7765', domain: 'sarasotaflexterminator.com', area: 'Sarasota', location: 'sarasota' },
    { number: '+19412972671', formatted: '(941) 297-2671', domain: 'sarasotaflpestcontrol.com', area: 'Sarasota', location: 'sarasota' },
    { number: '+19412998937', formatted: '(941) 299-8937', domain: 'veniceexterminator.com', area: 'Venice', location: 'venice' },
    { number: '+19412975749', formatted: '(941) 297-5749', domain: 'wavespestcontrol.com', area: 'General', location: 'lakewood-ranch' },
  ],

  tracking: {
    vanWrap: { number: '+19412412459', formatted: '(941) 241-2459', label: 'Van Wrap Tracking' },
  },

  reserve: [
    { number: '+19412402066', label: 'Reserve — North Port' },
    { number: '+19413041850', label: 'Reserve — Palmetto' },
    { number: '+19412589109', label: 'Reserve — Port Charlotte' },
    { number: '+19412691692', label: 'Reserve — Bradenton' },
    { number: '+19412077456', label: 'Reserve — Venice' },
    { number: '+19414131227', label: 'Reserve — Sarasota' },
    { number: '+19412413824', label: 'Reserve — Bradenton' },
    { number: '+19412411388', label: 'Reserve' },
    { number: '+19412535279', label: 'Reserve' },
  ],

  tollFree: { number: '+18559260203', formatted: '(855) 926-0203', label: 'Toll-Free / Talkyto', managedByPortal: false },

  get portalNumbers() {
    const nums = Object.values(this.locations).map(l => l.number);
    this.domainTracking.forEach(d => nums.push(d.number));
    nums.push(this.tracking.vanWrap.number);
    return nums;
  },

  findByNumber(phoneNumber) {
    for (const [locId, loc] of Object.entries(this.locations)) {
      if (loc.number === phoneNumber) return { ...loc, type: 'location', locationId: locId };
    }
    const domain = this.domainTracking.find(d => d.number === phoneNumber);
    if (domain) return { ...domain, type: 'domain_tracking', locationId: domain.location };
    if (this.tracking.vanWrap.number === phoneNumber) return { ...this.tracking.vanWrap, type: 'van_tracking' };
    if (this.tollFree.number === phoneNumber) return { ...this.tollFree, type: 'tollFree' };
    const reserve = this.reserve.find(r => r.number === phoneNumber);
    if (reserve) return { ...reserve, type: 'location', locationId: 'lakewood-ranch' };
    return null;
  },

  getOutboundNumber(customerLocationId) {
    return this.locations[customerLocationId]?.number || this.locations['lakewood-ranch'].number;
  },

  getLeadSourceFromNumber(phoneNumber) {
    const domain = this.domainTracking.find(d => d.number === phoneNumber);
    if (domain) return { source: 'domain_website', domain: domain.domain, area: domain.area };
    if (this.tracking.vanWrap.number === phoneNumber) return { source: 'van_wrap', domain: null, area: null };
    for (const [locId, loc] of Object.entries(this.locations)) {
      if (loc.number === phoneNumber) return { source: 'location_direct', domain: null, area: loc.label };
    }
    return { source: 'unknown', domain: null, area: null };
  },
};

module.exports = TWILIO_NUMBERS;
