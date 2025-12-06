// ================================================
// DRONE GCS SERVER - FIXED FOR RENDER.COM
// ================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

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

// Serve static files
app.use(express.static(__dirname));

// ============= HEALTH ENDPOINT =============
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        service: 'Drone GCS Server',
        version: '2.0.2',
        timestamp: new Date().toISOString(),
        drones: drones.size,
        uptime: process.uptime()
    });
});

// ============= HOME PAGE =============
app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Drone GCS Control Panel</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: 'Arial', sans-serif;
                margin: 0;
                padding: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                color: white;
            }
            .container {
                max-width: 1200px;
                margin: 0 auto;
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 30px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            }
            .header {
                text-align: center;
                margin-bottom: 30px;
                padding-bottom: 20px;
                border-bottom: 2px solid rgba(255, 255, 255, 0.2);
            }
            .header h1 {
                margin: 0;
                font-size: 2.5em;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
            }
            .header p {
                margin: 10px 0 0 0;
                opacity: 0.8;
            }
            .status-panel {
                background: rgba(0, 0, 0, 0.3);
                border-radius: 15px;
                padding: 25px;
                margin-bottom: 30px;
            }
            .status-panel h2 {
                margin-top: 0;
                color: #fff;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .status-panel h2:before {
                content: '📡';
                font-size: 1.2em;
            }
            #droneStatus {
                background: rgba(0, 0, 0, 0.5);
                padding: 15px;
                border-radius: 10px;
                font-family: monospace;
                font-size: 1.1em;
                border-left: 4px solid #4CAF50;
                margin-top: 10px;
            }
            .controls-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 15px;
                margin: 30px 0;
            }
            .control-btn {
                padding: 18px 15px;
                border: none;
                border-radius: 12px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                color: white;
                box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
            }
            .control-btn:hover {
                transform: translateY(-3px);
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
            }
            .control-btn:active {
                transform: translateY(1px);
            }
            .btn-takeoff { background: linear-gradient(135deg, #4CAF50 0%, #2E7D32 100%); }
            .btn-land { background: linear-gradient(135deg, #f44336 0%, #c62828 100%); }
            .btn-rth { background: linear-gradient(135deg, #2196F3 0%, #0D47A1 100%); }
            .btn-hold { background: linear-gradient(135deg, #FF9800 0%, #EF6C00 100%); }
            .btn-move { background: linear-gradient(135deg, #9C27B0 0%, #6A1B9A 100%); }
            .btn-arm { background: linear-gradient(135deg, #00BCD4 0%, #00838F 100%); }
            .btn-status { background: linear-gradient(135deg, #607D8B 0%, #37474F 100%); }
            .btn-clear { background: linear-gradient(135deg, #795548 0%, #4E342E 100%); }
            .log-container {
                background: rgba(0, 0, 0, 0.7);
                border-radius: 15px;
                padding: 25px;
                margin-top: 30px;
            }
            .log-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 15px;
            }
            .log-header h2 {
                margin: 0;
                color: #fff;
            }
            .log {
                background: rgba(0, 20, 0, 0.9);
                color: #0F0;
                padding: 20px;
                border-radius: 10px;
                font-family: 'Courier New', monospace;
                height: 300px;
                overflow-y: auto;
                font-size: 14px;
                line-height: 1.5;
                border: 1px solid #0F0;
            }
            .log::-webkit-scrollbar {
                width: 10px;
            }
            .log::-webkit-scrollbar-track {
                background: rgba(0, 0, 0, 0.3);
                border-radius: 5px;
            }
            .log::-webkit-scrollbar-thumb {
                background: #4CAF50;
                border-radius: 5px;
            }
            .connection-status {
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 10px 20px;
                border-radius: 20px;
                font-weight: bold;
                background: rgba(0, 0, 0, 0.5);
            }
            .connected { color: #4CAF50; border: 2px solid #4CAF50; }
            .disconnected { color: #f44336; border: 2px solid #f44336; }
            @media (max-width: 768px) {
                .controls-grid {
                    grid-template-columns: repeat(2, 1fr);
                }
                .container {
                    padding: 15px;
                }
            }
        </style>
    </head>
    <body>
        <div class="connection-status disconnected" id="connectionStatus">
            🔴 Disconnected
        </div>
        
        <div class="container">
            <div class="header">
                <h1>🚁 Drone Ground Control Station</h1>
                <p>Real-time control panel for Mini Surveillance Drone</p>
            </div>
            
            <div class="status-panel">
                <h2>Drone Status</h2>
                <div id="droneStatus">Waiting for drone connection...</div>
            </div>
            
            <div class="controls-grid">
                <button class="control-btn btn-takeoff" onclick="sendCommand('takeoff')">
                    🛫 Takeoff
                </button>
                <button class="control-btn btn-land" onclick="sendCommand('land')">
                    🛬 Land
                </button>
                <button class="control-btn btn-rth" onclick="sendCommand('rth')">
                    🏠 Return Home
                </button>
                <button class="control-btn btn-hold" onclick="sendCommand('hold')">
                    ✋ Hold Position
                </button>
                <button class="control-btn btn-move" onclick="sendCommand('forward')">
                    ⬆️ Forward
                </button>
                <button class="control-btn btn-move" onclick="sendCommand('backward')">
                    ⬇️ Backward
                </button>
                <button class="control-btn btn-move" onclick="sendCommand('left')">
                    ⬅️ Left
                </button>
                <button class="control-btn btn-move" onclick="sendCommand('right')">
                    ➡️ Right
                </button>
                <button class="control-btn btn-move" onclick="sendCommand('up')">
                    ⬆️ Up
                </button>
                <button class="control-btn btn-move" onclick="sendCommand('down')">
                    ⬇️ Down
                </button>
                <button class="control-btn btn-arm" onclick="sendCommand('arm')">
                    ⚡ Arm Motors
                </button>
                <button class="control-btn btn-arm" onclick="sendCommand('disarm')">
                    🔓 Disarm
                </button>
                <button class="control-btn btn-status" onclick="sendCommand('status')">
                    📊 Get Status
                </button>
                <button class="control-btn btn-clear" onclick="clearLog()">
                    🗑️ Clear Log
                </button>
            </div>
            
            <div class="log-container">
                <div class="log-header">
                    <h2>📋 System Log</h2>
                    <div id="logCount">Messages: 0</div>
                </div>
                <div class="log" id="log"></div>
            </div>
        </div>
        
        <script>
            let socket = null;
            let reconnectAttempts = 0;
            const maxReconnectAttempts = 10;
            let messageCount = 0;
            
            // DOM Elements
            const logElement = document.getElementById('log');
            const connectionStatus = document.getElementById('connectionStatus');
            const droneStatusElement = document.getElementById('droneStatus');
            const logCountElement = document.getElementById('logCount');
            
            function connectWebSocket() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = protocol + '//' + window.location.host;
                
                socket = new WebSocket(wsUrl);
                
                socket.onopen = function() {
                    console.log('✅ WebSocket connected');
                    logMessage('Connected to GCS Server', 'success');
                    updateConnectionStatus('connected');
                    reconnectAttempts = 0;
                };
                
                socket.onmessage = function(event) {
                    try {
                        const data = JSON.parse(event.data);
                        handleWebSocketMessage(data);
                    } catch (error) {
                        logMessage('Error parsing message: ' + error, 'error');
                    }
                };
                
                socket.onclose = function(event) {
                    console.log('❌ WebSocket disconnected:', event.code, event.reason);
                    logMessage('Disconnected from server', 'error');
                    updateConnectionStatus('disconnected');
                    
                    if (reconnectAttempts < maxReconnectAttempts) {
                        reconnectAttempts++;
                        const delay = Math.min(1000 * reconnectAttempts, 10000);
                        logMessage('Reconnecting in ' + (delay/1000) + ' seconds...', 'warning');
                        
                        setTimeout(connectWebSocket, delay);
                    } else {
                        logMessage('Max reconnection attempts reached. Please refresh the page.', 'error');
                    }
                };
                
                socket.onerror = function(error) {
                    console.error('WebSocket error:', error);
                    logMessage('Connection error occurred', 'error');
                };
            }
            
            function handleWebSocketMessage(data) {
                switch(data.type) {
                    case 'init':
                        logMessage('System initialized. Connected drones: ' + (data.drones ? data.drones.length : 0), 'success');
                        updateDroneStatus('Ready - Waiting for commands');
                        break;
                        
                    case 'drone_connected':
                        logMessage('🚁 Drone connected: ' + data.droneId, 'success');
                        updateDroneStatus('Drone ' + data.droneId + ' connected and ready');
                        break;
                        
                    case 'command_queued':
                        logMessage('Command queued: ' + data.command, 'info');
                        break;
                        
                    case 'command_sent':
                        logMessage('📤 Command sent to drone: ' + data.command, 'info');
                        break;
                        
                    case 'command_ack':
                        logMessage('✅ Drone executed: ' + data.command + ' (Status: ' + data.status + ')', 'success');
                        updateDroneStatus('Last command: ' + data.command + ' - ' + data.status);
                        break;
                        
                    case 'drone_disconnected':
                        logMessage('⚠️ Drone disconnected: ' + data.droneId, 'warning');
                        updateDroneStatus('Drone disconnected - Waiting for reconnection...');
                        break;
                        
                    default:
                        console.log('Unknown message type:', data.type);
                }
            }
            
            function sendCommand(command) {
                if (!socket || socket.readyState !== WebSocket.OPEN) {
                    logMessage('Not connected to server. Please wait...', 'error');
                    return;
                }
                
                const message = {
                    type: 'command',
                    droneId: 'MINI_SURV_001',
                    command: command,
                    timestamp: Date.now()
                };
                
                socket.send(JSON.stringify(message));
                logMessage('Sending command: ' + command, 'info');
            }
            
            function logMessage(message, type = 'info') {
                const time = new Date().toLocaleTimeString();
                const typeEmoji = {
                    'success': '✅',
                    'error': '❌',
                    'warning': '⚠️',
                    'info': '📝'
                }[type] || '📝';
                
                const messageElement = document.createElement('div');
                messageElement.innerHTML = '[' + time + '] ' + typeEmoji + ' ' + message;
                messageElement.style.color = {
                    'success': '#4CAF50',
                    'error': '#f44336',
                    'warning': '#FF9800',
                    'info': '#2196F3'
                }[type] || '#FFFFFF';
                
                logElement.appendChild(messageElement);
                messageCount++;
                logCountElement.textContent = 'Messages: ' + messageCount;
                
                // Auto-scroll to bottom
                logElement.scrollTop = logElement.scrollHeight;
            }
            
            function clearLog() {
                logElement.innerHTML = '';
                messageCount = 0;
                logCountElement.textContent = 'Messages: 0';
                logMessage('Log cleared', 'info');
            }
            
            function updateConnectionStatus(status) {
                connectionStatus.textContent = status === 'connected' ? '🟢 Connected' : '🔴 Disconnected';
                connectionStatus.className = 'connection-status ' + status;
            }
            
            function updateDroneStatus(message) {
                droneStatusElement.textContent = message;
                
                // Visual feedback
                droneStatusElement.style.animation = 'none';
                setTimeout(() => {
                    droneStatusElement.style.animation = 'pulse 0.5s';
                }, 10);
            }
            
            // Add CSS animation
            const style = document.createElement('style');
            style.textContent = '
                @keyframes pulse {
                    0% { opacity: 1; }
                    50% { opacity: 0.7; }
                    100% { opacity: 1; }
                }
            ';
            document.head.appendChild(style);
            
            // Initialize connection
            connectWebSocket();
            
            // Keep connection alive
            setInterval(() => {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
                }
            }, 30000);
            
            // Keyboard shortcuts
            document.addEventListener('keydown', function(event) {
                switch(event.key.toLowerCase()) {
                    case 't': sendCommand('takeoff'); break;
                    case 'l': sendCommand('land'); break;
                    case 'h': sendCommand('hold'); break;
                    case 'r': sendCommand('rth'); break;
                    case 'w': sendCommand('forward'); break;
                    case 's': sendCommand('backward'); break;
                    case 'a': sendCommand('left'); break;
                    case 'd': sendCommand('right'); break;
                    case 'q': sendCommand('up'); break;
                    case 'e': sendCommand('down'); break;
                    case ' ': sendCommand('arm'); break;
                }
            });
            
            // Show keyboard shortcuts
            logMessage('Keyboard shortcuts: T=Takeoff, L=Land, H=Hold, R=RTH, W=Forward, S=Backward, A=Left, D=Right, Q=Up, E=Down, Space=Arm', 'info');
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// ============= API ENDPOINTS =============

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
        battery: 85,
        mode: 'idle'
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
            battery: battery || 85,
            mode: 'idle'
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
        if (status) drone.status = status;
        if (battery) drone.battery = battery;
    }
    
    // Check for pending commands
    const queue = commandQueues.get(droneId) || [];
    
    if (queue.length > 0) {
        const command = queue.shift();
        commandQueues.set(droneId, queue);
        
        console.log(`📤 Sending command to ${droneId}: ${command}`);
        
        // Notify web clients
        broadcastToWebClients({
            type: 'command_sent',
            droneId,
            command,
            timestamp: Date.now()
        });
        
        res.json({
            command: command,
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
    
    broadcastToWebClients({
        type: 'broadcast_command',
        command,
        timestamp: Date.now()
    });
    
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
        mode: data.mode,
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
    const droneList = Array.from(drones.values()).map(d => ({
        id: d.id,
        status: d.status,
        battery: d.battery,
        mode: d.mode
    }));
    
    ws.send(JSON.stringify({
        type: 'init',
        clientId,
        drones: droneList,
        timestamp: Date.now()
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            if (data.type === 'command') {
                const droneId = data.droneId || 'MINI_SURV_001';
                const command = data.command;
                
                if (!command) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Command is required'
                    }));
                    return;
                }
                
                // Initialize queue if not exists
                if (!commandQueues.has(droneId)) {
                    commandQueues.set(droneId, []);
                }
                
                // Add command to queue
                commandQueues.get(droneId).push(command);
                
                console.log(`🎯 Command from ${clientId}: ${command} to ${droneId}`);
                
                // Send confirmation to sender
                ws.send(JSON.stringify({
                    type: 'command_queued',
                    command,
                    droneId,
                    timestamp: Date.now()
                }));
                
                // Notify all clients
                broadcastToWebClients({
                    type: 'command_sent',
                    droneId,
                    command,
                    clientId,
                    timestamp: Date.now()
                }, ws);
            } else if (data.type === 'ping') {
                // Keep connection alive
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: Date.now()
                }));
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
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
    const timeout = 60000; // 1 minute timeout
    
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
}, 30000);

// ============= START SERVER =============
server.listen(PORT, HOST, () => {
    console.log('🚀 Drone GCS Server started successfully!');
    console.log(`🌐 Web server: http://${HOST}:${PORT}`);
    console.log(`📡 WebSocket: ws://${HOST}:${PORT}`);
    console.log('✅ Ready for connections');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down...');
    
    // Close all WebSocket connections
    webClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1001, 'Server shutting down');
        }
    });
    
    server.close(() => {
        console.log('✅ Server shutdown complete');
        process.exit(0);
    });
});