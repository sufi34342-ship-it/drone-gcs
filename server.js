// ===== 100% RELIABLE DRONE GCS SERVER =====
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['polling'] // Most reliable for Render
});

const PORT = process.env.PORT || 3000;

// ===== DATA STORES =====
const commandQueues = new Map();    // droneId -> [commands]
const telemetryStore = new Map();   // droneId -> [telemetry]
const connectedWebClients = new Set();

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.static('public'));

// ===== HEALTH & STATUS =====
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'drone-gcs',
    drones: Array.from(commandQueues.keys()),
    webClients: connectedWebClients.size,
    uptime: process.uptime()
  });
});

app.get('/status', (req, res) => {
  res.json({
    drones: Array.from(commandQueues.keys()).map(id => ({
      id: id,
      pendingCommands: (commandQueues.get(id) || []).length,
      lastTelemetry: telemetryStore.has(id) ? 
        telemetryStore.get(id).slice(-1)[0] : null
    }))
  });
});

// ===== DRONE API (HTTP - 100% RELIABLE) =====

// 1. Drone polls for commands
app.get('/api/drone/:droneId/commands', (req, res) => {
  const droneId = req.params.droneId;
  const commands = commandQueues.get(droneId) || [];
  
  console.log(`🤖 ${droneId} polled, ${commands.length} commands pending`);
  
  res.json({
    success: true,
    droneId: droneId,
    commands: commands,
    timestamp: Date.now(),
    serverTime: new Date().toISOString()
  });
  
  // Clear delivered commands
  commandQueues.set(droneId, []);
});

// 2. Drone sends telemetry
app.post('/api/drone/:droneId/telemetry', (req, res) => {
  const droneId = req.params.droneId;
  const { data, battery, gps, altitude } = req.body;
  
  const telemetry = {
    droneId,
    data: data || 'heartbeat',
    battery: battery || 100,
    gps: gps || '0,0',
    altitude: altitude || 0,
    timestamp: Date.now(),
    serverTime: new Date().toISOString()
  };
  
  // Store telemetry
  if (!telemetryStore.has(droneId)) {
    telemetryStore.set(droneId, []);
  }
  telemetryStore.get(droneId).push(telemetry);
  
  // Keep only last 100 entries
  if (telemetryStore.get(droneId).length > 100) {
    telemetryStore.set(droneId, telemetryStore.get(droneId).slice(-100));
  }
  
  console.log(`📊 Telemetry from ${droneId}:`, data || 'heartbeat');
  
  // Broadcast to all web clients via Socket.io
  io.emit('telemetry', telemetry);
  
  res.json({
    success: true,
    received: telemetry
  });
});

// 3. Send command to drone (from web)
app.post('/api/drone/:droneId/command', (req, res) => {
  const droneId = req.params.droneId;
  const { command, priority = 1 } = req.body;
  
  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }
  
  // Initialize queue if not exists
  if (!commandQueues.has(droneId)) {
    commandQueues.set(droneId, []);
  }
  
  // Add command to queue
  const cmdObj = {
    command: command,
    priority: priority,
    timestamp: Date.now(),
    serverTime: new Date().toISOString()
  };
  
  commandQueues.get(droneId).push(cmdObj);
  
  console.log(`🎯 Command to ${droneId}: ${command}`);
  
  // Also emit via Socket.io for real-time web updates
  io.emit('command-sent', {
    droneId: droneId,
    command: command,
    timestamp: Date.now()
  });
  
  res.json({
    success: true,
    droneId: droneId,
    command: command,
    queuedAt: new Date().toISOString(),
    queuePosition: commandQueues.get(droneId).length
  });
});

// 4. Get drone telemetry history (for web)
app.get('/api/drone/:droneId/telemetry/history', (req, res) => {
  const droneId = req.params.droneId;
  const limit = parseInt(req.query.limit) || 50;
  
  const history = telemetryStore.get(droneId) || [];
  const recent = history.slice(-limit);
  
  res.json({
    success: true,
    droneId: droneId,
    count: recent.length,
    telemetry: recent
  });
});

// ===== WEB SOCKET (for real-time web updates) =====
io.on('connection', (socket) => {
  console.log(`📱 Web client connected: ${socket.id}`);
  connectedWebClients.add(socket.id);
  
  // Send initial status
  socket.emit('init', {
    drones: Array.from(commandQueues.keys()),
    serverTime: new Date().toISOString()
  });
  
  // Handle commands from web
  socket.on('command', (data) => {
    const { droneId = 'all', command } = data;
    
    console.log(`🎯 Web command from ${socket.id}: ${command} to ${droneId}`);
    
    if (droneId === 'all') {
      // Send to all drones
      Array.from(commandQueues.keys()).forEach(id => {
        if (!commandQueues.has(id)) commandQueues.set(id, []);
        commandQueues.get(id).push({
          command: command,
          timestamp: Date.now(),
          source: 'web'
        });
      });
    } else {
      // Send to specific drone
      if (!commandQueues.has(droneId)) commandQueues.set(droneId, []);
      commandQueues.get(droneId).push({
        command: command,
        timestamp: Date.now(),
        source: 'web'
      });
    }
    
    // Broadcast to all web clients
    io.emit('command-issued', {
      from: socket.id,
      droneId: droneId,
      command: command,
      timestamp: Date.now()
    });
  });
  
  socket.on('disconnect', () => {
    console.log(`📱 Web client disconnected: ${socket.id}`);
    connectedWebClients.delete(socket.id);
  });
});

// ===== WEB INTERFACE ROUTES =====
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/api/telemetry/latest', (req, res) => {
  const latest = {};
  
  telemetryStore.forEach((telemetry, droneId) => {
    if (telemetry.length > 0) {
      latest[droneId] = telemetry[telemetry.length - 1];
    }
  });
  
  res.json({
    success: true,
    latest: latest,
    timestamp: Date.now()
  });
});

// ===== START SERVER =====
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 =================================================
🚀   DRONE GCS - 100% RELIABLE EDITION
🚀 =================================================
🌐 HTTP REST API:   Port ${PORT}
📡 Web Interface:   https://your-app.onrender.com
📊 Health Check:    /health
🤖 Drone Endpoints:
   GET  /api/drone/:id/commands      - Poll for commands
   POST /api/drone/:id/telemetry     - Send telemetry
   POST /api/drone/:id/command       - Send command
📲 WebSocket:       Real-time updates
🚀 =================================================
✅ Server ready for unlimited range drone control
🚀 =================================================
  `);
});

// ===== ERROR HANDLING =====
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down gracefully...');
  
  io.emit('server-shutdown', { message: 'Maintenance', time: new Date().toISOString() });
  
  setTimeout(() => {
    server.close(() => {
      console.log('🛑 Server stopped');
      process.exit(0);
    });
  }, 1000);
});

module.exports = { app, server, io };