// Bid Desk detector and parser (GATE_BID_DESK): pure, no database, no AI. Every name, address and email below is
// invented; the bodies copy the SHAPE of the BuildingConnected and Procore templates, not any real message.
const { detectBidEmail, parseBidEmail, parseDateET, htmlToText } = require('../services/bid-desk/detector');

const email = (over = {}) => ({
  id: 'e-1', gmail_thread_id: 't-1', from_address: 'someone@example.test', from_name: 'Someone', subject: 'Hello',
  body_text: '', body_html: null, received_at: new Date('2026-08-20T14:00:00Z'), ...over,
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
  test('the same sender org and project share a key; a reply prefix or addendum marker does not split a subject', () => {
    expect(parseBidEmail(bcInvite()).group_key).toBe(parseBidEmail(bcInvite({ subject: 'Addendum 1 Re: something', id: 'e-2' })).group_key);
    const plain = parseBidEmail(email({ from_address: 'a@sample-hoa.example', from_name: 'Sample HOA', subject: 'RFP: Grounds Pest Control' }));
    const reply = parseBidEmail(email({ from_address: 'a@sample-hoa.example', from_name: 'Sample HOA', subject: 'Re: Reminder: RFP: Grounds Pest Control' }));
    expect(reply.group_key).toBe(plain.group_key);
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

