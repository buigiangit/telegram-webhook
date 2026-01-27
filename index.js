// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();

// TradingView thường gửi text/plain -> nhận raw text trước
app.use(express.text({ type: "*/*", limit: "1mb" }));

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN; // bắt buộc
const CHAT_ID = process.env.CHAT_ID; // bắt buộc (group id dạng -100xxx)

// ================= CONFIG =================
// (BỎ chặn spam theo yêu cầu)
const SL_PCT_DEFAULT = 1.0; // SL ~ 1%
const RR_TP1_DEFAULT = 1; // TP1 = 1R
const RR_TP2_DEFAULT = 2; // TP2 = 2R

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

function normSymbol(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.includes(":")) s = s.split(":").pop();
  return s.toUpperCase();
}

function hashtagFromSymbol(symRaw) {
  const s = normSymbol(symRaw);
  const cleaned = s.replace(/(\.P|\.PERP)$/i, "");

  const quotes = ["USDT", "USD", "BUSD", "USDC", "FDUSD"];
  for (const q of quotes) {
    if (cleaned.endsWith(q) && cleaned.length > q.length) {
      return `#${cleaned.slice(0, -q.length)}`;
    }
  }
  const m = cleaned.match(/^[A-Z]+/);
  return `#${m ? m[0] : cleaned || "COIN"}`;
}

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
  if (low === "w") return "1W";
  if (low.endsWith("d")) {
    const n = parseInt(low.replace("d", ""), 10);
    if (Number.isFinite(n)) return `${n}D`;
  }

  return s.toUpperCase();
}

// ✅ LUẬT FORMAT GIÁ theo yêu cầu của bạn:
// - số >= 1000: giữ logic cũ => làm tròn + có dấu phẩy (3,201)
// - số < 100: giữ nguyên (10.123456)
// - 100..999: làm tròn cho gọn
function fmtPrice(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "";

  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n < 100) return String(x);
  return Math.round(n).toString();
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

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    console.error("TELEGRAM_FAIL:", { status: r.status, data });
    throw new Error(`Telegram API error: status=${r.status} data=${JSON.stringify(data)}`);
  }

  return data;
}

// TradingView có thể gửi text/plain -> parse JSON string
function parseTradingViewBody(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;

  const s = String(raw).trim();
  if (!s) return {};

  try {
    return JSON.parse(s);
  } catch {
    const up = s.toUpperCase();
    if (up.includes("LONG")) return { side: "LONG" };
    if (up.includes("SHORT")) return { side: "SHORT" };
    return { raw: s };
  }
}

function buildTelegramHtml({ side, symbol, tf, entry, sl, tp1, tp2 }) {
  const icon = side === "LONG" ? "🔵" : "🔴";
  const hashSym = hashtagFromSymbol(symbol);
  const tfMain = formatTF(tf);

  const header = `<b>${escapeHtml(`${icon} ${side}  ${hashSym}${tfMain ? "|" + tfMain : ""}`)}</b>`;
  const it = (label, val) => `<i>👉 ${escapeHtml(label)}:</i> <b>${escapeHtml(val)}</b>`;

  return (
    `${header}\n\n` +
    `${it("Entry", fmtPrice(entry))}\n` +
    `${it("Stoploss", fmtPrice(sl))}\n` +
    `${it("TP1", fmtPrice(tp1))}\n` +
    `${it("TP2", fmtPrice(tp2))}\n\n` +
    `⚠️ <u>Cảnh báo:</u> Tín hiệu từ bot (tự động), không phải lời khuyến khích đầu tư.`
  );
}

// ================= ROUTES =================
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).send("OK health"));

app.post("/test-telegram", async (_req, res) => {
  try {
    await sendTelegramHtml(`<b>${escapeHtml("✅ TEST Telegram OK")}</b>`);
    res.json({ ok: true });
  } catch (e) {
    console.error("TEST_TELEGRAM_ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const body = parseTradingViewBody(req.body);
    console.log("WEBHOOK_IN:", body);

    const sideRaw = String(body.side || body.signal || "").toUpperCase();
    const side = sideRaw.includes("LONG") ? "LONG" : sideRaw.includes("SHORT") ? "SHORT" : "NONE";
    if (side === "NONE") return res.json({ ok: true, skipped: "side=NONE" });

    const symbol = normSymbol(body.symbol ?? body.ticker ?? "BTCUSDT");
    const tf = body.tf ?? body.timeframe ?? body.interval ?? "";
    const entry = toNum(body.entry) ?? toNum(body.price) ?? toNum(body.close);

    if (entry == null) return res.status(400).json({ ok: false, error: "Missing entry/price/close" });

    const slPct = toNum(body.sl_pct) ?? SL_PCT_DEFAULT;
    const rr1 = toNum(body.rr1) ?? RR_TP1_DEFAULT;
    const rr2 = toNum(body.rr2) ?? RR_TP2_DEFAULT;

    const { sl, tp1, tp2 } = calcLevels(side, entry, slPct, rr1, rr2);

    const html = buildTelegramHtml({ side, symbol, tf, entry, sl, tp1, tp2 });
    await sendTelegramHtml(html);

    res.json({ ok: true, sent: true, side, symbol, tf, entry, sl, tp1, tp2 });
  } catch (e) {
    console.error("WEBHOOK_ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
