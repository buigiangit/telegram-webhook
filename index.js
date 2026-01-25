import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;          // bắt buộc
const CHAT_ID = process.env.CHAT_ID;              // bắt buộc (group id dạng -100xxx)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // optional
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // optional

// ================= CONFIG =================
const MIN_PRICE_GAP = 200;  // chặn spam: lệch < 200 thì không gửi
const SL_PCT_DEFAULT = 1.0; // SL ~ 1%
const RR_TP1_DEFAULT = 1;   // TP1 = 1R
const RR_TP2_DEFAULT = 2;   // TP2 = 2R

let lastSignal = { side: null, price: null, ts: 0 };

// ================= HELPERS =================
function ensureEnv() {
  if (!BOT_TOKEN) throw new Error("Missing ENV: BOT_TOKEN");
  if (!CHAT_ID) throw new Error("Missing ENV: CHAT_ID");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// TradingView hay gửi tf: "15", "60", "240", "D", "1D", "15m", "1h"
function formatTF(tfRaw) {
  if (tfRaw === null || tfRaw === undefined) return "";
  const s = String(tfRaw).trim();
  if (!s) return "";

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

function parseTfs(body) {
  // ưu tiên body.tfs = "H1|M15|M30|H4|1D"
  if (body?.tfs) {
    return String(body.tfs)
      .split("|")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(formatTF);
  }
  // fallback: tf hoặc interval
  const one = body?.tf ?? body?.interval ?? body?.timeframe;
  if (one) return [formatTF(one)];
  return [];
}

function calcLevels(side, entry, slPct, rr1, rr2) {
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

async function sendTelegramHtml(html) {
  ensureEnv();
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

function buildTelegramHtml({
  side,
  symbol,
  tfs,
  entry,
  sl,
  tp1,
  tp2,
  confidence,
  reason,
}) {
  const icon = side === "LONG" ? "🔵" : "🔴";
  const sym = (symbol || "BTCUSDT.P").toString();
  const hashSym = "#BTC"; // bạn muốn cố định #BTC

  // ví dụ: |H1|M15|M30|H4|1D
  const tfLine = tfs?.length ? `|${tfs.join("|")}` : "";
  const tfFocus = tfs?.[0] ? `🔹 Khung ${tfs[0]}` : "🔹 Khung";

  // Bôi đậm phần gạch chân (bạn muốn): dòng LONG/SHORT + #BTC + tfLine
  const headerBold = `<b>${escapeHtml(`${icon} ${side}  ${hashSym} ${tfLine}`)}</b>`;

  // In nghiêng phần mũi tên 👉
  const it = (label, val) =>
    `<i>👉 ${escapeHtml(label)}:</i> <b>${escapeHtml(val)}</b>`;

  const scoreLine =
    typeof confidence === "number"
      ? `\n<b>🔹 Score:</b> ${escapeHtml(String(Math.round(confidence)))} / 100`
      : "";

  const reasonLine = reason ? `\n<b>🔹 Lý do:</b> ${escapeHtml(reason)}` : "";

  return (
    `<b>CDT - BOT</b>\n` +
    `${headerBold}\n` +
    `${escapeHtml(tfFocus)}\n\n` +
    `${it("Entry", entry.toFixed(2))}\n` +
    `${it("Stoploss", sl.toFixed(2))}\n` +
    `${it("TP1", tp1.toFixed(2))}\n` +
    `${it("TP2", tp2.toFixed(2))}\n` +
    `${scoreLine}${reasonLine}\n\n` +
    `⚠️ <u>Cảnh báo:</u> Tín hiệu từ bot/AI (tự động), không phải lời khuyến khích đầu tư.`
  );
}

// ================= AI (ChatGPT) =================
// Nếu body không có side -> mới gọi AI để quyết định
async function askChatGPTDecision(payload) {
  if (!OPENAI_API_KEY) {
    return { side: "NONE", confidence: 0, reason: "Missing OPENAI_API_KEY" };
  }

  // Payload bạn gửi từ Pine/TradingView có thể gồm:
  // price, tf, ema34, ema50, rsi, atr, confirmLong, confirmShort, touchSonic, touchEMA50, touchPH, touchPL, ...
  const prompt = `
Bạn là AI trader BTCUSDT.P theo phong cách:
- Ưu tiên bắt T3 (nến xác nhận đảo chiều)
- Ưu tiên vùng chạm Sonic R (EMA34) / EMA50
- Ưu tiên chạm vùng đỉnh/đáy gần nhất (SR)
- Tránh spam: nếu tín hiệu mới quá gần tín hiệu trước (<200 giá) thì nên NONE
Chỉ trả JSON hợp lệ dạng:
{"side":"LONG|SHORT|NONE","confidence":0-100,"sl_pct":1,"rr1":1,"rr2":2,"reason":"..."}
Dữ liệu:
${JSON.stringify(payload)}
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
        { role: "system", content: "Chỉ trả JSON hợp lệ, không thêm chữ." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  const data = await r.json();

  // Nếu hết quota / lỗi OpenAI -> throw để caller fallback
  if (!r.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`OpenAI error: ${msg}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  return JSON.parse(content);
}

// Fallback rule-based (khi AI lỗi/quota)
function ruleBasedSide(body) {
  // nếu Pine gửi confirmLong/confirmShort (1/0)
  const cL = toNum(body?.confirmLong) === 1;
  const cS = toNum(body?.confirmShort) === 1;
  if (cL && !cS) return "LONG";
  if (cS && !cL) return "SHORT";

  // fallback cuối: NONE
  return "NONE";
}

// ================= ROUTES =================
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).send("OK health"));

app.post("/test-telegram", async (req, res) => {
  try {
    const text = req.body?.text || "✅ TEST Telegram OK";
    await sendTelegramHtml(`<b>${escapeHtml(text)}</b>`);
    res.json({ ok: true });
  } catch (e) {
    console.error("TEST TELEGRAM ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * TradingView Webhook
 * URL: https://telegram-webhook-y82o.onrender.com/webhook
 *
 * Nên gửi JSON ở TradingView Message:
 * LONG alert:
 * {"side":"LONG","symbol":"{{ticker}}","tf":"{{interval}}","price":"{{close}}","tfs":"H1|M15|M30|H4|1D"}
 *
 * SHORT alert:
 * {"side":"SHORT","symbol":"{{ticker}}","tf":"{{interval}}","price":"{{close}}","tfs":"H1|M15|M30|H4|1D"}
 *
 * Nếu bạn KHÔNG gửi side -> server sẽ gọi ChatGPT quyết định (nếu có OPENAI_API_KEY).
 */
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body || {};

    // -------- symbol / price / tf --------
    const symbol = (body.symbol || body.ticker || "BTCUSDT.P").toString();
    const entry =
      toNum(body.entry) ??
      toNum(body.price) ??
      toNum(body.close) ??
      null;

    if (!entry) return res.status(400).json({ ok: false, error: "Missing price/entry/close" });

    const tfs = parseTfs(body);

    // -------- side: ưu tiên lấy từ TradingView --------
    let side = null;
    const sideRaw = (body.side || body.signal || "").toString().toUpperCase();
    if (sideRaw.includes("LONG")) side = "LONG";
    if (sideRaw.includes("SHORT")) side = "SHORT";

    let confidence = null;
    let reason = "";

    // -------- nếu không có side thì dùng AI (hoặc fallback) --------
    if (!side) {
      try {
        const ai = await askChatGPTDecision(body);
        const aiSide = String(ai?.side || "NONE").toUpperCase();
        if (aiSide === "LONG" || aiSide === "SHORT") side = aiSide;
        else side = "NONE";
        confidence = toNum(ai?.confidence);
        reason = ai?.reason || "";

        // AI cho phép override sl/rr nếu muốn
        body.sl_pct = ai?.sl_pct ?? body.sl_pct;
        body.rr1 = ai?.rr1 ?? body.rr1;
        body.rr2 = ai?.rr2 ?? body.rr2;
      } catch (e) {
        // QUOTA / lỗi OpenAI -> fallback không 500
        console.error("AI ERROR -> FALLBACK:", e.message);
        side = ruleBasedSide(body);
        confidence = 0;
        reason = `AI lỗi/quota -> fallback rule (${side})`;
      }
    }

    if (side === "NONE") {
      return res.json({ ok: true, skipped: "side=NONE", body });
    }

    // -------- chống spam theo khoảng giá --------
    if (lastSignal.price && Math.abs(entry - lastSignal.price) < MIN_PRICE_GAP) {
      return res.json({
        ok: true,
        skipped: "min_gap",
        last: lastSignal,
        now: { side, entry },
      });
    }

    // -------- SL/TP theo RR --------
    const slPct = toNum(body.sl_pct) ?? SL_PCT_DEFAULT;
    const rr1 = toNum(body.rr1) ?? RR_TP1_DEFAULT;
    const rr2 = toNum(body.rr2) ?? RR_TP2_DEFAULT;

    const { sl, tp1, tp2 } = calcLevels(side, entry, slPct, rr1, rr2);

    // -------- gửi Telegram --------
    const html = buildTelegramHtml({
      side,
      symbol,
      tfs,
      entry,
      sl,
      tp1,
      tp2,
      confidence,
      reason,
    });

    await sendTelegramHtml(html);

    lastSignal = { side, price: entry, ts: Date.now() };

    res.json({ ok: true, sent: true, side, entry, sl, tp1, tp2, tfs });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    // Quan trọng: vẫn trả JSON rõ lỗi
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Render uses PORT env
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
