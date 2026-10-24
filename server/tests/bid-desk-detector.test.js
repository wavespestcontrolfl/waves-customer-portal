// Bid Desk detector and parser (GATE_BID_DESK): pure, no database, no AI. Every name, address and email below is
// invented; the bodies copy the SHAPE of the BuildingConnected and Procore templates, not any real message.
const {
  detectBidEmail, parseBidEmail, parseDateET, htmlToText, passesGmailSpam,
} = require('../services/bid-desk/detector');

// provider_verified is what the intake sets after checking aligned SPF/DKIM; fixtures are verified unless a test
// says otherwise (see "a forged provider email").
const email = (over = {}) => ({
  id: 'e-1', gmail_thread_id: 't-1', from_address: 'someone@example.test', from_name: 'Someone', subject: 'Hello',
  body_text: '', body_html: null, received_at: new Date('2026-08-20T14:00:00Z'), provider_verified: true, ...over,
});

const BC_BODY = [
  'Hi there,',
  'Fixture Build Co has invited you to bid on Sample Ridge Residences: Pest Control Package',
  'Location: 100 Fixture Way, Sampleville, FL 34000',
  'Job Walk: September 1, 2026',
  'Bid Due: October 5, 2026',
  'Lead: Pat Sample | pat.sample@fixture-gc.example',
  'View the invitation in BuildingConnected.',
].join('\n');

const bcInvite = (over = {}) => email({
  from_address: 'invites@buildingconnected.com', from_name: 'Fixture Build Co via BuildingConnected',
  subject: 'Fixture Build Co has invited you to bid on Sample Ridge Residences', body_text: BC_BODY, ...over,
});

const PROCORE_BODY = [
  'You have been invited to bid.',
  'Project Name Sample Tower Phase 2',
  'Bid Form Name Pest Control Bid Form',
  'Bid Due: Friday, September 25, 2026 at 12:00 pm',
].join('\n');

const procoreInvite = (over = {}) => email({
  from_address: 'noreply@procoretech.com', from_name: 'Sample Developers via Procore',
  subject: 'Invitation to Bid: Sample Tower Phase 2', body_text: PROCORE_BODY, ...over,
});

describe('detectBidEmail', () => {
  test('BuildingConnected and Procore mail is a bid only with a bid line in the body or bid words in the subject', () => {
    expect(detectBidEmail(bcInvite())).toMatchObject({ bid: true, source: 'buildingconnected', kind: 'invite' });
    expect(detectBidEmail(procoreInvite())).toMatchObject({ bid: true, source: 'procore', kind: 'invite' });
    // A subdomain sender with a bid line in the body still counts.
    expect(detectBidEmail(bcInvite({ from_address: 'x@mail.buildingconnected.com', subject: 'Welcome' })).bid).toBe(true);
    // Account and marketing mail from the same providers is not a bid.
    expect(detectBidEmail(email({ from_address: 'team@buildingconnected.com', subject: 'Manage all your bids in one place', body_text: 'Start now. More subs choose Bid Board every day.' })))
      .toMatchObject({ bid: false, reason: 'provider_not_bid' });
    expect(detectBidEmail(email({ from_address: 'noreply@procoretech.com', subject: 'Your Procore password was changed', body_text: 'If this was not you, contact support.' })).bid).toBe(false);
  });

  test('a government or bid-portal sender needs bid words in the subject', () => {
    expect(detectBidEmail(email({ from_address: 'purchasing@samplecity.gov', subject: 'RFQ 24-15 Pest Control' })))
      .toMatchObject({ bid: true, source: 'gov_email' });
    expect(detectBidEmail(email({ from_address: 'clerk@samplecounty.fl.us', subject: 'Invitation to Bid - Mowing' })).source).toBe('gov_email');
    expect(detectBidEmail(email({ from_address: 'noreply@bonfirehub.com', subject: 'Request for Proposal: Pest services' })).source).toBe('gov_email');
    expect(detectBidEmail(email({ from_address: 'purchasing@samplecity.gov', subject: 'Parking permit renewal' })).bid).toBe(false);
    expect(detectBidEmail(email({ from_address: 'noreply@opengov.com', subject: 'Your weekly digest' })).bid).toBe(false);
  });

  test('bid words in the subject make a bid from any sender', () => {
    for (const subject of ['RFP: Pest control for Sample HOA', 'ITB 2026-07 grounds', 'Pre-bid meeting Thursday', 'prebid walk', 'Bid invite - Sample Mall',
      'Request for qualifications', 'Addendum 1 to the solicitation', 'Invitation to bid']) {
      expect(detectBidEmail(email({ from_address: 'manager@sample-hoa.example', subject })))
        .toMatchObject({ bid: true, source: 'email_subject' });
    }
    expect(detectBidEmail(email({ from_address: 'manager@sample-hoa.example', subject: 'Question about your service' })).bid).toBe(false);
    expect(detectBidEmail(email({ subject: 'Your rfpsomething is ready' })).bid).toBe(false);
  });

  test('our own mail, internal ops mail and GitHub notifications are never bids', () => {
    expect(detectBidEmail(email({ from_address: 'contact@wavespestcontrol.com', subject: 'Re: RFP follow up' })))
      .toEqual({ bid: false, reason: 'own_mail' });
    expect(detectBidEmail(email({ from_address: 'Contact@WavesPestControl.com', subject: 'RFP' })).bid).toBe(false);
    for (const prefix of ['FIX:', 'ACT:', 'FYI:', 'OK:']) {
      expect(detectBidEmail(bcInvite({ subject: `${prefix} RFP for Sample Ridge` })).bid).toBe(false);
    }
    expect(detectBidEmail(email({ from_address: 'notifications@github.com', subject: 'Re: [repo] Addendum to RFP parser' })))
      .toEqual({ bid: false, reason: 'github' });
  });

  test('kind comes from the subject: addendum, reminder, else invite', () => {
    expect(detectBidEmail(bcInvite({ subject: 'Addendum 2: Sample Ridge Residences' })).kind).toBe('addendum');
    expect(detectBidEmail(bcInvite({ subject: 'Bid due date extended: Sample Ridge Residences' })).kind).toBe('addendum');
    expect(detectBidEmail(bcInvite({ subject: 'Reminder: Sample Ridge Residences bid due soon' })).kind).toBe('reminder');
    expect(detectBidEmail(procoreInvite()).kind).toBe('invite');
  });
});

describe('parseBidEmail: BuildingConnected template', () => {
  const parsed = parseBidEmail(bcInvite());

  test('reads the invite, location, lead and both dates', () => {
    expect(parsed).toMatchObject({
      template: 'buildingconnected',
      gc_or_agency: 'Fixture Build Co',
      project_title: 'Sample Ridge Residences',
      package_name: 'Pest Control Package',
      location: '100 Fixture Way, Sampleville, FL 34000',
      buyer_name: 'Pat Sample',
      buyer_email: 'pat.sample@fixture-gc.example',
      due_source_line: 'Bid Due: October 5, 2026',
    });
  });

  test('dates are America/New_York; a date with no time is stored at 23:59 ET', () => {
    expect(parsed.due_at.toISOString()).toBe('2026-10-06T03:59:00.000Z'); // 23:59 EDT
    expect(parsed.job_walk_at.toISOString()).toBe('2026-09-02T03:59:00.000Z');
  });

  test('a project name that holds a colon splits at the last colon only', () => {
    const colon = parseBidEmail(bcInvite({ body_text: 'Fixture Build Co has invited you to bid on Tower 4: Phase 2: Pest Control' }));
    expect(colon.project_title).toBe('Tower 4: Phase 2');
    expect(colon.package_name).toBe('Pest Control');
    expect(parseBidEmail(bcInvite({ body_text: 'Fixture Build Co has invited you to bid on Sample Ridge Residences' })).package_name).toBeNull();
  });

  test('reads an HTML-only body', () => {
    const html = `<html><body><p>Fixture Build Co has invited you to bid on <b>Sample Ridge Residences</b>: Pest</p>
      <table><tr><td>Bid Due:</td><td>October&nbsp;5, 2026</td></tr><tr><td>Location: 5 Fixture Ln</td></tr></table></body></html>`;
    const fromHtml = parseBidEmail(bcInvite({ body_text: null, body_html: html }));
    expect(fromHtml.project_title).toBe('Sample Ridge Residences');
    expect(fromHtml.due_at.toISOString()).toBe('2026-10-06T03:59:00.000Z');
    expect(fromHtml.location).toBe('5 Fixture Ln');
  });

  test('fields the template does not carry stay null', () => {
    const bare = parseBidEmail(bcInvite({ body_text: 'Please see the portal for details.' }));
    expect(bare).toMatchObject({
      gc_or_agency: null, project_title: null, location: null, due_at: null, due_source_line: null, job_walk_at: null,
      buyer_name: null, buyer_email: null, solicitation_number: null, questions_due_at: null,
    });
  });
});

describe('parseBidEmail: Procore template', () => {
  test('reads the due date with its weekday and time, the project and the bid form', () => {
    const parsed = parseBidEmail(procoreInvite());
    expect(parsed).toMatchObject({
      template: 'procore', project_title: 'Sample Tower Phase 2', package_name: 'Pest Control Bid Form',
      due_source_line: 'Bid Due: Friday, September 25, 2026 at 12:00 pm',
    });
    expect(parsed.due_at.toISOString()).toBe('2026-09-25T16:00:00.000Z'); // 12:00 EDT
    expect(parsed.gc_or_agency).toBeNull();
  });

  test('reads labels set in table cells, and a label alone on a line', () => {
    const html = '<table><tr><td>Project Name</td><td>Sample Tower Phase 2</td></tr><tr><td>Bid Form Name</td><td>Pest Form</td></tr>'
      + '<tr><td>Bid Due</td><td>Monday, December 14, 2026 at 3:30 pm</td></tr></table>';
    const parsed = parseBidEmail(procoreInvite({ body_text: '', body_html: html }));
    expect(parsed.project_title).toBe('Sample Tower Phase 2');
    expect(parsed.due_at.toISOString()).toBe('2026-12-14T20:30:00.000Z'); // 15:30 EST
    const alone = parseBidEmail(procoreInvite({ body_text: 'Project Name\nSample Tower Phase 2\nBid Form Name\nPest Form' }));
    expect(alone.project_title).toBe('Sample Tower Phase 2');
    expect(alone.package_name).toBe('Pest Form');
  });
});

describe('parseBidEmail: anything else leaves fields null', () => {
  test('a city RFQ with a date in its text is detected but never parsed', () => {
    const rfq = email({
      from_address: 'purchasing@samplecity.gov', subject: 'RFQ 24-15 Pest Control Services',
      body_text: 'Project Name Sample City Hall\nBid Due: October 5, 2026\nLocation: 1 City Plaza',
    });
    const parsed = parseBidEmail(rfq);
    expect(parsed).toMatchObject({
      source: 'gov_email', template: null, project_title: null, due_at: null, due_source_line: null, location: null, gc_or_agency: null,
    });
  });

  test('impossible and partial dates read as no date', () => {
    expect(parseDateET('February 30, 2026')).toBeNull();
    expect(parseDateET('October 2026')).toBeNull();
    expect(parseDateET('Bid Due: soon')).toBeNull();
    expect(parseDateET('Friday, September 25, 2026 at 13:00 pm')).toBeNull();
    expect(parseDateET('10/5/2026').at.toISOString()).toBe('2026-10-06T03:59:00.000Z');
    expect(parseDateET('Oct 5th, 2026 by 2 PM').at.toISOString()).toBe('2026-10-05T18:00:00.000Z');
  });

  test('a time on the fall-back day resolves with the offset in force', () => {
    expect(parseDateET('November 1, 2026 at 12:00 pm').at.toISOString()).toBe('2026-11-01T17:00:00.000Z'); // EST after the change
  });

  test('htmlToText drops style blocks and decodes entities', () => {
    expect(htmlToText('<style>p{}</style><p>A &amp; B&#33;</p><br>C')).toMatch(/A & B!\s*\n\s*C/);
  });
});

describe('grouping keys', () => {
  test('a template invite and its addendum share a key; a reply prefix or addendum subject does not split it', () => {
    expect(parseBidEmail(bcInvite()).group_key).toBe(parseBidEmail(bcInvite({ subject: 'Addendum 1 Re: something', id: 'e-2' })).group_key);
  });

  test('outside a provider template there is no cross-thread key (a subject or display name is never an identity)', () => {
    for (const over of [
      { from_address: 'a@sample-hoa.example', from_name: 'Sample HOA', subject: 'RFP: Grounds Pest Control' },
      { from_address: 'purchasing@samplecity.gov', subject: 'Invitation to Bid' },
      { from_address: 'x@elsewhere.example', from_name: 'Fixture Build Co', subject: 'Addendum: Sample Ridge Residences' },
    ]) {
      expect(parseBidEmail(email({ ...over, body_text: 'x' }))).toMatchObject({ group_key: null, group_base: null });
    }
  });

  test('different projects from one GC do not share a key', () => {
    const other = bcInvite({ body_text: BC_BODY.replace('Sample Ridge Residences', 'Other Fixture Plaza') });
    expect(parseBidEmail(other).group_key).not.toBe(parseBidEmail(bcInvite()).group_key);
  });
});

// The live templates break lines differently from the one-line shape above: the project sits on the line after
// "has invited you to bid on", the lead's email on the line after "Lead:", and a GC message names the bid package
// on the line after "sent your company a message about". Names below are invented.
describe('parseBidEmail: template line breaks as delivered', () => {
  const BC_SPLIT_INVITE = [
    'Download',
    'Pat Sample from Fixture Build Co, Inc. has invited you to bid on',
    'Sampleville Public Works Shed (PEMB): General Requirements',
    'View this RFP',
    'Bidding Not Bidding Not Sure',
    'Project Details',
    'Location: 100 Fixture Way, Sampleville, FL 34000, United States of America',
    'Job Walk: September 1, 2026',
    'Bid Due: September 28, 2026',
    'Client Details',
    'Lead: Pat Sample',
    'Senior Estimator • pat.sample@fixture-gc.example',
    'Fixture Build Co, Inc.',
  ].join('\n');
  const BC_SPLIT_MESSAGE = [
    'Pat Sample of Fixture Build Co, Inc. sent your company a message about',
    'Sampleville Public Works Shed (PEMB): General Requirements',
    'Addendums #1, #2 and #3',
    'Addendum 2 was a date change.',
    'Project Details',
    'Location: 100 Fixture Way, Sampleville, FL 34000, United States of America',
    'Bid Due: October 5, 2026',
    'Sender Details',
    'Pat Sample',
    'Senior Estimator • pat.sample@fixture-gc.example',
  ].join('\n');
  const invite = email({ from_address: 'team@buildingconnected.com', subject: 'Bid Invite: Sampleville Public Works Sh...', body_text: BC_SPLIT_INVITE });
  const message = email({ gmail_thread_id: 't-2', from_address: 'team@buildingconnected.com', subject: 'Addendums #1, #2 and #3 - Sampleville Public Works...', body_text: BC_SPLIT_MESSAGE });

  test('reads the person, the GC and the project from the next line', () => {
    expect(parseBidEmail(invite)).toMatchObject({
      buyer_name: 'Pat Sample',
      buyer_email: 'pat.sample@fixture-gc.example',
      gc_or_agency: 'Fixture Build Co, Inc.',
      project_title: 'Sampleville Public Works Shed (PEMB)',
      package_name: 'General Requirements',
      due_source_line: 'Bid Due: September 28, 2026',
    });
  });

  test('a GC message about the same package is an addendum with the same grouping key', () => {
    expect(detectBidEmail(message)).toMatchObject({ bid: true, source: 'buildingconnected', kind: 'addendum' });
    const parsedMessage = parseBidEmail(message);
    expect(parsedMessage).toMatchObject({ gc_or_agency: 'Fixture Build Co, Inc.', buyer_email: 'pat.sample@fixture-gc.example' });
    expect(parsedMessage.group_key).toBe(parseBidEmail(invite).group_key);
  });

  test('a Procore invite names the person and the GC, and the buyer email under Client Details', () => {
    const body = [
      'Bid Due: Friday, September 25, 2026 at 12:00 pm',
      'Invitation to Bid',
      'Sam Example from Sample Developers has invited you to bid on project Sample Tower (Termite Treatment).',
      'Project Name',
      'Sample Tower',
      'Bid Form Name',
      'Termite Treatment',
      'Client Details',
      'Sam Example - sam.example@sample-dev.example',
    ].join('\n');
    expect(parseBidEmail(email({ from_address: 'Sample_notifications@procoretech.com', subject: 'Sample Tower: Invitation to bid on GMP (Termite Treatment)', body_text: body })))
      .toMatchObject({ buyer_name: 'Sam Example', gc_or_agency: 'Sample Developers', buyer_email: 'sam.example@sample-dev.example', project_title: 'Sample Tower', package_name: 'Termite Treatment' });
  });

  test('"Addendums" in a subject is an addendum and a bid word', () => {
    expect(detectBidEmail(email({ from_address: 'gc@sample-gc.example', subject: 'Addendums 1 and 2 - Sample Clinic' })))
      .toMatchObject({ bid: true, source: 'email_subject', kind: 'addendum' });
  });
});

describe('parseDateET: AM/PM in any case', () => {
  test('a numeric date with an uppercase PM keeps its time', () => {
    expect(parseDateET('10/5/2026 at 2:00 PM').at.toISOString()).toBe('2026-10-05T18:00:00.000Z');
    expect(parseDateET('10/5/2026 at 2:00 pm').at.toISOString()).toBe('2026-10-05T18:00:00.000Z');
    expect(parseDateET('October 5, 2026 at 9:30 AM').at.toISOString()).toBe('2026-10-05T13:30:00.000Z');
  });
});

describe('grouping keys stay bounded and distinct', () => {
  test('two long template project names that share a long head get different, bounded keys', () => {
    const head = 'Sample Regional Facilities Improvement Program '.repeat(6);
    const one = parseBidEmail(bcInvite({ body_text: BC_BODY.replace('Sample Ridge Residences', `${head} Phase One`) }));
    const two = parseBidEmail(bcInvite({ body_text: BC_BODY.replace('Sample Ridge Residences', `${head} Phase Two`) }));
    expect(one.group_key).not.toBe(two.group_key);
    expect(one.group_key.length).toBeLessThan(400);
  });
});

describe('a forged provider email', () => {
  test('without verified sender authentication a BuildingConnected email is read like a plain email', () => {
    const forged = bcInvite({ provider_verified: false });
    expect(parseBidEmail(forged)).toMatchObject({ template: null, gc_or_agency: null, project_title: null, due_at: null, group_key: null });
    // With no bid word in its subject it is not filed at all; with one ("Addendum 1") it files as a plain email.
    expect(detectBidEmail(forged).bid).toBe(false);
    expect(detectBidEmail(bcInvite({ provider_verified: false, subject: 'Addendum 1' }))).toMatchObject({ bid: true, source: 'email_subject' });
  });
});


// The SHAPE of a VendorLink "Solicitation Broadcast" (the date sits on the line after its label); invented agency.
const VL_BODY = (city = 'Sampleville, FL 34200') => [
  'SOLICITATION NOTIFICATION',
  'Sample County School Board',
  'Purchasing Department',
  '100 Fixture Way',
  city,
  'Sample County School Board requests interested parties to submit formal sealed bids/proposals for the below referenced solicitation.',
  'BID NUMBER: ITB 27-001',
  'BID TITLE: Pest Control Services',
  'BID OPENING DUE DATE/TIME:',
  '11/4/2026 at 2:00 PM, Local Time, Sampleville, FL',
  'PRE-BID/PROPOSAL CONFERENCE:',
  'None',
  'PURCHASING AGENT: Pat Sample (pat.sample@sample-schools.example ) 9415550100',
].join('\n');
const vlNotice = (over = {}) => email({
  from_address: 'vendorlink@myvendorlink.com', from_name: 'VendorLink', subject: 'Solicitation Broadcast', body_text: VL_BODY(), ...over,
});

describe('VendorLink solicitation broadcasts', () => {
  test('a notice from an agency in the service area is a bid, read from the fixed template', () => {
    expect(detectBidEmail(vlNotice())).toMatchObject({ bid: true, source: 'gov_email', kind: 'invite' });
    expect(parseBidEmail(vlNotice())).toMatchObject({
      template: 'vendorlink',
      gc_or_agency: 'Sample County School Board',
      project_title: 'Pest Control Services',
      solicitation_number: 'ITB 27-001',
      location: 'Sampleville, FL 34200',
      buyer_email: 'pat.sample@sample-schools.example',
      due_source_line: '11/4/2026 at 2:00 PM, Local Time, Sampleville, FL',
    });
    expect(parseBidEmail(vlNotice()).due_at.toISOString()).toBe('2026-11-04T19:00:00.000Z');
    // The state spelled out counts too.
    expect(detectBidEmail(vlNotice({ body_text: VL_BODY('SAMPLEVILLE, FLORIDA 33601') })).bid).toBe(true);
  });

  test('an agency outside the service area, a catch-up list, or a forged sender is not a bid', () => {
    expect(detectBidEmail(vlNotice({ body_text: VL_BODY('Sampleton, TN 37402') }))).toMatchObject({ bid: false, reason: 'outside_area' });
    expect(detectBidEmail(vlNotice({ body_text: VL_BODY('Sampleton, FL 32401') }))).toMatchObject({ bid: false, reason: 'outside_area' });
    expect(detectBidEmail(vlNotice({ subject: 'Solicitation Broadcast - Vendor Commodity Code Changed' })))
      .toMatchObject({ bid: false, reason: 'catch_up_list' });
    expect(detectBidEmail(vlNotice({ subject: 'VendorLink Registration', body_text: 'Welcome to VendorLink.' })))
      .toMatchObject({ bid: false, reason: 'provider_not_bid' });
    // Without aligned SPF/DKIM the template is not trusted: no subject bid words, so it is not a bid.
    expect(detectBidEmail(vlNotice({ provider_verified: false }))).toMatchObject({ bid: false });
    expect(parseBidEmail(vlNotice({ provider_verified: false }))).toMatchObject({ template: null, due_at: null });
  });

  test('a repeat notice of the same bid number groups with it; a new number of the same title is its own bid', () => {
    const first = parseBidEmail(vlNotice());
    expect(parseBidEmail(vlNotice({ gmail_thread_id: 't-2' })).group_key).toBe(first.group_key);
    const rebid = parseBidEmail(vlNotice({ body_text: VL_BODY().replace('ITB 27-001', 'ITB 28-001') }));
    expect(rebid.group_key).not.toBe(first.group_key);
    expect(rebid.group_base).not.toBe(first.group_base);
  });

  test('HA eProcurement and MyFloridaMarketPlace mail with bid words counts as government mail', () => {
    for (const from of ['notices@ha.internationaleprocurement.com', 'MFMP.NoReply@dms.myflorida.com']) {
      expect(detectBidEmail(email({ from_address: from, subject: 'New RFP: Pest Control' }))).toMatchObject({ bid: true, source: 'gov_email' });
    }
  });
});

// The SHAPE of a Blue Book Network ONETEAM invite (htmlToText of the delivered HTML); invented contractor and place.
const BB_LINES = (due = 'Bid is due by 5:00 PM (Pacific) on September 14, 2026') => [
  '96', 'Invitation to Bid', due,
  'You\u2019ve been invited to bid on a - Government Building Project in Sampleport, FL.',
  'We are looking for', 'Pest Control--Exterminating.',
  'View Full Project Details & Files', 'Bid Due Date', '09/14/26 5:00 PM (Pacific)',
  'You are receiving this email because you are registered in The Blue Book Network. www.thebluebook.com',
  "Fixture & Honor LLC is sharing this project opportunity with you through The Blue Book Network's ONETEAM. For help & training on how to view and respond to this ITB call 888-555-0100 .",
];
const bbInvite = (over = {}) => email({
  from_address: 'FixtureHonor.oneteam.build@bbbid.thebluebook.com', from_name: 'Fixture & Honor LLC',
  subject: 'Invitation to Bid', body_text: BB_LINES().join('\n'), ...over,
});

describe('Blue Book ONETEAM invites', () => {
  test('reads the contractor, project, place, trade and due time (moved from the named zone to ET)', () => {
    expect(parseBidEmail(bbInvite())).toMatchObject({
      template: 'bluebook', source: 'bluebook', kind: 'invite',
      gc_or_agency: 'Fixture & Honor LLC', project_title: 'Government Building Project in Sampleport, FL',
      location: 'Sampleport, FL', package_name: 'Pest Control--Exterminating', solicitation_number: null,
      due_source_line: 'Bid is due by 5:00 PM (Pacific) on September 14, 2026',
    });
    // 5:00 PM Pacific = 8:00 PM Eastern (EDT) = 00:00 UTC the next day.
    expect(parseBidEmail(bbInvite()).due_at.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    const eastern = bbInvite({ body_text: BB_LINES('Bid is due by 4:00 PM (Eastern) on May 12, 2026').join('\n') });
    expect(parseBidEmail(eastern).due_at.toISOString()).toBe('2026-05-12T20:00:00.000Z');
    // A zone the template does not name gives no date (never a guess).
    const other = bbInvite({ body_text: BB_LINES('Bid is due by 4:00 PM (Hawaii) on May 12, 2026').join('\n') });
    expect(parseBidEmail(other).due_at).toBeNull();
  });

  test('the invite, its reminder and its addendum group as one bid; another project of the same contractor does not', () => {
    const invite = parseBidEmail(bbInvite());
    const reminder = parseBidEmail(bbInvite({ subject: 'Reminder to Bid' }));
    const addendum = parseBidEmail(bbInvite({ subject: 'Notice of Addenda #:  - #1234567 Termite Fumigation' }));
    expect(reminder).toMatchObject({ kind: 'reminder', group_key: invite.group_key });
    expect(addendum).toMatchObject({ kind: 'addendum', group_key: invite.group_key });
    const otherSite = BB_LINES().map((line) => line.replace('Sampleport', 'Fixtureville'));
    expect(parseBidEmail(bbInvite({ body_text: otherSite.join('\n') })).group_key).not.toBe(invite.group_key);
  });

  test('reads the HTML when there is no text part, with a straight apostrophe', () => {
    const html = BB_LINES().map((line) => `<div>${line.replace('\u2019', "'").replace('&', '&amp;')}</div>`).join('');
    expect(parseBidEmail(bbInvite({ body_text: '', body_html: html }))).toMatchObject({
      source: 'bluebook', gc_or_agency: 'Fixture & Honor LLC', package_name: 'Pest Control--Exterminating',
    });
  });

  test("the network's own Project Notification and account mail are not bids", () => {
    const notice = bbInvite({
      from_address: 'bbbid400@bbbid.thebluebook.com', subject: 'Project Notification from Sample County',
      body_text: ['Project Notification', 'Sample Creek Dredging', 'Bids Due: 10/28/2026 at (Eastern)', 'GC Bidder: Sample County'].join('\n'),
    });
    expect(detectBidEmail(notice)).toEqual({ bid: false, reason: 'provider_not_bid' });
    expect(detectBidEmail(bbInvite({ subject: 'Your Blue Book profile', body_text: 'Update your company profile.' })).bid).toBe(false);
  });

  test('a forged Blue Book email is read like any plain email and may pass Gmail Spam only when verified', () => {
    const forged = bbInvite({ provider_verified: false });
    expect(parseBidEmail(forged)).toMatchObject({ template: null, source: 'email_subject', gc_or_agency: null, due_at: null, group_key: null });
    expect(passesGmailSpam(forged)).toBe(false);
    expect(passesGmailSpam(bbInvite())).toBe(true);
    expect(passesGmailSpam(bcInvite())).toBe(false);
  });
});
