// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();

// Nhận mọi loại content-type (TradingView hay gửi text/plain)
app.use(express.text({ type: "*/*", limit: "1mb" }));

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN; // bắt buộc
const CHAT_ID = process.env.CHAT_ID; // bắt buộc (group id dạng -100xxx)

// ================= HELPERS =================
function ensureEnv() {
  if (!BOT_TOKEN) throw new Error("Missing ENV: BOT_TOKEN");
  if (!CHAT_ID) throw new Error("Missing ENV: CHAT_ID");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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
  return `#${cleaned || "COIN"}`;
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
  if (low === "d") return "1D";
  if (low === "w") return "1W";
  return s.toUpperCase();
}

function fmtPrice(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "";
  // Giá lớn: format có dấu phẩy
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  // Giá nhỏ: giữ nguyên
  return String(x);
}

function buildTelegramHtml({ side, symbol, tf, price }) {
  const icon = side === "LONG" ? "🔵" : "🔴";
  const hash = hashtagFromSymbol(symbol);
  const tfFmt = formatTF(tf);

  return (
    `<b>${escapeHtml(`${icon} ${side}  ${hash}${tfFmt ? "|" + tfFmt : ""}`)}</b>\n\n` +
    `<i>👉 Price:</i> <b>${escapeHtml(fmtPrice(price))}</b>\n\n` +
    `⚠️ <u>Cảnh báo:</u> Tín hiệu từ bot (tự động), không phải lời khuyến khích đầu tư.`
  );
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

  // LOG để biết lỗi thật sự nếu fail
  if (!r.ok || !data.ok) {
    console.error("TELEGRAM_FAIL:", { status: r.status, data });
    throw new Error(`Telegram API error: status=${r.status} data=${JSON.stringify(data)}`);
  }

  console.log("TELEGRAM_OK:", { message_id: data?.result?.message_id });
  return data;
}

// Parse body: TradingView có thể gửi string JSON
function parseTradingViewBody(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  const s = String(raw).trim();
  if (!s) return {};
  // thử parse JSON
  try {
    return JSON.parse(s);
  } catch {
    // nếu chỉ là "LONG" / "SHORT" thì wrap lại
    const up = s.toUpperCase();
    if (up.includes("LONG")) return { side: "LONG" };
    if (up.includes("SHORT")) return { side: "SHORT" };
    return { raw: s };
  }
}

// ================= ROUTES =================
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).send("OK health"));

app.post("/test-telegram", async (req, res) => {
  try {
    const html = `<b>${escapeHtml("✅ TEST Telegram OK")}</b>`;
    await sendTelegramHtml(html);
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

    const symbol = normSymbol(body.symbol ?? body.ticker ?? "");
    const tf = body.tf ?? body.timeframe ?? body.interval ?? "";
    const price = toNum(body.price ?? body.close ?? body.entry);

    // bắt buộc có side + price (để gửi)
    if (side === "NONE") return res.json({ ok: true, skipped: "side=NONE" });
    if (price == null) return res.status(400).json({ ok: false, error: "Missing price/close/entry" });

    const html = buildTelegramHtml({ side, symbol, tf, price });
    await sendTelegramHtml(html);

    res.json({ ok: true, sent: true, side, symbol, tf, price });
  } catch (e) {
    console.error("WEBHOOK_ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
