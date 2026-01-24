import express from "express";

const app = express();
app.use(express.json());
app.use(express.text({ type: "*/*" }));

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/webhook", (req, res) => res.status(200).send("OK /webhook"));

app.post("/webhook", async (req, res) => {
  try {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ ok: false, error: "Missing BOT_TOKEN or CHAT_ID" });
    }

    // nhận payload dạng JSON hoặc text
    let data = {};
    if (typeof req.body === "string") {
      // nếu TV gửi text thì cố parse JSON, không được thì giữ text
      try { data = JSON.parse(req.body); }
      catch { data = { message: req.body }; }
    } else {
      data = req.body || {};
    }

    const side = data.side || "";
    const symbol = data.symbol || "";
    const tf = data.tf || "";
    const entry = parseFloat(data.price || data.entry || 0);

    const riskPercent = 0.01; // 1%
    let sl = 0, tp1 = 0, tp2 = 0;

    if (side === "LONG") {
      sl = entry * (1 - riskPercent);
      tp1 = entry * (1 + riskPercent);
      tp2 = entry * (1 + riskPercent * 2);
    } else if (side === "SHORT") {
      sl = entry * (1 + riskPercent);
      tp1 = entry * (1 - riskPercent);
      tp2 = entry * (1 - riskPercent * 2);
    }

    const coinTag = "#" + symbol.replace(".P", "").replace("USDT", "").toUpperCase();

    const message =
`${side === "LONG" ? "🔵 LONG" : "🔴 SHORT"}  ${coinTag} |${tf}
👉 Entry: ${entry.toFixed(2)}
👉 Stl: ${sl.toFixed(2)}
👉 TP1: ${tp1.toFixed(2)}
👉 TP2: ${tp2.toFixed(2)}

⚠️ Cảnh báo: Tín hiệu từ bot, chỉ mang tính tham khảo; không phải lời khuyến khích/tư vấn đầu tư.`;

    // Node 22 có fetch sẵn
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
    });

    const t = await resp.json();
    if (!t.ok) return res.status(500).json({ ok: false, telegram: t });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
