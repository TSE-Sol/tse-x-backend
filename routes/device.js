import express from "express";
import fs from "fs";

const router = express.Router();

function readState() {
  return JSON.parse(fs.readFileSync("./state/devices.json"));
}

router.get("/devices/:id/state", (req, res) => {
  const id = req.params.id;
  const data = readState();

  if (!data[id]) {
    return res.json({ state: "locked", unlockUntil: 0 });
  }

  res.json(data[id]);
});

export default router;
