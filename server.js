const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);

// ===== LAYER 1: Socket.io (HTTP Long-polling fallback) =====
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['polling', 'websocket'], // Polling first for reliability
  pingInterval: 25000,
  pingTimeout: 60000
});

// ===== LAYER 2: Pure WebSocket (for ESP32) =====
const wss = new WebSocketServer({ noServer: true });

// Handle upgrade to WebSocket
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  
  if (pathname === '/drone-ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket connections
wss.on('connection', (ws) => {
  console.log('🤖 Drone connected via raw WebSocket');
  
  ws.on('message', (data) => {
    console.log('📥 Raw WS:', data.toString());
    // Broadcast to Socket.io clients
    io.emit('drone-data', data.toString());
  });
  
  ws.on('close', () => {
    console.log('🤖 Drone disconnected (WS)');
  });
});

// ===== LAYER 3: HTTP REST API (Most reliable) =====
app.post('/api/drone/command', express.json(), (req, res) => {
  const { droneId, command } = req.body;
  console.log(`📨 HTTP Command to ${droneId}: ${command}`);
  
  // Store command for drone to fetch
  commandQueue.push({ droneId, command, timestamp: Date.now() });
  res.json({ success: true, queued: true });
});

app.get('/api/drone/poll/:droneId', (req, res) => {
  const { droneId } = req.params;
  const commands = commandQueue.filter(cmd => cmd.droneId === droneId);
  
  res.json({
    commands: commands,
    timestamp: Date.now()
  });
  
  // Clear delivered commands
  commandQueue = commandQueue.filter(cmd => cmd.droneId !== droneId);
});

const commandQueue = [];

// ===== MAIN LOGIC =====
io.on('connection', (socket) => {
  console.log('📱 Web client connected');
  
  socket.on('command', (data) => {
    console.log('🎯 Command:', data);
    
    // Try WebSocket first
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: 'command', data: data }));
      }
    });
    
    // Also queue for HTTP poll
    commandQueue.push({
      droneId: 'broadcast',
      command: data,
      timestamp: Date.now()
    });
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`
🚀  TRIPLE-REDUNDANT DRONE GCS ONLINE
├── 📡 HTTP REST API:    /api/drone/*
├── 🔌 WebSocket:        /drone-ws
└── 📲 Socket.io:        Auto-negotiated
`);
});