// FDACS-13692 consumer notices on file (GATE_WARRANTY_13692_CHECK): which notice counts for a date (Eastern
// signed day, on-or-before rule, e-sign vs paper) and the paper-scan upload checks. Synthetic data only.
jest.mock('../models/db', () => {
  const db = () => { throw new Error('unexpected db call'); };
  db.raw = (sql) => ({ sql });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: { region: 'us-east-1', bucket: 'test-bucket' } }));
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(input) { this.input = input; } }
  return {
    S3Client: class { send(command) { return mockSend(command); } },
    PutObjectCommand: class PutObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const mockSend = jest.fn(async () => ({}));
const notices = require('../services/consumer-notices');

function fakeConn({ esigned = [], paper = [] }) {
  return (table) => {
    const rows = table === 'customer_contracts' ? esigned : paper;
    const q = { where: () => q, whereIn: () => q, select: async () => rows };
    return q;
  };
}
const signed = (id, signedAt, extra = {}) => ({ id, status: 'signed', signed_at: signedAt, created_at: signedAt, ...extra });
const paperRow = (id, signedOn) => ({ id, file_name: 'scan.pdf', notes: null, signed_on: signedOn });
const find = (conn, onOrBefore) => notices.findConsumerNotice(conn, 'cust-1', { onOrBefore });

describe('findConsumerNotice', () => {
  test('reads the e-signed day in Eastern time, not UTC (late evening and just after midnight)', async () => {
    // 03:30Z on 10/21 is 23:30 EDT on 10/20; 04:00Z is 00:00 EDT on 10/21.
    const lateEvening = fakeConn({ esigned: [signed('e1', '2026-10-21T03:30:00Z')] });
    expect(await find(lateEvening, { y: 2026, m: 10, d: 20 })).toEqual({ source: 'esign', id: 'e1', signedOn: '10/20/2026' });
    const afterMidnight = fakeConn({ esigned: [signed('e2', '2026-10-21T04:00:00Z')] });
    expect(await find(afterMidnight, { y: 2026, m: 10, d: 20 })).toBeNull();
    expect((await find(afterMidnight, '2026-10-21')).signedOn).toBe('10/21/2026');
    // An exact UTC-midnight instant is 8 PM the evening before in Eastern time.
    const utcMidnight = fakeConn({ esigned: [signed('e3', '2026-10-21T00:00:00Z')] });
    expect((await find(utcMidnight, '2026-10-20')).signedOn).toBe('10/20/2026');
    // Winter (EST, UTC-5): 04:30Z is still the evening before.
    const winter = fakeConn({ esigned: [signed('e4', '2027-01-15T04:30:00Z')] });
    expect((await find(winter, '2027-01-14')).signedOn).toBe('01/14/2027');
  });

  test('counts a notice signed on the limit day, never a later one', async () => {
    const conn = fakeConn({ paper: [paperRow('p1', '2026-09-01'), paperRow('p2', '2026-09-02')] });
    expect((await find(conn, { y: 2026, m: 9, d: 1 })).id).toBe('p1');
    expect(await find(conn, { y: 2026, m: 8, d: 31 })).toBeNull();
  });

  test('takes the newest signed day across e-sign and paper; an e-sign notice wins a tie', async () => {
    const conn = fakeConn({
      esigned: [signed('e1', '2026-08-10T15:00:00Z'), signed('e2', '2026-09-10T15:00:00Z')],
      paper: [paperRow('p1', '2026-09-05'), paperRow('p2', '2026-09-10')],
    });
    expect(await find(conn, '2026-12-31')).toEqual({ source: 'esign', id: 'e2', signedOn: '09/10/2026' });
    expect(await find(conn, '2026-09-09')).toEqual({ source: 'paper', id: 'p1', signedOn: '09/05/2026' });
    expect((await find(conn, '2026-08-31')).id).toBe('e1');
  });

  test('a sent or viewed e-sign notice never counts, and none on file is null', async () => {
    const conn = fakeConn({ esigned: [{ id: 'e1', status: 'sent', signed_at: null, created_at: '2026-09-01T12:00:00Z' }] });
    expect(await find(conn, '2026-12-31')).toBeNull();
    expect(await find(fakeConn({}), '2026-12-31')).toBeNull();
  });
});

describe('listConsumerNotices', () => {
  test('lists every notice newest first with whether it is usable', async () => {
    const conn = fakeConn({
      esigned: [signed('e1', '2026-09-10T15:00:00Z'), { id: 'e2', status: 'sent', signed_at: null, created_at: '2026-10-01T12:00:00Z' }],
      paper: [paperRow('p1', '2026-09-20')],
    });
    const list = await notices.listConsumerNotices('cust-1', conn);
    expect(list.map((n) => [n.source, n.id, n.usable, n.signedOn])).toEqual([
      ['paper', 'p1', true, '09/20/2026'],
      ['esign', 'e1', true, '09/10/2026'],
      ['esign', 'e2', false, null],
    ]);
    expect(list[0]).not.toHaveProperty('s3_key');
  });
});

describe('paper upload checks', () => {
  const PDF = Buffer.from('%PDF-1.4\n%fixture bytes\n', 'latin1');
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture')]);
  const file = (over = {}) => ({ originalname: 'notice.pdf', mimetype: 'application/pdf', buffer: PDF, ...over });

  test('accepts JPG, PNG and PDF whose bytes match; refuses another type, a mismatch, an empty or a large file', () => {
    expect(notices.validatePaperFile(file())).toBe('application/pdf');
    expect(notices.validatePaperFile(file({ originalname: 'n.png', mimetype: 'image/png', buffer: PNG }))).toBe('image/png');
    expect(notices.validatePaperFile(file({ originalname: 'n.jpg', mimetype: 'image/jpg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]) }))).toBe('image/jpeg');
    expect(() => notices.validatePaperFile(file({ originalname: 'n.gif', mimetype: 'image/gif' }))).toThrow(/JPG, PNG and PDF/);
    expect(() => notices.validatePaperFile(file({ originalname: 'n.exe', mimetype: 'application/pdf' }))).toThrow(/JPG, PNG and PDF/);
    expect(() => notices.validatePaperFile(file({ mimetype: 'image/png' }))).toThrow(/JPG, PNG and PDF/);
    expect(() => notices.validatePaperFile(file({ buffer: Buffer.from('not a pdf at all') }))).toThrow(/does not match/);
    expect(() => notices.validatePaperFile(file({ buffer: Buffer.alloc(0) }))).toThrow(/empty/);
    expect(() => notices.validatePaperFile(file({ buffer: Buffer.concat([PDF, Buffer.alloc(notices.MAX_FILE_BYTES)]) }))).toThrow(/larger than 10 MB/);
  });

  test('the signed date must be a real day, not in the future (Eastern), and not before 07/01/2021', () => {
    const today = '2026-10-24';
    expect(notices.validatePaperSignedOn('10/24/2026', today)).toEqual({ y: 2026, m: 10, d: 24 });
    expect(notices.validatePaperSignedOn('07/01/2021', today)).toEqual({ y: 2021, m: 7, d: 1 });
    expect(() => notices.validatePaperSignedOn('10/25/2026', today)).toThrow(/future/);
    expect(() => notices.validatePaperSignedOn('06/30/2021', today)).toThrow(/before 07\/01\/2021/);
    expect(() => notices.validatePaperSignedOn('02/30/2026', today)).toThrow(/MM\/DD\/YYYY/);
    expect(() => notices.validatePaperSignedOn('2026-10-01', today)).toThrow(/MM\/DD\/YYYY/);
    expect(() => notices.validatePaperSignedOn('', today)).toThrow(/MM\/DD\/YYYY/);
  });

  test('recordPaperNotice refuses a bad file or date before anything is stored', async () => {
    mockSend.mockClear();
    await expect(notices.recordPaperNotice('cust-1', file({ originalname: 'n.gif', mimetype: 'image/gif' }), { signedOn: '09/01/2026' })).rejects.toMatchObject({ status: 400 });
    await expect(notices.recordPaperNotice('cust-1', file(), { signedOn: '01/01/2099' })).rejects.toMatchObject({ status: 400 });
    await expect(notices.recordPaperNotice('cust-1', file(), { signedOn: '01/01/2020' })).rejects.toMatchObject({ status: 400 });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
