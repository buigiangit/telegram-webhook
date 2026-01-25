// index.js (Node + Express) — TradingView webhook -> ChatGPT quyết định -> gửi Telegram
// Yêu cầu ENV:
//   BOT_TOKEN=xxxxx
//   CHAT_ID=-100xxxxxxxxxx
//   OPENAI_API_KEY=sk-xxxxx
// (khuyến nghị thêm) OPENAI_MODEL=gpt-4o-mini
//
// Cảnh báo: Đây là tín hiệu tự động từ bot/AI, không phải khuyến nghị đầu tư.

import express from "express";
import fetch from "node-fetch";

const app = express();

// TradingView đôi khi gửi JSON (application/json) hoặc text/plain -> ta hỗ trợ cả 2
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ type: ["text/plain", "text/*"], limit: "1mb" }));

// ============ ENV ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ============ CONFIG ============
const MIN_PRICE_GAP = 200;        // vừa call LONG/SHORT mà giá lệch < 200 -> bỏ qua
const MIN_CONFIDENCE = 65;        // AI score tối thiểu mới gửi
const DEFAULT_SL_PCT = 1.0;       // SL ~ 1% (chưa đòn bẩy)
const RR_TP1 = 1;                 // TP1 = 1R
const RR_TP2 = 2;                 // TP2 = 2R
const COOLDOWN_MS = 60_000;       // chống spam theo thời gian (60s)

// nhớ tín hiệu gần nhất
let lastSignal = { side: null, price: null, ts: 0 };

// ============ HELPERS ============
function ensureEnv() {
  if (!BOT_TOKEN) throw new Error("Missing ENV: BOT_TOKEN");
  if (!CHAT_ID) throw new Error("Missing ENV: CHAT_ID");
  if (!OPENAI_API_KEY) throw new Error("Missing ENV: OPENAI_API_KEY");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function safeJsonParse(maybeString) {
  if (typeof maybeString !== "string") return maybeString ?? {};
  const s = maybeString.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    // nếu TradingView gửi raw text không phải JSON
    return { message: s };
  }
}

// TradingView thường gửi "15", "15m", "1h", "240", "D", "1D"
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
  if (low.endsWith("m")) {
    const n = parseInt(low.replace("m", ""), 10);
    if (Number.isFinite(n)) return `M${n}`;
  }
  if (low.endsWith("h")) {
    const n = parseInt(low.replace("h", ""), 10);
    if (Number.isFinite(n)) return `H${n}`;
  }
  if (low === "d") return "1D";
  if (low.endsWith("d")) {
    const n = parseInt(low.replace("d", ""), 10);
    if (Number.isFinite(n)) return `${n}D`;
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
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

function buildMsg({ side, symbol, tfs, entry, sl, tp1, tp2, confidence, reason }) {
  const icon = side === "LONG" ? "🔵" : "🔴";
  const sideText = side === "LONG" ? "LONG" : "SHORT";

  // "#BTC" theo ý bạn (có thể thay bằng symbol)
  const symHash = "#BTC";

  // format danh sách khung: |H1|M15|M30|H4|1D
  const tfLine = tfs?.length ? `|${tfs.join("|")}` : "";
  const tfFocus = tfs?.[0] ? `🔹 Khung ${tfs[0]}` : "🔹 Khung";

  return (
`CDT - BOT
${icon} ${sideText} ${symHash}${tfLine}
${tfFocus}

👉 Entry: ${entry.toFixed(2)}
👉 Stoploss: ${sl.toFixed(2)}
👉 TP1: ${tp1.toFixed(2)}
👉 TP2: ${tp2.toFixed(2)}

🔹 Score: ${Math.round(confidence)}/100
👉 ${reason || "AI đánh giá theo dữ liệu hiện tại."}

⚠️ Cảnh báo: Tín hiệu từ bot/AI (tự động), không phải lời khuyến khích đầu tư.`
  );
}

// ============ CHATGPT (OPENAI) ============
async function askChatGPT(features) {
  ensureEnv();

  // Prompt ngắn – đúng style bạn:
  // 1) Confirm đảo chiều (T3)
  // 2) Chạm vùng đỉnh/đáy nhiều nến trước
  // 3) Chạm Sonic R (EMA34) hoặc EMA
  // Output phải JSON
  const prompt = `
Bạn là AI hỗ trợ tín hiệu theo phong cách của tôi.
Ưu tiên:
(1) Nến xác nhận đảo chiều: nến đỏ -> nến xanh (LONG), nến xanh -> nến đỏ (SHORT). Bắt ở nến tiếp theo.
(2) Chạm vùng đỉnh/đáy nhiều nến trước đó.
(3) Chạm Sonic R (EMA34) hoặc EMA quan trọng.

Hãy trả về JSON HỢP LỆ, KHÔNG thêm chữ ngoài JSON:
{
 "side":"LONG|SHORT|NONE",
 "confidence":0-100,
 "sl_pct":1.0,
 "rr1":1,
 "rr2":2,
 "reason":"..."
}

Dữ liệu đầu vào (TradingView webhook):
${JSON.stringify(features)}
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

  // Nếu key/model sai sẽ rơi vào đây
  if (!r.ok) {
    throw new Error(`OpenAI error: ${JSON.stringify(data)}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI: empty content");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${content}`);
  }

  // Chuẩn hoá
  const sideRaw = String(parsed.side || "NONE").toUpperCase();
  const side =
    sideRaw.includes("LONG") ? "LONG" :
    sideRaw.includes("SHORT") ? "SHORT" : "NONE";

  const confidence = toNum(parsed.confidence) ?? 0;
  const sl_pct = toNum(parsed.sl_pct) ?? DEFAULT_SL_PCT;
  const rr1 = toNum(parsed.rr1) ?? RR_TP1;
  const rr2 = toNum(parsed.rr2) ?? RR_TP2;
  const reason = String(parsed.reason || "").slice(0, 400);

  return { side, confidence, sl_pct, rr1, rr2, reason };
}

// ============ ROUTES ============
// ping
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).send("OK health"));

// test telegram
app.post("/test-telegram", async (req, res) => {
  try {
    const body = safeJsonParse(req.body);
    const text = body?.text || "✅ TEST Telegram OK";
    const out = await sendTelegram(text);
    res.json({ ok: true, message_id: out.result?.message_id });
  } catch (e) {
    console.error("TEST TELEGRAM ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * TradingView webhook:
 * URL: https://YOUR.onrender.com/webhook
 *
 * TradingView Alert "Tin nhắn" (Message) bạn nên dán JSON như sau:
 * {
 *   "symbol":"{{ticker}}",
 *   "tf":"{{interval}}",
 *   "price":"{{close}}",
 *   "tfs":"H1|M15|M30|H4|1D",
 *   "note":"BTC Bot - Confirm T3 + SR + EMA/Sonic"
 * }
 *
 * (side LONG/SHORT) sẽ do ChatGPT quyết định.
 */
app.post("/webhook", async (req, res) => {
  try {
    // body có thể là object hoặc string
    const body = safeJsonParse(req.body);

    const symbol = String(body.symbol || body.ticker || "BTCUSDT.P");
    const tf = body.tf || body.interval || "";  // ví dụ "15"
    const price = toNum(body.price || body.close || body.entry);

    // Nếu TradingView không gửi giá -> không thể tính SL/TP
    if (!price) return res.status(400).json({ ok: false, error: "Missing price (close/price/entry)" });

    // list khung theo ý bạn (mặc định lấy từ tfs hoặc tf)
    let tfs = [];
    if (body.tfs) {
      tfs = String(body.tfs)
        .split("|")
        .map(s => s.trim())
        .filter(Boolean)
        .map(formatTF);
    } else if (tf) {
      tfs = [formatTF(tf)];
    } else {
      tfs = ["M15"];
    }

    // chống spam theo time + giá
    const now = Date.now();
    if (lastSignal.ts && now - lastSignal.ts < COOLDOWN_MS) {
      return res.json({ ok: true, skipped: "cooldown" });
    }
    if (lastSignal.price && Math.abs(price - lastSignal.price) < MIN_PRICE_GAP) {
      return res.json({ ok: true, skipped: "min_gap", last: lastSignal.price, now: price });
    }

    // ======= GỌI CHATGPT QUYẾT ĐỊNH =======
    const ai = await askChatGPT({
      symbol,
      tf: formatTF(tf),
      tfs,
      price,
      note: body.note || "",
      // bạn có thể nhét thêm dữ liệu indicator vào đây nếu Pine gửi qua webhook
      // ví dụ: ema34: body.ema34, rsi: body.rsi, ...
      extra: body.extra || null,
    });

    if (ai.side === "NONE" || ai.confidence < MIN_CONFIDENCE) {
      return res.json({ ok: true, skipped: true, ai });
    }

    const { sl, tp1, tp2 } = calcLevels(ai.side, price, ai.sl_pct, ai.rr1, ai.rr2);

    const msg = buildMsg({
      side: ai.side,
      symbol,
      tfs,
      entry: price,
      sl,
      tp1,
      tp2,
      confidence: ai.confidence,
      reason: ai.reason,
    });

    await sendTelegram(msg);

    lastSignal = { side: ai.side, price, ts: now };

    res.json({ ok: true, sent: true, ai, levels: { entry: price, sl, tp1, tp2 }, tfs });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// IMPORTANT: Render uses PORT env
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
