// X.402 Backend - Node.js + Express + Base Blockchain
// Pay-per-use device access with USDC payments on Base

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const ALCHEMY_BASE_RPC = process.env.ALCHEMY_RPC_URL;
const DEVICE_WALLET = process.env.DEVICE_WALLET_ADDRESS;

// USDC on Base contract address
const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Validate required environment variables
if (!JWT_SECRET) {
  console.error('ERROR: JWT_SECRET is not set in environment variables');
  process.exit(1);
}
if (!ALCHEMY_BASE_RPC) {
  console.error('ERROR: ALCHEMY_RPC_URL is not set in environment variables');
  process.exit(1);
}
if (!DEVICE_WALLET) {
  console.warn('WARNING: DEVICE_WALLET_ADDRESS is not set - payments will fail');
}

// Alchemy provider for Base blockchain
const provider = new ethers.JsonRpcProvider(ALCHEMY_BASE_RPC);

// In-memory storage (replace with database in production)
const challenges = new Map(); // walletAddress -> { challenge, expiresAt }
const devices = new Map(); // deviceId -> device data

// Initialize mock devices with environment wallet
devices.set('X402-LOCK-001', {
  deviceId: 'X402-LOCK-001',
  deviceName: 'Smart Bike Lock',
  deviceType: 'Bike Lock',
  model: 'X402-BL Pro',
  supportsLock: true,
  supportsTimer: false,
  supportsNFC: true,
  supportsBLE: true,
  costPerUse: '0.50', // USDC per unlock ($0.50)
  walletAddress: DEVICE_WALLET,
  rssi: -45,
  firmwareVersion: '1.2.0',
  currentTimerSecond: 0
});

devices.set('X402-COFFEE-001', {
  deviceId: 'X402-COFFEE-001',
  deviceName: 'Smart Coffee Machine',
  deviceType: 'Coffee Machine',
  model: 'X402-CM Elite',
  supportsLock: false,
  supportsTimer: true,
  supportsNFC: true,
  supportsBLE: true,
  costPerUse: '0.25', // USDC per brew ($0.25)
  walletAddress: DEVICE_WALLET,
  rssi: -62,
  firmwareVersion: '2.0.1',
  currentTimerSecond: 0
});

devices.set('X402-LOCK-002', {
  deviceId: 'X402-LOCK-002',
  deviceName: 'Office Door Lock',
  deviceType: 'Door Lock',
  model: 'X402-DL Standard',
  supportsLock: true,
  supportsTimer: false,
  supportsNFC: false,
  supportsBLE: true,
  costPerUse: '0.50',
  walletAddress: DEVICE_WALLET,
  rssi: -78,
  firmwareVersion: '1.0.5',
  currentTimerSecond: 0
});

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    blockchain: 'Base',
    payment: 'USDC'
  });
});

// Get device info (public)
app.get('/devices/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const device = devices.get(deviceId);
  
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  // Return device info without sensitive wallet address
  const { walletAddress, ...publicDeviceInfo } = device;
  res.json(publicDeviceInfo);
});

// Request authentication challenge
app.post('/devices/:deviceId/challenge', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress } = req.body;
  
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }
  
  // Validate wallet address format
  if (!ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }
  
  const device = devices.get(deviceId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  // Generate random challenge
  const challenge = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  
  // Store challenge
  challenges.set(walletAddress.toLowerCase(), {
    challenge,
    expiresAt,
    deviceId
  });
  
  res.json({
    challenge,
    expiresAt: expiresAt.toISOString(),
    deviceId,
    message: `Sign this message to authenticate: ${challenge}`
  });
});

// Verify signature + payment
app.post('/devices/:deviceId/verify', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, challenge, signature } = req.body;
  
  if (!walletAddress || !challenge || !signature) {
    return res.status(400).json({ error: 'walletAddress, challenge, and signature required' });
  }
  
  const device = devices.get(deviceId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  // Verify challenge exists and hasn't expired
  const storedChallenge = challenges.get(walletAddress.toLowerCase());
  if (!storedChallenge || storedChallenge.challenge !== challenge) {
    return res.status(401).json({ error: 'Invalid challenge' });
  }
  
  if (new Date() > storedChallenge.expiresAt) {
    challenges.delete(walletAddress.toLowerCase());
    return res.status(401).json({ error: 'Challenge expired' });
  }
  
  // Verify signature
  try {
    const message = `Sign this message to authenticate: ${challenge}`;
    const recoveredAddress = ethers.verifyMessage(message, signature);
    
    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    console.error('Signature verification failed:', err);
    return res.status(401).json({ error: 'Signature verification failed' });
  }
  
  // Check USDC payment on Base blockchain
  try {
    const hasPaid = await checkRecentPayment(walletAddress, device.walletAddress, device.costPerUse);
    
    if (!hasPaid) {
      return res.status(402).json({ 
        error: 'Payment required',
        costPerUse: device.costPerUse,
        currency: 'USDC',
        deviceWallet: device.walletAddress,
        usdcContract: USDC_BASE_ADDRESS,
        chainId: 8453, // Base mainnet
        message: `Please send ${device.costPerUse} USDC to ${device.walletAddress} on Base`
      });
    }
  } catch (err) {
    console.error('Payment check failed:', err);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
  
  // Generate session token (valid for 1 hour)
  const sessionToken = jwt.sign(
    { 
      walletAddress: walletAddress.toLowerCase(), 
      deviceId,
      exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour
    },
    JWT_SECRET
  );
  
  // Clear challenge
  challenges.delete(walletAddress.toLowerCase());
  
  res.json({
    verified: true,
    sessionToken,
    deviceData: device,
    accessLevel: 'full',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
});

// Device control - Lock
app.post('/devices/:deviceId/lock', authenticateToken, async (req, res) => {
  const { deviceId } = req.params;
  const device = devices.get(deviceId);
  
  if (!device || !device.supportsLock) {
    return res.status(400).json({ error: 'Device does not support lock' });
  }
  
  // TODO: Send command to ESP32 device via MQTT/WebSocket
  console.log(`Locking device ${deviceId} for wallet ${req.user.walletAddress}`);
  
  res.json({
    success: true,
    action: 'lock',
    deviceId,
    timestamp: new Date().toISOString()
  });
});

// Device control - Unlock
app.post('/devices/:deviceId/unlock', authenticateToken, async (req, res) => {
  const { deviceId } = req.params;
  const device = devices.get(deviceId);
  
  if (!device || !device.supportsLock) {
    return res.status(400).json({ error: 'Device does not support unlock' });
  }
  
  // TODO: Send command to ESP32 device
  console.log(`Unlocking device ${deviceId} for wallet ${req.user.walletAddress}`);
  
  res.json({
    success: true,
    action: 'unlock',
    deviceId,
    timestamp: new Date().toISOString()
  });
});

// Device control - Brew
app.post('/devices/:deviceId/brew', authenticateToken, async (req, res) => {
  const { deviceId } = req.params;
  const device = devices.get(deviceId);
  
  if (!device || !device.supportsTimer) {
    return res.status(400).json({ error: 'Device does not support brew timer' });
  }
  
  // TODO: Send command to ESP32 device
  console.log(`Starting brew on device ${deviceId} for wallet ${req.user.walletAddress}`);
  
  res.json({
    success: true,
    action: 'brew',
    deviceId,
    duration: 30,
    timestamp: new Date().toISOString()
  });
});

// Get device status
app.get('/devices/:deviceId/status', authenticateToken, (req, res) => {
  const { deviceId } = req.params;
  const device = devices.get(deviceId);
  
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  // TODO: Get real status from ESP32 device
  res.json({
    deviceId,
    online: true,
    locked: true, // Mock data
    batteryLevel: 85,
    lastSeen: new Date().toISOString()
  });
});

// ============================================
// MIDDLEWARE
// ============================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// ============================================
// BLOCKCHAIN HELPERS
// ============================================

// USDC ERC-20 ABI (Transfer event)
const USDC_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)'
];

async function checkRecentPayment(fromAddress, toAddress, expectedAmount) {
  // Check if wallet has sent USDC payment in last 5 minutes
  try {
    const usdcContract = new ethers.Contract(USDC_BASE_ADDRESS, USDC_ABI, provider);
    
    // Get latest block
    const latestBlock = await provider.getBlockNumber();
    
    // Search last ~40 blocks (roughly 5 minutes on Base, 2 sec blocks)
    const startBlock = Math.max(0, latestBlock - 40);
    
    // Query Transfer events where 'from' is the user and 'to' is the device
    const filter = usdcContract.filters.Transfer(fromAddress, toAddress);
    const events = await usdcContract.queryFilter(filter, startBlock, latestBlock);
    
    // USDC has 6 decimals
    const decimals = 6;
    const expectedAmountBigInt = ethers.parseUnits(expectedAmount, decimals);
    
    for (const event of events) {
      const amount = event.args.value;
      
      // Check if payment amount meets or exceeds expected
      if (amount >= expectedAmountBigInt) {
        console.log(`✓ Payment verified: ${ethers.formatUnits(amount, decimals)} USDC from ${fromAddress}`);
        return true;
      }
    }
    
    console.log(`✗ No recent payment found from ${fromAddress}`);
    return false;
  } catch (err) {
    console.error('Error checking USDC payment:', err);
    // In development, return true to allow testing
    if (process.env.NODE_ENV === 'development') {
      console.warn('⚠️ Development mode: Skipping payment verification');
      return true;
    }
    return false;
  }
}

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 X.402 Backend running on port ${PORT}`);
  console.log(`⛓️  Base RPC: ${ALCHEMY_BASE_RPC}`);
  console.log(`💰 USDC Contract: ${USDC_BASE_ADDRESS}`);
  console.log(`📱 Device Wallet: ${DEVICE_WALLET || 'NOT SET'}`);
  console.log(`🔐 JWT Secret: ${JWT_SECRET ? '✓ Set' : '✗ NOT SET'}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});