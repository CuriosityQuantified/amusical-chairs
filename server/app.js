import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { attachSockets } from './sockets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, '../public')));
  // Shared pure-logic modules are served to the browser as-is (ES modules).
  app.use('/shared', express.static(path.join(__dirname, '../shared')));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    // Same-origin app; generous ping so flaky wifi survives (30s grace lives
    // in the room layer, not the transport).
    pingTimeout: 20000,
    pingInterval: 10000,
  });
  const rooms = attachSockets(io);
  return { httpServer, io, rooms };
}
