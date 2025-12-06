require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ---------- Solana imports (global, for all Solana helpers) ----------
const {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const splToken = require('@solana/spl-token');
const {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = splToken;

const app = express();
const PORT = process.env.PORT || 3000;

// ============ ENVIRONMENT VARIABLES ============
const ALCHEMY_RPC_URL =
  process.env.ALCHEMY_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/demo';

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  'https://mainnet.helius-rpc.com/?api-key=3b904f43-e600-4d65-8cf4-aabf4d5fa5e3';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-change-me';

const DEVICE_WALLET_ADDRESS =
  process.env.DEVICE_WALLET_ADDRESS ||
  '0x0000000000000000000000000000000000000000';

// Where TSE payments for X.402 should be sent
const TSE_RECEIVER_WALLET =
  process.env.TSE_RECEIVER_WALLET ||
  'E7gnXdN4Nneh5KHBUgXVdUNXkBYtwNF4fkpzZU3otnmX';

// USDC on Base
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const USDC_COST = ethers.parseUnits('0.50', USDC_DECIMALS);

// TSE on Solana
const TSE_MINT = 'yrEwtVJKbxghF3P3tJtPARSXUctkBvQ2xyqvRLztpRD';
const TSE_DECIMALS = 9;
const TSE_PRICE_USD = 0.00003134;
const TSE_COST = Math.ceil(
  (0.5 / TSE_PRICE_USD) * Math.pow(10, TSE_DECIMALS)
); // ~15,947 TSE

// ============ MIDDLEWARE ============
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );

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

// ============ SESSION MANAGEMENT (EXISTING FLOW) ============

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

// ============ PAYMENT VERIFICATION (BALANCE-BASED, USDC/TSE) ============

async function verifyBaseUSDCPayment(walletAddress, deviceId, amountRequired) {
  try {
    console.log(
      `\n💰 Verifying Base USDC payment from ${walletAddress.substring(
        0,
        10
      )}...`
    );
    console.log(
      `   Required: ${ethers.formatUnits(amountRequired, USDC_DECIMALS)} USDC`
    );

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
      'function decimals() public view returns (uint8)',
    ];

    const usdcContract = new ethers.Contract(
      USDC_CONTRACT,
      USDC_ABI,
      baseProvider
    );
    const balance = await usdcContract.balanceOf(checksummedAddress);
    const balanceUSDC = ethers.formatUnits(balance, USDC_DECIMALS);
    const requiredUSDC = ethers.formatUnits(amountRequired, USDC_DECIMALS);

    console.log(`   Wallet balance: ${balanceUSDC} USDC`);

    if (parseFloat(balanceUSDC) >= parseFloat(requiredUSDC)) {
      console.log(`✅ USDC payment verified`);
      return {
        verified: true,
        message: 'USDC payment verified',
        currency: 'USDC',
        balance: balanceUSDC,
      };
    } else {
      console.log(`❌ Insufficient USDC balance`);
      return {
        verified: false,
        message: `Insufficient USDC. Have: ${balanceUSDC}, Need: ${requiredUSDC}`,
      };
    }
  } catch (error) {
    console.error('❌ USDC verification error:', error.message);
    return {
      verified: false,
      message: `USDC verification failed: ${error.message}`,
    };
  }
}

async function verifySolanaTokenPayment(
  walletAddress,
  deviceId,
  tokenMint,
  amountRequired
) {
  try {
    console.log(
      `\n💰 Verifying Solana token payment from ${walletAddress.substring(
        0,
        10
      )}...`
    );
    console.log(`   Token: ${tokenMint.substring(0, 10)}...`);
    console.log(
      `   Required: ${amountRequired / Math.pow(10, TSE_DECIMALS)} TSE`
    );

    // Create connection to Solana mainnet
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    // Parse wallet address
    let walletPublicKey;
    try {
      walletPublicKey = new PublicKey(walletAddress);
    } catch (e) {
      console.error('❌ Invalid Solana wallet address:', walletAddress);
      return {
        verified: false,
        message: 'Invalid Solana wallet address format',
      };
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
      return {
        verified: false,
        message: 'No TSE token account found. Please acquire some TSE.',
      };
    }

    // Get the balance of the first token account
    const tokenAccount = tokenAccounts.value[0];
    const accountInfo = await connection.getParsedAccountInfo(
      tokenAccount.pubkey
    );

    if (!accountInfo.value || !accountInfo.value.data.parsed) {
      console.log(`❌ Could not parse token account data`);
      return { verified: false, message: 'Error reading token account' };
    }

    const balance = BigInt(
      accountInfo.value.data.parsed.info.tokenAmount.amount
    );
    const balanceTSE = Number(balance) / Math.pow(10, TSE_DECIMALS);
    const requiredTSE = amountRequired / Math.pow(10, TSE_DECIMALS);

    console.log(`   Wallet balance: ${balanceTSE} TSE`);
    console.log(`   Required: ${requiredTSE} TSE`);

    if (balance >= BigInt(amountRequired)) {
      console.log(`✅ TSE payment verified`);
      return {
        verified: true,
        message: 'TSE payment verified',
        currency: 'TSE',
        balance: balanceTSE.toFixed(2),
      };
    } else {
      console.log(`❌ Insufficient TSE balance`);
      return {
        verified: false,
        message: `Insufficient TSE. Have: ${balanceTSE.toFixed(
          2
        )}, Need: ${requiredTSE.toFixed(2)}`,
      };
    }
  } catch (error) {
    console.error('❌ Solana payment verification error:', error.message);
    return {
      verified: false,
      message: `Solana verification failed: ${error.message}`,
    };
  }
}

// ============ X.402 CHALLENGE STORE ============

// In-memory challenge table
const challenges = new Map();
/*
  challengeId -> {
    deviceId,
    walletAddress,
    chain,
    token,
    amount,
    receiver,
    createdAt,
    expiresAt,
    paid,
    txHash,
    accessToken
  }
*/

function createX402Challenge({
  deviceId,
  walletAddress,
  chain,
  token,
  amount,
  receiver,
  ttlSeconds = 600,
}) {
  const challengeId = crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  const record = {
    deviceId,
    walletAddress,
    chain,
    token,
    amount,
    receiver,
    createdAt: now,
    expiresAt,
    paid: false,
    txHash: null,
    accessToken: null,
  };

  challenges.set(challengeId, record);
  return { challengeId, record };
}

// ============ X.402: VERIFY REAL TSE PAYMENT BY TX (B2 STRICT) ============

async function verifySolanaTsePaymentByTx(
  txHash,
  expectedReceiver,
  tokenMint,
  amountRequired
) {
  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    console.log(`\n🔎 X.402: Checking Solana tx ${txHash}`);
    console.log(`   Expected receiver: ${expectedReceiver}`);
    console.log(`   Required raw amount: ${amountRequired}`);

    const tx = await connection.getTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      console.log('❌ X.402: Transaction not found');
      return { verified: false, message: 'Transaction not found' };
    }

    if (!tx.meta || tx.meta.err) {
      console.log('❌ X.402: Transaction failed on-chain');
      return { verified: false, message: 'On-chain transaction failed' };
    }

    const mintPk = new PublicKey(tokenMint);
    const receiverPk = new PublicKey(expectedReceiver);

    // B2: require that the fee payer is the same wallet that requested access
    const feePayer = tx.transaction.message.accountKeys[0];
    console.log(`   Fee payer: ${feePayer.toBase58()}`);

    // The caller will separately ensure walletAddress matches fee payer.

    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];

    let receivedAmount = 0n;

    // B2: Only count TSE that lands in the EXPECTED RECEIVER's token account
    for (const postEntry of post) {
      if (
        postEntry.mint === mintPk.toBase58() &&
        postEntry.owner === receiverPk.toBase58()
      ) {
        const preEntry = pre.find(
          (p) => p.accountIndex === postEntry.accountIndex
        );

        const before = preEntry
          ? BigInt(preEntry.uiTokenAmount.amount)
          : 0n;
        const after = BigInt(postEntry.uiTokenAmount.amount);
        const diff = after - before;

        if (diff > 0n) {
          receivedAmount += diff;
        }
      }
    }

    console.log(`   Receiver gained: ${receivedAmount.toString()} raw`);
    console.log(
      `   Required:        ${BigInt(amountRequired).toString()} raw`
    );

    if (receivedAmount >= BigInt(amountRequired)) {
      console.log('✅ X.402: TSE payment verified in tx (B2 strict)');
      return {
        verified: true,
        message: 'TSE payment verified by transaction',
        amount: receivedAmount,
      };
    } else {
      console.log('❌ X.402: Not enough TSE in tx to receiver');
      return {
        verified: false,
        message: 'Transaction did not send required TSE amount to receiver',
      };
    }
  } catch (error) {
    console.error('❌ X.402 Solana tx verification error:', error.message);
    return {
      verified: false,
      message: `Solana tx verification failed: ${error.message}`,
    };
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
 * Request authentication challenge (existing flow – NOT X.402)
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

  console.log(
    `\n🔐 Challenge requested for ${deviceId} by ${walletAddress.substring(
      0,
      10
    )}...`
  );

  const challenge =
    Math.random().toString(36).substring(2, 15) +
    Date.now().toString(36);
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
 * (existing flow – balance-based, NOT X.402)
 */
app.post('/devices/:deviceId/verify', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, challenge, signature, timestamp, paymentMethod } =
    req.body;

  if (!devices[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }

  console.log(
    `\n🔐 Verify request for ${deviceId} from ${walletAddress.substring(
      0,
      10
    )}...`
  );

  const device = devices[deviceId];

  // Handle lock devices
  if (device.supportsLock) {
    let paymentCheck;

    // Determine payment method (default to USDC)
    const method = paymentMethod?.toUpperCase() || 'USDC';

    if (method === 'TSE') {
      paymentCheck = await verifySolanaTokenPayment(
        walletAddress,
        deviceId,
        TSE_MINT,
        TSE_COST
      );
    } else {
      paymentCheck = await verifyBaseUSDCPayment(
        walletAddress,
        deviceId,
        USDC_COST
      );
    }

    if (!paymentCheck.verified) {
      const amount =
        method === 'TSE'
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

    console.log(
      `   ✅ Payment verified (${method}), issuing 30-min session token`
    );

    return res.json({
      verified: true,
      sessionToken,
      deviceData: device,
      accessLevel: 'full',
      sessionDuration: 1800,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      paymentMethod: method,
      cost:
        method === 'TSE'
          ? `${(TSE_COST / Math.pow(10, TSE_DECIMALS)).toFixed(0)} TSE`
          : ethers.formatUnits(USDC_COST, USDC_DECIMALS),
      message:
        'Session established - ${method} payment accepted. Pay once, unlimited lock/unlock for 30 minutes',
    });
  }

  // Handle coffee devices
  if (device.supportsTimer) {
    let paymentCheck;
    const method = paymentMethod?.toUpperCase() || 'USDC';

    if (method === 'TSE') {
      paymentCheck = await verifySolanaTokenPayment(
        walletAddress,
        deviceId,
        TSE_MINT,
        TSE_COST
      );
    } else {
      paymentCheck = await verifyBaseUSDCPayment(
        walletAddress,
        deviceId,
        USDC_COST
      );
    }

    if (!paymentCheck.verified) {
      const amount =
        method === 'TSE'
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
      cost:
        method === 'TSE'
          ? `${(TSE_COST / Math.pow(10, TSE_DECIMALS)).toFixed(0)} TSE`
          : ethers.formatUnits(USDC_COST, USDC_DECIMALS),
      message: `${method} payment verified - select your brew type`,
    });
  }

  return res.status(400).json({ error: 'Unknown device type' });
});

/**
 * Unlock device (requires session token – existing flow)
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
 * Lock device (requires session token – existing flow)
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
    walletAddress: walletAddress
      ? walletAddress.substring(0, 10) + '...'
      : 'mock',
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

// ============ X.402 ROUTES ============

/**
 * X.402: Request payment challenge
 * POST /x402/:deviceId/challenge
 * body: { walletAddress }
 */
app.post('/x402/:deviceId/challenge', (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress } = req.body;

  const device = devices[deviceId];
  if (!device) {
    return res.status(404).json({ error: 'Device not found', deviceId });
  }
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }

  console.log(
    `\n🧾 X.402 challenge requested for ${deviceId} by ${walletAddress.substring(
      0,
      10
    )}...`
  );

  const amountRequired = TSE_COST;

  const { challengeId, record } = createX402Challenge({
    deviceId,
    walletAddress,
    chain: 'solana',
    token: 'TSE',
    amount: amountRequired,
    receiver: TSE_RECEIVER_WALLET,
    ttlSeconds: 600, // 10 minutes
  });

  return res.json({
    challengeId,
    deviceId,
    payment: {
      chain: record.chain,
      token: record.token,
      amount: record.amount,
      mint: TSE_MINT,
      receiver: record.receiver,
      decimals: TSE_DECIMALS,
      expiresAt: record.expiresAt.toISOString(),
    },
    message:
      'Send the specified TSE amount to the receiver address before expiresAt, then call /x402/:deviceId/verify with the txHash.',
  });
});

/**
 * X.402: Verify payment + issue access token
 * POST /x402/:deviceId/verify
 * body: { walletAddress, challengeId, txHash }
 */
app.post('/x402/:deviceId/verify', async (req, res) => {
  const { deviceId } = req.params;
  const { walletAddress, challengeId, txHash } = req.body;

  const device = devices[deviceId];
  if (!device) {
    return res.status(404).json({ error: 'Device not found', deviceId });
  }

  if (!walletAddress || !challengeId || !txHash) {
    return res
      .status(400)
      .json({ error: 'walletAddress, challengeId and txHash required' });
  }

  const record = challenges.get(challengeId);
  if (!record) {
    return res.status(404).json({ error: 'Challenge not found', challengeId });
  }

  if (record.deviceId !== deviceId) {
    return res.status(400).json({ error: 'Challenge does not match device' });
  }

  if (record.walletAddress !== walletAddress) {
    return res
      .status(400)
      .json({ error: 'Challenge does not belong to wallet' });
  }

  const now = new Date();
  if (now > record.expiresAt) {
    return res.status(410).json({ error: 'Challenge expired' });
  }

  if (record.paid) {
    return res.status(409).json({
      error: 'Challenge already used',
      accessToken: record.accessToken,
      txHash: record.txHash,
    });
  }

  console.log(
    `\n💳 X.402 verify for challenge ${challengeId}, tx ${txHash}`
  );

  const paymentCheck = await verifySolanaTsePaymentByTx(
    txHash,
    record.receiver,
    TSE_MINT,
    record.amount
  );

  if (!paymentCheck.verified) {
    return res.status(402).json({
      verified: false,
      message: paymentCheck.message,
      challengeId,
    });
  }

  // Issue X.402 access token (JWT)
  const payload = {
    type: 'x402-access',
    walletAddress,
    deviceId,
    challengeId,
    txHash,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
  };

  const accessToken = jwt.sign(payload, JWT_SECRET);

  record.paid = true;
  record.txHash = txHash;
  record.accessToken = accessToken;
  challenges.set(challengeId, record);

  console.log(`✅ X.402 access token issued for ${deviceId}`);

  return res.json({
    verified: true,
    deviceId,
    challengeId,
    txHash,
    accessToken,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    message:
      'Payment verified. Use this accessToken as Bearer token to control the device via X.402 endpoints.',
  });
});

/**
 * Middleware: require valid X.402 access token
 */
function requireX402(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res
      .status(401)
      .json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'x402-access') {
      throw new Error('Wrong token type');
    }
    req.x402 = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Invalid or expired X.402 access token',
      message: error.message,
    });
  }
}

/**
 * X.402: Unlock using X.402 token
 */
app.post('/x402/:deviceId/unlock', requireX402, (req, res) => {
  const { deviceId } = req.params;

  if (req.x402.deviceId !== deviceId) {
    return res
      .status(403)
      .json({ error: 'Token not valid for this device' });
  }

  console.log(`\n🔓 X.402 unlock request for ${deviceId} (token OK)`);

  res.json({
    success: true,
    granted: true,
    action: 'unlock',
    deviceId,
    walletAddress: req.x402.walletAddress.substring(0, 10) + '...',
    timestamp: new Date().toISOString(),
    sessionExpiresAt: new Date(req.x402.exp * 1000).toISOString(),
    message: '✅ Device unlocked via X.402 access token',
  });
});

/**
 * X.402: Lock using X.402 token
 */
app.post('/x402/:deviceId/lock', requireX402, (req, res) => {
  const { deviceId } = req.params;

  if (req.x402.deviceId !== deviceId) {
    return res
      .status(403)
      .json({ error: 'Token not valid for this device' });
  }

  console.log(`\n🔒 X.402 lock request for ${deviceId} (token OK)`);

  res.json({
    success: true,
    granted: true,
    action: 'lock',
    deviceId,
    walletAddress: req.x402.walletAddress.substring(0, 10) + '...',
    timestamp: new Date().toISOString(),
    sessionExpiresAt: new Date(req.x402.exp * 1000).toISOString(),
    message: '✅ Device locked via X.402 access token',
  });
});

// ============ PHANTOM TRANSACTION BUILDING (FIXED SPL-TOKEN IMPORT) ============

/**
 * Build a Solana transaction for Phantom to sign
 * POST /transactions/build
 * body: { senderWallet, recipientWallet, amount, tokenType }
 */
app.post('/transactions/build', async (req, res) => {
  const { senderWallet, recipientWallet, amount, tokenType } = req.body;

  console.log(`\n💳 Building ${tokenType} transaction...`);
  console.log(`   Sender: ${senderWallet?.substring(0, 10)}...`);
  console.log(`   Recipient: ${recipientWallet?.substring(0, 10)}...`);
  console.log(`   Amount: ${amount}`);

  // Validate inputs
  if (!senderWallet || !recipientWallet || !amount || !tokenType) {
    return res.status(400).json({
      success: false,
      error:
        'Missing required fields: senderWallet, recipientWallet, amount, tokenType',
    });
  }

  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    // Parse addresses
    let sender, recipient;
    try {
      sender = new PublicKey(senderWallet);
      recipient = new PublicKey(recipientWallet);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address format',
      });
    }

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = sender;

    if (tokenType.toUpperCase() === 'SOL') {
      // Native SOL transfer
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
      console.log(`   Lamports: ${lamports}`);

      transaction.add(
        SystemProgram.transfer({
          fromPubkey: sender,
          toPubkey: recipient,
          lamports: lamports,
        })
      );
    } else if (tokenType.toUpperCase() === 'TSE') {
      // TSE token transfer
      const tseMint = new PublicKey(TSE_MINT);
      const tokenAmount = Math.floor(amount * Math.pow(10, TSE_DECIMALS));
      console.log(`   Token amount (raw): ${tokenAmount}`);

      // Get sender's token account
      const senderTokenAccount = await getAssociatedTokenAddress(
        tseMint,
        sender,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Check sender has token account
      const senderAccountInfo = await connection.getAccountInfo(
        senderTokenAccount
      );
      if (!senderAccountInfo) {
        return res.status(400).json({
          success: false,
          error: 'Sender does not have a TSE token account',
        });
      }

      // Get recipient's token account
      const recipientTokenAccount = await getAssociatedTokenAddress(
        tseMint,
        recipient,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Check if recipient token account exists
      const recipientAccountInfo = await connection.getAccountInfo(
        recipientTokenAccount
      );
      if (!recipientAccountInfo) {
        // Create associated token account for recipient
        console.log('   Creating recipient token account...');
        transaction.add(
          createAssociatedTokenAccountInstruction(
            sender, // payer
            recipientTokenAccount, // ata
            recipient, // owner
            tseMint, // mint
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      // Add transfer instruction
      transaction.add(
        createTransferInstruction(
          senderTokenAccount,
          recipientTokenAccount,
          sender,
          tokenAmount,
          [],
          TOKEN_PROGRAM_ID
        )
      );
    } else {
      return res.status(400).json({
        success: false,
        error: `Unknown token type: ${tokenType}. Use 'SOL' or 'TSE'.`,
      });
    }

    // Serialize transaction (without signatures)
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    const base64Tx = serialized.toString('base64');
    console.log(`✅ Transaction built, base64 length: ${base64Tx.length}`);

    return res.json({
      success: true,
      transaction: base64Tx,
      message: 'Transaction built successfully. Send to Phantom for signing.',
    });
  } catch (error) {
    console.error('❌ Error building transaction:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Submit a signed transaction to Solana
 * POST /transactions/submit
 * body: { transaction }
 *
 * Note: Phantom returns the fully signed transaction, not just the signature.
 * The 'transaction' field should contain the signed transaction from Phantom.
 */
app.post('/transactions/submit', async (req, res) => {
  const { transaction } = req.body;

  console.log(`\n📤 Submitting signed transaction to Solana...`);

  if (!transaction) {
    return res.status(400).json({
      success: false,
      error: 'Missing required field: transaction',
    });
  }

  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    // Decode the base64 transaction
    const txBuffer = Buffer.from(transaction, 'base64');

    // Send the raw transaction
    const txHash = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    console.log(`✅ Transaction sent: ${txHash}`);

    // Wait for confirmation
    console.log('   Waiting for confirmation...');
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');

    const confirmation = await connection.confirmTransaction(
      {
        signature: txHash,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed'
    );

    if (confirmation.value.err) {
      console.error('❌ Transaction failed:', confirmation.value.err);
      return res.status(400).json({
        success: false,
        error: 'Transaction failed on-chain',
        details: confirmation.value.err,
      });
    }

    console.log(`✅ Transaction confirmed: ${txHash}`);

    return res.json({
      success: true,
      txHash: txHash,
      message: 'Transaction submitted and confirmed successfully',
    });
  } catch (error) {
    console.error('❌ Error submitting transaction:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
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
  console.log('📡 TSE Receiver Wallet (X.402):', TSE_RECEIVER_WALLET);
  console.log('💳 Transaction Building: /transactions/build');
  console.log('📤 Transaction Submit: /transactions/submit');
  console.log('📱 Available Devices:');
  Object.keys(devices).forEach((id) => {
    const device = devices[id];
    console.log(`   - ${id}: ${device.deviceName}`);
  });
  console.log('\n');
});
