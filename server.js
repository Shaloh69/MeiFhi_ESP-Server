/*
 * Multi-Device Electrical Safety Monitor - Node.js Server
 * Version: 3.0 - Multi-Device Support (Vaulter + CirquitIQ)
 * 
 * SUPPORTED DEVICES:
 * - Vaulter: Single-channel power monitor with SSR control
 * - CirquitIQ: Dual-channel power monitor with 2 relay controls
 * 
 * Features:
 * - Real-time data reception from multiple ESP32 devices
 * - WebSocket communication for live updates
 * - REST API for data access
 * - Web dashboard with real-time charts
 * - Data logging and storage
 * - Command sending to ESP32
 * - Multiple device support (both types)
 * - ADMIN CONTROLS: Full remote control
 * - Mock data generator for testing without hardware
 * - Command history and logging
 * - Authentication support
 * - Device type detection and handling
 * - Render deployment ready
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
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

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
  console.log('âœ" Created data directory');
}

// Initialize log file if it doesn't exist
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, JSON.stringify({ sessions: [], readings: [] }, null, 2));
  console.log('âœ" Initialized log file');
}

// Initialize command log file
if (!fs.existsSync(COMMAND_LOG_FILE)) {
  fs.writeFileSync(COMMAND_LOG_FILE, JSON.stringify({ commands: [] }, null, 2));
  console.log('âœ" Initialized command log file');
}

// In-memory storage for active devices
const activeDevices = new Map();
const realtimeData = new Map();
const deviceConfigs = new Map();

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
    source,
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
function createSession(deviceId, ip, deviceType) {
  const data = loadData();
  
  const session = {
    deviceId,
    deviceType,
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

// ==================== MOCK DATA GENERATOR ====================

// Generate realistic mock sensor data (for Vaulter - single channel)
function generateMockDataVaulter() {
  const baseVoltage = 220 + (Math.random() - 0.5) * 10;
  const baseCurrent = 0.5 + Math.random() * 2;
  const powerFactor = 0.95;
  
  return {
    deviceType: 'VAULTER',
    voltage: parseFloat(baseVoltage.toFixed(1)),
    current: parseFloat(baseCurrent.toFixed(3)),
    power: parseFloat((baseVoltage * baseCurrent * powerFactor).toFixed(1)),
    energy: parseFloat((Math.random() * 100).toFixed(3)),
    ssrState: Math.random() > 0.1,
    state: 'MONITOR',
    sensors: 'valid'
  };
}

// Generate realistic mock sensor data (for CirquitIQ - dual channel)
function generateMockDataCirquitIQ() {
  const baseVoltage = 220 + (Math.random() - 0.5) * 10;
  const ch1Current = 0.5 + Math.random() * 2;
  const ch2Current = 0.5 + Math.random() * 2;
  const powerFactor = 0.95;
  
  return {
    deviceType: 'CIRQUITIQ',
    voltage: parseFloat(baseVoltage.toFixed(1)),
    state: 'MONITOR',
    sensors: 'valid',
    channel1: {
      current: parseFloat(ch1Current.toFixed(3)),
      power: parseFloat((baseVoltage * ch1Current * powerFactor).toFixed(1)),
      energy: parseFloat((Math.random() * 100).toFixed(3)),
      cost: parseFloat((Math.random() * 10).toFixed(2)),
      relayState: Math.random() > 0.1
    },
    channel2: {
      current: parseFloat(ch2Current.toFixed(3)),
      power: parseFloat((baseVoltage * ch2Current * powerFactor).toFixed(1)),
      energy: parseFloat((Math.random() * 100).toFixed(3)),
      cost: parseFloat((Math.random() * 10).toFixed(2)),
      relayState: Math.random() > 0.1
    },
    totalPower: parseFloat(((baseVoltage * ch1Current * powerFactor) + (baseVoltage * ch2Current * powerFactor)).toFixed(1)),
    totalEnergy: parseFloat((Math.random() * 200).toFixed(3)),
    totalCost: parseFloat((Math.random() * 20).toFixed(2))
  };
}

// POST endpoint to generate mock data (for testing without ESP32)
app.post('/api/mock/data/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const deviceType = req.query.type || 'VAULTER'; // Default to VAULTER
  const count = parseInt(req.query.count) || 1;
  
  const readings = [];
  
  for (let i = 0; i < count; i++) {
    const mockData = deviceType === 'CIRQUITIQ' ? generateMockDataCirquitIQ() : generateMockDataVaulter();
    
    // Register device if new
    if (!activeDevices.has(deviceId)) {
      activeDevices.set(deviceId, {
        deviceType: deviceType,
        ip: req.ip || 'mock',
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        isMock: true
      });
      createSession(deviceId, 'mock', deviceType);
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
      deviceType,
      ...mockData,
      timestamp: entry.timestamp
    });
    
    readings.push(entry);
  }
  
  res.json({
    success: true,
    message: `Generated ${count} mock reading(s) for ${deviceType}`,
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
    version: '3.0',
    supportedDevices: ['VAULTER', 'CIRQUITIQ']
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

// Get devices by type
app.get('/api/devices/type/:deviceType', (req, res) => {
  const { deviceType } = req.params;
  const devices = Array.from(activeDevices.entries())
    .filter(([id, device]) => device.deviceType === deviceType.toUpperCase())
    .map(([id, device]) => ({
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
  const deviceType = req.query.deviceType;
  
  const data = loadData();
  let readings = data.readings;
  
  if (deviceId) {
    readings = readings.filter(r => r.deviceId === deviceId);
  }
  
  if (deviceType) {
    readings = readings.filter(r => r.deviceType === deviceType.toUpperCase());
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
  const deviceType = req.query.deviceType;
  
  let sessions = data.sessions;
  
  if (deviceId) {
    sessions = sessions.filter(s => s.deviceId === deviceId);
  }
  
  if (deviceType) {
    sessions = sessions.filter(s => s.deviceType === deviceType.toUpperCase());
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
  
  // For Vaulter devices
  const vaulterReadings = readings.filter(r => r.deviceType === 'VAULTER' || !r.deviceType);
  const vaulterStats = vaulterReadings.length > 0 ? {
    totalReadings: vaulterReadings.length,
    voltage: {
      min: Math.min(...vaulterReadings.map(r => r.voltage).filter(v => v != null)),
      max: Math.max(...vaulterReadings.map(r => r.voltage).filter(v => v != null)),
      avg: vaulterReadings.map(r => r.voltage).filter(v => v != null).reduce((a, b) => a + b, 0) / vaulterReadings.filter(r => r.voltage != null).length
    },
    current: {
      min: Math.min(...vaulterReadings.map(r => r.current).filter(c => c != null)),
      max: Math.max(...vaulterReadings.map(r => r.current).filter(c => c != null)),
      avg: vaulterReadings.map(r => r.current).filter(c => c != null).reduce((a, b) => a + b, 0) / vaulterReadings.filter(r => r.current != null).length
    },
    power: {
      min: Math.min(...vaulterReadings.map(r => r.power).filter(p => p != null)),
      max: Math.max(...vaulterReadings.map(r => r.power).filter(p => p != null)),
      avg: vaulterReadings.map(r => r.power).filter(p => p != null).reduce((a, b) => a + b, 0) / vaulterReadings.filter(r => r.power != null).length
    }
  } : null;
  
  // For CirquitIQ devices
  const cirquitiqReadings = readings.filter(r => r.deviceType === 'CIRQUITIQ');
  const cirquitiqStats = cirquitiqReadings.length > 0 ? {
    totalReadings: cirquitiqReadings.length,
    voltage: {
      min: Math.min(...cirquitiqReadings.map(r => r.voltage).filter(v => v != null)),
      max: Math.max(...cirquitiqReadings.map(r => r.voltage).filter(v => v != null)),
      avg: cirquitiqReadings.map(r => r.voltage).filter(v => v != null).reduce((a, b) => a + b, 0) / cirquitiqReadings.filter(r => r.voltage != null).length
    },
    channel1: {
      avgCurrent: cirquitiqReadings.map(r => r.channel1?.current || 0).reduce((a, b) => a + b, 0) / cirquitiqReadings.length,
      avgPower: cirquitiqReadings.map(r => r.channel1?.power || 0).reduce((a, b) => a + b, 0) / cirquitiqReadings.length,
      totalEnergy: cirquitiqReadings.map(r => r.channel1?.energy || 0).reduce((a, b) => a + b, 0)
    },
    channel2: {
      avgCurrent: cirquitiqReadings.map(r => r.channel2?.current || 0).reduce((a, b) => a + b, 0) / cirquitiqReadings.length,
      avgPower: cirquitiqReadings.map(r => r.channel2?.power || 0).reduce((a, b) => a + b, 0) / cirquitiqReadings.length,
      totalEnergy: cirquitiqReadings.map(r => r.channel2?.energy || 0).reduce((a, b) => a + b, 0)
    }
  } : null;
  
  res.json({
    vaulter: vaulterStats,
    cirquitiq: cirquitiqStats
  });
});

// ==================== ESP32 DATA ENDPOINT ====================

// POST endpoint for ESP32 to send data
app.post('/api/data', (req, res) => {
  const {
    deviceId,
    deviceType,
    voltage,
    current,
    power,
    energy,
    ssrState,
    state,
    sensors,
    channel1,
    channel2,
    totalPower,
    totalEnergy,
    totalCost
  } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Device ID required' });
  }
  
  // Detect device type if not provided
  let detectedType = deviceType || 'VAULTER';
  if (channel1 || channel2) {
    detectedType = 'CIRQUITIQ';
  }
  
  // Register device if new
  if (!activeDevices.has(deviceId)) {
    const ip = req.ip || req.connection.remoteAddress;
    activeDevices.set(deviceId, {
      deviceType: detectedType,
      ip,
      connectedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      isMock: false
    });
    
    createSession(deviceId, ip, detectedType);
    console.log(`âœ" New device connected: ${deviceId} (${detectedType}) from ${ip}`);
  } else {
    // Update last seen
    const device = activeDevices.get(deviceId);
    device.lastSeen = new Date().toISOString();
    device.deviceType = detectedType; // Update device type if changed
  }
  
  // Store reading based on device type
  let reading;
  
  if (detectedType === 'CIRQUITIQ') {
    reading = {
      deviceType: 'CIRQUITIQ',
      voltage: parseFloat(voltage),
      state: state || 'unknown',
      sensors: sensors || 'unknown',
      channel1: channel1 || {},
      channel2: channel2 || {},
      totalPower: parseFloat(totalPower) || 0,
      totalEnergy: parseFloat(totalEnergy) || 0,
      totalCost: parseFloat(totalCost) || 0
    };
  } else {
    reading = {
      deviceType: 'VAULTER',
      voltage: parseFloat(voltage),
      current: parseFloat(current),
      power: parseFloat(power),
      energy: parseFloat(energy),
      ssrState: ssrState === 'true' || ssrState === true || ssrState === 1,
      state: state || 'unknown',
      sensors: sensors || 'unknown'
    };
  }
  
  const entry = addReading(deviceId, reading);
  
  // Update realtime data
  realtimeData.set(deviceId, {
    ...reading,
    timestamp: entry.timestamp
  });
  
  // Broadcast to all connected web clients
  io.emit('sensorData', {
    deviceId,
    deviceType: detectedType,
    ...reading,
    timestamp: entry.timestamp
  });
  
  res.json({
    success: true,
    timestamp: entry.timestamp,
    message: 'Data received',
    deviceType: detectedType
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

// Get available commands based on device type
app.get('/api/admin/commands/available', (req, res) => {
  const deviceType = req.query.deviceType || 'VAULTER';
  
  const vaulterCommands = [
    {
      name: 'on',
      description: 'Turn SSR ON (normal operation)',
      category: 'SSR Control',
      deviceType: 'VAULTER',
      parameters: null
    },
    {
      name: 'off',
      description: 'Turn SSR OFF (manual disable)',
      category: 'SSR Control',
      deviceType: 'VAULTER',
      parameters: null
    },
    {
      name: 'enable',
      description: 'Enable SSR (alias for on)',
      category: 'SSR Control',
      deviceType: 'VAULTER',
      parameters: null
    },
    {
      name: 'disable',
      description: 'Disable SSR (alias for off)',
      category: 'SSR Control',
      deviceType: 'VAULTER',
      parameters: null
    }
  ];
  
  const cirquitiqCommands = [
    {
      name: 'on 1',
      description: 'Turn Relay 1 ON',
      category: 'Relay Control',
      deviceType: 'CIRQUITIQ',
      parameters: null
    },
    {
      name: 'on 2',
      description: 'Turn Relay 2 ON',
      category: 'Relay Control',
      deviceType: 'CIRQUITIQ',
      parameters: null
    },
    {
      name: 'on all',
      description: 'Turn Both Relays ON',
      category: 'Relay Control',
      deviceType: 'CIRQUITIQ',
      parameters: null
    },
    {
      name: 'off 1',
      description: 'Turn Relay 1 OFF',
      category: 'Relay Control',
      deviceType: 'CIRQUITIQ',
      parameters: null
    },
    {
      name: 'off 2',
      description: 'Turn Relay 2 OFF',
      category: 'Relay Control',
      deviceType: 'CIRQUITIQ',
      parameters: null
    },
    {
      name: 'off all',
      description: 'Turn Both Relays OFF',
      category: 'Relay Control',
      deviceType: 'CIRQUITIQ',
      parameters: null
    }
  ];
  
  const commonCommands = [
    {
      name: 'reset',
      description: 'Emergency reset system',
      category: 'System Control',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'restart',
      description: 'Restart ESP32',
      category: 'System Control',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'calibrate',
      description: 'Start manual calibration',
      category: 'Calibration',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'cal_voltage',
      description: 'Start voltage calibration wizard',
      category: 'Calibration',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'voltage_cal',
      description: 'Set voltage calibration factor',
      category: 'Calibration',
      deviceType: 'ALL',
      parameters: 'number (0.01-1000)'
    },
    {
      name: 'current_cal',
      description: 'Set current calibration factor',
      category: 'Calibration',
      deviceType: 'ALL',
      parameters: 'number (0.001-100)'
    },
    {
      name: 'power_factor',
      description: 'Set power factor',
      category: 'Settings',
      deviceType: 'ALL',
      parameters: 'number (0.1-1.0)'
    },
    {
      name: 'status',
      description: 'Get current status',
      category: 'Information',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'test',
      description: 'Test sensors',
      category: 'Diagnostics',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'diag',
      description: 'Full diagnostics',
      category: 'Diagnostics',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'stats',
      description: 'Show statistics',
      category: 'Information',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'manual',
      description: 'Toggle manual mode',
      category: 'Settings',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'safety',
      description: 'Toggle safety checks',
      category: 'Settings',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'buzzer',
      description: 'Toggle buzzer',
      category: 'Settings',
      deviceType: 'ALL',
      parameters: null
    },
    {
      name: 'clear',
      description: 'Clear statistics',
      category: 'Settings',
      deviceType: 'ALL',
      parameters: null
    }
  ];
  
  let commands = [...commonCommands];
  
  if (deviceType.toUpperCase() === 'VAULTER') {
    commands = [...vaulterCommands, ...commands];
  } else if (deviceType.toUpperCase() === 'CIRQUITIQ') {
    commands = [...cirquitiqCommands, ...commands];
  } else {
    commands = [...vaulterCommands, ...cirquitiqCommands, ...commands];
  }
  
  res.json({ commands });
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
  
  const device = activeDevices.get(deviceId);
  
  // Build full command with parameters if provided
  let fullCommand = command;
  if (parameters) {
    fullCommand = `${command} ${parameters}`;
  }
  
  // Log command
  logCommand(deviceId, fullCommand, 'admin', true);
  
  // Emit command to specific device
  io.emit('command', { deviceId, command: fullCommand });
  
  console.log(`â†' Admin command sent to ${deviceId} (${device.deviceType}): ${fullCommand}`);
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
    command: fullCommand,
    timestamp: new Date().toISOString()
  });
});

// Relay/SSR Control - Turn ON
app.post('/api/admin/relay/:deviceId/on', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  const channel = req.query.channel; // Optional: 1, 2, or 'all' for CirquitIQ
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const device = activeDevices.get(deviceId);
  let command;
  
  if (device.deviceType === 'CIRQUITIQ') {
    if (channel === '1') {
      command = 'on 1';
    } else if (channel === '2') {
      command = 'on 2';
    } else {
      command = 'on all';
    }
  } else {
    command = 'on';
  }
  
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`â†' Admin Relay ON: ${deviceId} (${device.deviceType}) - ${command}`);
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
    action: `Relay turned ON: ${command}`,
    timestamp: new Date().toISOString()
  });
});

// Relay/SSR Control - Turn OFF
app.post('/api/admin/relay/:deviceId/off', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  const channel = req.query.channel; // Optional: 1, 2, or 'all' for CirquitIQ
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const device = activeDevices.get(deviceId);
  let command;
  
  if (device.deviceType === 'CIRQUITIQ') {
    if (channel === '1') {
      command = 'off 1';
    } else if (channel === '2') {
      command = 'off 2';
    } else {
      command = 'off all';
    }
  } else {
    command = 'off';
  }
  
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`â†' Admin Relay OFF: ${deviceId} (${device.deviceType}) - ${command}`);
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
    action: `Relay turned OFF: ${command}`,
    timestamp: new Date().toISOString()
  });
});

// System Control - Reset
app.post('/api/admin/system/:deviceId/reset', basicAuth, (req, res) => {
  const { deviceId } = req.params;
  
  if (!activeDevices.has(deviceId)) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }
  
  const device = activeDevices.get(deviceId);
  const command = 'reset';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`â†' Admin RESET: ${deviceId} (${device.deviceType})`);
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
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
  
  const device = activeDevices.get(deviceId);
  const command = 'restart';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`â†' Admin RESTART: ${deviceId} (${device.deviceType})`);
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
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
  
  const device = activeDevices.get(deviceId);
  const command = 'calibrate';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`â†' Admin CALIBRATE: ${deviceId} (${device.deviceType})`);
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
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
  
  const device = activeDevices.get(deviceId);
  
  // Valid parameters
  const validParams = ['power_factor', 'voltage_cal', 'current_cal', 'ch1_cal', 'ch2_cal', 'rate'];
  
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
  
  console.log(`â†' Admin CONFIG: ${deviceId} (${device.deviceType}) - ${parameter} = ${value}`);
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
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
  
  const device = activeDevices.get(deviceId);
  const validSettings = ['manual', 'safety', 'buzzer', 'display'];
  
  if (!validSettings.includes(setting)) {
    return res.status(400).json({ 
      error: 'Invalid setting',
      validSettings: validSettings
    });
  }
  
  const command = setting;
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  console.log(`â†' Admin TOGGLE ${setting.toUpperCase()}: ${deviceId} (${device.deviceType})`);
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
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
  
  const device = activeDevices.get(deviceId);
  const command = 'diag';
  logCommand(deviceId, command, 'admin', true);
  io.emit('command', { deviceId, command });
  
  res.json({
    success: true,
    deviceId,
    deviceType: device.deviceType,
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
      const device = activeDevices.get(deviceId);
      logCommand(deviceId, fullCommand, 'admin', true);
      io.emit('command', { deviceId, command: fullCommand });
      results.push({ deviceId, deviceType: device.deviceType, success: true });
    } else {
      results.push({ deviceId, success: false, error: 'Device not found' });
    }
  });
  
  console.log(`â†' Admin BATCH command to ${deviceIds.length} devices: ${fullCommand}`);
  
  res.json({
    success: true,
    command: fullCommand,
    results,
    timestamp: new Date().toISOString()
  });
});

// ==================== WEBSOCKET HANDLING ====================

io.on('connection', (socket) => {
  console.log('âœ" Web client connected:', socket.id);
  
  // Send current active devices and latest data
  const devices = Array.from(activeDevices.entries()).map(([id, device]) => ({
    deviceId: id,
    deviceType: device.deviceType
  }));
  socket.emit('activeDevices', devices);
  
  realtimeData.forEach((data, deviceId) => {
    const device = activeDevices.get(deviceId);
    socket.emit('sensorData', { 
      deviceId, 
      deviceType: device?.deviceType,
      ...data 
    });
  });
  
  socket.on('disconnect', () => {
    console.log('âœ— Web client disconnected:', socket.id);
  });
  
  // Handle command from web client
  socket.on('sendCommand', ({ deviceId, command }) => {
    if (activeDevices.has(deviceId)) {
      const device = activeDevices.get(deviceId);
      logCommand(deviceId, command, 'websocket', true);
      io.emit('command', { deviceId, command });
      console.log(`â†' Command from web: ${command} to ${deviceId} (${device.deviceType})`);
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
      console.log(`âš ï¸  Device ${deviceId} (${device.deviceType}) timed out (no data for 60s)`);
      activeDevices.delete(deviceId);
      endSession(deviceId);
      
      io.emit('deviceDisconnected', { deviceId, deviceType: device.deviceType });
    }
  });
}, 30000); // Check every 30 seconds

// ==================== SERVER START ====================

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('Multi-Device Monitoring Server Started');
  console.log('Version 3.0 - Vaulter + CirquitIQ Support');
  console.log('========================================');
  console.log(`Server running on port: ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`Admin API: http://localhost:${PORT}/api/admin`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log('\n--- Supported Devices ---');
  console.log('• Vaulter: Single-channel SSR monitor');
  console.log('• CirquitIQ: Dual-channel relay monitor');
  console.log('\n--- Admin Credentials ---');
  console.log(`Username: ${ADMIN_USERNAME}`);
  console.log(`Password: ${ADMIN_PASSWORD}`);
  console.log('(Change via environment variables)');
  console.log('========================================\n');
  console.log('ðŸ" TESTING WITHOUT HARDWARE:');
  console.log(`   POST http://localhost:${PORT}/api/mock/data/TEST_VAULTER?type=VAULTER`);
  console.log(`   POST http://localhost:${PORT}/api/mock/data/TEST_CIRQUITIQ?type=CIRQUITIQ`);
  console.log('   This will generate realistic mock data\n');
  console.log('ðŸš€ RENDER DEPLOYMENT READY');
  console.log('   PORT is automatically configured from environment\n');
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
    console.log('âœ" Server shut down gracefully');
    process.exit(0);
  });
});

module.exports = { app, server, io };