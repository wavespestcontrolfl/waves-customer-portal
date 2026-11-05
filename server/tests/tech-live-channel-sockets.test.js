/**
 * Technician visibility pack 1, B1 (GATE_TECH_LOGIN_PRIVACY): the staff socket room.
 *
 * Gate on: a technician socket is not in 'dispatch:admins' (the company-wide channel) and is in
 * 'tech:<its id>'. A visit update reaches the visit's technician with ids and status only; the office
 * still gets the full payload. Gate off: today's rooms and payloads, byte for byte.
 *
 * A small in-memory io routes each emit to the sockets in the named room, so the assertions read
 * "what did this socket receive", not "which mock was called".
 */
let mockIo = null;
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/cors-origins', () => ({ allowedOrigins: [] }));
jest.mock('../sockets/auth', () => ({ socketAuth: jest.fn() }));
jest.mock('../services/retired-dispatch-alerts', () => ({ emitRetiredAlertResolutions: jest.fn() }));
jest.mock('socket.io', () => ({
  Server: jest.fn().mockImplementation(() => {
    const handlers = {};
    return { use: jest.fn(), on: (event, fn) => { handlers[event] = fn; }, handlers };
  }),
}));
jest.mock('../sockets', () => ({ ...jest.requireActual('../sockets'), getIo: () => mockIo }));
jest.mock('../services/stamped-address', () => ({ stampedDivergesSql: () => 'FALSE', stampedLine2Sql: () => 'NULL' }));
jest.mock('../services/scheduling/quality-after-change', () => ({
  refreshScheduleQualityAfterChange: jest.fn(async () => ({ status: 'gate_off' })),
}));

const db = require('../models/db');
const sockets = require('../sockets');
const { emitRetiredAlertResolutions } = require('../services/retired-dispatch-alerts');
const { techRoom, pingTechnicianRooms } = require('../sockets/tech-rooms');

const T1 = '00000000-0000-4000-8000-0000000000b1';
const T2 = '00000000-0000-4000-8000-0000000000b2';
const ADMIN_ID = '00000000-0000-4000-8000-0000000000a0';

// Sockets with rooms; io.to(room).emit(event, payload?) delivers to each socket in the room.
function makeFakeIo() {
  const all = new Set();
  const rooms = new Map();
  const io = {
    sockets: { adapter: { rooms }, sockets: new Map() },
    to(room) {
      return {
        emit(event, ...args) {
          for (const socket of rooms.get(room) || []) socket.received.push({ event, args });
        },
      };
    },
    add(userType, userId) {
      const socket = {
        id: `s-${all.size}`,
        userType,
        userId,
        received: [],
        rooms: new Set(),
        join(room) {
          this.rooms.add(room);
          if (!rooms.has(room)) rooms.set(room, new Set());
          rooms.get(room).add(this);
        },
        emit: jest.fn(),
        on: jest.fn(),
        disconnect: jest.fn(),
      };
      all.add(socket);
      return socket;
    },
  };
  return io;
}

const savedGate = process.env.GATE_TECH_LOGIN_PRIVACY;
// Every socket connect() made: its staff re-check interval is real, so it is
// cleared after each test (a leaked interval fired inside a later suite).
const connectedSockets = [];
afterEach(() => {
  for (const socket of connectedSockets.splice(0)) clearInterval(socket.staffRecheckTimer);
  mockIo = null;
  if (savedGate === undefined) delete process.env.GATE_TECH_LOGIN_PRIVACY; else process.env.GATE_TECH_LOGIN_PRIVACY = savedGate;
  jest.clearAllMocks();
});

// Boot the connection handler once and connect a fake socket through it.
function connect(userType, userId) {
  const { Server } = require('socket.io');
  Server.mockClear();
  sockets.attachSockets({});
  const server = Server.mock.results[Server.mock.results.length - 1].value;
  const socket = makeFakeIo().add(userType, userId);
  server.handlers.connection(socket);
  connectedSockets.push(socket);
  return socket;
}

describe('connection room joins', () => {
  test('gate on: a technician socket is not in dispatch:admins and is in its own room', () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const socket = connect('technician', T1);
    expect([...socket.rooms]).toEqual([techRoom(T1)]);
    expect(socket.rooms.has('dispatch:admins')).toBe(false);
    expect(emitRetiredAlertResolutions).not.toHaveBeenCalled();
  });

  test('gate on: the staff recheck still starts for a technician socket', () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const socket = connect('technician', T1);
    expect(socket.staffRecheckTimer).toBeTruthy();
    clearInterval(socket.staffRecheckTimer);
  });

  test('gate on: an admin socket still joins dispatch:admins only', () => {
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    const socket = connect('admin', ADMIN_ID);
    expect([...socket.rooms]).toEqual(['dispatch:admins']);
    expect(emitRetiredAlertResolutions).toHaveBeenCalledWith(socket);
    clearInterval(socket.staffRecheckTimer);
  });

  test('gate off: a technician socket joins dispatch:admins as today', () => {
    delete process.env.GATE_TECH_LOGIN_PRIVACY;
    const socket = connect('technician', T1);
    expect([...socket.rooms]).toEqual(['dispatch:admins']);
    expect(emitRetiredAlertResolutions).toHaveBeenCalledWith(socket);
    clearInterval(socket.staffRecheckTimer);
  });
});

// Office board and two technicians, joined the way the connection handler joins them for the gate state.
function staffFloor(gateOn) {
  if (gateOn) process.env.GATE_TECH_LOGIN_PRIVACY = 'true'; else delete process.env.GATE_TECH_LOGIN_PRIVACY;
  const io = makeFakeIo();
  const office = io.add('admin', ADMIN_ID);
  const tech1 = io.add('technician', T1);
  const tech2 = io.add('technician', T2);
  office.join('dispatch:admins');
  if (gateOn) { tech1.join(techRoom(T1)); tech2.join(techRoom(T2)); } else { tech1.join('dispatch:admins'); tech2.join('dispatch:admins'); }
  return { io, office, tech1, tech2 };
}

const FULL_ADMIN_PAYLOAD = {
  job_id: 'job-1', customer_id: 'cust-1', cust_first_name: 'Pat', status: 'en_route', from_status: 'scheduled', tech_id: T1,
  tech_full_name: 'Tech One', service_type: 'Pest Control', notes: 'gate code note', internal_notes: 'internal note', updated_at: 'x',
};

describe('job-status broadcast (dispatch:job_update)', () => {
  const { _test } = require('../services/job-status');

  test('gate on: the visit\'s technician gets ids and status only; the other technician gets nothing; the office gets everything', () => {
    const { io, office, tech1, tech2 } = staffFloor(true);
    mockIo = io;
    _test.emitToAdmins(FULL_ADMIN_PAYLOAD);

    expect(office.received).toEqual([{ event: 'dispatch:job_update', args: [FULL_ADMIN_PAYLOAD] }]);
    expect(tech1.received).toEqual([{ event: 'dispatch:job_update', args: [{ job_id: 'job-1', status: 'en_route', tech_id: T1 }] }]);
    expect(tech2.received).toEqual([]);
    const seen = JSON.stringify(tech1.received);
    for (const leak of ['Pat', 'cust-1', 'gate code note', 'internal note', 'Tech One', 'Pest Control']) expect(seen).not.toContain(leak);
  });

  test('gate off: both technicians get the full payload through the shared room, as today', () => {
    const { io, office, tech1, tech2 } = staffFloor(false);
    mockIo = io;
    _test.emitToAdmins(FULL_ADMIN_PAYLOAD);
    for (const socket of [office, tech1, tech2]) {
      expect(socket.received).toEqual([{ event: 'dispatch:job_update', args: [FULL_ADMIN_PAYLOAD] }]);
    }
  });
});

describe('dispatch-assignment broadcast', () => {
  const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');

  function primeJob(row) {
    db.mockImplementation(() => {
      const chain = { leftJoin: () => chain, where: () => chain, first: async () => row };
      return chain;
    });
    db.raw = (sql) => sql;
  }
  const JOB_ROW = {
    job_id: 'job-1', customer_id: 'cust-1', tech_id: T2, status: 'scheduled', scheduled_date: '2040-09-11',
    cust_first_name: 'Pat', first_name: 'Pat', last_name: 'Example', address_line1: '1 Test Way',
    notes: 'gate code note', internal_notes: 'internal note', lat: '27.1', lng: '-82.2', tech_full_name: 'Tech Two',
  };

  test('gate on, a reassignment from T1 to T2: both technicians are pinged with ids and status only; the office gets the full payload', async () => {
    const { io, office, tech1, tech2 } = staffFloor(true);
    mockIo = io;
    primeJob(JOB_ROW);
    await emitDispatchJobUpdate({ jobId: 'job-1', previousTechnicianId: T1 });

    expect(office.received).toHaveLength(1);
    expect(office.received[0].args[0]).toMatchObject({ customer_name: 'Pat E.', address: '1 Test Way', notes: 'gate code note' });
    const ping = { event: 'dispatch:job_update', args: [{ job_id: 'job-1', status: 'scheduled', tech_id: T2 }] };
    expect(tech1.received).toEqual([ping]);
    expect(tech2.received).toEqual([ping]);
  });

  test('gate on, previous technician unknown: the new technician gets ids and status; every other technician room gets a ping with no payload', async () => {
    const { io, tech1, tech2 } = staffFloor(true);
    mockIo = io;
    primeJob(JOB_ROW);
    await emitDispatchJobUpdate({ jobId: 'job-1' });

    expect(tech2.received).toEqual([{ event: 'dispatch:job_update', args: [{ job_id: 'job-1', status: 'scheduled', tech_id: T2 }] }]);
    expect(tech1.received).toEqual([{ event: 'dispatch:job_update', args: [] }]);
  });

  test('gate on, an unassigned visit that stays unassigned: no technician is named, the known previous holder is not guessed', async () => {
    const { io, tech1, tech2 } = staffFloor(true);
    mockIo = io;
    primeJob({ ...JOB_ROW, tech_id: null });
    await emitDispatchJobUpdate({ jobId: 'job-1', previousTechnicianId: null });
    expect(tech1.received).toEqual([]);
    expect(tech2.received).toEqual([]);
  });

  test('gate off: both technicians get the full payload through the shared room and no ping goes out', async () => {
    const { io, office, tech1, tech2 } = staffFloor(false);
    mockIo = io;
    primeJob(JOB_ROW);
    await emitDispatchJobUpdate({ jobId: 'job-1', previousTechnicianId: T1 });
    for (const socket of [office, tech1, tech2]) {
      expect(socket.received).toHaveLength(1);
      expect(socket.received[0].args[0]).toMatchObject({ customer_name: 'Pat E.', notes: 'gate code note', internal_notes: 'internal note' });
    }
  });
});

describe('office-only events never reach a technician with the gate on', () => {
  test('truck GPS, alerts and absences go to dispatch:admins, which no technician socket is in', () => {
    const { io, office, tech1, tech2 } = staffFloor(true);
    io.to('dispatch:admins').emit('dispatch:tech_status', { tech_id: T2, lat: 27.1, lng: -82.2 });
    io.to('dispatch:admins').emit('dispatch:alert', { id: 'a1' });
    io.to('dispatch:admins').emit('dispatch:tech_absence', { tech_id: T2, out: true });
    expect(office.received).toHaveLength(3);
    expect(tech1.received).toEqual([]);
    expect(tech2.received).toEqual([]);
  });
});

describe('pingTechnicianRooms', () => {
  test('gate off sends nothing and gate on skips a missing io', () => {
    delete process.env.GATE_TECH_LOGIN_PRIVACY;
    const io = { to: jest.fn() };
    expect(pingTechnicianRooms(io, 'e', { techIds: [T1] })).toBe(0);
    expect(io.to).not.toHaveBeenCalled();
    process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
    expect(pingTechnicianRooms(null, 'e', { techIds: [T1] })).toBe(0);
  });
});
