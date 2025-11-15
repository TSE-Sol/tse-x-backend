import express from "express";
import { verifyBasePayment } from "../services/verifyBasePayment.js";
import fs from "fs";

const router = express.Router();

function readState() {
  return JSON.parse(fs.readFileSync("./state/devices.json"));
}

function writeState(data) {
  fs.writeFileSync("./state/devices.json", JSON.stringify(data, null, 2));
}

function priceFor(minutes) {
  if (minutes === 15) return "1.00";
  if (minutes === 30) return "1.50";
  if (minutes === 60) return "2.50";
  return "5.00";
}

// ---- 1. x402 Payment Request ----
router.post("/unlock-request", (req, res) => {
  const { deviceId, minutes } = req.body;

  const paymentRequirements = {
    version: "1",
    network: "base",
    token: "USDC",
    to: process.env.BASE_USDC_RECEIVER,
    amount: priceFor(minutes),
    metadata: { deviceId, minutes }
  };

  res.status(402).json(paymentRequirements);
});

// ---- 2. Payment Confirmation ----
router.post("/unlock-confirm", async (req, res) => {
  const { deviceId, minutes, txHash } = req.body;

  const isPaid = await verifyBasePayment({
    txHash,
    expectedAmount: priceFor(minutes)
  });

  if (!isPaid) {
    return res.status(400).json({ ok: false, error: "payment_not_verified" });
  }

  const now = Date.now();
  const unlockUntil = now + minutes * 60 * 1000;

  const data = readState();
  data[deviceId] = {
    state: "unlocked",
    unlockUntil
  };

  writeState(data);

  res.json({ ok: true, unlockUntil });
});

export default router;
