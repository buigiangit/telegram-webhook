import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// test route
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/webhook", (req, res) => res.status(200).send("OK /webhook"));

// webhook
app.post("/webhook", async (req, res) => {
  try {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;

  const sideIcon = side === "LONG" ? "🔵" : "🔴";
const sideText = side === "LONG" ? "LONG" : "SHORT";

// Nếu symbol có dạng BTCUSDT.P thì bạn muốn #BTC
const hashCoin = "#" + (symbol || "").replace(".P", "").replace("USDT", "").replace("PERP", "").replace(/[^A-Z]/g, "").toUpperCase();

const { side, symbol, tf, price } = req.body;

const message = `
${side === "LONG" ? "🔵 LONG" : "🔴 SHORT"}  #${symbol}
🔹 Khung: ${tf}

👉 Entry: ${price}
👉 Stoploss: ${side === "LONG" ? (price * 0.99).toFixed(2) : (price * 1.01).toFixed(2)}

👉 TP1: ${side === "LONG" ? (price * 1.01).toFixed(2) : (price * 0.99).toFixed(2)}
👉 TP2: ${side === "LONG" ? (price * 1.02).toFixed(2) : (price * 0.98).toFixed(2)}

⚠️ Cảnh báo: Tín hiệu từ BOT, không phải khuyến nghị đầu tư.`;




    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message })
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// IMPORTANT: Render port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
