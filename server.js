// ===== PRODUCTION DRONE GCS SERVER =====
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const net = require('net');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ===== CONFIGURATION =====
const WEB_PORT = process.env.PORT || 3000;          // Render provides PORT
const DRONE_TCP_PORT = process.env.TCP_PORT || 3001; // TCP for drones
const ALLOWED_ORIGINS = process.env.ORIGINS || '*';  // CORS origins

const tcpClients = new Map(); // droneId -> socket

// ===== SECURITY MIDDLEWARE =====
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS === '*' || ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

// ===== STATIC SERVER =====
app.use(express.static('public'));

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'online',
        service: 'drone-gcs',
        drones_connected: tcpClients.size,
        uptime: process.uptime()
    });
});

// ===== WEBSOCKET HANDLER =====
io.on('connection', (socket) => {
    console.log(`📱 Web client connected: ${socket.id} from ${socket.handshake.address}`);
    
    // Send current drone status
    const droneList = Array.from(tcpClients.keys());
    socket.emit('system-status', {
        drones_online: droneList.length,
        drone_ids: droneList
    });
    
    // Command handler
    socket.on('command', (data) => {
        console.log(`🎯 Command from ${socket.id}:`, data);
        
        let commandToSend, targetDrone;
        
        // Parse command
        if (typeof data === 'object') {
            commandToSend = data.command || 'unknown';
            targetDrone = data.droneId || 'all';
        } else {
            commandToSend = String(data);
            targetDrone = 'all';
        }
        
        // Forward to drone(s)
        if (targetDrone === 'all') {
            // Send to all drones
            tcpClients.forEach((client, droneId) => {
                if (client.writable) {
                    client.write(commandToSend + '\n');
                    console.log(`📤 To drone ${droneId}: ${commandToSend}`);
                }
            });
        } else if (tcpClients.has(targetDrone)) {
            // Send to specific drone
            tcpClients.get(targetDrone).write(commandToSend + '\n');
            console.log(`📤 To drone ${targetDrone}: ${commandToSend}`);
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`📱 Web client disconnected: ${socket.id}`);
    });
});

// ===== TCP SERVER FOR DRONES =====
const tcpServer = net.createServer((socket) => {
    const droneAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    let droneId = `drone_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    console.log(`🤖 New drone connection: ${droneAddress}`);
    
    // Store connection
    tcpClients.set(droneId, socket);
    
    // Send drone its assigned ID
    socket.write(`ID:${droneId}\n`);
    
    // Data handler
    socket.on('data', (data) => {
        try {
            const message = data.toString().trim();
            
            if (message.startsWith('REG:')) {
                // Drone registration with custom ID
                const customId = message.split(':')[1];
                if (customId) {
                    tcpClients.delete(droneId);
                    droneId = customId;
                    tcpClients.set(droneId, socket);
                    console.log(`🤖 Drone registered as: ${droneId}`);
                }
            }
            
            if (message.length > 0) {
                console.log(`📥 From ${droneId}: ${message}`);
                
                // Broadcast telemetry to all web clients
                io.emit('telemetry', {
                    droneId: droneId,
                    timestamp: Date.now(),
                    data: message
                });
            }
        } catch (error) {
            console.error(`Error processing data from ${droneId}:`, error);
        }
    });
    
    // Cleanup on disconnect
    socket.on('end', () => {
        console.log(`🤖 Drone disconnected: ${droneId}`);
        tcpClients.delete(droneId);
        io.emit('drone-disconnected', { droneId: droneId });
    });
    
    socket.on('error', (error) => {
        console.error(`🤖 TCP error from ${droneId}:`, error.message);
        tcpClients.delete(droneId);
    });
    
    // Timeout handler
    socket.setTimeout(30000, () => {
        console.log(`⏰ Timeout for drone ${droneId}`);
        socket.end();
    });
});

// ===== START SERVERS =====
tcpServer.listen(DRONE_TCP_PORT, '0.0.0.0', () => {
    console.log(`📡 TCP Server listening on 0.0.0.0:${DRONE_TCP_PORT} for drones`);
});

server.listen(WEB_PORT, '0.0.0.0', () => {
    console.log('🚀 ============================================');
    console.log('🚀   DRONE GCS - PRODUCTION DEPLOYMENT        ');
    console.log('🚀 ============================================');
    console.log(`🌐 Web Interface:   http://0.0.0.0:${WEB_PORT}`);
    console.log(`📡 Drone TCP Port:  ${DRONE_TCP_PORT}`);
    console.log(`📊 Environment:     ${process.env.NODE_ENV || 'development'}`);
    console.log('📡 Waiting for connections...');
    console.log('🚀 ============================================\n');
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', () => {
    console.log('\n🔴 Shutting down servers...');
    
    tcpClients.forEach((client) => {
        client.end('SERVER_SHUTDOWN');
    });
    
    tcpServer.close();
    server.close();
    
    setTimeout(() => {
        console.log('🛑 Servers stopped');
        process.exit(0);
    }, 1000);
});

module.exports = { app, server, tcpServer }; // For testing