require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ ENVIRONMENT VARIABLES ============
const requiredEnvVars = [
  'ALCHEMY_RPC_URL',
  'JWT_SECRET',
  'DEVICE_WALLET_ADDRESS',
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌ Missing environment variables:', missingVars.join(', '));
  process.exit(1);
}

const ALCHEMY_RPC_URL = process.env.ALCHEMY_RPC_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const DEVICE_WALLET_ADDRESS = process.env.DEVICE_WALLET_ADDRESS;
const NODE_ENV = process.env.NODE_ENV || 'development';

// USDC Contract on Base
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;

// Payment amounts (in USDC)
const UNLOCK_COST = ethers.parseUnits('0.50', USDC_DECIMALS);
const BREW_COST = ethers.parseUnits('0.25', USDC_DECIMALS);

// ============ MIDDLEWARE ============
app.use(express.json());

// Enable CORS for development and browser requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============ ETHERS SETUP ============
const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);

// USDC ERC-20 ABI (minimal for Transfer events)
const USDC_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address account) public view returns (uint256)',
];

const usdcContract = new ethers.Contract(USDC_CONTRACT, USDC_ABI, provider);

// ============ MOCK DEVICES DATABASE ============
const devices = {
  'X402-LOCK-001': {
    deviceId: 'X402-LOCK-001',
    deviceName: 'Office Door Lock',
    deviceType: 'Door Lock',
    model: 'X402-DL Standard',
    supportsLock: true,
    supportsTimer: false,
    supportsNFC: true,
    supportsBLE: true,
    firmwareVersion: '1.0.5',
    walletAddress: DEVICE_WALLET_ADDRESS,
    status: 'online',
  },
  'X402-COFFEE-001': {
    deviceId: 'X402-COFFEE-001',
    deviceName: 'Smart Coffee Maker',
    deviceType: 'Coffee Machine',
    model: 'X402-CM Pro',
    supportsLock: false,
    supportsTimer: true,
    supportsNFC: false,
    supportsBLE: true,
    firmwareVersion: '2.1.3',
    walletAddress: DEVICE_WALLET_ADDRESS,
    status: 'online',
  },
};

// ============ HELPER FUNCTIONS ============

/**
 * Check if a wallet has made a recent USDC payment to the device wallet
 */
async function verifyPayment(walletAddress, deviceId, amountRequired) {
  try {
    console.log(`\n💰 Verifying payment from ${walletAddress}...`);
    console.log(`   Required: ${ethers.formatUnits(amountRequired, USDC_DECIMALS)} USDC`);

    // In development mode, skip payment verification
    if (NODE_ENV === 'development') {
      console.log('🔨 Development mode: Skipping payment verification');
      return { verified: true, message: 'Development mode - payment skipped' };
    }

    // Get recent Transfer events (last 1000 blocks)
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 1000);

    const filter = usdcContract.filters.Transfer(walletAddress, DEVICE_WALLET_ADDRESS);
    const events = await provider.getLogs({
      address: USDC_CONTRACT,
      topics: filter.topics,
      fromBlock: fromBlock,
      toBlock: 'latest',
    });

    console.log(`   Found ${events.length} transfer event(s)`);

    if (events.length === 0) {
      return { verified: false, message: 'No recent payment found' };
    }

    // Decode the latest transfer event
    const latestEvent = events[events.length - 1];
    const iface = new ethers.Interface(USDC_ABI);
    const decodedEvent = iface.parseLog(latestEvent);

    if (!decodedEvent) {
      return { verified: false, message: 'Could not decode transfer event' };
    }

    const transferAmount = decodedEvent.args.value;
    const isValid = transferAmount >= amountRequired;

    console.log(`   Transfer amount: ${ethers.formatUnits(transferAmount, USDC_DECIMALS)} USDC`);
    console.log(`   Valid: ${isValid ? '✅' : '❌'}`);

    return {
      verified: isValid,
      amount: transferAmount,
      message: isValid ? 'Payment verified' : 'Insufficient payment',
    };
  } catch (error) {
    console.error('❌ Payment verification error:', error.message);
    return { verified: false, message: `Verification failed: ${error.message}` };
  }
}

/**
 * Generate JWT session token
 */
function generateSessionToken(walletAddress, deviceId) {
  const payload = {
    walletAddress,
    deviceId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
  };
  return jwt.sign(payload, JWT_SECRET);
}

/**
 * Verify JWT session token
 */
function verifySessionToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
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
    environment: NODE_ENV,
  });
});

/**
 * Get device info (public)
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

  // Generate random challenge
  const challenge = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min expiry

  res.json({
    challenge,
    deviceId,
    expiresAt: expiresAt.toISOString(),
    message: 'Sign this challenge with your wallet',
  });
});

/**
 * Verify payment + grant session token
 * POST /devices/:deviceId/verify
 * Body: { walletAddress, challenge, signature, timestamp }
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

  console.log(`\n🔐 Verify request for ${deviceId} from ${walletAddress}`);

  // In development, skip signature verification
  if (NODE_ENV !== 'development') {
    if (!challenge || !signature) {
      return res.status(400).json({ error: 'challenge and signature required' });
    }
  }

  // Verify payment
  const paymentCheck = await verifyPayment(walletAddress, deviceId, UNLOCK_COST);

  if (!paymentCheck.verified) {
    return res.status(402).json({
      verified: false,
      message: paymentCheck.message,
      requiredAmount: ethers.formatUnits(UNLOCK_COST, USDC_DECIMALS),
      currency: 'USDC',
    });
  }

  // Generate session token
  const sessionToken = generateSessionToken(walletAddress, deviceId);

  res.json({
    verified: true,
    sessionToken,
    deviceData: devices[deviceId],
    accessLevel: 'full',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    message: 'Access granted',
  });
});

/**
 * Unlock device
 * POST /devices/:deviceId/unlock
 * Headers: Authorization: Bearer <token>
 * Body: { walletAddress, timestamp }
 */
app.post('/devices/:deviceId/unlock', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n🔓 Unlock request for ${deviceId}`);

  // Verify session token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifySessionToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }
    console.log('   ✅ Session token valid');
  }

  // Verify payment
  const paymentCheck = await verifyPayment(walletAddress, deviceId, UNLOCK_COST);

  if (!paymentCheck.verified) {
    return res.status(402).json({
      granted: false,
      message: paymentCheck.message,
      requiredAmount: ethers.formatUnits(UNLOCK_COST, USDC_DECIMALS),
      currency: 'USDC',
    });
  }

  // In real scenario, send command to ESP32
  console.log('   📡 Sending unlock command to device...');
  console.log('   ✅ Device unlocked');

  res.json({
    success: true,
    granted: true,
    action: 'unlock',
    deviceId,
    walletAddress: walletAddress.substring(0, 10) + '...',
    amount: ethers.formatUnits(UNLOCK_COST, USDC_DECIMALS),
    currency: 'USDC',
    timestamp: new Date().toISOString(),
    message: 'Device unlocked successfully',
  });
});

/**
 * Lock device
 * POST /devices/:deviceId/lock
 * Headers: Authorization: Bearer <token>
 * Body: { walletAddress, timestamp }
 */
app.post('/devices/:deviceId/lock', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n🔒 Lock request for ${deviceId}`);

  // Verify session token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifySessionToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }
    console.log('   ✅ Session token valid');
  }

  // Verify payment
  const paymentCheck = await verifyPayment(walletAddress, deviceId, UNLOCK_COST);

  if (!paymentCheck.verified) {
    return res.status(402).json({
      granted: false,
      message: paymentCheck.message,
      requiredAmount: ethers.formatUnits(UNLOCK_COST, USDC_DECIMALS),
      currency: 'USDC',
    });
  }

  // In real scenario, send command to ESP32
  console.log('   📡 Sending lock command to device...');
  console.log('   ✅ Device locked');

  res.json({
    success: true,
    granted: true,
    action: 'lock',
    deviceId,
    walletAddress: walletAddress.substring(0, 10) + '...',
    amount: ethers.formatUnits(UNLOCK_COST, USDC_DECIMALS),
    currency: 'USDC',
    timestamp: new Date().toISOString(),
    message: 'Device locked successfully',
  });
});

/**
 * Brew coffee
 * POST /devices/:deviceId/brew
 * Headers: Authorization: Bearer <token>
 * Body: { walletAddress, timestamp }
 */
app.post('/devices/:deviceId/brew', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n☕ Brew request for ${deviceId}`);

  // Verify session token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifySessionToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }
    console.log('   ✅ Session token valid');
  }

  // Verify payment (lower cost for brew)
  const paymentCheck = await verifyPayment(walletAddress, deviceId, BREW_COST);

  if (!paymentCheck.verified) {
    return res.status(402).json({
      granted: false,
      message: paymentCheck.message,
      requiredAmount: ethers.formatUnits(BREW_COST, USDC_DECIMALS),
      currency: 'USDC',
    });
  }

  // In real scenario, send command to ESP32
  console.log('   📡 Sending brew command to device...');
  console.log('   ✅ Brewing started');

  res.json({
    success: true,
    granted: true,
    action: 'brew',
    deviceId,
    walletAddress: walletAddress.substring(0, 10) + '...',
    amount: ethers.formatUnits(BREW_COST, USDC_DECIMALS),
    currency: 'USDC',
    timestamp: new Date().toISOString(),
    brewTime: 30, // seconds
    message: 'Brewing started',
  });
});

/**
 * Get device status
 * GET /devices/:deviceId/status
 * Headers: Authorization: Bearer <token>
 */
app.get('/devices/:deviceId/status', (req, res) => {
  const { deviceId } = req.params;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  // Verify session token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifySessionToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }
  }

  const device = devices[deviceId];
  res.json({
    deviceId,
    status: device.status,
    lastSeen: new Date().toISOString(),
    isLocked: true, // would come from ESP32
    batteryLevel: 85,
  });
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log('\n');
  console.log('🚀 X.402 Backend running on port', PORT);
  console.log('⛓️  Base RPC:', ALCHEMY_RPC_URL.substring(0, 50) + '...');
  console.log('💰 USDC Contract:', USDC_CONTRACT);
  console.log('📱 Device Wallet:', DEVICE_WALLET_ADDRESS);
  console.log('🔐 JWT Secret:', JWT_SECRET ? '✓ Set' : '✗ NOT SET');
  console.log('🌍 Environment:', NODE_ENV);
  console.log('\n');
});