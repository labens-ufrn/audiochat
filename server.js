import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3003;

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Keep track of connected clients (key: role string, value: ws socket)
const clients = new Map();

wss.on('connection', (ws) => {
  let clientRole = null;

  console.log('New WebSocket connection established.');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'register':
          registerClient(ws, data.role);
          break;

        case 'offer':
        case 'answer':
        case 'candidate':
          relayMessage(data);
          break;

        default:
          console.warn('Unknown message type received:', data.type);
      }
    } catch (err) {
      console.error('Failed to parse WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    if (clientRole) {
      console.log(`Client disconnected: ${clientRole}`);
      clients.delete(clientRole);

      // Notify other relevant peers about the disconnect
      notifyDisconnect(clientRole);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error on client ${clientRole || 'unknown'}:`, error);
  });

  // Helper: Register client and bind role
  function registerClient(socket, role) {
    if (!['guest', 'host-1', 'host-2', 'host-3'].includes(role)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid role' }));
      return;
    }

    // If role is already taken, close the existing one (user reconnected)
    if (clients.has(role)) {
      console.log(`Role ${role} re-registered. Disconnecting previous socket.`);
      const oldSocket = clients.get(role);
      oldSocket.send(JSON.stringify({ type: 'error', message: 'Replaced by another session' }));
      oldSocket.close();
    }

    clientRole = role;
    clients.set(role, socket);
    console.log(`Successfully registered: ${role}`);

    // Confirm registration to client
    socket.send(JSON.stringify({
      type: 'registered',
      role,
      activePeers: Array.from(clients.keys()).filter(k => k !== role)
    }));

    // Notify peers
    if (role === 'guest') {
      // Notify all active hosts that guest has joined
      for (const [peerRole, peerSocket] of clients.entries()) {
        if (peerRole.startsWith('host-')) {
          peerSocket.send(JSON.stringify({ type: 'peer-joined', role: 'guest' }));
        }
      }
    } else {
      // It's a host joining. Notify the guest if connected.
      if (clients.has('guest')) {
        clients.get('guest').send(JSON.stringify({ type: 'peer-joined', role }));
      }
    }
  }

  // Helper: Relay signaling data (offer/answer/candidate) to target
  function relayMessage(data) {
    const { target } = data;
    if (!target) {
      console.warn('Cannot relay message: missing target');
      return;
    }

    if (clients.has(target)) {
      // Forward message, preserve sender's identity as 'sender' field
      clients.get(target).send(JSON.stringify({
        ...data,
        sender: clientRole
      }));
    } else {
      console.log(`Target client offline, buffered or dropped message to: ${target}`);
    }
  }

  // Helper: Notify peers on disconnect
  function notifyDisconnect(role) {
    if (role === 'guest') {
      // Notify all hosts that guest left
      for (const [peerRole, peerSocket] of clients.entries()) {
        if (peerRole.startsWith('host-')) {
          peerSocket.send(JSON.stringify({ type: 'peer-left', role: 'guest' }));
        }
      }
    } else {
      // Host left. Notify guest if guest is connected.
      if (clients.has('guest')) {
        clients.get('guest').send(JSON.stringify({ type: 'peer-left', role }));
      }
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================================`);
  console.log(`Studio Audio Router listening on port ${PORT}`);
  console.log(`- Local access:   http://localhost:${PORT}`);
  console.log(`- Network access: http://<studio-pc-ip>:${PORT}`);
  console.log(`========================================================\n`);
});
