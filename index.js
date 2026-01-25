import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ====== CONFIG ======
const BINANCE_BASE = "https://api.binance.com";
const TIMEFRAMES = [
  { key: "M15", interval: "15m", limit: 300 },
  { key: "M30", interval: "30m", limit: 300 },
  { key: "H1", interval: "1h",  limit: 400 },
  { key: "H4", interval: "4h",  limit: 400 },
  { key: "1D", interval: "1d",  limit: 500 },
];

const MIN_PRICE_GAP = 200;     // bạn yêu cầu: vừa call cách nhau <200$ thì bỏ
const MIN_CONFIDENCE = 65;     // threshold AI (tự chỉnh)
let lastSignal = { side: null, price: null, ts: 0 };

// ====== Helpers: Indicators ======
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function rsi(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const out = new Array(closes.length).fill(null);
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function atr(highs, lows, closes, period = 14) {
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  // simple smoothing
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < tr.length; i++) {
    out[i + 1] = (out[i] * (period - 1) + tr[i]) / period;
  }
  return out;
}

// “vùng đỉnh/đáy nhiều cây trước” (pivot đơn giản)
function pivots(highs, lows, left = 3, right = 3) {
  const ph = new Array(highs.length).fill(false);
  const pl = new Array(lows.length).fill(false);
  for (let i = left; i < highs.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (highs[j] > highs[i]) isHigh = false;
      if (lows[j] < lows[i]) isLow = false;
    }
    ph[i] = isHigh;
    pl[i] = isLow;
  }
  return { ph, pl };
}

// ====== Data fetch ======
async function fetchKlines(symbol, interval, limit) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance klines error ${r.status}`);
  const rows = await r.json();
  const o = [], h = [], l = [], c = [], t = [];
  for (const k of rows) {
    t.push(Number(k[0]));
    o.push(Number(k[1]));
    h.push(Number(k[2]));
    l.push(Number(k[3]));
    c.push(Number(k[4]));
  }
  return { t, o, h, l, c };
}

function buildFeatures(tfKey, series) {
  const { o, h, l, c } = series;
  const last = c.length - 1;

  const ema50 = ema(c, 50)[last];
  const ema200 = ema(c, 200)[last];
  const rsi14 = rsi(c, 14)[last];
  const atr14 = atr(h, l, c, 14)[last];

  const { ph, pl } = pivots(h, l, 3, 3);
  // lấy pivot gần nhất
  let lastPH = null, lastPL = null;
  for (let i = last - 1; i >= 0; i--) {
    if (lastPH === null && ph[i]) lastPH = h[i];
    if (lastPL === null && pl[i]) lastPL = l[i];
    if (lastPH !== null && lastPL !== null) break;
  }

  // “nến xác nhận đảo chiều”: cây 1 đỏ, cây 2 xanh -> long ở cây 3
  const prevRed = c[last - 1] < o[last - 1];
  const nowGreen = c[last] > o[last];
  const confirmLong = prevRed && nowGreen;

  const prevGreen = c[last - 1] > o[last - 1];
  const nowRed = c[last] < o[last];
  const confirmShort = prevGreen && nowRed;

  // chạm vùng pivot (đỉnh/đáy)
  const price = c[last];
  const touchPivotHigh = lastPH ? Math.abs(price - lastPH) <= (atr14 ?? 0) * 0.25 : false;
  const touchPivotLow  = lastPL ? Math.abs(price - lastPL) <= (atr14 ?? 0) * 0.25 : false;

  // chạm EMA (case 3)
  const touchEMA = (ema50 && Math.abs(price - ema50) <= (atr14 ?? 0) * 0.25) ||
                   (ema200 && Math.abs(price - ema200) <= (atr14 ?? 0) * 0.25);

  return {
    tf: tfKey,
    price,
    ema50, ema200, rsi14, atr14,
    lastPivotHigh: lastPH,
    lastPivotLow: lastPL,
    confirmLong, confirmShort,
    touchPivotHigh, touchPivotLow,
    touchEMA,
    trend: ema50 && ema200 ? (ema50 > ema200 ? "UP" : "DOWN") : "NA"
  };
}

// ====== OpenAI call (Chat Completions + JSON mode) ======
async function askAI(allFeatures) {
  const prompt = `
Bạn là AI quyết định LONG/SHORT cho BTC dựa trên dữ liệu đa khung.
Chỉ trả về JSON.

Mục tiêu:
- Nếu không rõ ràng -> side="NONE"
- Ưu tiên setup:
  (1) Nến xác nhận đảo chiều (confirmLong/confirmShort)
  (2) Chạm vùng pivot (touchPivotLow/touchPivotHigh)
  (3) Chạm EMA (touchEMA)
- Tránh nhiễu: nếu RSI trung tính và không chạm vùng/pivot/ema -> NONE
- Ưu tiên trade thuận xu hướng ở khung lớn (H4, 1D trend)

Trả về schema:
{"side":"LONG|SHORT|NONE","confidence":0-100,"reason":"ngắn gọn","tf_focus":"M15|M30|H1|H4|1D","sl_pct":number,"tp1_pct":number,"tp2_pct":number}

Gợi ý quản trị rủi ro:
- sl_pct mặc định 1
- tp1_pct 1
- tp2_pct 2
Dữ liệu:
${JSON.stringify(allFeatures)}
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`, // :contentReference[oaicite:0]{index=0}
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Chỉ xuất JSON hợp lệ." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" } // :contentReference[oaicite:1]{index=1}
    })
  });

  if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(text);
}

// ====== Telegram format giống bạn muốn ======
function formatTelegram(decision, symbol, price, tfsStr) {
  const side = decision.side;
  const icon = side === "LONG" ? "🔵" : side === "SHORT" ? "🔴" : "⚪️";
  const tag = `#${symbol.replace("USDT","")}`;

  const sl = side === "LONG" ? price * (1 - decision.sl_pct/100) : price * (1 + decision.sl_pct/100);
  const tp1 = side === "LONG" ? price * (1 + decision.tp1_pct/100) : price * (1 - decision.tp1_pct/100);
  const tp2 = side === "LONG" ? price * (1 + decision.tp2_pct/100) : price * (1 - decision.tp2_pct/100);

  return `${icon} ${side}  ${tag}  ${tfsStr}
🔹 Khung ${decision.tf_focus}

👉 Entry: ${price.toFixed(2)}
👉 Stoploss: ${sl.toFixed(2)}
👉 TP1: ${tp1.toFixed(2)}
👉 TP2: ${tp2.toFixed(2)}

🔹 Score: ${decision.confidence}/100
👉 Lý do: ${decision.reason}

⚠️ Cảnh báo: Tín hiệu từ bot/AI chỉ mang tính tham khảo, không phải lời khuyến khích đầu tư.`;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text })
  });
  if (!r.ok) throw new Error(`Telegram error ${r.status}`);
}

// ====== MAIN ENDPOINT ======
app.post("/decide", async (req, res) => {
  try {
    const symbol = String(req.body?.symbol ?? "BTCUSDT").toUpperCase();

    // 1) fetch all TF data
    const all = {};
    for (const tf of TIMEFRAMES) {
      const s = await fetchKlines(symbol, tf.interval, tf.limit);
      all[tf.key] = buildFeatures(tf.key, s);
    }

    // 2) AI decides
    const decision = await askAI(all);

    // 3) basic guards
    const mainPrice = all["M15"]?.price ?? all["H1"]?.price ?? 0;
    if (!mainPrice) return res.status(200).json({ ok: true, skipped: "no_price" });

    if (decision.side === "NONE" || (decision.confidence ?? 0) < MIN_CONFIDENCE) {
      return res.status(200).json({ ok: true, skipped: true, decision });
    }

    // 4) price-gap filter (200$)
    if (lastSignal.price && Math.abs(mainPrice - lastSignal.price) < MIN_PRICE_GAP) {
      return res.status(200).json({ ok: true, skipped: "min_gap", lastSignal, decision });
    }

    // 5) send telegram
    const tfsStr = "|H1|M15|M30|H4|1D"; // đúng format bạn muốn
    const text = formatTelegram(decision, symbol, mainPrice, tfsStr);
    await sendTelegram(text);

    lastSignal = { side: decision.side, price: mainPrice, ts: Date.now() };

    return res.status(200).json({ ok: true, sent: true, decision });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/", (req, res) => res.status(200).send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
