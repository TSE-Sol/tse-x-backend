require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ ENVIRONMENT VARIABLES ============
const ALCHEMY_RPC_URL = process.env.ALCHEMY_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/demo';
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-change-me';
const DEVICE_WALLET_ADDRESS = process.env.DEVICE_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000';

// USDC Contract on Base
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;

// ============ MIDDLEWARE ============
app.use(express.json());

// Enable CORS for browser requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============ MOCK DEVICES DATABASE ============
const devices = {
  'X402-LOCK-001': {
    deviceId: 'X402-LOCK-001',
    deviceName: 'Smart Bike Lock',
    deviceType: 'Bike Lock',
    model: 'X402-BL Pro',
    supportsLock: true,
    supportsTimer: false,
    supportsNFC: true,
    supportsBLE: true,
    firmwareVersion: '1.2.1',
    status: 'online',
  },
  'X402-LOCK-002': {
    deviceId: 'X402-LOCK-002',
    deviceName: 'Office Door Lock',
    deviceType: 'Door Lock',
    model: 'X402-DL Standard',
    supportsLock: true,
    supportsTimer: false,
    supportsNFC: true,
    supportsBLE: true,
    firmwareVersion: '1.0.5',
    status: 'online',
  },
  'X402-COFFEE-001': {
    deviceId: 'X402-COFFEE-001',
    deviceName: 'Smart Coffee Maker',
    deviceType: 'Coffee Machine',
    model: 'X402-CM Elite',
    supportsLock: false,
    supportsTimer: true,
    supportsNFC: false,
    supportsBLE: true,
    firmwareVersion: '2.0.1',
    status: 'online',
  },
};

// ============ ROUTES ============

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    blockchain: 'Base',
    payment: 'USDC',
    environment: 'development',
  });
});

/**
 * Get device info
 */
app.get('/devices/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const device = devices[deviceId];

  if (!device) {
    return res.status(404).json({
      error: 'Device not found',
      deviceId,
    });
  }

  res.json(device);
});

/**
 * Unlock device - TESTING MODE (no payment verification)
 */
app.post('/devices/:deviceId/unlock', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n🔓 UNLOCK: ${deviceId} from ${walletAddress}`);

  // Always succeed in testing mode
  res.json({
    success: true,
    granted: true,
    action: 'unlock',
    deviceId,
    walletAddress: walletAddress ? walletAddress.substring(0, 10) + '...' : 'mock',
    amount: '0.50',
    currency: 'USDC',
    timestamp: new Date().toISOString(),
    message: '✅ Device unlocked successfully!',
  });
});

/**
 * Lock device - TESTING MODE (no payment verification)
 */
app.post('/devices/:deviceId/lock', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n🔒 LOCK: ${deviceId} from ${walletAddress}`);

  // Always succeed in testing mode
  res.json({
    success: true,
    granted: true,
    action: 'lock',
    deviceId,
    walletAddress: walletAddress ? walletAddress.substring(0, 10) + '...' : 'mock',
    amount: '0.50',
    currency: 'USDC',
    timestamp: new Date().toISOString(),
    message: '✅ Device locked successfully!',
  });
});

/**
 * Brew coffee - TESTING MODE (no payment verification)
 */
app.post('/devices/:deviceId/brew', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n☕ BREW: ${deviceId} from ${walletAddress}`);

  // Always succeed in testing mode
  res.json({
    success: true,
    granted: true,
    action: 'brew',
    deviceId,
    walletAddress: walletAddress ? walletAddress.substring(0, 10) + '...' : 'mock',
    amount: '0.25',
    currency: 'USDC',
    timestamp: new Date().toISOString(),
    brewTime: 30,
    message: '✅ Brewing started!',
  });
});

/**
 * Get device status
 */
app.get('/devices/:deviceId/status', (req, res) => {
  const { deviceId } = req.params;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  res.json({
    deviceId,
    status: 'online',
    lastSeen: new Date().toISOString(),
    isLocked: true,
    batteryLevel: 85,
  });
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log('\n');
  console.log('🚀 X.402 Backend running on port', PORT);
  console.log('🔨 MODE: TESTING (all requests succeed)');
  console.log('📱 Available Devices:');
  Object.keys(devices).forEach(id => {
    console.log(`   - ${id}: ${devices[id].deviceName}`);
  });
  console.log('\n');
});
