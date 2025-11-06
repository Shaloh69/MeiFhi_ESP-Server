/*
 * ESP32 Electrical Safety Monitor - Node.js Server
 * Version: 2.0 - Enhanced with Admin Controls
 * 
 * Features:
 * - Real-time data reception from ESP32
 * - WebSocket communication for live updates
 * - REST API for data access
 * - Web dashboard with real-time charts
 * - Data logging and storage
 * - Command sending to ESP32
 * - Multiple ESP32 device support
 * - ADMIN CONTROLS: Full ESP32 remote control
 * - Mock data generator for testing without hardware
 * - Command history and logging
 * - Authentication support
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

// Configuration
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'sensor_log.json');
const COMMAND_LOG_FILE = path.join(DATA_DIR, 'command_log.json');

// Simple authentication (in production, use proper auth)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Simple auth middleware
function basicAuth(req, res, next) {
  const auth = req.headers.authorization;
  
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const [username, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    next();
  } else {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
}

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('✓ Created data directory');
}

// Initialize log file if it doesn't exist
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, JSON.stringify({ sessions: [], readings: [] }, null, 2));
  console.log('✓ Initialized log file');
}

// Initialize command log file
if (!fs.existsSync(COMMAND_LOG_FILE)) {
  fs.writeFileSync(COMMAND_LOG_FILE, JSON.stringify({ commands: [] }, null, 2));
  console.log('✓ Initialized command log file');
}

// In-memory storage for active devices
const activeDevices = new Map();
const realtimeData = new Map();
const deviceConfigs = new Map(); // Store device configurations

// Helper: Load data from file
function loadData() {
  try {
    const data = fs.readFileSync(LOG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading data:', error);
    return { sessions: [], readings: [] };
  }
}

// Helper: Save data to file
function saveData(data) {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving data:', error);
    return false;
  }
}

// Helper: Load command log
function loadCommandLog() {
  try {
    const data = fs.readFileSync(COMMAND_LOG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading command log:', error);
    return { commands: [] };
  }
}

// Helper: Save command log
function saveCommandLog(data) {
  try {
    fs.writeFileSync(COMMAND_LOG_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving command log:', error);
    return false;
  }
}

// Helper: Log command
function logCommand(deviceId, command, source, success = true) {
  const commandLog = loadCommandLog();
  
  const entry = {
    deviceId,
    command,
    source, // 'api', 'admin', 'websocket'
    success,
    timestamp: new Date().toISOString()
  };
  
  commandLog.commands.push(entry);
  
  // Keep only last 1000 commands
  if (commandLog.commands.length > 1000) {
    commandLog.commands = commandLog.commands.slice(-1000);
  }
  
  saveCommandLog(commandLog);
  return entry;
}

// Helper: Add reading to storage
function addReading(deviceId, reading) {
  const data = loadData();
  
  const entry = {
    deviceId,
    timestamp: new Date().toISOString(),
    ...reading
  };
  
  data.readings.push(entry);
  
  // Keep only last 10000 readings
  if (data.readings.length > 10000) {
    data.readings = data.readings.slice(-10000);
  }
  
  saveData(data);
  return entry;
}

// Helper: Create session record
function createSession(deviceId, ip) {
  const data = loadData();
  
  const session = {
    deviceId,
    ip,
    startTime: new Date().toISOString(),
    endTime: null,
    active: true
  };
  
  data.sessions.push(session);
  saveData(data);
  
  return session;
}

// Helper: End session
function endSession(deviceId) {
  const data = loadData();
  
  const sessions = data.sessions.filter(s => s.deviceId === deviceId && s.active);
  sessions.forEach(session => {
    session.endTime = new Date().toISOString();
    session.active = false;
  });
  
  saveData(data);
}

// ==================== MOCK DATA GENERATOR (FOR TESTING) ====================

// Generate realistic mock sensor data
function generateMockData() {
  const baseVoltage = 220 + (Math.random() - 0.5) * 10; // 215-225V
  const baseCurrent = 0.5 + Math.random() * 2; // 0.5-2.5A
  const powerFactor = 0.95;
  
  return {
    voltage: parseFloat(baseVoltage.toFixed(1)),
    current: parseFloat(baseCurrent.toFixed(3)),
    power: parseFloat((baseVoltage * baseCurrent * powerFactor).toFixed(1)),
    energy: parseFloat((Math.random() * 100).toFixed(3)),
    ssrState: Math.random() > 0.1, // 90% on, 10% off
    state: 'MONITOR',
    sensors: 'valid'
  };
}

// POST endpoint to generate mock data (for testing without ESP32)
app.post('/api/mock/data/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const count = parseInt(req.query.count) || 1;
  
  const readings = [];
  
  for (let i = 0; i < count; i++) {
    const mockData = generateMockData();
    
    // Register device if new
    if (!activeDevices.has(deviceId)) {
      activeDevices.set(deviceId, {
        ip: req.ip || 'mock',
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        isMock: true
      });
      createSession(deviceId, 'mock');
    } else {
      const device = activeDevices.get(deviceId);
      device.lastSeen = new Date().toISOString();
    }
    
    const entry = addReading(deviceId, mockData);
    
    // Update realtime data
    realtimeData.set(deviceId, {
      ...mockData,
      timestamp: entry.timestamp
    });
    
    // Broadcast to all connected web clients
    io.emit('sensorData', {
      deviceId,
      ...mockData,
      timestamp: entry.timestamp
    });
    
    readings.push(entry);
  }
  
  res.json({
    success: true,
    message: `Generated ${count} mock reading(s)`,
    readings: readings
  });
});

// ==================== REST API ENDPOINTS ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeDevices: activeDevices.size,
    version: '2.0'
  });
});

// Get all active devices
app.get('/api/devices', (req, res) => {
  const devices = Array.from(activeDevices.entries()).map(([id, device]) => ({
    deviceId: id,
    ...device,
    lastSeen: realtimeData.get(id)?.timestamp || null,
    currentData: realtimeData.get(id) || null,
    config: deviceConfigs.get(id) || null
  }));
  
  res.json(devices);
});

// Get device info
app.get('/api/devices/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const device = activeDevices.get(deviceId);
  
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  res.json({
    deviceId,
    ...device,
    currentData: realtimeData.get(deviceId),
    config: deviceConfigs.get(deviceId) || null
  });
});

// Get latest readings for a device
app.get('/api/devices/:deviceId/readings', (req, res) => {
  const { deviceId } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  
  const data = loadData();
  const readings = data.readings
    .filter(r => r.deviceId === deviceId)
    .slice(-limit);
  
  res.json(readings);
});

// Get all readings (with pagination)
app.get('/api/readings', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const deviceId = req.query.deviceId;
  
  const data = loadData();
  let readings = data.readings;
  
  if (deviceId) {
    readings = readings.filter(r => r.deviceId === deviceId);
  }
  
  const total = readings.length;
  const paginatedReadings = readings.slice(offset, offset + limit);
  
  res.json({
    total,
    offset,
    limit,
    readings: paginatedReadings
  });
});

// Get sessions
app.get('/api/sessions', (req, res) => {
  const data = loadData();
  const deviceId = req.query.deviceId;
  
  let sessions = data.sessions;
  
  if (deviceId) {
    sessions = sessions.filter(s => s.deviceId === deviceId);
  }
  
  res.json(sessions);
});

// Get statistics
app.get('/api/stats', (req, res) => {
  const deviceId = req.query.deviceId;
  const data = loadData();
  
  let readings = data.readings;
  if (deviceId) {
    readings = readings.filter(r => r.deviceId === deviceId);
  }
  
  if (readings.length === 0) {
    return res.json({ error: 'No data available' });
  }
  
  const voltages = readings.map(r => r.voltage).filter(v => v != null);
  const currents = readings.map(r => r.current).filter(c => c != null);
  const powers = readings.map(r => r.power).filter(p => p != null);
  
  const stats = {
    totalReadings: readings.length,
    voltage: {
      min: Math.min(...voltages),
      max: Math.max(...voltages),
      avg: voltages.reduce((a, b) => a + b, 0) / voltages.length
    },
    current: {
      min: Math.min(...currents),
      max: Math.max(...currents),
      avg: currents.reduce((a, b) => a + b, 0) / currents.length
    },
    power: {
      min: Math.min(...powers),
      max: Math.max(...powers),
      avg: powers.reduce((a, b) => a + b, 0) / powers.length,
      total: powers.reduce((a, b) => a + b, 0)
    }
  };
  
  res.json(stats);
});

// ==================== ESP32 DATA ENDPOINT ====================

// POST endpoint for ESP32 to send data
app.post('/api/data', (req, res) => {
  const {
    deviceId,
    voltage,
    current,
    power,
    energy,
    ssrState,
    state,
    sensors
  } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Device ID required' });
  }
  
  // Register device if new
  if (!activeDevices.has(deviceId)) {
    const ip = req.ip || req.connection.remoteAddress;
    activeDevices.set(deviceId, {
      ip,
      connectedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      isMock: false
    });
    
    createSession(deviceId, ip);
    console.log(`✓ New device connected: ${deviceId} from ${ip}`);
  } else {
    // Update last seen
    const device = activeDevices.get(deviceId);
    device.lastSeen = new Date().toISOString();
  }
  
  // Store reading
  const reading = {
    voltage: parseFloat(voltage),
    current: parseFloat(current),
    power: parseFloat(power),
    energy: parseFloat(energy),
    ssrState: ssrState === 'true' || ssrState === true || ssrState === 1,
    state: state || 'unknown',
    sensors: sensors || 'unknown'
  };
  
  const entry = addReading(deviceId, reading);
  
  // Update realtime data
  realtimeData.set(deviceId, {
    ...reading,
    timestamp: entry.timestamp
  });
  
  // Broadcast to all connected web clients
  io.emit('sensorData', {
    deviceId,
    ...reading,
    timestamp: entry.timestamp
  });
  
  res.json({
    success: true,
    timestamp: entry.timestamp,
    message: 'Data received'
  });
});

// ==================== ADMIN CONTROL ENDPOINTS ====================

// Get command history
app.get('/api/admin/commands', basicAuth, (req, res) => {
  const deviceId = req.query.deviceId;
  const limit = parseInt(req.query.limit) || 100;
  
  const commandLog = loadCommandLog();
  let commands = commandLog.commands;
  
  if (deviceId) {
    commands = commands.filter(c => c.deviceId === deviceId);
  }
  
  res.json({
    total: commands.length,
    commands: commands.slice(-limit)
  });
});

// Get available commands
app.get('/api/admin/commands/available', (req, res) => {
  res.json({
    commands: [
      {
        name: 'on',
        description: 'Turn SSR ON (normal operation)',
        category: 'SSR Control',
        parameters: null
      },
      {
        name: 'off',
        description: 'Turn SSR OFF (manual disable)',
        category: 'SSR Control',
        parameters: null
      },
      {
        name: 'enable',
        description: 'Enable SSR (alias for on)',
        category: 'SSR Control',
        parameters: null
      },
      {
        name: 'disable',
        description: 'Disable SSR (alias for off)',
        category: 'SSR Control',
        parameters: null
      },
      {
        name: 'reset',
        description: 'Emergency reset system',
        category: 'System Control',
        parameters: null
      },
      {
        name: 'restart',
        description: 'Restart ESP32',
        category: 'System Control',
        parameters: null
      },
      {
        name: 'calibrate',
        description: 'Start manual calibration',
        category: 'Calibration',
        parameters: null
      },
      {
        name: 'cal_voltage',
        description: 'Start voltage calibration wizard',
        category: 'Calibration',
        parameters: null
      },
      {
        name: 'voltage_cal',
        description: 'Set voltage calibration factor',
        category: 'Calibration',
        parameters: 'number (0.01-1000)'
      },
      {
        name: 'current_cal',
        description: 'Set current calibration factor',
        category: 'Calibration',
        parameters: 'number (0.001-100)'
      },
      {
        name: 'power_factor',
        description: 'Set power factor',
        category: 'Settings',
        parameters: 'number (0.1-1.0)'
      },
      {
        name: 'status',
        description: 'Get current status',
        category: 'Information',
        parameters: null
      },
      {
        name: 'test',
        description: 'Test sensors',
        category: 'Diagnostics',
        parameters: null
      },
      {
        name: 'diag',
        description: 'Full diagnostics',
        category: 'Diagnostics',
        parameters: null
      },
      {
        name: 'diagnostics',
        description: 'Full diagnostics (alias)',
        category: 'Diagnostics',
        parameters: null
      },
      {
        name: 'mem',
        description: 'Memory usage',
        category: 'Diagnostics',
        parameters: null
      },
      {
        name: 'memory',
        description: 'Memory usage (alias)',
        category: 'Diagnostics',
        parameters: null
      },
      {
        name: 'stats',
        description: 'Show statistics',
        category: 'Information',
        parameters: null
      },
      {
        name: 'manual',
        description: 'Toggle manual mode',
        category: 'Settings',
        parameters: null
      },
      {
        name: 'safety',
        description: 'Toggle safety checks',
        category: 'Settings',
        parameters: null
      },
      {
        name: 'buzzer',
        description: 'Toggle buzzer',
        category: 'Settings',
        parameters: null
      },
      {
        name: 'clear',
        description: 'Clear statistics',
        category: 'Settings',
        parameters: null
      },
      {
        name: 'help',
        description: 'Show command menu',
        category: 'Information',
        parameters: null
      }
    ]
  });
});

// Send command to specific device (with auth)
app.post('/api/admin/command/:deviceId', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  const { command, parameters } = req.body;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }
  
  // Build full command with parameters if provided
  let fullCommand = command;
  if (parameters) {
    fullCommand = `${command} ${parameters}`;
  }
  
  // Log command
  logCommand(deviceId, fullCommand, 'admin', true);
  
  // Emit command to specific device
  io.emit('command', { deviceId, command: fullCommand });
  
  console.log(`→ Admin command sent to ${deviceId}: ${fullCommand}`);
  
  res.json({
    success: true,
    deviceId,
    command: fullCommand,
    timestamp: new Date().toISOString()
  });
});

// SSR Control - Turn ON
app.post('/api/admin/ssr/:deviceId/on', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const command = 'on';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`→ Admin SSR ON: ${deviceId}`);
  
  res.json({
    success: true,
    deviceId,
    action: 'SSR turned ON',
    timestamp: new Date().toISOString()
  });
});

// SSR Control - Turn OFF
app.post('/api/admin/ssr/:deviceId/off', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const command = 'off';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`→ Admin SSR OFF: ${deviceId}`);
  
  res.json({
    success: true,
    deviceId,
    action: 'SSR turned OFF',
    timestamp: new Date().toISOString()
  });
});

// System Control - Reset
app.post('/api/admin/system/:deviceId/reset', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const command = 'reset';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`→ Admin RESET: ${deviceId}`);
  
  res.json({
    success: true,
    deviceId,
    action: 'System reset initiated',
    timestamp: new Date().toISOString()
  });
});

// System Control - Restart
app.post('/api/admin/system/:deviceId/restart', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const command = 'restart';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`→ Admin RESTART: ${deviceId}`);
  
  res.json({
    success: true,
    deviceId,
    action: 'ESP32 restart initiated',
    timestamp: new Date().toISOString()
  });
});

// Calibration Control
app.post('/api/admin/calibration/:deviceId/start', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const command = 'calibrate';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`→ Admin CALIBRATE: ${deviceId}`);
  
  res.json({
    success: true,
    deviceId,
    action: 'Calibration started',
    timestamp: new Date().toISOString()
  });
});

// Set Configuration
app.post('/api/admin/config/:deviceId', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  const { parameter, value } = req.body;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  if (!parameter || value === undefined) {
    return res.status(400).json({ error: 'Parameter and value required' });
  }
  
  // Valid parameters
  const validParams = ['power_factor', 'voltage_cal', 'current_cal'];
  
  if (!validParams.includes(parameter)) {
    return res.status(400).json({ 
      error: 'Invalid parameter',
      validParameters: validParams
    });
  }
  
  const command = `${parameter} ${value}`;
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  // Store in device config
  if (!deviceConfigs.has(deviceId)) {
    deviceConfigs.set(deviceId, {});
  }
  const config = deviceConfigs.get(deviceId);
  config[parameter] = value;
  config.lastUpdated = new Date().toISOString();
  
  console.log(`→ Admin CONFIG: ${deviceId} - ${parameter} = ${value}`);
  
  res.json({
    success: true,
    deviceId,
    parameter,
    value,
    timestamp: new Date().toISOString()
  });
});

// Toggle Settings
app.post('/api/admin/toggle/:deviceId/:setting', basicAuth, (req, res) => {
  const { deviceId, setting } = req.params;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const validSettings = ['manual', 'safety', 'buzzer'];
  
  if (!validSettings.includes(setting)) {
    return res.status(400).json({ 
      error: 'Invalid setting',
      validSettings: validSettings
    });
  }
  
  const command = setting;
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`→ Admin TOGGLE ${setting.toUpperCase()}: ${deviceId}`);
  
  res.json({
    success: true,
    deviceId,
    setting,
    action: `${setting} toggled`,
    timestamp: new Date().toISOString()
  });
});

// Get Device Diagnostics
app.get('/api/admin/diagnostics/:deviceId', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const command = 'diag';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  res.json({
    success: true,
    deviceId,
    message: 'Diagnostics requested - check device serial output',
    timestamp: new Date().toISOString()
  });
});

// Batch command (send to multiple devices)
app.post('/api/admin/command/batch', basicAuth, (req, res) => {
  const { deviceIds, command, parameters } = req.body;
  
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return res.status(400).json({ error: 'deviceIds array required' });
  }
  
  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }
  
  const fullCommand = parameters ? `${command} ${parameters}` : command;
  const results = [];
  
  deviceIds.forEach(deviceId => {
    if (activeDevices.has(deviceId)) {
      logCommand(deviceId, fullCommand, 'admin', true);
      io.emit('command', { deviceId, command: fullCommand });
      results.push({ deviceId, success: true });
    } else {
      results.push({ deviceId, success: false, error: 'Device not found' });
    }
  });
  
  console.log(`→ Admin BATCH command to ${deviceIds.length} devices: ${fullCommand}`);
  
  res.json({
    success: true,
    command: fullCommand,
    results,
    timestamp: new Date().toISOString()
  });
});

// ==================== WEBSOCKET HANDLING ====================

io.on('connection', (socket) => {
  console.log('✓ Web client connected:', socket.id);
  
  // Send current active devices and latest data
  socket.emit('activeDevices', Array.from(activeDevices.keys()));
  
  realtimeData.forEach((data, deviceId) => {
    socket.emit('sensorData', { deviceId, ...data });
  });
  
  socket.on('disconnect', () => {
    console.log('✗ Web client disconnected:', socket.id);
  });
  
  // Handle command from web client
  socket.on('sendCommand', ({ deviceId, command }) => {
    if (activeDevices.has(deviceId)) {
      logCommand(deviceId, command, 'websocket', true);
      io.emit('command', { deviceId, command });
      console.log(`→ Command from web: ${command} to ${deviceId}`);
    }
  });
});

// ==================== CLEANUP ====================

// Device timeout check (mark inactive after 60 seconds)
setInterval(() => {
  const now = Date.now();
  const timeout = 60000; // 60 seconds
  
  activeDevices.forEach((device, deviceId) => {
    const lastSeen = new Date(device.lastSeen).getTime();
    
    if (now - lastSeen > timeout) {
      console.log(`⚠️  Device ${deviceId} timed out (no data for 60s)`);
      activeDevices.delete(deviceId);
      endSession(deviceId);
      
      io.emit('deviceDisconnected', deviceId);
    }
  });
}, 30000); // Check every 30 seconds

// ==================== SERVER START ====================

server.listen(PORT, () => {
  console.log('\n========================================');
  console.log('ESP32 Monitoring Server Started');
  console.log('Version 2.0 - Enhanced with Admin Controls');
  console.log('========================================');
  console.log(`Server running on port: ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`Admin API: http://localhost:${PORT}/api/admin`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log('\n--- Admin Credentials ---');
  console.log(`Username: ${ADMIN_USERNAME}`);
  console.log(`Password: ${ADMIN_PASSWORD}`);
  console.log('(Change via environment variables)');
  console.log('========================================\n');
  console.log('📝 TESTING WITHOUT ESP32:');
  console.log(`   POST http://localhost:${PORT}/api/mock/data/TEST_ESP32`);
  console.log('   This will generate realistic mock data\n');
  console.log('Waiting for ESP32 connections...\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down server...');
  
  // End all active sessions
  activeDevices.forEach((device, deviceId) => {
    endSession(deviceId);
  });
  
  server.close(() => {
    console.log('✓ Server shut down gracefully');
    process.exit(0);
  });
});

module.exports = { app, server, io };