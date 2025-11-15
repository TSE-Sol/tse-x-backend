// server.js
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const app = express();

// ===== Config & constants =====
const PORT = process.env.PORT || 3000;
const BASE_USDC_RECEIVER =
  process.env.BASE_USDC_RECEIVER ||
  '0x8469a3A136AE586356bAA89C61191D8E2d84B92f';

// In-memory device state:
// devices[deviceId] = { state: 'locked' | 'unlocked', unlockUntil: number }
const devices = {};

// ===== Middleware =====
app.use(express.json());
app.use(morgan('dev'));
app.use(cors());

// ===== Helpers =====
function getDeviceState(deviceId) {
  if (!devices[deviceId]) {
    devices[deviceId] = { state: 'locked', unlockUntil: 0 };
  }

  const now = Date.now();
  if (devices[deviceId].unlockUntil && devices[deviceId].unlockUntil < now) {
    // auto-relock on expiry
    devices[deviceId].state = 'locked';
    devices[deviceId].unlockUntil = 0;
  }

  return devices[deviceId];
}

function setUnlocked(deviceId, minutes) {
  const now = Date.now();
  const ms = Number(minutes) * 60 * 1000;
  const unlockUntil = now + ms;

  devices[deviceId] = {
    state: 'unlocked',
    unlockUntil,
  };

  return unlockUntil;
}

function calculatePriceUSDC(minutes) {
  const m = Number(minutes) || 0;

  // Very simple pricing for now (can adjust later)
  if (m <= 15) return '0.10';
  if (m <= 30) return '0.20';
  if (m <= 60) return '0.30';
  return '1.00'; // 24h or anything longer
}

// ===== Routes =====

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'TSE-X backend is running' });
});

// Current device state
app.get('/api/devices/:id/state', (req, res) => {
  const deviceId = req.params.id;
  const d = getDeviceState(deviceId);
  res.json({
    state: d.state,
    unlockUntil: d.unlockUntil || 0,
  });
});

// x402-style unlock request: returns 402 Payment Required
app.post('/api/unlock-request', (req, res) => {
  try {
    const { deviceId, minutes } = req.body || {};

    if (!deviceId || !minutes) {
      return res
        .status(400)
        .json({ error: 'deviceId and minutes are required' });
    }

    const amount = calculatePriceUSDC(minutes);

    const paymentRequired = {
      version: '1',
      network: 'base',
      token: 'USDC',
      to: BASE_USDC_RECEIVER,
      amount, // USDC amount as string
      metadata: {
        deviceId,
        minutes,
        description: 'TSE-X bike rental',
      },
    };

    console.log('unlock-request -> 402 Payment Required:', paymentRequired);

    // 402 means "Payment Required" in HTTP
    return res.status(402).json(paymentRequired);
  } catch (e) {
    console.error('unlock-request error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Dev-mode unlock-confirm: DOES NOT VERIFY ON-CHAIN (yet)
// Just accepts txHash and unlocks for N minutes
app.post('/api/unlock-confirm', async (req, res) => {
  try {
    const { deviceId, minutes, txHash } = req.body || {};

    if (!deviceId || !minutes || !txHash) {
      return res
        .status(400)
        .json({ error: 'deviceId, minutes, and txHash are required' });
    }

    console.log('DEV unlock-confirm called with:', { deviceId, minutes, txHash });

    // In real mode, here you would:
    // - call Alchemy / Base RPC with txHash
    // - check it is on Base
    // - check token = USDC
    // - check "to" = BASE_USDC_RECEIVER
    // - check amount ≥ calculatePriceUSDC(minutes)
    //
    // For now, dev mode: always unlock
    const unlockUntil = setUnlocked(deviceId, minutes);

    return res.json({ ok: true, unlockUntil });
  } catch (e) {
    console.error('unlock-confirm error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== Start server =====
app.listen(PORT, () => {
  console.log(`TSE-X backend listening on port ${PORT}`);
  console.log(`USDC receiver: ${BASE_USDC_RECEIVER}`);
});
