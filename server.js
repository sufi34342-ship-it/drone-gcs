// ===== GLOBAL DRONE CONTROL SERVER - WITH CAMERA STREAMING =====
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
const drones = new Map();           // droneId -> {info, lastSeen, commands[], camera}
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
      cameraActive: data.camera ? Date.now() - data.camera.lastUpdate < 5000 : false,
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
    registeredAt: new Date().toISOString(),
    camera: null  // Initialize camera storage
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

// ===== CAMERA STREAMING ENDPOINTS =====

// 4. CAMERA FRAME UPLOAD (ESP32-CAM sends JPEG) - WORKING VERSION
app.post('/api/drone/:droneId/camera/upload', (req, res) => {
  const droneId = req.params.droneId;
  const timestamp = Date.now();
  
  console.log(`📸 Camera upload starting for ${droneId}`);
  
  let frameData = Buffer.alloc(0);
  let receivedBytes = 0;
  
  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
    frameData = Buffer.concat([frameData, chunk]);
  });
  
  req.on('end', () => {
    console.log(`✅ Camera upload complete: ${droneId}, ${receivedBytes} bytes`);
    
    // VALIDATION
    if (receivedBytes === 0) {
      return res.status(400).json({ error: 'No frame data' });
    }
    
    if (receivedBytes > 500000) { // 500KB limit
      return res.status(400).json({ error: 'Frame too large' });
    }
    
    // FAST DRONE UPDATE
    if (drones.has(droneId)) {
      const drone = drones.get(droneId);
      drone.lastSeen = timestamp;
      
      if (!drone.camera) {
        drone.camera = {
          frames: [],
          lastUpdate: 0,
          lastFrame: null
        };
      }
      
      drone.camera.lastFrame = frameData;
      drone.camera.lastUpdate = timestamp;
      
      // Keep only last 2 frames
      drone.camera.frames.push({
        data: frameData,
        timestamp: timestamp,
        size: frameData.length
      });
      
      if (drone.camera.frames.length > 2) {
        drone.camera.frames.shift();
      }
    }
    
    // IMMEDIATE RESPONSE (CRITICAL!)
    res.json({
      success: true,
      received: receivedBytes,
      timestamp: timestamp,
      frameId: `frame_${timestamp}`
    });
    
    // Broadcast AFTER response
    setTimeout(() => {
      if (drones.has(droneId)) {
        io.emit('camera-frame', {
          droneId: droneId,
          timestamp: timestamp,
          size: receivedBytes,
          hasFrame: true
        });
      }
    }, 10);
  });
  
  req.on('error', (err) => {
    console.error(`❌ Camera upload error for ${droneId}:`, err.message);
    res.status(500).json({ error: 'Upload failed' });
  });
  
  // 30 second timeout
  req.setTimeout(30000, () => {
    console.error(`⏰ Camera upload timeout for ${droneId}`);
  });
});

// 5. GET LATEST CAMERA FRAME (GCS requests)
app.get('/api/drone/:droneId/camera/latest', (req, res) => {
  const droneId = req.params.droneId;
  const drone = drones.get(droneId);
  
  if (!drone || !drone.camera || !drone.camera.lastFrame) {
    return res.status(404).json({ error: 'No camera frame available' });
  }
  
  // Send JPEG image
  res.set('Content-Type', 'image/jpeg');
  res.set('X-Drone-ID', droneId);
  res.set('X-Timestamp', drone.camera.lastUpdate);
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.send(drone.camera.lastFrame);
});

// 6. CAMERA STATUS ENDPOINT
app.get('/api/drone/:droneId/camera/status', (req, res) => {
  const droneId = req.params.droneId;
  const drone = drones.get(droneId);
  
  const status = {
    hasCamera: !!(drone && drone.camera),
    lastUpdate: drone?.camera?.lastUpdate || null,
    frameSize: drone?.camera?.lastFrame?.length || 0,
    streaming: !!(drone?.camera?.lastUpdate && Date.now() - drone.camera.lastUpdate < 5000),
    framesInMemory: drone?.camera?.frames?.length || 0
  };
  
  res.json(status);
});

// 7. GET CAMERA HISTORY (last 10 frames metadata)
app.get('/api/drone/:droneId/camera/history', (req, res) => {
  const droneId = req.params.droneId;
  const drone = drones.get(droneId);
  
  if (!drone || !drone.camera) {
    return res.json({ frames: [] });
  }
  
  const frames = drone.camera.frames.map(f => ({
    timestamp: f.timestamp,
    size: f.size,
    age: Date.now() - parseInt(f.timestamp)
  }));
  
  res.json({
    droneId: droneId,
    frames: frames,
    latestUpdate: drone.camera.lastUpdate
  });
});

// 8. WEB CLIENT SEND COMMAND (FROM ANYWHERE)
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

// 9. GET DRONE INFO (PUBLIC STATUS)
app.get('/api/drone/:droneId', (req, res) => {
  const droneId = req.params.droneId;
  const drone = drones.get(droneId);
  
  if (!drone) {
    return res.status(404).json({ error: 'Drone not found' });
  }
  
  const cameraStatus = drone.camera ? {
    streaming: Date.now() - drone.camera.lastUpdate < 5000,
    lastFrame: drone.camera.lastUpdate,
    frameSize: drone.camera.lastFrame?.length || 0
  } : { streaming: false };
  
  res.json({
    success: true,
    drone: {
      id: drone.id,
      online: Date.now() - drone.lastSeen < 30000,
      lastSeen: new Date(drone.lastSeen).toISOString(),
      registered: drone.registeredAt,
      ip: drone.ip,
      firmware: drone.firmware,
      pendingCommands: drone.commands.length,
      camera: cameraStatus
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
      
      // Send camera status if drone has camera
      if (data.droneId && drones.has(data.droneId) && drones.get(data.droneId).camera) {
        const drone = drones.get(data.droneId);
        socket.emit('camera-status', {
          streaming: Date.now() - drone.camera.lastUpdate < 5000,
          lastUpdate: drone.camera.lastUpdate
        });
      }
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
  
  // Request camera stream
  socket.on('request-camera', (data) => {
    const { droneId } = data;
    
    if (drones.has(droneId) && drones.get(droneId).camera) {
      const drone = drones.get(droneId);
      socket.emit('camera-info', {
        hasStream: true,
        lastUpdate: drone.camera.lastUpdate,
        endpoint: `/api/drone/${droneId}/camera/latest`
      });
    } else {
      socket.emit('camera-info', {
        hasStream: false,
        message: 'No camera stream available'
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
🌍   GLOBAL DRONE CONTROL SERVER - WITH CAMERA STREAMING
🌍 ======================================================
📍 Server URL:  https://your-app.onrender.com
📍 Local URL:   http://localhost:${PORT}
📍 Health Check: /health
📍 Status Page:  /status
📡 Endpoints:
   POST /api/drone/register           - Drone registration
   GET  /api/drone/:id/commands       - Poll for commands
   POST /api/drone/:id/telemetry      - Send telemetry
   POST /api/drone/:id/camera/upload  - Upload camera frame
   GET  /api/drone/:id/camera/latest  - Get latest frame
   GET  /api/drone/:id/camera/status  - Camera status
   POST /api/drone/:id/command        - Send command
   GET  /api/drone/:id                - Get drone status
🌍 ======================================================
✅ Ready for GLOBAL control with LIVE CAMERA STREAMING!
🌍 ======================================================
  `);
});

// ===== AUTO CLEANUP (Remove offline drones and old frames) =====
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  
  for (const [droneId, drone] of drones.entries()) {
    // Remove drone if offline for 5 minutes
    if (now - drone.lastSeen > 300000) {
      drones.delete(droneId);
      removed++;
      console.log(`🧹 Removed offline drone: ${droneId}`);
      continue;
    }
    
    // Clean old camera frames
    if (drone.camera && drone.camera.frames) {
      // Remove frames older than 1 minute
      drone.camera.frames = drone.camera.frames.filter(f => 
        now - parseInt(f.timestamp) < 60000
      );
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