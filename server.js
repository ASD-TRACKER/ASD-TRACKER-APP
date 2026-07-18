import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Simple in-memory rate limiter: 30 AI calls per IP per minute ───────────
const _rateMap = new Map();
function rateLimited(ip) {
  const now = Date.now(), window = 60_000, max = 30;
  const e = _rateMap.get(ip) || { n: 0, t: now };
  if (now - e.t > window) { _rateMap.set(ip, { n: 1, t: now }); return false; }
  if (e.n >= max) return true;
  _rateMap.set(ip, { n: e.n + 1, t: e.t });
  return false;
}

// ── Security headers ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.json({ limit: "16kb" }));

// ── AI brief proxy — Anthropic key never reaches the client ───────────────
app.post("/api/ai-brief", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests — try again in a minute." });

  const key = process.env.ANTHROPIC_KEY;
  if (!key) return res.status(503).json({ error: "AI not configured on this server." });

  const { title = "", type = "Commercial", year = "2024", keywords = "" } = req.body || {};
  if (!keywords.trim()) return res.status(400).json({ error: "keywords required" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 220,
        messages: [{ role: "user", content:
          `Write a 2-3 sentence professional project description for an Australian structural steel detailing portfolio website.\n\nProject: ${title || "Steel project"}\nType: ${type}\nYear: ${year}\nKeywords: ${keywords}\n\nRules:\n- 2-3 concise sentences only\n- Professional, factual tone\n- Focus on the steel detailing scope delivered (modelling, GA drawings, fabrication drawings, RFI management, etc.)\n- Australian English, no marketing fluff\n- Output the description only — no preamble, no quotation marks`
        }],
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error("[ai-brief] Anthropic error", r.status, body);
      return res.status(500).json({ error: `Anthropic ${r.status}: ${body.slice(0, 200)}` });
    }
    const data = await r.json();
    const text = (data.content?.[0]?.text || "").trim();
    if (!text) throw new Error("Empty response");
    res.json({ text });
  } catch (err) {
    console.error("[ai-brief]", err.message);
    res.status(500).json({ error: err.message || "AI generation failed." });
  }
});

// ── Serve the built SPA ────────────────────────────────────────────────────
app.use(express.static(join(__dirname, "dist"), { index: false }));

// SPA fallback — all non-API routes return index.html
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => console.log(`ASD server on :${PORT}`));
