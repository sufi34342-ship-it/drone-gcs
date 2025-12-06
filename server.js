// ================================================
// DRONE GCS SERVER - RENDER.COM COMPATIBLE
// ================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const net = require('net');
const path = require('path');

// ============= CONFIGURATION =============
const PORT = process.env.PORT || 10000;  // Render provides PORT
const TCP_PORT = 3001;
const HOST = '0.0.0.0';  // Required for Render

// ============= GLOBAL STATE =============
const drones = new Map();          // drone_id -> {connection, status}
const commandQueues = new Map();   // drone_id -> [commands]
const webClients = new Set();      // WebSocket clients

// ============= EXPRESS SETUP =============
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));  // Serve HTML from root

// ============= WEB INTERFACE =============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health endpoint (required by Render)
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        drones: Array.from(drones.keys())
    });
});

// Get all drones status
app.get('/api/drones', (req, res) => {
    const droneList = Array.from(drones.entries()).map(([id, data]) => ({
        id,
        status: data.status,
        lastSeen: data.lastSeen,
        battery: data.battery || 100,
        ip: data.ip
    }));
    res.json(droneList);
});

// Send command to drone (Web interface)
app.post('/api/command', (req, res) => {
    const { droneId, command } = req.body;
    
    if (!droneId || !command) {
        return res.status(400).json({ error: 'Missing droneId or command' });
    }
    
    // Queue command for specific drone
    if (!commandQueues.has(droneId)) {
        commandQueues.set(droneId, []);
    }
    
    commandQueues.get(droneId).push(command);
    
    // Broadcast to web clients
    broadcastToWebClients({
        type: 'command_sent',
        droneId,
        command,
        timestamp: Date.now()
    });
    
    console.log(`📤 Command queued for ${droneId}: ${command}`);
    res.json({ success: true, message: 'Command queued' });
});

// Send command to all drones
app.post('/api/command/all', (req, res) => {
    const { command } = req.body;
    
    if (!command) {
        return res.status(400).json({ error: 'Missing command' });
    }
    
    // Send to all connected drones
    drones.forEach((droneData, droneId) => {
        if (!commandQueues.has(droneId)) {
            commandQueues.set(droneId, []);
        }
        commandQueues.get(droneId).push(command);
    });
    
    broadcastToWebClients({
        type: 'broadcast_command',
        command,
        timestamp: Date.now()
    });
    
    console.log(`📤 Broadcast command to all drones: ${command}`);
    res.json({ success: true, affected: drones.size });
});

// Drone polling endpoint (ESP32 calls this)
app.post('/api/drone/poll/:droneId', (req, res) => {
    const droneId = req.params.droneId;
    const { battery, status, location } = req.body;
    
    // Update drone status
    if (drones.has(droneId)) {
        const drone = drones.get(droneId);
        drone.lastSeen = Date.now();
        drone.status = status || drone.status;
        drone.battery = battery || drone.battery;
        if (location) drone.location = location;
    } else {
        // New drone registration
        drones.set(droneId, {
            ip: req.ip,
            status: 'connected',
            lastSeen: Date.now(),
            battery: battery || 100,
            location: location || null
        });
        console.log(`🚁 New drone registered: ${droneId}`);
        
        broadcastToWebClients({
            type: 'drone_connected',
            droneId,
            status: 'connected'
        });
    }
    
    // Check for pending commands
    if (commandQueues.has(droneId) && commandQueues.get(droneId).length > 0) {
        const command = commandQueues.get(droneId).shift();
        console.log(`📤 Sending command to ${droneId}: ${command}`);
        
        res.json({
            command: command,
            timestamp: Date.now()
        });
        
        broadcastToWebClients({
            type: 'command_delivered',
            droneId,
            command,
            timestamp: Date.now()
        });
    } else {
        // No commands
        res.json({ command: 'no_command' });
    }
});

// Drone acknowledgment endpoint
app.post('/api/drone/ack/:droneId', (req, res) => {
    const droneId = req.params.droneId;
    const { command, status } = req.body;
    
    console.log(`✅ ${droneId} acknowledged: ${command} (${status})`);
    
    broadcastToWebClients({
        type: 'command_ack',
        droneId,
        command,
        status,
        timestamp: Date.now()
    });
    
    res.json({ success: true });
});

// ============= WEB SOCKET HANDLER =============
wss.on('connection', (ws) => {
    webClients.add(ws);
    console.log(`📱 Web client connected (${webClients.size} total)`);
    
    // Send current state
    const droneList = Array.from(drones.entries()).map(([id, data]) => ({
        id,
        status: data.status,
        battery: data.battery,
        lastSeen: data.lastSeen
    }));
    
    ws.send(JSON.stringify({
        type: 'init',
        drones: droneList,
        timestamp: Date.now()
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'command') {
                const { droneId, command } = data;
                
                if (!commandQueues.has(droneId)) {
                    commandQueues.set(droneId, []);
                }
                commandQueues.get(droneId).push(command);
                
                console.log(`🎯 Web command from client: ${command} to ${droneId}`);
                
                // Broadcast to other web clients
                broadcastToWebClients({
                    type: 'command_sent',
                    droneId,
                    command,
                    timestamp: Date.now()
                }, ws);  // Don't send back to sender
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        webClients.delete(ws);
        console.log(`📱 Web client disconnected (${webClients.size} remaining)`);
    });
});

function broadcastToWebClients(data, excludeWs = null) {
    const message = JSON.stringify(data);
    webClients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============= TCP SERVER FOR DIRECT CONNECTIONS =============
const tcpServer = net.createServer((socket) => {
    let droneId = null;
    
    socket.on('data', (data) => {
        const message = data.toString().trim();
        
        if (message.startsWith('REGISTER:')) {
            droneId = message.split(':')[1];
            drones.set(droneId, {
                connection: socket,
                status: 'connected',
                lastSeen: Date.now(),
                ip: socket.remoteAddress,
                battery: 100
            });
            
            console.log(`🚁 TCP Drone connected: ${droneId}`);
            socket.write(`REGISTERED:${droneId}\n`);
            
            broadcastToWebClients({
                type: 'drone_connected',
                droneId,
                status: 'connected'
            });
        } 
        else if (message.startsWith('ACK:')) {
            const command = message.substring(4);
            console.log(`✅ TCP ACK from ${droneId}: ${command}`);
            
            broadcastToWebClients({
                type: 'command_ack',
                droneId,
                command,
                status: 'executed',
                timestamp: Date.now()
            });
        }
        else if (message.startsWith('STATUS:')) {
            const parts = message.split(':');
            if (parts.length >= 4) {
                const battery = parts[2];
                const status = parts[3];
                
                if (droneId && drones.has(droneId)) {
                    drones.get(droneId).battery = battery;
                    drones.get(droneId).status = status;
                    drones.get(droneId).lastSeen = Date.now();
                }
            }
        }
    });
    
    socket.on('error', (err) => {
        console.error(`❌ TCP Error for ${droneId}:`, err.message);
    });
    
    socket.on('close', () => {
        if (droneId) {
            drones.delete(droneId);
            console.log(`🚁 TCP Drone disconnected: ${droneId}`);
            
            broadcastToWebClients({
                type: 'drone_disconnected',
                droneId,
                timestamp: Date.now()
            });
        }
    });
});

// ============= START SERVERS =============
server.listen(PORT, HOST, () => {
    console.log(`🌐 Web server running on http://${HOST}:${PORT}`);
    console.log(`📡 WebSocket server ready on port ${PORT}`);
});

tcpServer.listen(TCP_PORT, HOST, () => {
    console.log(`🔌 TCP server listening on ${HOST}:${TCP_PORT}`);
});

// Clean up old drones
setInterval(() => {
    const now = Date.now();
    drones.forEach((drone, droneId) => {
        if (now - drone.lastSeen > 30000) {  // 30 seconds
            drones.delete(droneId);
            console.log(`🕒 Removing inactive drone: ${droneId}`);
            
            broadcastToWebClients({
                type: 'drone_disconnected',
                droneId,
                timestamp: now
            });
        }
    });
}, 10000);

console.log('🚀 Drone GCS Server started successfully!');