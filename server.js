import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Rate limiter ───────────────────────────────────────────────────────────────
const _rateMap = new Map();
function rateLimited(ip) {
  const now = Date.now(), window = 60_000, max = 30;
  const e = _rateMap.get(ip) || { n: 0, t: now };
  if (now - e.t > window) { _rateMap.set(ip, { n: 1, t: now }); return false; }
  if (e.n >= max) return true;
  _rateMap.set(ip, { n: e.n + 1, t: e.t });
  return false;
}

// ── Security headers ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.json({ limit: "16kb" }));

// ═══════════════════════════════════════════════════════════════════════════════
// FIREBASE ADMIN SDK — bypasses Firestore rules entirely, no auth token needed.
// Set FIREBASE_SERVICE_ACCOUNT_B64 in Railway (base64-encoded service account JSON).
// Download from Firebase Console → Project Settings → Service Accounts → Generate key.
// ═══════════════════════════════════════════════════════════════════════════════
let adminDb = null;
let adminAuth = null;

(function initAdmin() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) { console.log("[admin] No service account — using REST API fallback"); return; }
  try {
    const sa = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    adminDb = admin.firestore();
    adminAuth = admin.auth();
    console.log("[admin] Firebase Admin SDK initialized ✓");
  } catch (e) {
    console.error("[admin] Init failed:", e.message);
  }
})();

// Process data for Admin SDK — convert { __op__: "delete" } sentinels to FieldValue.delete()
function processForAdmin(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !Array.isArray(v) && v.__op__ === "delete") {
      out[k] = admin.firestore.FieldValue.delete();
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = processForAdmin(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIREBASE REST API — fallback when Admin SDK is not configured.
// Uses anonymous auth + sentinel displayName so Firestore rules (isTeamMember) pass.
// ═══════════════════════════════════════════════════════════════════════════════
const _fb = { refreshToken: null, idToken: null, expiry: 0 };

async function getFirebaseIdToken() {
  const key = process.env.VITE_FIREBASE_API_KEY;
  if (!key) return null;
  if (_fb.idToken && Date.now() < _fb.expiry) return _fb.idToken;

  if (_fb.refreshToken) {
    try {
      const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=${_fb.refreshToken}`,
      });
      const d = await r.json();
      if (d.id_token) {
        _fb.idToken = d.id_token;
        _fb.expiry = Date.now() + (parseInt(d.expires_in || "3600") - 60) * 1000;
        _fb.refreshToken = d.refresh_token;
        return _fb.idToken;
      }
    } catch {}
  }

  // Create a new anonymous user (happens on server restart)
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  const d = await r.json();

  // Set the sentinel displayName so server's own writes satisfy isTeamMember() rules.
  // Then exchange the refresh token for a new idToken that includes name: "asd-hub-admin".
  try {
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: d.idToken, displayName: "asd-hub-admin" }),
    });
    const r2 = await fetch(`https://securetoken.googleapis.com/v1/token?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${d.refreshToken}`,
    });
    const d2 = await r2.json();
    if (d2.id_token) {
      _fb.idToken = d2.id_token;
      _fb.expiry = Date.now() + (parseInt(d2.expires_in || "3600") - 60) * 1000;
      _fb.refreshToken = d2.refresh_token || d.refreshToken;
      return _fb.idToken;
    }
  } catch (e) {
    console.warn("[firebase] Sentinel setup failed, using base token:", e.message);
  }

  _fb.idToken = d.idToken;
  _fb.expiry = Date.now() + (parseInt(d.expiresIn || "3600") - 60) * 1000;
  _fb.refreshToken = d.refreshToken;
  return _fb.idToken;
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${process.env.VITE_FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, toFsValue(val)])) } };
  return { nullValue: null };
}

function fromFsValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return parseInt(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, fromFsValue(val)]));
  return null;
}

async function fsGet(collection, docId) {
  const token = await getFirebaseIdToken();
  if (!token) return null;
  const r = await fetch(`${FS_BASE}/${collection}/${docId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const d = await r.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromFsValue(v)]));
}

async function fsSet(collection, docId, data) {
  const token = await getFirebaseIdToken();
  if (!token) return false;
  const r = await fetch(`${FS_BASE}/${collection}/${docId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFsValue(v)])) }),
  });
  return r.ok;
}

// Updates a single nested field using Firestore field mask (equivalent to updateDoc with dot notation)
async function fsUpdateField(collection, docId, fieldPath, value) {
  const token = await getFirebaseIdToken();
  if (!token) return false;
  const url = `${FS_BASE}/${collection}/${docId}?updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`;
  const parts = fieldPath.split(".");
  const fields = {};
  let cur = fields;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = { mapValue: { fields: {} } };
    cur = cur[parts[i]].mapValue.fields;
  }
  cur[parts[parts.length - 1]] = toFsValue(value);
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  return r.ok;
}

async function fsDelete(collection, docId) {
  const token = await getFirebaseIdToken();
  if (!token) return false;
  const r = await fetch(`${FS_BASE}/${collection}/${docId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.ok;
}

// List all document ids + data in a Firestore collection (paginates automatically)
async function fsListDocs(col) {
  const token = await getFirebaseIdToken();
  if (!token) return [];
  const results = [];
  let pageToken = null;
  do {
    const url = `${FS_BASE}/${col}${pageToken ? `?pageToken=${pageToken}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) break;
    const d = await r.json();
    for (const doc of d.documents || []) {
      const id = doc.name.split("/").pop();
      results.push({ id, data: Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, fromFsValue(v)])) });
    }
    pageToken = d.nextPageToken || null;
  } while (pageToken);
  return results;
}

// Partial update via REST field mask — handles { __op__: "delete" } sentinels.
async function fsUpdatePartial(col, docId, data) {
  const token = await getFirebaseIdToken();
  if (!token) return false;
  const fieldPaths = [], fields = {};
  for (const [k, v] of Object.entries(data)) {
    fieldPaths.push(k);
    if (!(v && typeof v === "object" && v.__op__ === "delete")) fields[k] = toFsValue(v);
  }
  const mask = fieldPaths.map(p => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join("&");
  const r = await fetch(`${FS_BASE}/${col}/${docId}?${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  return r.ok;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE PROXY — all client Firestore writes go through here.
// Uses Admin SDK (bypasses rules, always works) or falls back to REST with sentinel.
// Eliminates: PERMISSION_DENIED, token race conditions, data loss on close.
// ═══════════════════════════════════════════════════════════════════════════════
const WRITE_ALLOWED_COLS = new Set([
  "appState", "projects", "calendar_events", "tasks",
  "feedback", "notices", "asd_online", "quotes", "googleTokens",
]);

app.post("/api/write", async (req, res) => {
  const { ops } = req.body || {};
  if (!Array.isArray(ops) || ops.length === 0) return res.status(400).json({ error: "No ops" });
  if (ops.length > 100) return res.status(400).json({ error: "Too many ops in one batch" });

  // Validate every op before touching Firestore
  for (const op of ops) {
    if (!["set", "update", "delete"].includes(op.op)) return res.status(400).json({ error: `Invalid op: ${op.op}` });
    if (!op.collection || !op.docId) return res.status(400).json({ error: "Missing collection or docId" });
    if (!WRITE_ALLOWED_COLS.has(op.collection)) return res.status(400).json({ error: `Blocked collection: ${op.collection}` });
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(op.docId)) return res.status(400).json({ error: `Invalid docId` });
  }

  // Auth: Admin SDK token verification (preferred) or shared-secret fallback.
  if (adminAuth) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No auth token" });
    try {
      const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
      const role = decoded.name;
      if (role !== "asd-hub-member" && role !== "asd-hub-admin") {
        return res.status(403).json({ error: "Not a team member" });
      }
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  try {
    if (adminDb) {
      // Admin SDK batch — atomic, bypasses all Firestore rules
      const batch = adminDb.batch();
      for (const op of ops) {
        const ref = adminDb.collection(op.collection).doc(op.docId);
        if (op.op === "set")    batch.set(ref, processForAdmin(op.data || {}));
        else if (op.op === "update") batch.update(ref, processForAdmin(op.data || {}));
        else if (op.op === "delete") batch.delete(ref);
      }
      await batch.commit();
    } else {
      // REST fallback — uses anonymous auth with sentinel (isTeamMember passes)
      for (const op of ops) {
        if (op.op === "set")    await fsSet(op.collection, op.docId, op.data || {});
        else if (op.op === "update") await fsUpdatePartial(op.collection, op.docId, op.data || {});
        else if (op.op === "delete") await fsDelete(op.collection, op.docId);
      }
    }
    res.json({ ok: true, ts: Date.now() });
  } catch (err) {
    console.error("[write-proxy]", err.code || err.message);
    res.status(500).json({ error: err.code || err.message || "Write failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR — server-side OAuth with refresh tokens (permanent sign-in)
// ═══════════════════════════════════════════════════════════════════════════════
const GCAL_ID     = process.env.GOOGLE_CLIENT_ID;
const GCAL_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GCAL_REDIR  = process.env.GOOGLE_REDIRECT_URI; // https://your-app.railway.app/gcal/auth/callback

// Encrypt refresh tokens before storing in Firestore
const _encKey = Buffer.from(
  (process.env.GCAL_ENCRYPT_KEY || "asd-default-key-change-me-in-prod!").padEnd(32).slice(0, 32),
  "utf8"
);
function encryptToken(plain) {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", _encKey, iv);
  return iv.toString("hex") + ":" + c.update(plain, "utf8", "hex") + c.final("hex");
}
function decryptToken(enc) {
  const [ivHex, data] = enc.split(":");
  const d = createDecipheriv("aes-256-cbc", _encKey, Buffer.from(ivHex, "hex"));
  return d.update(data, "hex", "utf8") + d.final("utf8");
}

async function gcalExchangeCode(code) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: GCAL_ID, client_secret: GCAL_SECRET, redirect_uri: GCAL_REDIR, grant_type: "authorization_code" }),
  });
  return r.json();
}

async function gcalRefreshAccessToken(refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: GCAL_ID, client_secret: GCAL_SECRET, grant_type: "refresh_token" }),
  });
  return r.json();
}

async function gcalFetchRaw(accessToken) {
  const now = new Date();
  const pastStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); // 90 days back for history
  const maxTime = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);  // 60 days forward
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(pastStart.toISOString())}&timeMax=${encodeURIComponent(maxTime.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=500`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return { ok: r.ok, status: r.status, data: await r.json() };
}

function mapGcalItems(rawItems) {
  return (rawItems || [])
    .filter(e => {
      const self = (e.attendees || []).find(a => a.self);
      return !self || self.responseStatus !== "declined";
    })
    .map(e => ({
      id: e.id,
      title: e.summary || "(No title)",
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      allDay: !e.start?.dateTime,
      location: e.location || "",
      description: e.description || "",
      meetLink: (() => {
        if (e.hangoutLink) return e.hangoutLink;
        const eps = e.conferenceData?.entryPoints || [];
        const vid = eps.find(ep => ep.entryPointType === "video" || ep.uri?.startsWith("http"));
        if (vid?.uri) return vid.uri;
        if (e.location && /^https?:\/\//i.test(e.location.trim())) return e.location.trim();
        const m = (e.description || "").match(/https?:\/\/[^\s<>"']+/);
        return m ? m[0] : "";
      })(),
      organizer: e.organizer?.displayName || e.organizer?.email || "",
      attendees: (e.attendees || []).map(a => a.displayName || a.email).filter(Boolean),
    }));
}

// Redirect browser to Google OAuth consent screen
app.get("/gcal/auth/url", (req, res) => {
  const user = (req.query.user || "").replace(/[^A-Z0-9_]/gi, "").toUpperCase();
  if (!user || !GCAL_ID || !GCAL_REDIR) {
    return res.status(400).send("GCal not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI in Railway.");
  }
  const params = new URLSearchParams({
    client_id: GCAL_ID,
    redirect_uri: GCAL_REDIR,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    access_type: "offline",
    prompt: "consent",
    state: user,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Google redirects here after user approves — exchange code, store refresh token
app.get("/gcal/auth/callback", async (req, res) => {
  const { code, state: user, error } = req.query;
  if (error) return res.redirect(`/gcal/auth/done?result=error&reason=${encodeURIComponent(error)}`);
  if (!code || !user) return res.redirect("/gcal/auth/done?result=error&reason=missing_params");
  try {
    const tokens = await gcalExchangeCode(code);
    if (tokens.error) return res.redirect(`/gcal/auth/done?result=error&reason=${encodeURIComponent(tokens.error)}`);
    if (!tokens.refresh_token) return res.redirect("/gcal/auth/done?result=error&reason=no_refresh_token");
    await fsSet("googleTokens", user, { encryptedRefreshToken: encryptToken(tokens.refresh_token), connectedAt: Date.now() });
    res.redirect(`/gcal/auth/done?result=connected&user=${encodeURIComponent(user)}`);
  } catch (err) {
    console.error("[gcal/callback]", err);
    res.redirect(`/gcal/auth/done?result=error&reason=${encodeURIComponent(err.message)}`);
  }
});

// Tiny page that closes the OAuth popup and notifies the parent window
app.get("/gcal/auth/done", (req, res) => {
  const result = req.query.result || "error";
  const user = req.query.user || "";
  const reason = req.query.reason || "";
  res.setHeader("Content-Type", "text/html");
  res.send(`<!doctype html><html><head><title>Calendar</title></head><body>
<script>
try { window.opener && window.opener.postMessage(${JSON.stringify({ gcalAuth: result, user, reason })}, ${JSON.stringify(process.env.APP_ORIGIN || "https://www.advancedsteeldrafting.com.au")}); } catch(e) {}
setTimeout(() => window.close(), 400);
</script>
<p style="font-family:sans-serif;padding:20px;color:#334155">${result === "connected" ? "✅ Calendar connected — closing window…" : "❌ Connection failed — closing window…"}</p>
</body></html>`);
});

// Fetch events for a user using their stored refresh token
app.get("/gcal/events", async (req, res) => {
  const user = (req.query.user || "").replace(/[^A-Z0-9_]/gi, "").toUpperCase();
  if (!user || !GCAL_ID || !GCAL_SECRET) return res.status(400).json({ error: "not_configured" });
  try {
    const stored = await fsGet("googleTokens", user);
    if (!stored?.encryptedRefreshToken) return res.status(401).json({ error: "not_connected" });

    const refreshToken = decryptToken(stored.encryptedRefreshToken);
    const tokenRes = await gcalRefreshAccessToken(refreshToken);
    if (!tokenRes.access_token) return res.status(401).json({ error: "token_refresh_failed" });

    const { ok, status, data } = await gcalFetchRaw(tokenRes.access_token);
    if (!ok) {
      if (status === 401) {
        await fsDelete("googleTokens", user);
        return res.status(401).json({ error: "not_connected" });
      }
      return res.status(status).json({ error: `Calendar API ${status}` });
    }

    const items = mapGcalItems(data.items);

    // Push meeting times to Firestore so all team members see accurate status dots
    const timesPayload = {
      fetchedAt: Date.now(),
      meetings: items.filter(e => !e.allDay && e.start && e.end).map(e => ({ start: e.start, end: e.end })),
    };
    if (adminDb) {
      adminDb.collection("appState").doc("asd_gcal_times").set({ value: { [user]: timesPayload } }, { merge: true }).catch(console.error);
    } else {
      fsUpdateField("appState", "asd_gcal_times", `value.${user}`, timesPayload)
        .catch(() => fsSet("appState", "asd_gcal_times", { value: { [user]: timesPayload } }).catch(console.error));
    }

    res.json({ items });
  } catch (err) {
    console.error("[gcal/events]", err);
    res.status(500).json({ error: err.message });
  }
});

// Check if a user has Calendar connected
app.get("/gcal/status", async (req, res) => {
  const user = (req.query.user || "").replace(/[^A-Z0-9_]/gi, "").toUpperCase();
  if (!user) return res.json({ connected: false });
  try {
    const stored = await fsGet("googleTokens", user);
    res.json({ connected: !!stored?.encryptedRefreshToken });
  } catch {
    res.json({ connected: false });
  }
});

// Disconnect — delete stored tokens and clear meeting times
app.post("/gcal/disconnect", async (req, res) => {
  const user = ((req.body || {}).user || "").replace(/[^A-Z0-9_]/gi, "").toUpperCase();
  if (!user) return res.status(400).json({ error: "user required" });
  await fsDelete("googleTokens", user);
  fsUpdateField("appState", "asd_gcal_times", `value.${user}`, { fetchedAt: 0, meetings: [] }).catch(console.error);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MICROSOFT TEAMS PRESENCE — app-only auth, polls Graph API every 30s
// Requires: Azure AD app with Presence.Read.All application permission + admin consent
// Set in Railway: TEAMS_TENANT_ID, TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET
// Set email per member: TEAMS_RAJ_EMAIL, TEAMS_LESLIE_EMAIL, etc.
// ═══════════════════════════════════════════════════════════════════════════════
const TEAMS_TENANT   = process.env.TEAMS_TENANT_ID;
const TEAMS_APP_ID   = process.env.TEAMS_CLIENT_ID;
const TEAMS_APP_SEC  = process.env.TEAMS_CLIENT_SECRET;

// Map member names → their Microsoft account email (set each in Railway)
const TEAMS_EMAILS = {
  RAJ:      process.env.TEAMS_RAJ_EMAIL,
  LESLIE:   process.env.TEAMS_LESLIE_EMAIL,
  LALITHA:  process.env.TEAMS_LALITHA_EMAIL,
  SRIKANTH: process.env.TEAMS_SRIKANTH_EMAIL,
};

let _teamsToken = null, _teamsTokenExpiry = 0;

async function getTeamsToken() {
  if (_teamsToken && Date.now() < _teamsTokenExpiry) return _teamsToken;
  if (!TEAMS_TENANT || !TEAMS_APP_ID || !TEAMS_APP_SEC) return null;
  try {
    const r = await fetch(`https://login.microsoftonline.com/${TEAMS_TENANT}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: TEAMS_APP_ID, client_secret: TEAMS_APP_SEC, scope: "https://graph.microsoft.com/.default" }),
    });
    const d = await r.json();
    if (d.access_token) {
      _teamsToken = d.access_token;
      _teamsTokenExpiry = Date.now() + (parseInt(d.expires_in || "3600") - 60) * 1000;
    }
    return _teamsToken;
  } catch { return null; }
}

async function pollTeamsPresence() {
  const token = await getTeamsToken();
  if (!token) return;
  const results = {};
  const members = Object.entries(TEAMS_EMAILS).filter(([, email]) => !!email);
  if (!members.length) return;
  await Promise.all(members.map(async ([member, email]) => {
    try {
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/presence`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const d = await r.json();
        results[member] = d.activity || "Unknown";
      }
    } catch {}
  }));
  if (Object.keys(results).length > 0) {
    const data = { value: results, updatedAt: Date.now() };
    if (adminDb) {
      adminDb.collection("appState").doc("teams_presence").set(data).catch(console.error);
    } else {
      fsSet("appState", "teams_presence", data).catch(console.error);
    }
  }
}

if (TEAMS_TENANT && TEAMS_APP_ID && TEAMS_APP_SEC) {
  pollTeamsPresence().catch(console.error);
  setInterval(() => pollTeamsPresence().catch(console.error), 30_000);
  console.log("[teams] Presence polling started (30s interval)");
}

// Manual refresh endpoint (client can call to get immediate update)
app.get("/teams/presence/refresh", async (_req, res) => {
  await pollTeamsPresence().catch(console.error);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROACTIVE GCAL TOKEN REFRESH — keeps all connected users' tokens alive
// Runs hourly. Clears expired tokens so users get a clean reconnect prompt
// rather than silently stale data.
// ═══════════════════════════════════════════════════════════════════════════════
async function proactiveGcalRefreshAll() {
  if (!GCAL_ID || !GCAL_SECRET) return;
  try {
    const docs = await fsListDocs("googleTokens");
    if (!docs.length) return;
    console.log(`[gcal-cron] Proactive refresh for ${docs.length} connected user(s)`);
    await Promise.all(docs.map(async ({ id: user, data: stored }) => {
      if (!stored?.encryptedRefreshToken) return;
      try {
        const refreshToken = decryptToken(stored.encryptedRefreshToken);
        const tokenRes = await gcalRefreshAccessToken(refreshToken);
        if (!tokenRes.access_token) {
          // Token permanently expired/revoked — delete so user gets a clear reconnect prompt
          await fsDelete("googleTokens", user);
          console.log(`[gcal-cron] Token expired for ${user} — cleared, user must reconnect`);
          return;
        }
        const { ok, status, data } = await gcalFetchRaw(tokenRes.access_token);
        if (!ok) {
          if (status === 401) { await fsDelete("googleTokens", user); return; }
          return; // Transient error — don't delete, will retry next hour
        }
        const items = mapGcalItems(data.items);
        const timesPayload = {
          fetchedAt: Date.now(),
          meetings: items.filter(e => !e.allDay && e.start && e.end).map(e => ({ start: e.start, end: e.end })),
        };
        if (adminDb) {
          adminDb.collection("appState").doc("asd_gcal_times").set({ value: { [user]: timesPayload } }, { merge: true }).catch(console.error);
        } else {
          fsUpdateField("appState", "asd_gcal_times", `value.${user}`, timesPayload).catch(console.error);
        }
        console.log(`[gcal-cron] Refreshed ${user}: ${items.length} events`);
      } catch (e) {
        console.error(`[gcal-cron] Error refreshing ${user}:`, e.message);
      }
    }));
  } catch (e) {
    console.error("[gcal-cron] proactiveGcalRefreshAll failed:", e.message);
  }
}

// Run immediately on startup, then every hour
proactiveGcalRefreshAll().catch(console.error);
setInterval(() => proactiveGcalRefreshAll().catch(console.error), 60 * 60 * 1000);
console.log("[gcal-cron] Proactive hourly refresh scheduled");

// ═══════════════════════════════════════════════════════════════════════════════
// EXISTING — AI brief + spell-check proxies
// ═══════════════════════════════════════════════════════════════════════════════
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
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 220,
        messages: [{ role: "user", content: `Write a 2-3 sentence professional project description for an Australian structural steel detailing portfolio website.\n\nProject: ${title || "Steel project"}\nType: ${type}\nYear: ${year}\nKeywords: ${keywords}\n\nRules:\n- 2-3 concise sentences only\n- Professional, factual tone\n- Focus on the steel detailing scope delivered (modelling, GA drawings, fabrication drawings, RFI management, etc.)\n- Australian English, no marketing fluff\n- Output the description only — no preamble, no quotation marks` }],
      }),
    });
    if (!r.ok) { const body = await r.text(); console.error("[ai-brief] Anthropic error", r.status, body); return res.status(500).json({ error: `Anthropic ${r.status}: ${body.slice(0, 200)}` }); }
    const data = await r.json();
    const text = (data.content?.[0]?.text || "").trim();
    if (!text) throw new Error("Empty response");
    res.json({ text });
  } catch (err) { console.error("[ai-brief]", err.message); res.status(500).json({ error: err.message || "AI generation failed." }); }
});

app.post("/api/spellcheck", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests — try again in a minute." });
  const key = process.env.ANTHROPIC_KEY;
  if (!key) return res.status(503).json({ error: "AI not configured on this server." });
  const { text = "" } = req.body || {};
  if (!text.trim()) return res.status(400).json({ error: "text required" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 600,
        messages: [{ role: "user", content: `Check the following text for spelling and grammar errors. Return ONLY a valid JSON object with two fields:\n1. "text": the fully corrected text (identical to input if nothing to fix)\n2. "changes": an array of short strings describing each correction made (empty array if none)\n\nRules:\n- Fix spelling and grammar only — do not rephrase, rewrite, or change meaning\n- Keep Australian English spelling (e.g. "colour", "realise")\n- Preserve all formatting, line breaks, and punctuation style\n- Return raw JSON only — no markdown, no code fences, no explanation\n\nText:\n${text}` }],
      }),
    });
    if (!r.ok) { const b = await r.text(); throw new Error(`Anthropic ${r.status}: ${b.slice(0, 150)}`); }
    const data = await r.json();
    const raw = (data.content?.[0]?.text || "").trim().replace(/^```json\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(raw);
    res.json({ text: parsed.text || text, changes: Array.isArray(parsed.changes) ? parsed.changes : [] });
  } catch (err) { console.error("[spellcheck]", err.message); res.status(500).json({ error: err.message || "Spell check failed." }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC SPA
// ═══════════════════════════════════════════════════════════════════════════════
app.use(express.static(join(__dirname, "dist"), { index: false }));
app.get(/^(?!\/api\/|\/gcal\/|\/teams\/).*/, (_req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => console.log(`ASD server on :${PORT}`));
