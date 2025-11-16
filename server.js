// server.js – TSE-X backend with real USDC on Base, remainingMs, and 0.01 USDC demo

require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const axios = require("axios");

const app = express();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// ---------- Config ----------
const PORT = process.env.PORT || 3000;

const BASE_RPC_URL = process.env.BASE_RPC_URL;
const BASE_USDC_RECEIVER =
  (process.env.BASE_USDC_RECEIVER ||
    "0x8469a3A136AE586356bAA89C61191D8E2d84B92f").toLowerCase();

// Official USDC contract on Base mainnet
const BASE_USDC_CONTRACT = (
  process.env.BASE_USDC_CONTRACT ||
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
).toLowerCase();

// ERC-20 Transfer(address,address,uint256) topic
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ---------- In-memory device state ----------
const devices = {
  "bike-1": {
    state: "locked", // "locked" | "unlocked"
    unlockUntil: 0,  // ms since epoch
  },
};

function getDevice(id) {
  if (!devices[id]) {
    devices[id] = { state: "locked", unlockUntil: 0 };
  }
  return devices[id];
}

function setLocked(deviceId) {
  const d = getDevice(deviceId);
  d.state = "locked";
  d.unlockUntil = 0;
  console.log(`Device ${deviceId} -> LOCKED`);
  return d.unlockUntil;
}

function setUnlocked(deviceId, minutes) {
  const d = getDevice(deviceId);
  const now = Date.now();
  const durMs = Number(minutes) * 60 * 1000;
  d.state = "unlocked";
  d.unlockUntil = now + durMs;
  console.log(
    `Device ${deviceId} -> UNLOCKED for ${minutes} min (until ${new Date(
      d.unlockUntil
    ).toISOString()})`
  );
  return d.unlockUntil;
}

// ---------- Pricing ----------
function calculatePriceUSDC(minutes) {
  const m = Number(minutes) || 0;

  // 30-second demo: 0.5 minutes = 0.01 USDC
  if (m > 0 && m < 1) return "0.01";

  if (m <= 15) return "0.10";
  if (m <= 30) return "0.20";
  if (m <= 60) return "0.30";

  // 24h or more
  return "1.00";
}

function usdcToUnits(amountStr) {
  // "0.10" -> 100000 (USDC has 6 decimals)
  const [whole, fracRaw = ""] = amountStr.split(".");
  const frac = (fracRaw + "000000").slice(0, 6); // pad/trim to 6
  return BigInt(whole || "0") * 1000000n + BigInt(frac || "0");
}

// ---------- Routes ----------

// Health check
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "TSE-X backend is running",
  });
});

// Current device state (Arduino polls this)
app.get("/api/devices/:id/state", (req, res) => {
  const id = req.params.id;
  const d = getDevice(id);

  const now = Date.now();

  // Auto relock if time expired
  if (d.state === "unlocked" && d.unlockUntil > 0 && now > d.unlockUntil) {
    d.state = "locked";
    d.unlockUntil = 0;
    console.log(`Auto-lock: device ${id} rental expired`);
  }

  let remainingMs = 0;
  if (d.state === "unlocked" && d.unlockUntil > now) {
    remainingMs = d.unlockUntil - now;
  }

  res.json({
    deviceId: id,
    state: d.state,
    unlockUntil: d.unlockUntil,
    remainingMs,
  });
});

// Start unlock request – returns 402 with payment details
app.post("/api/unlock-request", (req, res) => {
  const { deviceId, minutes } = req.body || {};

  if (!deviceId || !minutes) {
    return res
      .status(400)
      .json({ error: "deviceId and minutes are required" });
  }

  const price = calculatePriceUSDC(minutes);
  console.log("unlock-request", { deviceId, minutes, price });

  // 402 Payment Required – app expects amount + to
  return res.status(402).json({
    deviceId,
    minutes,
    token: "USDC",
    network: "base-mainnet",
    amount: price, // human-readable USDC string
    to: BASE_USDC_RECEIVER,
    note: "Send USDC on Base, then paste tx hash to confirm.",
  });
});

// Confirm payment – real USDC verification on Base
app.post("/api/unlock-confirm", async (req, res) => {
  try {
    const { deviceId, minutes, txHash } = req.body || {};
    if (!deviceId || !minutes || !txHash) {
      return res
        .status(400)
        .json({ error: "deviceId, minutes, and txHash are required" });
    }

    if (!BASE_RPC_URL || !BASE_USDC_CONTRACT) {
      return res.status(500).json({
        error:
          "Server not configured for on-chain verification (missing BASE_RPC_URL or BASE_USDC_CONTRACT)",
      });
    }

    const cleanHash = txHash.trim();
    console.log("unlock-confirm: verifying tx", {
      deviceId,
      minutes,
      txHash: cleanHash,
    });

    // ----- 1) Fetch transaction receipt -----
    const rpcBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [cleanHash],
    };

    const rpcRes = await axios.post(BASE_RPC_URL, rpcBody);
    const receipt = rpcRes.data && rpcRes.data.result;

    if (!receipt) {
      return res
        .status(400)
        .json({ error: "Transaction not found on Base RPC" });
    }

    if (receipt.status !== "0x1") {
      return res
        .status(400)
        .json({ error: "Transaction did not succeed (status != 0x1)" });
    }

    // ----- 2) Scan logs for USDC Transfer(to = your wallet) -----
    const requiredAmountStr = calculatePriceUSDC(minutes);
    const requiredUnits = usdcToUnits(requiredAmountStr);
    const receiverLower = BASE_USDC_RECEIVER;

    let paidUnits = 0n;
    const logs = receipt.logs || [];

    for (const log of logs) {
      if (!log.address || log.address.toLowerCase() !== BASE_USDC_CONTRACT) {
        continue;
      }

      const topics = log.topics || [];
      if (!topics.length || topics[0].toLowerCase() !== TRANSFER_TOPIC) {
        continue;
      }

      // topics[2] = "to" address, padded to 32 bytes
      if (topics.length < 3) continue;
      const toTopic = topics[2];
      const toAddr = ("0x" + toTopic.slice(-40)).toLowerCase();

      if (toAddr !== receiverLower) continue;

      // data = value (uint256) in hex
      if (!log.data || !log.data.startsWith("0x")) continue;
      const value = BigInt(log.data);

      paidUnits += value;
    }

    if (paidUnits < requiredUnits) {
      const paidHuman = Number(paidUnits) / 1_000_000;
      return res.status(400).json({
        error: `Payment too small. Required ${requiredAmountStr} USDC, got ${paidHuman}`,
      });
    }

    console.log(
      `unlock-confirm: USDC payment verified. units=${paidUnits.toString()}`
    );

    // ----- 3) All good -> unlock device -----
    const unlockUntil = setUnlocked(deviceId, minutes);

    return res.json({ ok: true, unlockUntil });
  } catch (err) {
    console.error("unlock-confirm error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Optional: manual lock endpoint (for debugging/admin)
app.post("/api/devices/:id/lock", (req, res) => {
  const id = req.params.id;
  const unlockUntil = setLocked(id);
  res.json({ ok: true, deviceId: id, unlockUntil });
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`TSE-X backend listening on port ${PORT}`);
  console.log(`USDC receiver: ${BASE_USDC_RECEIVER}`);
  console.log(`USDC contract: ${BASE_USDC_CONTRACT}`);
});
