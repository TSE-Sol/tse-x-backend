import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const RPC = process.env.BASE_RPC_URL;
const RECEIVER = process.env.BASE_USDC_RECEIVER.toLowerCase();

const USDC_ADDRESS = "0xd9aAEc86B65D86f6A7b5b1b0c42fff0905A1aA77".toLowerCase();

export async function verifyBasePayment({ txHash, expectedAmount }) {
  try {
    const response = await axios.post(RPC, {
      id: 1,
      jsonrpc: "2.0",
      method: "eth_getTransactionReceipt",
      params: [txHash]
    });

    const receipt = response.data.result;
    if (!receipt) return false;

    if (receipt.to.toLowerCase() !== USDC_ADDRESS) return false;

    const logs = receipt.logs;
    if (!logs) return false;

    const transferLog = logs[0];
    if (!transferLog) return false;

    const topics = transferLog.topics;
    const receiver = "0x" + topics[2].substring(26);

    if (receiver.toLowerCase() !== RECEIVER) return false;

    const amountHex = transferLog.data;
    const amount = parseInt(amountHex, 16) / 1e6;

    return amount >= parseFloat(expectedAmount);

  } catch (err) {
    console.error("verifyBasePayment error:", err.message);
    return false;
  }
}
