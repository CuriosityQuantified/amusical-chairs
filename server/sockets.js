// Socket.IO wiring. Persistent websockets are non-negotiable — the clock
// sync protocol depends on them (spec §8).

import QRCode from 'qrcode';
import { Room, makeRoomCode } from './room.js';

export function attachSockets(io) {
  const rooms = new Map();

  const destroyRoom = (room) => {
    room.destroy();
    rooms.delete(room.code);
  };

  io.on('connection', (socket) => {
    const room = () => rooms.get(socket.data.roomCode);

    // NTP-style time endpoint (spec §5.2). Client sends t0, we ack with t1;
    // the client records t2 on receipt and computes rtt + offset.
    socket.on('sync:ping', (t0, cb) => {
      if (typeof cb === 'function') cb({ t0, t1: Date.now() });
    });

    socket.on('host:create', async (payload, cb) => {
      if (typeof cb !== 'function') return;
      try {
        let code;
        do { code = makeRoomCode(); } while (rooms.has(code));
        const r = new Room(io, code, payload?.config || {}, destroyRoom);
        rooms.set(code, r);
        r.hostSocketId = socket.id;
        socket.join(`room:${code}`);
        socket.join(`host:${code}`);
        socket.data.roomCode = code;
        socket.data.isHost = true;
        const origin = typeof payload?.origin === 'string' ? payload.origin.slice(0, 200) : '';
        const joinUrl = `${origin || ''}/?code=${code}`;
        let qr = null;
        try {
          qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 480 });
        } catch { /* QR is decorative — never block room creation on it */ }
        cb({ ok: true, code, hostKey: r.hostKey, joinUrl, qr, config: r.publicConfig() });
      } catch (err) {
        console.error('host:create', err);
        cb({ error: 'Could not create room.' });
      }
    });

    socket.on('host:rejoin', ({ code, hostKey } = {}, cb) => {
      const r = rooms.get(String(code || '').toUpperCase());
      if (!r || r.hostKey !== hostKey) return cb?.({ error: 'Room not found.' });
      r.hostSocketId = socket.id;
      r.clearTimer('empty');
      socket.join(`room:${r.code}`);
      socket.join(`host:${r.code}`);
      socket.data.roomCode = r.code;
      socket.data.isHost = true;
      cb?.({ ok: true, code: r.code, snapshot: r.snapshot(null), config: r.publicConfig() });
    });

    socket.on('player:join', ({ code, name, playerId } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const r = rooms.get(String(code || '').toUpperCase());
      if (!r) return cb({ error: 'Room not found — check the code.' });
      r.clearTimer('empty');
      cb(r.join(socket, { name, playerId }));
    });

    // Solo practice: one person, no host screen. The lone player creates a
    // private room and drives it (any game or the reaction round, unscored).
    socket.on('solo:create', ({ name } = {}, cb) => {
      if (typeof cb !== 'function') return;
      let code;
      do { code = makeRoomCode(); } while (rooms.has(code));
      const r = new Room(io, code, {}, destroyRoom);
      r.solo = true;
      rooms.set(code, r);
      cb(r.join(socket, { name }));
    });

    const soloOnly = (fn) => (...args) => {
      const r = room();
      const cb = args.find((a) => typeof a === 'function');
      if (!r || !r.solo || !socket.data.playerId) return cb?.({ error: 'Not in a solo room.' });
      fn(r, ...args);
    };

    socket.on('solo:play', soloOnly((r, payload, cb) => cb?.(r.startTest(payload?.key))));
    socket.on('solo:redemption', soloOnly((r, _p, cb) => cb?.(r.startRedemptionTest())));
    socket.on('solo:menu', soloOnly((r, _p, cb) => cb?.(r.backToLobby())));

    socket.on('sync:report', (sync) => {
      const r = room();
      if (r && socket.data.playerId) r.recordSync(socket.data.playerId, sync);
    });

    socket.on('player:submit', ({ payload } = {}) => {
      const r = room();
      if (r && socket.data.playerId) r.handleSubmit(socket.data.playerId, payload);
    });

    socket.on('redemption:report', (report) => {
      const r = room();
      if (r && socket.data.playerId) r.handleRedemptionReport(socket.data.playerId, report);
    });

    const hostOnly = (fn) => (...args) => {
      const r = room();
      if (!r || !socket.data.isHost) return;
      fn(r, ...args);
    };

    socket.on('host:start', hostOnly((r, _p, cb) => cb?.(r.start())));
    socket.on('host:test', hostOnly((r, payload, cb) => cb?.(r.startTest(payload?.key))));
    socket.on('host:next', hostOnly((r, _p, cb) => cb?.(r.hostNext())));
    socket.on('host:config', hostOnly((r, payload, cb) => cb?.(r.updateConfig(payload || {}))));

    socket.on('disconnect', () => {
      const r = room();
      if (r) r.handleDisconnect(socket);
    });
  });

  return rooms;
}
