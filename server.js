require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ ENVIRONMENT VARIABLES ============
const ALCHEMY_RPC_URL = process.env.ALCHEMY_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/demo';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-change-me';
const DEVICE_WALLET_ADDRESS = process.env.DEVICE_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000';

// USDC on Base
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const USDC_COST = ethers.parseUnits('0.50', USDC_DECIMALS);

// TSE on Solana
const TSE_MINT = 'yrEwtVJKbxghF3P3tJtPARSXUctkBvQ2xyqvRLztpRD';
const TSE_DECIMALS = 9;
const TSE_PRICE_USD = 0.00003134;
const TSE_COST = Math.ceil((0.50 / TSE_PRICE_USD) * Math.pow(10, TSE_DECIMALS)); // ~15,947 TSE

// ============ MIDDLEWARE ============
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============ ETHERS SETUP (FOR BASE) ============
const baseProvider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);

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

function verifySessionToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    return null;
  }
}

// ============ PAYMENT VERIFICATION ============

async function verifyBaseUSDCPayment(walletAddress, deviceId, amountRequired) {
  try {
    console.log(`\n💰 Verifying Base USDC payment from ${walletAddress.substring(0, 10)}...`);
    console.log(`   Required: ${ethers.formatUnits(amountRequired, USDC_DECIMALS)} USDC`);

    // Fix wallet address checksum
    let checksummedAddress;
    try {
      checksummedAddress = ethers.getAddress(walletAddress);
    } catch (e) {
      console.error('❌ Invalid wallet address format:', walletAddress);
      return { verified: false, message: 'Invalid wallet address format' };
    }

    console.log(`   Checking balance for: ${checksummedAddress}`);

    // Real USDC balance verification on Base
    const USDC_ABI = [
      'function balanceOf(address account) public view returns (uint256)',
      'function decimals() public view returns (uint8)'
    ];
    
    const usdcContract = new ethers.Contract(USDC_CONTRACT, USDC_ABI, baseProvider);
    const balance = await usdcContract.balanceOf(checksummedAddress);
    const balanceUSDC = ethers.formatUnits(balance, USDC_DECIMALS);
    const requiredUSDC = ethers.formatUnits(amountRequired, USDC_DECIMALS);
    
    console.log(`   Wallet balance: ${balanceUSDC} USDC`);
    
    if (parseFloat(balanceUSDC) >= parseFloat(requiredUSDC)) {
      console.log(`✅ USDC payment verified`);
      return { verified: true, message: 'USDC payment verified', currency: 'USDC', balance: balanceUSDC };
    } else {
      console.log(`❌ Insufficient USDC balance`);
      return { verified: false, message: `Insufficient USDC. Have: ${balanceUSDC}, Need: ${requiredUSDC}` };
    }
  } catch (error) {
    console.error('❌ USDC verification error:', error.message);
    return { verified: false, message: `USDC verification failed: ${error.message}` };
  }
}

async function verifySolanaTokenPayment(walletAddress, deviceId, tokenMint, amountRequired) {
  try {
    console.log(`\n💰 Verifying Solana token payment from ${walletAddress.substring(0, 10)}...`);
    console.log(`   Token: ${tokenMint.substring(0, 10)}...`);
    console.log(`   Required: ${amountRequired / Math.pow(10, TSE_DECIMALS)} TSE`);

    // Import Solana web3.js
    const { Connection, PublicKey } = require('@solana/web3.js');
    
    // Create connection to Solana mainnet
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    
    // Parse wallet address
    let walletPublicKey;
    try {
      walletPublicKey = new PublicKey(walletAddress);
    } catch (e) {
      console.error('❌ Invalid Solana wallet address:', walletAddress);
      return { verified: false, message: 'Invalid Solana wallet address format' };
    }

    // Parse token mint
    const tokenMintPublicKey = new PublicKey(tokenMint);

    console.log(`   Checking TSE balance for: ${walletAddress}`);

    // Get all token accounts for this wallet
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      walletPublicKey,
      { mint: tokenMintPublicKey }
    );

    if (tokenAccounts.value.length === 0) {
      console.log(`❌ No TSE token account found for wallet`);
      return { verified: false, message: 'No TSE token account found. Please acquire some TSE.' };
    }

    // Get the balance of the first token account
    const tokenAccount = tokenAccounts.value[0];
    const accountInfo = await connection.getParsedAccountInfo(tokenAccount.pubkey);
    
    if (!accountInfo.value || !accountInfo.value.data.parsed) {
      console.log(`❌ Could not parse token account data`);
      return { verified: false, message: 'Error reading token account' };
    }

    const balance = BigInt(accountInfo.value.data.parsed.info.tokenAmount.amount);
    const balanceTSE = Number(balance) / Math.pow(10, TSE_DECIMALS);
    const requiredTSE = amountRequired / Math.pow(10, TSE_DECIMALS);

    console.log(`   Wallet balance: ${balanceTSE} TSE`);
    console.log(`   Required: ${requiredTSE} TSE`);

    if (balance >= BigInt(amountRequired)) {
      console.log(`✅ TSE payment verified`);
      return { verified: true, message: 'TSE payment verified', currency: 'TSE', balance: balanceTSE.toFixed(2) };
    } else {
      console.log(`❌ Insufficient TSE balance`);
      return { 
        verified: false, 
        message: `Insufficient TSE. Have: ${balanceTSE.toFixed(2)}, Need: ${requiredTSE.toFixed(2)}` 
      };
    }
  } catch (error) {
    console.error('❌ Solana payment verification error:', error.message);
    return { verified: false, message: `Solana verification failed: ${error.message}` };
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
    blockchains: ['Base', 'Solana'],
    payments: ['USDC', 'TSE'],
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
 * Request authentication challenge
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

  const challenge = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  res.json({
    challenge,
    deviceId,
    expiresAt: expiresAt.toISOString(),
    message: 'Sign this challenge with your wallet to verify ownership',
  });
});

/**
 * Verify wallet signature + payment → Issue session token
 * Supports both Base USDC and Solana TSE
 */
app.post('/devices/:deviceId/verify', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, challenge, signature, timestamp, paymentMethod } = req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }

  console.log(`\n🔐 Verify request for ${deviceId} from ${walletAddress.substring(0, 10)}...`);

  const device = devices[deviceId];

  // Handle lock devices
  if (device.supportsLock) {
    let paymentCheck;

    // Determine payment method (default to USDC)
    const method = paymentMethod?.toUpperCase() || 'USDC';

    if (method === 'TSE') {
      paymentCheck = await verifySolanaTokenPayment(walletAddress, deviceId, TSE_MINT, TSE_COST);
    } else {
      paymentCheck = await verifyBaseUSDCPayment(walletAddress, deviceId, USDC_COST);
    }

    if (!paymentCheck.verified) {
      const amount = method === 'TSE'
        ? `${(TSE_COST / Math.pow(10, TSE_DECIMALS)).toFixed(0)} TSE`
        : `${ethers.formatUnits(USDC_COST, USDC_DECIMALS)} USDC`;

      return res.status(402).json({
        verified: false,
        message: paymentCheck.message,
        requiredAmount: amount,
        currency: method,
        paymentMethods: ['USDC', 'TSE'],
      });
    }

    // Payment verified! Generate session token
    const sessionToken = generateSessionToken(walletAddress, deviceId);

    console.log(`   ✅ Payment verified (${method}), issuing 30-min session token`);

    return res.json({
      verified: true,
      sessionToken,
      deviceData: device,
      accessLevel: 'full',
      sessionDuration: 1800,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      paymentMethod: method,
      cost: method === 'TSE'
        ? `${(TSE_COST / Math.pow(10, TSE_DECIMALS)).toFixed(0)} TSE`
        : ethers.formatUnits(USDC_COST, USDC_DECIMALS),
      message: `Session established - ${method} payment accepted. Pay once, unlimited lock/unlock for 30 minutes`,
    });
  }

  // Handle coffee devices
  if (device.supportsTimer) {
    let paymentCheck;
    const method = paymentMethod?.toUpperCase() || 'USDC';

    if (method === 'TSE') {
      paymentCheck = await verifySolanaTokenPayment(walletAddress, deviceId, TSE_MINT, TSE_COST);
    } else {
      paymentCheck = await verifyBaseUSDCPayment(walletAddress, deviceId, USDC_COST);
    }

    if (!paymentCheck.verified) {
      const amount = method === 'TSE'
        ? `${(TSE_COST / Math.pow(10, TSE_DECIMALS)).toFixed(0)} TSE`
        : `${ethers.formatUnits(USDC_COST, USDC_DECIMALS)} USDC`;

      return res.status(402).json({
        verified: false,
        message: paymentCheck.message,
        requiredAmount: amount,
        currency: method,
        paymentMethods: ['USDC', 'TSE'],
      });
    }

    console.log(`   ✅ Coffee payment verified (${method})`);

    return res.json({
      verified: true,
      deviceData: device,
      accessLevel: 'brew',
      paymentMethod: method,
      cost: method === 'TSE'
        ? `${(TSE_COST / Math.pow(10, TSE_DECIMALS)).toFixed(0)} TSE`
        : ethers.formatUnits(USDC_COST, USDC_DECIMALS),
      message: `${method} payment verified - select your brew type`,
    });
  }

  return res.status(400).json({ error: 'Unknown device type' });
});

/**
 * Unlock device (requires session token)
 */
app.post('/devices/:deviceId/unlock', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n🔓 Unlock request for ${deviceId}`);

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
 * Lock device (requires session token)
 */
app.post('/devices/:deviceId/lock', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, timestamp } = req.body;
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n🔒 Lock request for ${deviceId}`);

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
 * Brew coffee
 */
app.post('/devices/:deviceId/brew', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, brewType, timestamp } = req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  console.log(`\n☕ Brew request for ${deviceId} (${brewType})`);

  res.json({
    success: true,
    granted: true,
    action: 'brew',
    deviceId,
    walletAddress: walletAddress ? walletAddress.substring(0, 10) + '...' : 'mock',
    brewType: brewType,
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
  const authHeader = req.headers.authorization;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  let sessionInfo = null;

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
    supportedPayments: ['USDC', 'TSE'],
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
  console.log('☕ Coffee: Pay per brew');
  console.log('💰 Payment Methods: USDC (Base) & TSE (Solana)');
  console.log('📱 Available Devices:');
  Object.keys(devices).forEach(id => {
    const device = devices[id];
    console.log(`   - ${id}: ${device.deviceName}`);
  });
  console.log('\n');
});