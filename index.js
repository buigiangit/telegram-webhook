// index.js — TradingView(Pine alert JSON) -> ChatGPT quyết định -> Telegram
// ENV bắt buộc trên Render:
//   BOT_TOKEN
//   CHAT_ID
//   OPENAI_API_KEY
// (tuỳ chọn) OPENAI_MODEL=gpt-4o-mini

import express from "express";
import fetch from "node-fetch";

const app = express();

// Support both JSON & text/plain bodies
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ type: ["text/plain", "text/*"], limit: "1mb" }));

// ============ ENV ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ============ CONFIG ============
const MIN_PRICE_GAP = 200;        // tín hiệu mới cách tín hiệu trước <200 -> bỏ
const COOLDOWN_MS = 30_000;       // chống spam theo thời gian
const MIN_CONFIDENCE = 65;        // score tối thiểu mới gửi
const DEFAULT_SL_PCT = 1.0;       // SL ~ 1% (chưa đòn bẩy)
const RR_TP1 = 1;                 // TP1 = 1R
const RR_TP2 = 2;                 // TP2 = 2R

let lastSignal = { side: null, price: null, ts: 0 };

// ============ HELPERS ============
function ensureEnv() {
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!CHAT_ID) missing.push("CHAT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (missing.length) throw new Error(`Missing ENV: ${missing.join(", ")}`);
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function safeJsonParse(body) {
  if (typeof body === "object" && body !== null) return body;
  if (typeof body !== "string") return {};
  const s = body.trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { message: s }; }
}

function formatTF(tfRaw) {
  if (tfRaw === undefined || tfRaw === null) return "";
  const s = String(tfRaw).trim();

  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n < 60) return `M${n}`;
    if (n % 60 === 0) return `H${n / 60}`;
    return `M${n}`;
  }

  const low = s.toLowerCase();
  if (low === "d") return "1D";
  if (low.endsWith("d")) {
    const n = parseInt(low.replace("d", ""), 10);
    if (Number.isFinite(n)) return `${n}D`;
  }
  if (low.endsWith("m")) {
    const n = parseInt(low.replace("m", ""), 10);
    if (Number.isFinite(n)) return `M${n}`;
  }
  if (low.endsWith("h")) {
    const n = parseInt(low.replace("h", ""), 10);
    if (Number.isFinite(n)) return `H${n}`;
  }
  return s.toUpperCase();
}

function calcLevels(side, entry, slPct = DEFAULT_SL_PCT, rr1 = RR_TP1, rr2 = RR_TP2) {
  const slDist = entry * (slPct / 100);
  let sl, tp1, tp2;
  if (side === "LONG") {
    sl = entry - slDist;
    tp1 = entry + slDist * rr1;
    tp2 = entry + slDist * rr2;
  } else {
    sl = entry + slDist;
    tp1 = entry - slDist * rr1;
    tp2 = entry - slDist * rr2;
  }
  return { sl, tp1, tp2 };
}

async function sendTelegram(text) {
  ensureEnv();
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  return data;
}

function buildTelegramMsg({ side, tfFocus, entry, sl, tp1, tp2, confidence, reason }) {
  const icon = side === "LONG" ? "🔵" : "🔴";
  const sideText = side;
  const tfsLine = "|H1|M15|M30|H4|1D"; // đúng format bạn muốn

  return `CDT - BOT
${icon} ${sideText}  #BTC ${tfsLine}

👉 Entry: ${entry.toFixed(2)}
👉 Stoploss: ${sl.toFixed(2)}
👉 TP1: ${tp1.toFixed(2)}
👉 TP2: ${tp2.toFixed(2)}

🔹 Score: ${Math.round(confidence)}/100
👉 ${reason || ""}

⚠️ Cảnh báo: Tín hiệu từ bot/AI (tự động), không phải lời khuyến khích đầu tư.`;
}

// ============ CHATGPT CALL ============
async function askChatGPT(input) {
  ensureEnv();

  // input là JSON từ Pine: ema34/ema50/rsi/atr/pivot/touch/confirm...
  // AI sẽ trả LONG/SHORT/NONE + confidence + sl_pct + rr1/rr2 + reason
  const prompt = `
Bạn là AI trader theo phong cách của tôi:

✅ Ưu tiên 3 case:
(1) Nến xác nhận đảo chiều (đỏ→xanh => LONG, xanh→đỏ => SHORT) và vào sau khi nến xác nhận đóng.
(2) Chạm vùng đỉnh/đáy nhiều nến trước (pivot).
(3) Chạm Sonic R (EMA34) hoặc EMA quan trọng.

⚠️ Tránh sideway/nhiễu: nếu tín hiệu yếu hoặc mâu thuẫn -> NONE.
Hãy dùng dữ liệu JSON dưới đây để quyết định.

Trả về JSON HỢP LỆ (không thêm chữ ngoài JSON):
{
 "side":"LONG|SHORT|NONE",
 "confidence":0-100,
 "tf_focus":"M15|M30|H1|H4|1D",
 "sl_pct":1.0,
 "rr1":1,
 "rr2":2,
 "reason":"1-2 câu ngắn gọn nêu case (confirm/pivot/ema34) và lý do"
}

Dữ liệu:
${JSON.stringify(input)}
`.trim();

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Chỉ trả JSON hợp lệ theo schema yêu cầu." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`OpenAI error: ${JSON.stringify(data).slice(0, 400)}`);

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenAI empty response: ${JSON.stringify(data).slice(0, 300)}`);

  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`OpenAI non-JSON: ${content.slice(0, 300)}`); }

  const sideRaw = String(parsed.side || "NONE").toUpperCase();
  const side = sideRaw.includes("LONG") ? "LONG" : sideRaw.includes("SHORT") ? "SHORT" : "NONE";

  return {
    side,
    confidence: toNum(parsed.confidence) ?? 0,
    tf_focus: String(parsed.tf_focus || input.tf || "M15"),
    sl_pct: toNum(parsed.sl_pct) ?? DEFAULT_SL_PCT,
    rr1: toNum(parsed.rr1) ?? RR_TP1,
    rr2: toNum(parsed.rr2) ?? RR_TP2,
    reason: String(parsed.reason || "").slice(0, 350),
  };
}

// ============ ROUTES ============
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => {
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!CHAT_ID) missing.push("CHAT_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  res.json({ ok: true, missing });
});

app.post("/test-telegram", async (req, res) => {
  try {
    const body = safeJsonParse(req.body);
    const text = body?.text || "✅ TEST Telegram OK";
    await sendTelegram(text);
    res.json({ ok: true });
  } catch (e) {
    console.error("TEST TELEGRAM ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Pine sẽ bắn JSON qua đây
app.post("/webhook", async (req, res) => {
  try {
    const body = safeJsonParse(req.body);

    // dữ liệu tối thiểu phải có
    const symbol = String(body.symbol || "BTCUSDT.P");
    const tf = formatTF(body.tf || body.interval || "");
    const price = toNum(body.price || body.close || body.entry);

    if (!price) return res.status(400).json({ ok: false, error: "Missing price (price/close/entry)" });

    // chống spam theo thời gian + theo gap giá
    const now = Date.now();
    if (lastSignal.ts && now - lastSignal.ts < COOLDOWN_MS) {
      return res.json({ ok: true, skipped: "cooldown" });
    }
    if (lastSignal.price && Math.abs(price - lastSignal.price) < MIN_PRICE_GAP) {
      return res.json({ ok: true, skipped: "min_gap", last: lastSignal, now: { price } });
    }

    // ====== GỌI CHATGPT ======
    const ai = await askChatGPT({
      symbol,
      tf,
      price,
      ema34: toNum(body.ema34),
      ema50: toNum(body.ema50),
      rsi: toNum(body.rsi),
      atr: toNum(body.atr),
      confirmLong: toNum(body.confirmLong) === 1,
      confirmShort: toNum(body.confirmShort) === 1,
      touchSonic: toNum(body.touchSonic) === 1,
      touchEMA50: toNum(body.touchEMA50) === 1,
      touchPH: toNum(body.touchPH) === 1,
      touchPL: toNum(body.touchPL) === 1,
      lastPH: toNum(body.lastPH),
      lastPL: toNum(body.lastPL),
    });

    if (ai.side === "NONE" || ai.confidence < MIN_CONFIDENCE) {
      return res.json({ ok: true, skipped: true, ai });
    }

    // tính SL/TP theo AI (hoặc default)
    const { sl, tp1, tp2 } = calcLevels(ai.side, price, ai.sl_pct, ai.rr1, ai.rr2);

    // format telegram
    const msg = buildTelegramMsg({
      side: ai.side,
      tfFocus: ai.tf_focus || tf || "M15",
      entry: price,
      sl,
      tp1,
      tp2,
      confidence: ai.confidence,
      reason: ai.reason,
    });

    await sendTelegram(msg);

    lastSignal = { side: ai.side, price, ts: now };

    res.json({ ok: true, sent: true, ai, levels: { entry: price, sl, tp1, tp2 } });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
