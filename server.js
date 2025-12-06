// ===== GLOBAL DRONE CONTROL SERVER - RENDER DEPLOYMENT READY =====
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ===== GLOBAL CORS CONFIGURATION =====
app.use(cors({
  origin: '*',  // Allow ALL origins for global access
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: false
}));

// ===== WEBSOCKET WITH GLOBAL SUPPORT =====
const io = new Server(server, {
  cors: {
    origin: "*",  // Allow all origins
    methods: ["GET", "POST"]
  },
  pingInterval: 25000,    // Send ping every 25s
  pingTimeout: 60000,     // Wait 60s for pong
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

// ===== GLOBAL DATA STORES =====
const drones = new Map();           // droneId -> {info, lastSeen, commands[]}
const connectedClients = new Map(); // socketId -> {type: 'web'|'drone', droneId}
const telemetryHistory = new Map(); // droneId -> [telemetryData]

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.static('public'));

// ===== HEALTH ENDPOINTS (RENDER MONITORING) =====
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'global-drone-control',
    timestamp: new Date().toISOString(),
    drones: Array.from(drones.keys()).length,
    clients: connectedClients.size,
    uptime: process.uptime(),
    region: process.env.REGION || 'global',
    version: '1.0-global'
  });
});

app.get('/status', (req, res) => {
  const status = {
    online: true,
    drones: Array.from(drones.entries()).map(([id, data]) => ({
      id,
      online: Date.now() - data.lastSeen < 30000, // 30s timeout
      commandsPending: data.commands.length,
      lastSeen: new Date(data.lastSeen).toISOString(),
      ip: data.ip || 'unknown'
    })),
    webClients: Array.from(connectedClients.values())
      .filter(c => c.type === 'web').length,
    droneClients: Array.from(connectedClients.values())
      .filter(c => c.type === 'drone').length
  };
  res.json(status);
});

// ===== DRONE API (GLOBAL ACCESS) =====

// 1. DRONE REGISTRATION (4G/WiFi)
app.post('/api/drone/register', (req, res) => {
  const { droneId, firmware, capabilities } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  
  console.log(`🛩️  Drone REGISTER: ${droneId} from ${ip}`);
  
  drones.set(droneId, {
    id: droneId,
    ip: ip,
    firmware: firmware || 'unknown',
    capabilities: capabilities || [],
    commands: [],
    lastSeen: Date.now(),
    registeredAt: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: `Drone ${droneId} registered globally`,
    serverTime: new Date().toISOString(),
    endpoint: `/api/drone/${droneId}/commands`
  });
});

// 2. DRONE POLL FOR COMMANDS (4G/WiFi Friendly)
app.get('/api/drone/:droneId/commands', (req, res) => {
  const droneId = req.params.droneId;
  const drone = drones.get(droneId);
  
  if (!drone) {
    return res.status(404).json({ error: 'Drone not registered' });
  }
  
  // Update last seen
  drone.lastSeen = Date.now();
  
  // Get pending commands
  const commands = drone.commands;
  
  console.log(`📡 ${droneId} polled from ${drone.ip}, ${commands.length} commands`);
  
  // Clear commands after sending
  drone.commands = [];
  
  res.json({
    success: true,
    droneId: droneId,
    commands: commands,
    timestamp: Date.now(),
    nextPoll: Date.now() + 3000, // Suggest next poll in 3s
    serverTime: new Date().toISOString()
  });
});

// 3. DRONE SEND TELEMETRY (GLOBAL FORWARDING)
app.post('/api/drone/:droneId/telemetry', (req, res) => {
  const droneId = req.params.droneId;
  const telemetry = req.body;
  
  if (!drones.has(droneId)) {
    return res.status(404).json({ error: 'Drone not found' });
  }
  
  // Update drone last seen
  const drone = drones.get(droneId);
  drone.lastSeen = Date.now();
  
  // Add timestamp
  const telemetryData = {
    ...telemetry,
    droneId,
    timestamp: Date.now(),
    serverTime: new Date().toISOString(),
    receivedAt: new Date().toISOString()
  };
  
  // Store in history
  if (!telemetryHistory.has(droneId)) {
    telemetryHistory.set(droneId, []);
  }
  telemetryHistory.get(droneId).push(telemetryData);
  
  // Keep only last 100 telemetry entries
  if (telemetryHistory.get(droneId).length > 100) {
    telemetryHistory.set(droneId, telemetryHistory.get(droneId).slice(-100));
  }
  
  console.log(`📊 Telemetry from ${droneId}: ${telemetry.data || 'heartbeat'}`);
  
  // BROADCAST TO ALL WEB CLIENTS (GLOBAL)
  io.emit('telemetry', telemetryData);
  
  res.json({
    success: true,
    received: telemetryData
  });
});

// 4. WEB CLIENT SEND COMMAND (FROM ANYWHERE)
app.post('/api/drone/:droneId/command', (req, res) => {
  const droneId = req.params.droneId;
  const { command, priority = 1, params } = req.body;
  
  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }
  
  if (!drones.has(droneId)) {
    return res.status(404).json({ error: 'Drone not found' });
  }
  
  const drone = drones.get(droneId);
  
  // Create command object
  const cmdObj = {
    id: `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    command: command,
    priority: priority,
    params: params || {},
    timestamp: Date.now(),
    serverTime: new Date().toISOString(),
    status: 'queued'
  };
  
  // Add to drone's command queue
  drone.commands.push(cmdObj);
  
  console.log(`🌍 GLOBAL Command to ${droneId}: ${command}`);
  
  // Broadcast to all web clients
  io.emit('command-sent', {
    droneId: droneId,
    command: command,
    timestamp: Date.now(),
    from: 'api'
  });
  
  res.json({
    success: true,
    message: `Command sent to ${droneId}`,
    commandId: cmdObj.id,
    queuedAt: new Date().toISOString(),
    estimatedDelivery: Date.now() + 5000, // 5s estimate for 4G
    queuePosition: drone.commands.length
  });
});

// 5. GET DRONE INFO (PUBLIC STATUS)
app.get('/api/drone/:droneId', (req, res) => {
  const droneId = req.params.droneId;
  const drone = drones.get(droneId);
  
  if (!drone) {
    return res.status(404).json({ error: 'Drone not found' });
  }
  
  res.json({
    success: true,
    drone: {
      id: drone.id,
      online: Date.now() - drone.lastSeen < 30000,
      lastSeen: new Date(drone.lastSeen).toISOString(),
      registered: drone.registeredAt,
      ip: drone.ip,
      firmware: drone.firmware,
      pendingCommands: drone.commands.length
    }
  });
});

// ===== WEBSOCKET CONNECTION (GLOBAL CLIENTS) =====
io.on('connection', (socket) => {
  console.log(`🌐 New global connection: ${socket.id} from ${socket.handshake.address}`);
  
  socket.on('identify', (data) => {
    const { type, droneId } = data;
    
    if (type === 'drone') {
      // Drone connecting via WebSocket (alternative to HTTP)
      connectedClients.set(socket.id, { type: 'drone', droneId });
      console.log(`🛩️  Drone ${droneId} connected via WebSocket`);
      
      // Send welcome
      socket.emit('welcome', {
        message: 'Drone connected globally',
        serverTime: new Date().toISOString(),
        updateInterval: 3000
      });
    } else {
      // Web client (GCS from anywhere in world)
      connectedClients.set(socket.id, { type: 'web', droneId: data.droneId || 'all' });
      console.log(`🖥️  GCS client connected from ${socket.handshake.address}`);
      
      // Send initial data
      socket.emit('init', {
        drones: Array.from(drones.keys()),
        serverTime: new Date().toISOString(),
        connectionId: socket.id
      });
    }
  });
  
  // Handle commands from GCS (global)
  socket.on('command', (data) => {
    const { droneId = 'drone-001', command } = data;
    
    console.log(`🎯 Global WebSocket command: ${command} to ${droneId}`);
    
    if (drones.has(droneId)) {
      const drone = drones.get(droneId);
      drone.commands.push({
        command: command,
        timestamp: Date.now(),
        source: 'websocket',
        socketId: socket.id
      });
      
      // Broadcast to all clients
      io.emit('command-issued', {
        from: socket.id,
        droneId: droneId,
        command: command,
        timestamp: Date.now()
      });
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    const client = connectedClients.get(socket.id);
    if (client) {
      console.log(`🔌 ${client.type} disconnected: ${socket.id}`);
      connectedClients.delete(socket.id);
    }
  });
});

// ===== PUBLIC WEB INTERFACE =====
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ===== SERVER START =====
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🌍 ======================================================
🌍   GLOBAL DRONE CONTROL SERVER - DEPLOYMENT READY
🌍 ======================================================
📍 Server URL:  https://your-app.onrender.com
📍 Local URL:   http://localhost:${PORT}
📍 Health Check: /health
📍 Status Page:  /status
📡 Endpoints:
   POST /api/drone/register     - Drone registration (4G/WiFi)
   GET  /api/drone/:id/commands - Poll for commands
   POST /api/drone/:id/telemetry- Send telemetry
   POST /api/drone/:id/command  - Send command from anywhere
   GET  /api/drone/:id          - Get drone status
🌍 ======================================================
✅ Ready for GLOBAL control via 4G/WiFi from anywhere!
🌍 ======================================================
  `);
});

// ===== AUTO CLEANUP (Remove offline drones) =====
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  
  for (const [droneId, drone] of drones.entries()) {
    if (now - drone.lastSeen > 300000) { // 5 minutes offline
      drones.delete(droneId);
      removed++;
      console.log(`🧹 Removed offline drone: ${droneId}`);
    }
  }
  
  if (removed > 0) {
    console.log(`🧹 Cleanup: Removed ${removed} offline drones`);
  }
}, 60000); // Run every minute

// ===== ERROR HANDLING =====
process.on('uncaughtException', (err) => {
  console.error('❌ Global Server Error:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});