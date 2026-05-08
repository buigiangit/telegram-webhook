import express from "express";
import fetch from "node-fetch";

const app = express();

app.use(express.text({ type: "*/*", limit: "1mb" }));

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ================= CONFIG =================
const SL_PCT_DEFAULT = 1.0;

// Entry thông minh
const ENTRY_BUFFER_PCT_DEFAULT = 0.35; // BTC 69,500 => trừ/cộng khoảng 240 giá
const MAX_ENTRY_DISTANCE_PCT_DEFAULT = 0.8; // support/resistance xa quá 0.8% thì bỏ

// TP thông minh
const MIN_TP_DISTANCE_PCT_DEFAULT = 1.0; // TP1 và TP2 cách nhau tối thiểu 1%

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

function fmtPrice(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "";

  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n < 100) return String(Number(n.toFixed(8)));
  return Math.round(n).toString();
}

function parseLevels(...inputs) {
  const arr = [];

  for (const input of inputs) {
    if (input == null) continue;

    if (Array.isArray(input)) {
      for (const x of input) {
        const n = toNum(x);
        if (n != null) arr.push(n);
      }
      continue;
    }

    if (typeof input === "string") {
      input
        .split(",")
        .map((x) => x.trim())
        .forEach((x) => {
          const n = toNum(x);
          if (n != null) arr.push(n);
        });
      continue;
    }

    const n = toNum(input);
    if (n != null) arr.push(n);
  }

  return [...new Set(arr)].sort((a, b) => a - b);
}

function nearestAbove(entry, levels) {
  return levels.filter((x) => x > entry).sort((a, b) => a - b)[0] ?? null;
}

function nearestBelow(entry, levels) {
  return levels.filter((x) => x < entry).sort((a, b) => b - a)[0] ?? null;
}

// ================= SMART ENTRY =================
function calcSmartEntry(side, closePrice, body = {}) {
  const entryBufferPct = toNum(body.entry_buffer_pct) ?? ENTRY_BUFFER_PCT_DEFAULT;
  const maxEntryDistancePct =
    toNum(body.max_entry_distance_pct) ?? MAX_ENTRY_DISTANCE_PCT_DEFAULT;

  const buffer = closePrice * (entryBufferPct / 100);

  if (side === "LONG") {
    const supports = parseLevels(
      body.current_support,
      body.current_ma_support,
      body.ma_support,
      body.support,
      body.current_low,
      body.current_lows,
      body.low,
      body.lows
    );

    const nearestSupport = nearestBelow(closePrice, supports);

    if (nearestSupport != null) {
      const distancePct = ((closePrice - nearestSupport) / closePrice) * 100;

      if (distancePct <= maxEntryDistancePct) {
        return nearestSupport;
      }
    }

    return closePrice - buffer;
  }

  if (side === "SHORT") {
    const resistances = parseLevels(
      body.current_resistance,
      body.current_ma_resistance,
      body.ma_resistance,
      body.resistance,
      body.current_high,
      body.current_highs,
      body.high,
      body.highs
    );

    const nearestResistance = nearestAbove(closePrice, resistances);

    if (nearestResistance != null) {
      const distancePct = ((nearestResistance - closePrice) / closePrice) * 100;

      if (distancePct <= maxEntryDistancePct) {
        return nearestResistance;
      }
    }

    return closePrice + buffer;
  }

  return closePrice;
}

// ================= SMART TP =================
function fixTpDistance(side, tp1, tp2, minPct = MIN_TP_DISTANCE_PCT_DEFAULT) {
  if (tp1 == null || tp2 == null) return { tp1, tp2 };

  const minDist = tp1 * (minPct / 100);

  if (side === "LONG") {
    if (tp2 <= tp1 || tp2 - tp1 < minDist) {
      tp2 = tp1 * (1 + minPct / 100);
    }
  }

  if (side === "SHORT") {
    if (tp2 >= tp1 || tp1 - tp2 < minDist) {
      tp2 = tp1 * (1 - minPct / 100);
    }
  }

  return { tp1, tp2 };
}

function calcLevels(side, closePrice, body = {}) {
  const entry = calcSmartEntry(side, closePrice, body);

  const slPct = toNum(body.sl_pct) ?? SL_PCT_DEFAULT;
  const slDist = entry * (slPct / 100);
  const minTpDistancePct = toNum(body.min_tp_distance_pct) ?? MIN_TP_DISTANCE_PCT_DEFAULT;

  if (side === "LONG") {
    const sl = entry - slDist;

    const currentResistance = parseLevels(
      body.current_resistance,
      body.current_ma_resistance,
      body.ma_resistance,
      body.resistance,
      body.current_high,
      body.current_highs,
      body.high,
      body.highs
    );

    const h4Resistance = parseLevels(
      body.h4_resistance,
      body.h4_ma_resistance,
      body.h4_high,
      body.h4_highs
    );

    let tp1 = nearestAbove(entry, currentResistance);
    let tp2 = nearestAbove(entry, h4Resistance);

    if (tp1 == null) tp1 = entry + slDist;
    if (tp2 == null) tp2 = entry + slDist * 2;

    const fixed = fixTpDistance("LONG", tp1, tp2, minTpDistancePct);

    return {
      closePrice,
      entry,
      sl,
      tp1: fixed.tp1,
      tp2: fixed.tp2,
    };
  }

  if (side === "SHORT") {
    const sl = entry + slDist;

    const currentSupport = parseLevels(
      body.current_support,
      body.current_ma_support,
      body.ma_support,
      body.support,
      body.current_low,
      body.current_lows,
      body.low,
      body.lows
    );

    const h4Support = parseLevels(
      body.h4_support,
      body.h4_ma_support,
      body.h4_low,
      body.h4_lows
    );

    let tp1 = nearestBelow(entry, currentSupport);
    let tp2 = nearestBelow(entry, h4Support);

    if (tp1 == null) tp1 = entry - slDist;
    if (tp2 == null) tp2 = entry - slDist * 2;

    const fixed = fixTpDistance("SHORT", tp1, tp2, minTpDistancePct);

    return {
      closePrice,
      entry,
      sl,
      tp1: fixed.tp1,
      tp2: fixed.tp2,
    };
  }

  return {
    closePrice,
    entry,
    sl: null,
    tp1: null,
    tp2: null,
  };
}

// ================= TELEGRAM =================
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

function parseTradingViewBody(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;

  const s = String(raw).trim();
  if (!s) return {};

  try {
    return JSON.parse(s);
  } catch {
    const up = s.toUpperCase();

    if (up.includes("LONG")) return { side: "LONG", raw: s };
    if (up.includes("SHORT")) return { side: "SHORT", raw: s };

    return { raw: s };
  }
}

function buildTelegramHtml({ side, symbol, tf, closePrice, entry, sl, tp1, tp2 }) {
  const icon = side === "LONG" ? "🔵" : "🔴";
  const hashSym = hashtagFromSymbol(symbol);
  const tfMain = formatTF(tf);

  const header = `<b>${escapeHtml(`${icon} ${side}  ${hashSym}${tfMain ? "|" + tfMain : ""}`)}</b>`;
  const it = (label, val) => `<i>👉 ${escapeHtml(label)}:</i> <b>${escapeHtml(val)}</b>`;

  return (
    `${header}\n\n` +
    `${it("Entry", fmtPrice(closePrice))}\n` +
    `${it("Khuyến nghị", fmtPrice(entry))}\n` +
    `${it("Stoploss", fmtPrice(sl))}\n` +
    `${it("TP1", fmtPrice(tp1))}\n` +
    `${it("TP2", fmtPrice(tp2))}\n\n` +
    `⚠️ <u>Cảnh báo:</u> Tín hiệu từ bot tự động, không phải lời khuyến khích đầu tư. Anh em có thể tham khảo thêm và tự quyết định trước khi vào lệnh.`
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
    const side = sideRaw.includes("LONG")
      ? "LONG"
      : sideRaw.includes("SHORT")
      ? "SHORT"
      : "NONE";

    if (side === "NONE") {
      return res.json({ ok: true, skipped: "side=NONE" });
    }

    const symbol = normSymbol(body.symbol ?? body.ticker ?? "BTCUSDT");
    const tf = body.tf ?? body.timeframe ?? body.interval ?? "";

    const closePrice =
      toNum(body.close) ??
      toNum(body.entry) ??
      toNum(body.price) ??
      toNum(body.closePrice);

    if (closePrice == null) {
      return res.status(400).json({
        ok: false,
        error: "Missing close/entry/price",
      });
    }

    const { entry, sl, tp1, tp2 } = calcLevels(side, closePrice, body);

    const html = buildTelegramHtml({
      side,
      symbol,
      tf,
      closePrice,
      entry,
      sl,
      tp1,
      tp2,
    });

    await sendTelegramHtml(html);

    res.json({
      ok: true,
      sent: true,
      side,
      symbol,
      tf,
      closePrice,
      entry,
      sl,
      tp1,
      tp2,
    });
  } catch (e) {
    console.error("WEBHOOK_ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
