const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Store connected clients
const webClients = new Map();    // Web UI clients
const droneClients = new Map();  // Drone clients

// ===== MIDDLEWARE =====
app.use(express.static('public'));

// Health endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        drones: droneClients.size,
        webClients: webClients.size
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// ===== WEB CLIENT NAMESPACE =====
io.of('/web').on('connection', (socket) => {
    console.log(`📱 Web client connected: ${socket.id}`);
    webClients.set(socket.id, socket);
    
    // Send current status
    socket.emit('status', {
        drones: Array.from(droneClients.keys()),
        timestamp: Date.now()
    });
    
    // Handle commands from web
    socket.on('command', (data) => {
        console.log(`🎯 Command from ${socket.id}:`, data);
        
        const command = typeof data === 'object' ? data.command : data;
        
        // Send to all drones
        droneClients.forEach((droneSocket, droneId) => {
            droneSocket.emit('command', command);
            console.log(`📤 To drone ${droneId}: ${command}`);
        });
    });
    
    socket.on('disconnect', () => {
        console.log(`📱 Web client disconnected: ${socket.id}`);
        webClients.delete(socket.id);
    });
});

// ===== DRONE CLIENT NAMESPACE =====
io.of('/drone').on('connection', (socket) => {
    console.log(`🤖 Drone connected: ${socket.id}`);
    
    // Request drone registration
    socket.emit('request-registration');
    
    socket.on('register', (data) => {
        const droneId = data.droneId || `drone_${socket.id}`;
        console.log(`✅ Drone registered: ${droneId}`);
        
        droneClients.set(droneId, socket);
        
        // Notify all web clients
        io.of('/web').emit('drone-connected', { droneId: droneId });
        
        // Send confirmation to drone
        socket.emit('registered', { 
            droneId: droneId,
            serverTime: Date.now()
        });
    });
    
    // Handle telemetry from drone
    socket.on('telemetry', (data) => {
        const droneId = Array.from(droneClients.entries())
            .find(([id, sock]) => sock.id === socket.id)?.[0] || socket.id;
        
        console.log(`📥 Telemetry from ${droneId}:`, data);
        
        // Broadcast to all web clients
        io.of('/web').emit('telemetry', {
            droneId: droneId,
            data: data,
            timestamp: Date.now()
        });
    });
    
    socket.on('disconnect', () => {
        const droneId = Array.from(droneClients.entries())
            .find(([id, sock]) => sock.id === socket.id)?.[0];
        
        if (droneId) {
            console.log(`🤖 Drone disconnected: ${droneId}`);
            droneClients.delete(droneId);
            io.of('/web').emit('drone-disconnected', { droneId: droneId });
        }
    });
});

// ===== START SERVER =====
server.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 ============================================');
    console.log('🚀   DRONE GCS - WEBSOCKET EDITION            ');
    console.log('🚀 ============================================');
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📡 Web namespace: /web`);
    console.log(`🤖 Drone namespace: /drone`);
    console.log('🚀 ============================================');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔴 Shutting down...');
    
    // Notify all clients
    io.of('/web').emit('server-shutdown');
    io.of('/drone').emit('server-shutdown');
    
    setTimeout(() => {
        server.close();
        process.exit(0);
    }, 1000);
});