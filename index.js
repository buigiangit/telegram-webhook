import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const BINANCE_FUTURES = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";
const MIN_PRICE_GAP = 200;
const MIN_CONFIDENCE = 65;

// timeframes dùng cho AI
const TIMEFRAMES = [
  { key: "M15", interval: "15m", limit: 300 },
  { key: "M30", interval: "30m", limit: 300 },
  { key: "H1", interval: "1h", limit: 400 },
  { key: "H4", interval: "4h", limit: 400 },
  { key: "1D", interval: "1d", limit: 500 },
];

let lastSignal = { side: null, price: null };

// ================= INDICATORS =================
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  return values.map(v => (e = v * k + e * (1 - k)));
}

function rsi(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? (gains += d) : (losses -= d);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsis = new Array(closes.length).fill(null);
  rsis[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsis[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsis;
}

function atr(h, l, c, period = 14) {
  const tr = [];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  const out = new Array(c.length).fill(null);
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  out[period] = sum / period;
  for (let i = period; i < tr.length; i++) {
    out[i + 1] = (out[i] * (period - 1) + tr[i]) / period;
  }
  return out;
}

// ================= FETCH DATA =================
async function fetchKlines(interval, limit) {
  const url = `${BINANCE_FUTURES}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  const rows = await r.json();
  const o = [], h = [], l = [], c = [];
  rows.forEach(k => {
    o.push(+k[1]); h.push(+k[2]); l.push(+k[3]); c.push(+k[4]);
  });
  return { o, h, l, c };
}

// ================= FEATURE BUILDER =================
function buildFeatures(tf, data) {
  const { o, h, l, c } = data;
  const i = c.length - 1;

  const ema50 = ema(c, 50)[i];
  const ema200 = ema(c, 200)[i];
  const sonic = ema(c, 34)[i];
  const rsiv = rsi(c, 14)[i];
  const atrv = atr(h, l, c, 14)[i];
  const price = c[i];

  const confirmLong = c[i - 1] < o[i - 1] && c[i] > o[i];
  const confirmShort = c[i - 1] > o[i - 1] && c[i] < o[i];

  const t3Long = c[i - 2] < o[i - 2] && c[i - 1] > o[i - 1];
  const t3Short = c[i - 2] > o[i - 2] && c[i - 1] < o[i - 1];

  const buf = atrv * 0.25;

  return {
    tf,
    price,
    trend: ema50 > ema200 ? "UP" : "DOWN",
    ema50, ema200, sonic,
    rsi: rsiv,
    atr: atrv,
    confirmLong, confirmShort,
    t3Long, t3Short,
    touchEMA50: Math.abs(price - ema50) <= buf,
    touchEMA200: Math.abs(price - ema200) <= buf,
    touchSonic: Math.abs(price - sonic) <= buf
  };
}

// ================= AI DECISION =================
async function askAI(features) {
  const prompt = `
Bạn là AI trader BTCUSDT.P.
Phong cách:
- Vào T3 (nến xác nhận)
- Ưu tiên chạm EMA / Sonic R
- Tránh sideway
Trả JSON:
{"side":"LONG|SHORT|NONE","confidence":0-100,"tf_focus":"M15|M30|H1|H4|1D","sl_pct":1,"tp1_pct":1,"tp2_pct":2,"reason":"..."}
Dữ liệu:
${JSON.stringify(features)}
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Chỉ trả JSON hợp lệ" },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    })
  });

  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

// ================= TELEGRAM =================
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text })
  });
}

// ================= MAIN ENDPOINT =================
app.post("/decide", async (req, res) => {
  try {
    const all = {};
    for (const tf of TIMEFRAMES) {
      const data = await fetchKlines(tf.interval, tf.limit);
      all[tf.key] = buildFeatures(tf.key, data);
    }

    const decision = await askAI(all);
    const price = all.M15.price;

    if (decision.side === "NONE" || decision.confidence < MIN_CONFIDENCE)
      return res.json({ skipped: true, decision });

    if (lastSignal.price && Math.abs(price - lastSignal.price) < MIN_PRICE_GAP)
      return res.json({ skipped: "min_gap" });

    const sideIcon = decision.side === "LONG" ? "🔵" : "🔴";
    const sl = decision.side === "LONG"
      ? price * (1 - decision.sl_pct / 100)
      : price * (1 + decision.sl_pct / 100);
    const tp1 = decision.side === "LONG"
      ? price * (1 + decision.tp1_pct / 100)
      : price * (1 - decision.tp1_pct / 100);
    const tp2 = decision.side === "LONG"
      ? price * (1 + decision.tp2_pct / 100)
      : price * (1 - decision.tp2_pct / 100);

    const msg =
`CDT - BOT
${sideIcon} ${decision.side}  #BTC |H1|M15|M30|H4|1D
🔹 Khung ${decision.tf_focus}

👉 Entry: ${price.toFixed(2)}
👉 Stoploss: ${sl.toFixed(2)}
👉 TP1: ${tp1.toFixed(2)}
👉 TP2: ${tp2.toFixed(2)}

🔹 Score: ${decision.confidence}/100
👉 ${decision.reason}

⚠️ Tín hiệu từ bot/AI, không phải khuyến nghị đầu tư`;

    await sendTelegram(msg);
    lastSignal = { side: decision.side, price };

    res.json({ sent: true, decision });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 10000);
