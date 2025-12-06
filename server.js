// ================================================
// DRONE GCS SERVER - FIXED FOR RENDER.COM
// ================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

// ============= CONFIGURATION =============
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

// ============= GLOBAL STATE =============
const drones = new Map();
const commandQueues = new Map();
const webClients = new Set();

// ============= EXPRESS SETUP =============
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from current directory
app.use(express.static(__dirname));

// ============= HEALTH ENDPOINT (REQUIRED BY RENDER) =============
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        service: 'Drone GCS Server',
        version: '2.0.1',
        timestamp: new Date().toISOString(),
        drones: drones.size,
        uptime: process.uptime()
    });
});

// ============= API ENDPOINTS =============

// Home page
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Drone GCS Control Panel</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #0f172a; color: white; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { text-align: center; padding: 20px; background: #1e293b; border-radius: 10px; }
            .controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 20px 0; }
            button { padding: 15px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
            .primary { background: #3b82f6; color: white; }
            .danger { background: #ef4444; color: white; }
            .success { background: #10b981; color: white; }
            .warning { background: #f59e0b; color: white; }
            .status-panel { background: #1e293b; padding: 20px; border-radius: 10px; margin-top: 20px; }
            .log { background: #000; color: #0f0; padding: 15px; border-radius: 5px; font-family: monospace; height: 200px; overflow-y: auto; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🚁 Drone GCS Control Panel</h1>
                <p>Connected to: ${req.protocol}://${req.get('host')}</p>
            </div>
            
            <div class="status-panel">
                <h2>Drone Status</h2>
                <div id="droneStatus">Loading...</div>
            </div>
            
            <div class="controls">
                <button class="primary" onclick="sendCommand('takeoff')">🛫 Takeoff</button>
                <button class="danger" onclick="sendCommand('land')">🛬 Land</button>
                <button class="success" onclick="sendCommand('rth')">🏠 RTH</button>
                <button class="warning" onclick="sendCommand('hold')">✋ Hold</button>
                <button onclick="sendCommand('forward')">⬆️ Forward</button>
                <button onclick="sendCommand('backward')">⬇️ Backward</button>
                <button onclick="sendCommand('left')">⬅️ Left</button>
                <button onclick="sendCommand('right')">➡️ Right</button>
                <button onclick="sendCommand('up')">⬆️ Up</button>
                <button onclick="sendCommand('down')">⬇️ Down</button>
                <button onclick="sendCommand('arm')">⚡ Arm</button>
                <button onclick="sendCommand('disarm')">🔓 Disarm</button>
                <button onclick="sendCommand('status')">📊 Status</button>
                <button onclick="clearLog()">🗑️ Clear Log</button>
            </div>
            
            <div class="status-panel">
                <h2>System Log</h2>
                <div class="log" id="log"></div>
            </div>
        </div>
        
        <script>
            const socket = new WebSocket('wss://' + window.location.host);
            const logElement = document.getElementById('log');
            
            function log(msg) {
                const time = new Date().toLocaleTimeString();
                logElement.innerHTML += `[${time}] ${msg}\\n`;
                logElement.scrollTop = logElement.scrollHeight;
            }
            
            function clearLog() {
                logElement.innerHTML = '';
            }
            
            socket.onopen = () => {
                log('✅ Connected to GCS Server');
                updateDroneStatus('Connected, waiting for drone...');
            };
            
            socket.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    switch(data.type) {
                        case 'init':
                            updateDroneStatus('System initialized');
                            break;
                        case 'drone_connected':
                            log(`🚁 Drone connected: ${data.droneId}`);
                            updateDroneStatus(`Drone ${data.droneId} connected`);
                            break;
                        case 'command_ack':
                            log(`✅ ${data.droneId}: ${data.command} - ${data.status}`);
                            break;
                        case 'command_sent':
                            log(`📤 Command sent: ${data.command} to ${data.droneId}`);
                            break;
                        case 'drone_disconnected':
                            log(`❌ Drone disconnected: ${data.droneId}`);
                            updateDroneStatus('Drone disconnected');
                            break;
                    }
                } catch(e) {
                    log('Error parsing message: ' + event.data);
                }
            };
            
            socket.onclose = () => {
                log('❌ Disconnected from server');
                updateDroneStatus('Disconnected');
            };
            
            function sendCommand(cmd) {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        type: 'command',
                        droneId: 'MINI_SURV_001',
                        command: cmd
                    }));
                    log(`📤 Sending: ${cmd}`);
                } else {
                    log('❌ Not connected to server');
                }
            }
            
            function updateDroneStatus(msg) {
                document.getElementById('droneStatus').innerHTML = msg;
            }
            
            // Auto-reconnect
            setInterval(() => {
                if (socket.readyState === WebSocket.CLOSED) {
                    log('🔄 Attempting to reconnect...');
                    window.location.reload();
                }
            }, 5000);
        </script>
    </body>
    </html>
    `);
});

// ============= DRONE POLLING ENDPOINTS =============

// Register drone
app.post('/api/drone/register', (req, res) => {
    const { drone_id, ip_address } = req.body;
    
    if (!drone_id) {
        return res.status(400).json({ error: 'drone_id required' });
    }
    
    drones.set(drone_id, {
        id: drone_id,
        ip: ip_address || req.ip,
        status: 'connected',
        lastSeen: Date.now(),
        battery: 85
    });
    
    commandQueues.set(drone_id, []);
    
    console.log(`🚁 Drone registered: ${drone_id} from ${req.ip}`);
    
    broadcastToWebClients({
        type: 'drone_connected',
        droneId: drone_id,
        timestamp: Date.now()
    });
    
    res.json({
        success: true,
        drone_id,
        message: 'Registered successfully'
    });
});

// Poll for commands (ESP32 calls this)
app.post('/api/drone/poll/:droneId', (req, res) => {
    const droneId = req.params.droneId;
    const { battery, status } = req.body;
    
    // Update drone status
    if (!drones.has(droneId)) {
        drones.set(droneId, {
            id: droneId,
            ip: req.ip,
            status: status || 'connected',
            lastSeen: Date.now(),
            battery: battery || 85
        });
        commandQueues.set(droneId, []);
        
        console.log(`🚁 New drone registered via poll: ${droneId}`);
        
        broadcastToWebClients({
            type: 'drone_connected',
            droneId,
            timestamp: Date.now()
        });
    } else {
        const drone = drones.get(droneId);
        drone.lastSeen = Date.now();
        drone.status = status || drone.status;
        drone.battery = battery || drone.battery;
    }
    
    // Check for pending commands
    const queue = commandQueues.get(droneId) || [];
    
    if (queue.length > 0) {
        const command = queue.shift();
        commandQueues.set(droneId, queue);
        
        console.log(`📤 Sending command to ${droneId}: ${command}`);
        
        res.json({
            command: command,
            timestamp: Date.now()
        });
        
        broadcastToWebClients({
            type: 'command_sent',
            droneId,
            command,
            timestamp: Date.now()
        });
    } else {
        res.json({ command: 'no_command' });
    }
});

// Acknowledge command (ESP32 calls this)
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

// Send command to all drones
app.post('/api/command/all', (req, res) => {
    const { command } = req.body;
    
    if (!command) {
        return res.status(400).json({ error: 'command required' });
    }
    
    // Add to all drone queues
    drones.forEach((drone, droneId) => {
        if (!commandQueues.has(droneId)) {
            commandQueues.set(droneId, []);
        }
        commandQueues.get(droneId).push(command);
    });
    
    console.log(`📤 Broadcast command: ${command} to ${drones.size} drones`);
    
    res.json({
        success: true,
        command,
        drones: drones.size
    });
});

// Get all drones
app.get('/api/drones', (req, res) => {
    const droneList = Array.from(drones.entries()).map(([id, data]) => ({
        id,
        ip: data.ip,
        status: data.status,
        battery: data.battery,
        lastSeen: data.lastSeen
    }));
    
    res.json(droneList);
});

// ============= WEB SOCKET HANDLER =============
wss.on('connection', (ws) => {
    const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    webClients.add(ws);
    
    console.log(`📱 Web client connected: ${clientId}`);
    
    // Send initial state
    ws.send(JSON.stringify({
        type: 'init',
        clientId,
        drones: Array.from(drones.values()).map(d => ({
            id: d.id,
            status: d.status,
            battery: d.battery
        })),
        timestamp: Date.now()
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'command') {
                const { droneId = 'MINI_SURV_001', command } = data;
                
                // Queue the command
                if (!commandQueues.has(droneId)) {
                    commandQueues.set(droneId, []);
                }
                commandQueues.get(droneId).push(command);
                
                console.log(`🎯 Web command from ${clientId}: ${command} to ${droneId}`);
                
                // Notify sender
                ws.send(JSON.stringify({
                    type: 'command_queued',
                    command,
                    droneId,
                    timestamp: Date.now()
                }));
                
                // Broadcast to other clients
                broadcastToWebClients({
                    type: 'command_sent',
                    droneId,
                    command,
                    clientId,
                    timestamp: Date.now()
                }, ws);
            }
        } catch (error) {
            console.error('WebSocket error:', error);
        }
    });
    
    ws.on('close', () => {
        webClients.delete(ws);
        console.log(`📱 Web client disconnected: ${clientId}`);
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${clientId}:`, error);
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

// ============= CLEANUP OLD DRONES =============
setInterval(() => {
    const now = Date.now();
    const timeout = 60000; // 1 minute
    
    drones.forEach((drone, droneId) => {
        if (now - drone.lastSeen > timeout) {
            drones.delete(droneId);
            commandQueues.delete(droneId);
            
            console.log(`🕒 Removing inactive drone: ${droneId}`);
            
            broadcastToWebClients({
                type: 'drone_disconnected',
                droneId,
                timestamp: now
            });
        }
    });
}, 30000); // Check every 30 seconds

// ============= START SERVER =============
server.listen(PORT, HOST, () => {
    console.log(`🌐 Web server running on http://${HOST}:${PORT}`);
    console.log(`📡 WebSocket server ready on port ${PORT}`);
    console.log(`✅ Server ready for Render deployment`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});