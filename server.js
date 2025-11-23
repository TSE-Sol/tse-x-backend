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

// Lock access cost (in USDC) - paid once per session
const LOCK_SESSION_COST = ethers.parseUnits('0.50', USDC_DECIMALS);

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

// ============ ETHERS SETUP ============
const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);

// USDC ERC-20 ABI
const USDC_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address account) public view returns (uint256)',
];

const usdcContract = new ethers.Contract(USDC_CONTRACT, USDC_ABI, provider);

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

// ============ SESSION MANAGEMENT ============

/**
 * Generate JWT session token (valid for 30 minutes)
 */
function generateSessionToken(walletAddress, deviceId) {
  const payload = {
    walletAddress,
    deviceId,
    type: 'lock-session',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
  };
  return jwt.sign(payload, JWT_SECRET);
}

/**
 * Verify JWT session token
 */
function verifySessionToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    return null;
  }
}

/**
 * Check if wallet made a recent USDC payment
 */
async function verifyPayment(walletAddress, deviceId, amountRequired) {
  try {
    console.log(`\n💰 Verifying payment from ${walletAddress.substring(0, 10)}...`);
    console.log(`   Required: ${ethers.formatUnits(amountRequired, USDC_DECIMALS)} USDC`);

    // For testing: skip payment verification
    console.log('🔨 Testing mode: Accepting payment without verification');
    return { verified: true, message: 'Payment verified (testing mode)' };

    // TODO: Real payment verification (commented out for testing)
    /*
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 1000);

    const filter = usdcContract.filters.Transfer(walletAddress, DEVICE_WALLET_ADDRESS);
    const events = await provider.getLogs({
      address: USDC_CONTRACT,
      topics: filter.topics,
      fromBlock: fromBlock,
      toBlock: 'latest',
    });

    if (events.length === 0) {
      return { verified: false, message: 'No recent payment found' };
    }

    const latestEvent = events[events.length - 1];
    const iface = new ethers.Interface(USDC_ABI);
    const decodedEvent = iface.parseLog(latestEvent);

    if (!decodedEvent) {
      return { verified: false, message: 'Could not decode transfer event' };
    }

    const transferAmount = decodedEvent.args.value;
    const isValid = transferAmount >= amountRequired;

    return {
      verified: isValid,
      amount: transferAmount,
      message: isValid ? 'Payment verified' : 'Insufficient payment',
    };
    */
  } catch (error) {
    console.error('❌ Payment verification error:', error.message);
    return { verified: false, message: `Verification failed: ${error.message}` };
  }
}

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
    mode: 'testing',
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
 * Request authentication challenge
 * POST /devices/:deviceId/challenge
 * Body: { walletAddress }
 * 
 * Returns a challenge that the user must sign with their wallet
 */
app.post('/devices/:deviceId/challenge', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress } = req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }

  console.log(`\n🔐 Challenge requested for ${deviceId} by ${walletAddress.substring(0, 10)}...`);

  // Generate random challenge
  const challenge = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min expiry

  res.json({
    challenge,
    deviceId,
    expiresAt: expiresAt.toISOString(),
    message: 'Sign this challenge with your wallet to verify ownership',
  });
});

/**
 * Verify wallet signature + payment → Issue session token
 * POST /devices/:deviceId/verify
 * Body: { walletAddress, challenge, signature, timestamp }
 * 
 * Returns: Session token valid for 30 minutes
 * This token allows unlimited lock/unlock operations
 */
app.post('/devices/:deviceId/verify', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, challenge, signature, timestamp } = req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }

  console.log(`\n🔐 Verify request for ${deviceId} from ${walletAddress.substring(0, 10)}...`);

  // Check if this is a lock device
  const device = devices[deviceId];
  if (!device.supportsLock) {
    return res.status(400).json({ error: 'This device is not a lock' });
  }

  // Verify payment (one time per session)
  const paymentCheck = await verifyPayment(walletAddress, deviceId, LOCK_SESSION_COST);

  if (!paymentCheck.verified) {
    return res.status(402).json({
      verified: false,
      message: paymentCheck.message,
      requiredAmount: ethers.formatUnits(LOCK_SESSION_COST, USDC_DECIMALS),
      currency: 'USDC',
    });
  }

  // Payment verified! Generate session token
  const sessionToken = generateSessionToken(walletAddress, deviceId);

  console.log('   ✅ Payment verified, issuing 30-min session token');

  res.json({
    verified: true,
    sessionToken,
    deviceData: device,
    accessLevel: 'full',
    sessionDuration: 1800, // 30 minutes in seconds
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    cost: ethers.formatUnits(LOCK_SESSION_COST, USDC_DECIMALS),
    currency: 'USDC',
    message: 'Session established - pay once, unlimited lock/unlock for 30 minutes',
  });
});

/**
 * Unlock device
 * POST /devices/:deviceId/unlock
 * Headers: Authorization: Bearer <sessionToken>
 * Body: { walletAddress, timestamp }
 * 
 * Requires valid session token (no additional payment)
 */
app.post('/devices/:deviceId/unlock', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n🔓 Unlock request for ${deviceId}`);

  // Verify session token (REQUIRED)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing session token',
      message: 'Please verify your payment first to get a session token',
    });
  }

  const token = authHeader.slice(7);
  const decoded = verifySessionToken(token);

  if (!decoded) {
    return res.status(401).json({
      error: 'Invalid or expired session token',
      message: 'Please verify your payment again',
    });
  }

  console.log('   ✅ Session token valid');
  console.log('   📡 Sending unlock command to device...');

  // Success! Token is valid, unlock the device
  res.json({
    success: true,
    granted: true,
    action: 'unlock',
    deviceId,
    walletAddress: decoded.walletAddress.substring(0, 10) + '...',
    timestamp: new Date().toISOString(),
    sessionExpiresAt: new Date(decoded.exp * 1000).toISOString(),
    message: '✅ Device unlocked successfully',
  });
});

/**
 * Lock device
 * POST /devices/:deviceId/lock
 * Headers: Authorization: Bearer <sessionToken>
 * Body: { walletAddress, timestamp }
 * 
 * Requires valid session token (no additional payment)
 */
app.post('/devices/:deviceId/lock', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n🔒 Lock request for ${deviceId}`);

  // Verify session token (REQUIRED)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing session token',
      message: 'Please verify your payment first to get a session token',
    });
  }

  const token = authHeader.slice(7);
  const decoded = verifySessionToken(token);

  if (!decoded) {
    return res.status(401).json({
      error: 'Invalid or expired session token',
      message: 'Please verify your payment again',
    });
  }

  console.log('   ✅ Session token valid');
  console.log('   📡 Sending lock command to device...');

  // Success! Token is valid, lock the device
  res.json({
    success: true,
    granted: true,
    action: 'lock',
    deviceId,
    walletAddress: decoded.walletAddress.substring(0, 10) + '...',
    timestamp: new Date().toISOString(),
    sessionExpiresAt: new Date(decoded.exp * 1000).toISOString(),
    message: '✅ Device locked successfully',
  });
});

/**
 * Brew coffee (separate from lock system)
 * POST /devices/:deviceId/brew
 * Body: { walletAddress, timestamp }
 * 
 * Coffee machine is separate - charges per brew
 */
app.post('/devices/:deviceId/brew', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n☕ Brew request for ${deviceId}`);

  // For now, always succeed (testing mode)
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
 * Get device status + session info
 * GET /devices/:deviceId/status
 * Headers: Authorization: Bearer <sessionToken> (optional)
 */
app.get('/devices/:deviceId/status', (req, res) => {
  const { deviceId } = req.params;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  let sessionInfo = null;

  // Check if session token provided
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifySessionToken(token);
    
    if (decoded) {
      const now = Math.floor(Date.now() / 1000);
      const secondsRemaining = decoded.exp - now;
      
      sessionInfo = {
        valid: true,
        expiresAt: new Date(decoded.exp * 1000).toISOString(),
        secondsRemaining: Math.max(0, secondsRemaining),
        isExpired: secondsRemaining <= 0,
      };
    }
  }

  res.json({
    deviceId,
    status: 'online',
    lastSeen: new Date().toISOString(),
    batteryLevel: 85,
    session: sessionInfo,
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
  console.log('🔒 Lock System: Pay once per 30-min session');
  console.log('☕ Coffee: Pay per brew (coming soon)');
  console.log('📱 Available Devices:');
  Object.keys(devices).forEach(id => {
    const device = devices[id];
    console.log(`   - ${id}: ${device.deviceName}`);
  });
  console.log('\n');
});