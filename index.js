import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ====== CẤU HÌNH ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID  = process.env.CHAT_ID;

// ====== WEBHOOK ======
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message || "No message";

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message
      })
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ====== PORT CHO RENDER ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
