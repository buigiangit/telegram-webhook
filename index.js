import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============ ENV ============
const BOT_TOKEN = process.env.BOT_TOKEN; // bắt buộc
const CHAT_ID = process.env.CHAT_ID;     // bắt buộc

// ============ CONFIG ============
const MIN_PRICE_GAP = 200;       // chặn spam: lệch < 200 thì không gửi
const DEFAULT_SL_PCT = 1.0;      // SL ~ 1%
const RR_TP1 = 1;                // TP1 = 1R
const RR_TP2 = 2;                // TP2 = 2R

// nhớ tín hiệu gần nhất để chống spam
let lastSignal = { side: null, price: null, ts: 0 };

// ============ HELPERS ============
function ensureEnv() {
  if (!BOT_TOKEN) throw new Error("Missing ENV: BOT_TOKEN");
  if (!CHAT_ID) throw new Error("Missing ENV: CHAT_ID");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// đổi timeframe theo format bạn muốn: 15 -> M15, 60 -> H1, 240 -> H4, "1D" giữ nguyên...
function formatTF(tfRaw) {
  if (!tfRaw && tfRaw !== 0) return "";
  const s = String(tfRaw).trim();

  // TradingView hay gửi "15", "15m", "60", "1h", "240", "1D", "D"
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n < 60) return `M${n}`;
    if (n % 60 === 0) return `H${n / 60}`;
    return `M${n}`; // fallback
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
  // SL distance theo %
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
  if (!data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }
  return data;
}

function buildMsg({ side, symbol, tfs, entry, sl, tp1, tp2 }) {
  const icon = side === "LONG" ? "🔵" : "🔴";
  const sideText = side === "LONG" ? "LONG" : "SHORT";
  const symHash = symbol ? `#${String(symbol).replace(".P", "").replace("/", "")}` : "#BTC";

  const tfLine = tfs?.length ? tfs.join("|") : "";
  const tfBullet = tfs?.[0] ? `🔹 Khung ${tfs[0]}` : "🔹 Khung";

  return (
`CDT - BOT
${icon} ${sideText}  ${symHash} ${tfLine ? `|${tfLine}` : ""}

👉 Entry: ${entry.toFixed(2)}
👉 Stoploss: ${sl.toFixed(2)}
👉 TP1: ${tp1.toFixed(2)}
👉 TP2: ${tp2.toFixed(2)}

⚠️ <i>Cảnh báo: Tín hiệu từ bot (tự động), không phải lời khuyến khích đầu tư.<i>`
  );
}

// ============ ROUTES ============

// ping nhanh
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).send("OK health"));

// test telegram thủ công
app.post("/test-telegram", async (req, res) => {
  try {
    const text = req.body?.text || "✅ TEST Telegram OK";
    const out = await sendTelegram(text);
    res.json({ ok: true, telegram: out.result?.message_id ?? true });
  } catch (e) {
    console.error("TEST TELEGRAM ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * TradingView webhook
 * - URL: https://YOUR.onrender.com/webhook
 * - Body (TradingView Message) nên gửi JSON:
 *   {"side":"LONG","symbol":"BTCUSDT.P","tf":"15","price":"{{close}}","tfs":"H1|M15|M30|H4|1D"}
 *
 * Nếu thiếu field thì server tự fallback.
 */
app.post("/webhook", async (req, res) => {
  try {
    // TradingView đôi khi gửi raw string -> nhưng bạn đang dùng JSON, nên đọc thẳng body
    const body = req.body || {};

    // side: LONG/SHORT
    const sideRaw = (body.side || body.signal || "").toString().toUpperCase();
    const side = sideRaw.includes("SHORT") ? "SHORT" : sideRaw.includes("LONG") ? "LONG" : null;

    // symbol
    const symbol = (body.symbol || body.ticker || body.sym || "BTCUSDT.P").toString();

    // entry price
    const entry =
      toNum(body.entry) ??
      toNum(body.price) ??
      toNum(body.close) ??
      null;

    if (!side) return res.status(400).json({ ok: false, error: "Missing side LONG/SHORT" });
    if (!entry) return res.status(400).json({ ok: false, error: "Missing price/entry" });

    // timeframe(s)
    // - tf: "15" hoặc "15m"...
    // - tfs: "H1|M15|M30|H4|1D"
    let tfs = [];
    if (body.tfs) {
      tfs = String(body.tfs)
        .split("|")
        .map(s => s.trim())
        .filter(Boolean)
        .map(formatTF);
    } else if (body.tf || body.interval) {
      tfs = [formatTF(body.tf || body.interval)];
    }

    // chống spam theo khoảng giá
    if (lastSignal.price && Math.abs(entry - lastSignal.price) < MIN_PRICE_GAP) {
      return res.json({ ok: true, skipped: "min_gap", last: lastSignal, now: { side, entry } });
    }

    // tính SL/TP theo RR
    const slPct = toNum(body.sl_pct) ?? DEFAULT_SL_PCT;
    const rr1 = toNum(body.rr1) ?? RR_TP1;
    const rr2 = toNum(body.rr2) ?? RR_TP2;

    const { sl, tp1, tp2 } = calcLevels(side, entry, slPct, rr1, rr2);

    const msg = buildMsg({ side, symbol, tfs, entry, sl, tp1, tp2 });

    await sendTelegram(msg);

    lastSignal = { side, price: entry, ts: Date.now() };

    res.json({ ok: true, sent: true, side, entry, sl, tp1, tp2, tfs });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// IMPORTANT: Render uses PORT env
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
