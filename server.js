import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
import paymentRoutes from "./routes/payment.js";
import deviceRoutes from "./routes/device.js";

app.use("/api", paymentRoutes);
app.use("/api", deviceRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TSE-X Backend running on port ${PORT}`);
});
