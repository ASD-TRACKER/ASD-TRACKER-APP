import { useState, useEffect, useRef, useContext, createContext, Component, useCallback, useMemo, Fragment } from "react";
import { createPortal } from "react-dom";
import { doc, onSnapshot, setDoc, updateDoc, deleteField, collection, addDoc, runTransaction, deleteDoc, getDocs, getDoc } from "firebase/firestore";
import { ref as storageFileRef, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";
import { updateProfile } from "firebase/auth";
import { firebaseConfigured, db, authReady, storage, auth } from "./src/firebase.js";

// ═════════════════════════════════════════════════
// TEAM ROSTER — RAJ is the admin (only admin can add/remove members or reset
// PINs); everyone else is a regular member. Roster is persisted/synced via
// usePersistentState like everything else, and exposed through TeamContext so
// any component can read it without prop-drilling through the whole tree.
// ═════════════════════════════════════════════════
const DEFAULT_TEAM = [
  { name:"RAJ",      pin:"1bc3201a9f24a2fe48f634f90d406aaf6cbf5e36e292870ecba98d74b065ee1b", color:"#F97316", role:"admin" },
  { name:"LESLIE",   pin:"38083c7ee9121e17401883566a148aa5c2e2d55dc53bc4a94a026517dbff3c6b", color:"#3B82F6", role:"member" },
  { name:"LALITHA",  pin:"ceaa28bba4caba687dc31b1bbe79eca3c70c33f871f1ce8f528cf9ab5cfd76dd", color:"#EC4899", role:"member" },
  { name:"SRIKANTH", pin:"f8638b979b2f4f793ddb6dbd197e0ee25a7a6ea32b0ae22f5e3c5d119d839e75", color:"#8B5CF6", role:"member" },
];
const TEAM_COLOR_PALETTE = ["#F97316","#3B82F6","#EC4899","#8B5CF6","#10B981","#06B6D4","#F59E0B","#EF4444","#14B8A6","#A855F7"];
const TeamContext = createContext(null);
function useTeam() { return useContext(TeamContext); }

// ═════════════════════════════════════════════════
// THEME — dark (default) / light, toggled per user and saved to localStorage.
// CSS variables are injected on <html> so every inline style that references
// var(--c-*) picks up the change instantly without a re-render cascade.
// ═════════════════════════════════════════════════
const ThemeContext = createContext("dark");
function useThemeMode() { return useContext(ThemeContext); }

const THEME_CSS = `
:root {
  --c-page:#F1F5F9; --c-panel:#FFFFFF; --c-deep:#E2E8F0;
  --c-border:#CBD5E1; --c-border2:#E2E8F0;
  --c-t1:#0F172A; --c-t2:#1E293B; --c-t3:#475569; --c-t4:#64748B; --c-t5:#94A3B8;
  --c-input-bg:#FFFFFF; --c-input-border:#CBD5E1; --c-input-text:#0F172A;
}
html[data-theme="dark"] {
  --c-page:#0F172A; --c-panel:#1E293B; --c-deep:#0A1120;
  --c-border:#334155; --c-border2:#1E293B;
  --c-t1:#F1F5F9; --c-t2:#CBD5E1; --c-t3:#94A3B8; --c-t4:#64748B; --c-t5:#475569;
  --c-input-bg:#0F172A; --c-input-border:#334155; --c-input-text:#F1F5F9;
}
`;

// Run synchronously at parse time — before React mounts — so the saved theme
// is applied instantly with zero flash on every page load or refresh.
(function initTheme() {
  const saved = (typeof localStorage !== "undefined" && localStorage.getItem("asd_theme")) || "light";
  let el = document.getElementById("asd-theme-vars");
  if (!el) { el = document.createElement("style"); el.id = "asd-theme-vars"; document.head.appendChild(el); }
  el.textContent = THEME_CSS;
  document.documentElement.dataset.theme = saved;
  if (document.body) document.body.style.background = saved === "dark" ? "#0F172A" : "#F1F5F9";
})();

(function injectAnimations() {
  const el = document.createElement("style");
  el.id = "asd-animations";
  el.textContent = [
    "@keyframes asd-read-pulse{0%,100%{filter:brightness(1);box-shadow:0 0 0 0 rgba(249,115,22,0)}50%{filter:brightness(1.75);box-shadow:0 0 0 6px rgba(249,115,22,0.5),0 0 20px rgba(249,115,22,0.35)}}",
    "@keyframes asd-tag-pulse{0%,100%{opacity:0.4;text-shadow:none}50%{opacity:1;text-shadow:0 0 10px rgba(249,115,22,0.95),0 0 4px rgba(249,115,22,1)}}",
  ].join("");
  document.head.appendChild(el);
})();

// Returns live window width; updates on resize — used for responsive layout
function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1200));
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h, { passive: true });
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

// Members whose login/logout is tracked for attendance reporting
const PRESENCE_TRACKED = ["RAJ", "LESLIE", "LALITHA", "SRIKANTH"];
// Members who can see the live presence cluster in the header
const HEADER_PRESENCE_VIEWERS = ["RAJ", "LESLIE"];

// Online value: array of { sid, ts, system } — one entry per active tab/device.
// ts is refreshed every 60 s (heartbeat); entries older than 2 min are stale.
// Legacy string / single-object values are treated as stale immediately.
const ONLINE_TTL_MS = 3.5 * 60 * 1000; // 3.5 min — 60s heartbeat + 1.5 min buffer for browser throttling
const isSessionFresh = s => s && s.ts && Date.now() - s.ts < ONLINE_TTL_MS;
const isOnlineFresh = val => {
  if (!val || typeof val === "string") return false;
  if (Array.isArray(val)) return val.some(isSessionFresh);
  return isSessionFresh(val); // backward compat: single object
};
// Returns system label strings for all fresh sessions (one per active tab/device)
const getActiveSystems = val => {
  if (!val || typeof val === "string") return [];
  const sessions = Array.isArray(val) ? val : [val];
  return sessions.filter(isSessionFresh).map(s => s.system).filter(Boolean);
};
// Returns the user-named device label (set once per machine), falling back to browser · OS
const getSystemInfo = () => {
  const saved = localStorage.getItem("asd_device_name");
  if (saved && saved.trim()) return saved.trim();
  const ua = navigator.userAgent;
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  let os = "Unknown";
  if (/Windows NT 1[0-9]/.test(ua)) os = "Windows";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Mac OS X/.test(ua)) os = "Mac";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Linux/.test(ua)) os = "Linux";
  return `${browser} · ${os}`;
};

// Bump this on deploys that change how data is written. Tabs running an older
// build see the higher number in Firestore (appState/asd_app_version) and
// auto-reload, so stale clients can't keep writing old-shaped data.
const APP_VERSION = 3;

// ── Web3Forms key for quote email notifications ────────────────────────────
// FREE setup (30 sec): go to https://web3forms.com/create → enter
// admin@advancedsteeldrafting.com → copy the access key → paste below.
const WEB3FORMS_KEY = "YOUR_WEB3FORMS_KEY_HERE";

// ── Default portfolio items shown on the public landing page ───────────────
const DEFAULT_PORTFOLIO = [
  { id:"pf1", title:"Multi-Storey Commercial Frame — Melbourne CBD", type:"Commercial", year:"2024", status:"Issued", desc:"Full structural steel modelling, GA drawings and fabrication package for a 6-storey commercial building. Delivered 3 days ahead of schedule.", imageUrl:"", tags:["Tekla Structures","GA Drawings","Fab Package","Commercial"] },
  { id:"pf2", title:"Residential Duplex Frames — Kew, VIC", type:"Residential", year:"2024", status:"Issued", desc:"3D modelling and complete documentation package for a dual-occupancy residential development including all connection details.", imageUrl:"", tags:["Tekla Structures","Residential","Connections"] },
  { id:"pf3", title:"Industrial Warehouse Structure — Dandenong South", type:"Industrial", year:"2024", status:"Issued", desc:"Large-span industrial warehouse with mezzanine floor. Full fabrication drawings, RFI management and issued-for-construction package.", imageUrl:"", tags:["Industrial","RFI Management","Mezzanine","Large-Span"] },
  { id:"pf4", title:"Portal Frame Factory — Sunshine, VIC", type:"Industrial", year:"2023", status:"Issued", desc:"Steel portal frame design documentation for a manufacturing facility including crane beams, column bases and bracing details.", imageUrl:"", tags:["Portal Frame","Fab Package","Crane Beams"] },
  { id:"pf5", title:"3-Storey Townhouse Complex — Carlton, VIC", type:"Residential", year:"2024", status:"Issued", desc:"Structural steel detailing for a 3-storey townhouse development. Coordinated with LGS frame and precast panel elements.", imageUrl:"", tags:["Residential","LGS Coordination","Multi-Storey"] },
  { id:"pf6", title:"Commercial Office Fitout — Docklands, VIC", type:"Commercial", year:"2023", status:"Issued", desc:"Steel detailing for a commercial office fitout including feature staircases, mezzanine structures and architectural steel elements.", imageUrl:"", tags:["Commercial","Staircases","Architectural Steel"] },
];

const DEFAULT_SITE_SERVICES = [
  { id:"sv1", icon:"⬡", title:"Structural Steel Modelling", desc:"Precision 3D modelling of structural steel frameworks using Tekla Structures for residential, commercial and industrial projects.", color:"#3B82F6", visible:true },
  { id:"sv2", icon:"📋", title:"RFI Management", desc:"Systematic handling of Requests for Information, ensuring design queries are resolved and documented before fabrication commences.", color:"#8B5CF6", visible:true },
  { id:"sv3", icon:"📐", title:"GA Drawings", desc:"General arrangement drawings showing member positions, connections, levels and setting-out information for construction.", color:"#F97316", visible:true },
  { id:"sv4", icon:"🔩", title:"Fabrication Drawings", desc:"Detailed shop and fabrication drawings for steel members, connections, base plates and all associated steelwork.", color:"#10B981", visible:true },
  { id:"sv5", icon:"✅", title:"Final Package", desc:"Managed drawing issue, revision control and full project handover — ensuring the right revision reaches the right people at the right time.", color:"#06B6D4", visible:true },
];

const DEFAULT_SITE_STATS = [
  { id:"st1", num:"200+", label:"Projects Completed" },
  { id:"st2", num:"10+",  label:"Years Experience" },
  { id:"st3", num:"100%", label:"On-Time Delivery" },
  { id:"st4", num:"24hr", label:"Quote Turnaround" },
];

const DEFAULT_SITE_TESTIMONIALS = [
  { id:"tm1", quote:"ASD turned around our GA drawings within 3 business days. Accurate, clean drawings with no back-and-forth required.", name:"Mark T.", role:"Project Manager, Melbourne Steel Fabrication", visible:true },
  { id:"tm2", quote:"The level of detail in their shop drawings saved us at least two weeks on site. They really understand what fabricators need.", name:"Jason W.", role:"Site Manager, Premier Structural", visible:true },
  { id:"tm3", quote:"Consistent, accurate and always responsive when we need revisions. ASD is our go-to detailing team for every project.", name:"Sarah L.", role:"Director, Optima Steel", visible:true },
];

// ── ASD business details (from invoices on Google Drive) ──────────────────
const ASD_BUSINESS = {
  name: "Advanced Steel Drafting",
  address: "Broadmeadows, VIC",
  email: "raj@advancedsteeldrafting.com",
  phone: "0452 068 564",
  abn: "91 670 611 319",
  acn: "670 611 319",
  bsb: "013-230",
  accountNo: "164095595",
  accountName: "Advanced Steel Drafting",
};

// Fabricator/client codes — admin-curated list (same admin as the team roster)
// so the Client field on a project is picked from a controlled list instead
// of free text, avoiding typo'd duplicates like "USS" vs "uss".
const DEFAULT_CLIENTS = ["DF", "GS", "USS", "SQUARED", "CHRIS", "3RD ANGLE"];

// Per-client contact details — keyed by client code, pre-seeded from Drive invoices
const DEFAULT_CLIENT_DETAILS = {
  "DF":        { companyName: "Dream Engineering",       contactName: "Satnam",       email: "Info@dreamengineering.com.au",              phone: "0449 102 213" },
  "USS":       { companyName: "Unlimited Structural Steel", contactName: "Daniel",    email: "daniel@unlimitedstructuralsteel.com.au",    phone: "0430 386 515" },
  "GS":        { companyName: "Genuine Steel",           contactName: "Max",          email: "ma@genuinesteel.com.au",                    phone: "0468 426 066" },
  "SQUARED":   { companyName: "SQUARED",                 contactName: "Conrad",       email: "invoices@sqrd.com.au",                      phone: "0439 764 185" },
  "CHRIS":     { companyName: "CCS Services Group",      contactName: "Chris Raffoul",email: "chris_raffoul@ccsservicesgroup.com.au",     phone: "" },
  "3RD ANGLE": { companyName: "3rd Angle",               contactName: "",             email: "",                                          phone: "" },
};

const PROJECT_STATUS = {
  "PENDING":               { color:"#6B7280", bg:"#6B728020" },
  "ON HOLD":               { color:"#8B5CF6", bg:"#8B5CF620" },
  "MODELLING":             { color:"#3B82F6", bg:"#3B82F620" },
  "RFI & FAB DRAWINGS":    { color:"#F97316", bg:"#F9731620" },
  "APPROVED-READY TO ISSUE": { color:"#10B981", bg:"#10B98120" },
  "Completed":             { color:"#22C55E", bg:"#22C55E20" },
};
// "Completed" is set only via the dedicated Mark-Complete action, never picked
// manually — kept out of the selectable options shown in Status dropdowns.
const SELECTABLE_PROJECT_STATUS = Object.keys(PROJECT_STATUS).filter(s => s !== "Completed");
const TASK_STATUS = {
  "Not Started": { color:"#6B7280", bg:"#6B728020" },
  "In Progress": { color:"#3B82F6", bg:"#3B82F620" },
  "On Hold":     { color:"#F59E0B", bg:"#F59E0B20" },
  "Completed":   { color:"#10B981", bg:"#10B98120" },
  "Urgent":      { color:"#EF4444", bg:"#EF444420" },
};
const PRIORITY = ["Low","Medium","High","Urgent"];
const PROJECT_TYPES = ["Residential","Commercial","MISC","Take-Off"];
const PRIORITY_CLR = { Low:"#6B7280", Medium:"#F59E0B", High:"#EF4444", Urgent:"#7C3AED" };
const PRIORITY_RANK = { Urgent:0, High:1, Medium:2, Low:3 };
const PHASES = ["TAKE-OFF","MODELLING STAGE","RFI STAGE","FAB DRAWINGS STAGE","READY TO ISSUE"];
const PHASE_PCT = { "TAKE-OFF":0, "MODELLING STAGE":20, "RFI STAGE":40, "FAB DRAWINGS STAGE":60, "READY TO ISSUE":80 };
const phasePct = (phase, status) => status === "Completed" ? 100 : (PHASE_PCT[phase] ?? 0);
const CL_SECTIONS = ["Take-Off","Job Study","Modelling","GA Drawings","Issue GA","RFI & Acceptance","Fab Drawing","Issued Drawings"];
const SECTION_CLR = {
  "Take-Off":"#F59E0B",
  "Job Study":"#F97316",
  "Modelling":"#8B5CF6","GA Drawings":"#3B82F6","Issue GA":"#EC4899",
  "RFI & Acceptance":"#F59E0B","Fab Drawing":"#06B6D4","Issued Drawings":"#10B981",
};

const nowTs = () => new Date().toISOString();
const fmtTs = iso => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-AU",{day:"numeric",month:"short",year:"2-digit",hour:"2-digit",minute:"2-digit",hour12:true});
};

const INITIAL_TEMPLATE = [
  { section:"Take-Off", label:"Measure & take off steel quantities from drawings", takeOffOnly:true },
  { section:"Job Study", label:"Review project documentation & engineering report" },
  { section:"Job Study", label:"Confirm scope of works with client" },
  { section:"Job Study", label:"Confirm project type & specification" },
  { section:"Job Study", label:"Review site conditions & constraints" },
  { section:"Modelling", label:"Preview structural & architectural drawings" },
  { section:"Modelling", label:"Check folder and understand scope of works" },
  { section:"Modelling", label:"Background reference CAD — check if readable & clear" },
  { section:"Modelling", label:"Gridlines — follow col and external wall location" },
  { section:"Modelling", label:"Insert slab — insert FFL and unit numbering" },
  { section:"Modelling", label:"Insert cols & beams with assembly number at correct height" },
  { section:"Modelling", label:"Col/Beam profile & numbering check" },
  { section:"Modelling", label:"Insert windows if required" },
  { section:"GA Drawings", label:"Check all beam & col profiles match structural drawing" },
  { section:"GA Drawings", label:"Check precamber/galvanize requirements" },
  { section:"GA Drawings", label:"3D view — clear marks and notes" },
  { section:"GA Drawings", label:"Col plan view — dimensions correct" },
  { section:"GA Drawings", label:"Beam plan view — dimensions correct" },
  { section:"GA Drawings", label:"Elevation view — heights correct" },
  { section:"GA Drawings", label:"Section details — cuts/chamfers correct" },
  { section:"GA Drawings", label:"GA drawing page numbering correct" },
  { section:"Issue GA", label:"Check col & beam profiles per engineering" },
  { section:"Issue GA", label:"Insert structural layout" },
  { section:"Issue GA", label:"Notes & specifications listed" },
  { section:"Issue GA", label:"COLUMNS — Baseplate connection detail" },
  { section:"Issue GA", label:"COLUMNS — Column foot direction" },
  { section:"Issue GA", label:"COLUMNS — Column cap plate" },
  { section:"Issue GA", label:"BEAMS — Secondary beams sequence" },
  { section:"Issue GA", label:"BEAMS — Steel beam cleats specs" },
  { section:"Issue GA", label:"BEAMS — Timber beam cleats specs" },
  { section:"Issue GA", label:"BEAMS — Beam seat on block wall" },
  { section:"Issue GA", label:"BEAMS — Portal/rigid frame connection" },
  { section:"Issue GA", label:"LINTELS — Shelf lintel location" },
  { section:"Issue GA", label:"LINTELS — Door stud opening clearances" },
  { section:"Issue GA", label:"STAIRS — Overall stair heights" },
  { section:"Issue GA", label:"STAIRS — Stair void sizes" },
  { section:"Issue GA", label:"LGS MODEL — Check for clashes" },
  { section:"Issue GA", label:"GA & MODEL — Write out model with status" },
  { section:"Issue GA", label:"GA & MODEL — Output IFC and Trimble Connect" },
  { section:"Issue GA", label:"GA & MODEL — Attach RFI with GA drawings" },
  { section:"Issue GA", label:"GA & MODEL — Output preliminary material list" },
  { section:"RFI & Acceptance", label:"All RFIs ticked" },
  { section:"RFI & Acceptance", label:"Bolt tolerances correct" },
  { section:"RFI & Acceptance", label:"Confirm site visit & measurement" },
  { section:"Fab Drawing", label:"Check model is in correct version" },
  { section:"Fab Drawing", label:"Perform assembly clash check" },
  { section:"Issued Drawings", label:"Check secondary beam install sequence" },
  { section:"Issued Drawings", label:"Galvanized beam/col — provide holes/chamfer" },
  { section:"Issued Drawings", label:"Check if site welding can be avoided" },
  { section:"Issued Drawings", label:"Check finishing for exposed steel" },
  { section:"Issued Drawings", label:"Add bracing for frames" },
];

const mkId = () => crypto.randomUUID();

const isHashed = v => typeof v === "string" && v.length === 64 && /^[0-9a-f]+$/.test(v);

const hashPin = async pin => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(pin)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
};

// Notes used to be a single freeform string — normalize old saved data into the
// {id,text,author,ts,tagged,readBy} list shape so existing project notes don't silently vanish.
// IDs for legacy string notes are derived deterministically from the text so repeated calls
// return the same ID and React can diff note lists without remounting on every render.
const noteList = notes => {
  let arr;
  if (Array.isArray(notes)) arr = notes;
  else if (typeof notes === "string" && notes.trim()) {
    const text = notes.trim();
    let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    arr = [{ id: `legacy_${h.toString(36)}`, text, author: "", ts: "" }];
  }
  else arr = [];
  return arr.map(n => ({ tagged: [], readBy: [], scheduledBy: [], scheduleCompletedBy: [], ...n }));
};

const MASTER_DEFAULT = INITIAL_TEMPLATE.map((item, i) => ({
  id: `tpl_${String(i).padStart(3,"0")}`,
  section: item.section,
  label: item.label,
  ...(item.takeOffOnly ? { takeOffOnly: true } : {}),
}));

const makeChecklist = (template) => {
  const tpl = template || MASTER_DEFAULT;
  return tpl.map(item => ({
    id: mkId(),
    templateId: item.id || null,
    section: item.section,
    label: item.label,
    done: false,
    note: "",
    history: [],
    flag: null,
    ...((item.subItems||[]).length ? { subItems: item.subItems.map(si=>({ id:mkId(), text:si.text, done:false })) } : {}),
    ...(item.takeOffOnly ? { takeOffOnly: true } : {}),
  }));
};

const getProjectUpdates = (project, master) => {
  const cl = project.checklist || [];
  const projectTplIds = new Set(cl.map(c => c.templateId).filter(Boolean));
  const isTakeOff = project.type === "Take-Off";
  const newItems = master.filter(m => !projectTplIds.has(m.id) && (m.takeOffOnly ? isTakeOff : true));
  const changedItems = master.filter(m => {
    const existing = cl.find(c => c.templateId === m.id);
    if (!existing) return false;
    if (existing.label !== m.label) return true;
    const mSubs = (m.subItems||[]).map(s=>s.text).join("\x00");
    const eSubs = (existing.subItems||[]).map(s=>s.text).join("\x00");
    return mSubs !== eSubs;
  }).map(m => ({
    master: m,
    existing: cl.find(c => c.templateId === m.id),
  }));
  return { newItems, changedItems };
};

const seedWithFlags = (cl, flagIndexes, flagger) => cl.map((item, i) =>
  flagIndexes.includes(i)
    ? { ...item, flag: { member: flagger, ts: new Date(Date.now() - 86400000).toISOString(), reason: "Needs RAJ to review before issue" } }
    : item
);

const completedChecklist = (members, completionDate) => {
  const baseDate = new Date(completionDate + "T08:00:00").getTime();
  return MASTER_DEFAULT.map((item, i) => {
    const daysOffset = Math.floor((MASTER_DEFAULT.length - i) / 6);
    const hourOffset = (i % 8);
    const tickedAt = new Date(baseDate - daysOffset*86400000 + hourOffset*3600000).toISOString();
    const member = members[i % members.length];
    return {
      id: mkId(),
      templateId: item.id,
      section: item.section,
      label: item.label,
      done: true,
      note: "",
      flag: null,
      history: [{ ts: tickedAt, member, action: "checked" }],
    };
  });
};

// Local YYYY-MM-DD. Must NOT use toISOString() (UTC) — for AU timezones (UTC+10/+11)
// that flips "today" a day early/late for several hours every morning.
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const TODAY = ymd(new Date()); // module-load snapshot — use todayYmd() in handlers that run later
const todayYmd = () => ymd(new Date()); // always returns the correct current date

// ═════════════════════════════════════════════════
// TIMEZONE SUPPORT — the team schedules across different zones.
// Every calendar event is tagged with its creator's detected zone (no manual
// setup needed — browsers expose this). Times are always shown as originally
// entered; when a viewer is in a different zone, we additionally show the
// converted "your time" so nobody misreads someone else's clock as their own.
// ═════════════════════════════════════════════════
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function zoneAbbrev(tz, dateYmd) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date(`${dateYmd||TODAY}T00:00:00Z`))
      .find(p => p.type === "timeZoneName")?.value || tz;
  } catch { return tz; }
}

// Converts a wall-clock HH:MM on `dateYmd`, understood to be in `fromTz`, into the
// equivalent wall-clock time in `toTz`. Dependency-free — works by measuring how far
// off a naive UTC reading of that wall-clock is from the real zoned instant, then
// correcting for it (the standard trick before Temporal/date-fns-tz existed).
function convertWallTime(dateYmd, timeHHMM, fromTz, toTz) {
  if (!timeHHMM || !fromTz || !toTz || fromTz === toTz) return { date: dateYmd, time: timeHHMM };
  try {
    const [y,mo,d] = dateYmd.split("-").map(Number);
    const [h,mi] = timeHHMM.split(":").map(Number);
    const utcGuess = Date.UTC(y, mo-1, d, h, mi);
    const partsOf = (date, tz) => new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle:"h23", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit",
    }).formatToParts(date).reduce((o,p)=>{ o[p.type]=p.value; return o; }, {});
    const p = partsOf(new Date(utcGuess), fromTz);
    const asIfLocal = Date.UTC(+p.year, +p.month-1, +p.day, +p.hour, +p.minute, +p.second);
    const trueUtc = new Date(utcGuess - (asIfLocal - utcGuess));
    const out = partsOf(trueUtc, toTz);
    return { date: `${out.year}-${out.month}-${out.day}`, time: `${out.hour}:${out.minute}` };
  } catch {
    return { date: dateYmd, time: timeHHMM };
  }
}

// Relative-date helper for seed data so due dates never appear stale on a fresh install
const _addDays = n => { const d = new Date(); d.setDate(d.getDate()+n); return ymd(d); };

const SEED_PROJECTS = [
  { id:"p1",  jobCode:"USS-001", name:"55 Molesworth St, Kew",               client:"USS", type:"Residential", status:"RFI & FAB DRAWINGS", priority:"Medium", phase:"RFI STAGE",           assigned:["LESLIE"], due:"",            pct:20,  notes:[{id:"seed_p1n1",  text:"Basement cols.",         author:"LESLIE", ts:"2026-07-01T09:00:00", tagged:[], readBy:[]}], completedDate:"", checklist:seedWithFlags(makeChecklist(),[2,5],"LESLIE") },
  { id:"p2",  jobCode:"USS-002", name:"370 Ballarat Rd, Skye",                client:"USS", type:"Residential", status:"RFI & FAB DRAWINGS", priority:"Medium", phase:"FAB DRAWINGS STAGE", assigned:["LESLIE"], due:"",            pct:80,  notes:[{id:"seed_p2n1",  text:"Received feedback.",      author:"RAJ",   ts:"2026-07-10T14:00:00", tagged:[], readBy:[]}], completedDate:"", checklist:seedWithFlags(makeChecklist(),[18],"LESLIE") },
  { id:"p3",  jobCode:"USS-003", name:"59 Porter St, Dandenong",              client:"USS", type:"Residential", status:"RFI & FAB DRAWINGS", priority:"Medium", phase:"RFI STAGE",           assigned:["LESLIE"], due:"",            pct:40,  notes:[{id:"seed_p3n1",  text:"Awaiting approval.",     author:"LESLIE", ts:"2026-07-15T10:00:00", tagged:[], readBy:[]}], completedDate:"", checklist:makeChecklist() },
  { id:"p4",  jobCode:"DF-001",  name:"57 Drummond St, Carlton",              client:"DF",  type:"Residential", status:"MODELLING",          priority:"Medium", phase:"MODELLING STAGE",     assigned:["RAJ"],    due:"",            pct:20,  notes:[], completedDate:"", checklist:makeChecklist() },
  { id:"p5",  jobCode:"DF-002",  name:"12 Fairy St, Ivanhoe",                 client:"DF",  type:"Residential", status:"RFI & FAB DRAWINGS", priority:"High",   phase:"FAB DRAWINGS STAGE", assigned:["RAJ"],    due:_addDays(14),  pct:80,  notes:[{id:"seed_p5n1",  text:"Preliminary required.",  author:"RAJ",   ts:"2026-07-12T09:00:00", tagged:[], readBy:[]}], completedDate:"", checklist:seedWithFlags(makeChecklist(),[10,19,22],"LESLIE") },
  { id:"p6",  jobCode:"GS-001",  name:"187 Bossington St, Oakleigh South",   client:"GS",  type:"Residential", status:"RFI & FAB DRAWINGS", priority:"High",   phase:"RFI STAGE",           assigned:["RAJ"],    due:_addDays(10),  pct:40,  notes:[{id:"seed_p6n1",  text:"Preliminary required.",  author:"RAJ",   ts:"2026-07-18T11:00:00", tagged:[], readBy:[]}], completedDate:"", checklist:makeChecklist() },
  { id:"p7",  jobCode:"USS-004", name:"26 Orchard Cres, Mt Albert North",    client:"USS", type:"Residential", status:"MODELLING",          priority:"Medium", phase:"MODELLING STAGE",     assigned:["LESLIE"], due:_addDays(21),  pct:20,  notes:[], completedDate:"", checklist:makeChecklist() },
  { id:"p8",  jobCode:"USS-005", name:"11 Campbell Rd, Deepdene",             client:"USS", type:"Residential", status:"MODELLING",          priority:"Medium", phase:"MODELLING STAGE",     assigned:["LESLIE"], due:_addDays(30),  pct:10,  notes:[], completedDate:"", checklist:makeChecklist() },
  { id:"p9",  jobCode:"USS-006", name:"239 Highfield Rd, Camberwell",         client:"USS", type:"Residential", status:"MODELLING",          priority:"Medium", phase:"MODELLING STAGE",     assigned:["LESLIE"], due:_addDays(28),  pct:10,  notes:[], completedDate:"", checklist:makeChecklist() },
  { id:"p10", jobCode:"USS-007", name:"33 Urquhart St, Hawthorn",             client:"USS", type:"Residential", status:"RFI & FAB DRAWINGS", priority:"Medium", phase:"RFI STAGE",           assigned:["LESLIE"], due:"",            pct:20,  notes:[], completedDate:"", checklist:makeChecklist() },
  { id:"p11", jobCode:"DF-003",  name:"1 Goble St, Niddrie",                  client:"DF",  type:"Residential", status:"RFI & FAB DRAWINGS", priority:"Medium", phase:"RFI STAGE",           assigned:["LESLIE"], due:"",            pct:20,  notes:[], completedDate:"", checklist:makeChecklist() },
  { id:"p12", jobCode:"DF-004",  name:"18 Coate Av, Alphington",              client:"DF",  type:"Residential", status:"RFI & FAB DRAWINGS", priority:"High",   phase:"FAB DRAWINGS STAGE", assigned:["LESLIE"], due:"",            pct:40,  notes:[{id:"seed_p12n1", text:"RAJ to review.",         author:"LESLIE", ts:"2026-07-20T08:30:00", tagged:["RAJ"], readBy:[]}], completedDate:"", checklist:makeChecklist() },
  { id:"p19", jobCode:"GS-002",  name:"48 Taronga Cres, Croydon",             client:"GS",  type:"Residential", status:"RFI & FAB DRAWINGS", priority:"Urgent", phase:"FAB DRAWINGS STAGE", assigned:["LESLIE"], due:_addDays(7),   pct:40,  notes:[{id:"seed_p19n1", text:"Steel install next week.", author:"LESLIE", ts:"2026-07-21T09:00:00", tagged:[], readBy:[]}], completedDate:"", checklist:makeChecklist() },
  { id:"p23", jobCode:"DF-005",  name:"65 Somerville Rd, Yarraville",         client:"DF",  type:"Residential", status:"RFI & FAB DRAWINGS", priority:"High",   phase:"FAB DRAWINGS STAGE", assigned:["RAJ"],    due:"",            pct:40,  notes:[{id:"seed_p23n1", text:"Feedback received.",     author:"RAJ",   ts:"2026-07-19T15:00:00", tagged:[], readBy:[]}], completedDate:"", checklist:makeChecklist() },
  { id:"p26", jobCode:"USS-008", name:"72 Viewhill Rd, Balwyn North",         client:"USS", type:"Residential", status:"PENDING",            priority:"Low",    phase:"TAKE-OFF",            assigned:["LESLIE"], due:_addDays(35),  pct:0,   notes:[], completedDate:"", checklist:makeChecklist() },
  { id:"pc1", jobCode:"USS-C01", name:"4 Parkside St, Malvern",               client:"USS", type:"Residential", status:"Completed",          priority:"Medium", phase:"READY TO ISSUE",      assigned:["LESLIE"], due:"2026-04-15", pct:100, notes:[{id:"seed_pc1n1", text:"Issued and signed off.", author:"LESLIE", ts:"2026-04-12T17:00:00", tagged:[], readBy:[]}], completedDate:"2026-04-12", checklist:completedChecklist(["LESLIE","RAJ"],"2026-04-12") },
  { id:"pc2", jobCode:"USS-C02", name:"25 Anna St, Blackburn North",          client:"USS", type:"Residential", status:"Completed",          priority:"Medium", phase:"READY TO ISSUE",      assigned:["LESLIE"], due:"2026-04-20", pct:100, notes:[{id:"seed_pc2n1", text:"Late — engineer revisions.", author:"LESLIE", ts:"2026-04-22T16:00:00", tagged:[], readBy:[]}], completedDate:"2026-04-22", checklist:completedChecklist(["LESLIE","RAJ","LALITHA"],"2026-04-22") },
  { id:"pc3", jobCode:"DF-C01",  name:"9 Clydesdale Rd, Airport West",        client:"DF",  type:"Residential", status:"Completed",          priority:"Medium", phase:"READY TO ISSUE",      assigned:["LESLIE"], due:"2026-05-06", pct:100, notes:[{id:"seed_pc3n1", text:"Issued on time.",        author:"LESLIE", ts:"2026-05-05T17:00:00", tagged:[], readBy:[]}], completedDate:"2026-05-05", checklist:completedChecklist(["LESLIE","SRIKANTH"],"2026-05-05") },
  { id:"pc6", jobCode:"GS-C01",  name:"19-20 Maclaine Crt, Narre Warren",     client:"GS",  type:"Residential", status:"Completed",          priority:"Medium", phase:"READY TO ISSUE",      assigned:["RAJ"],    due:"2026-05-20", pct:100, notes:[{id:"seed_pc6n1", text:"Wait for Stage 2.",      author:"RAJ",   ts:"2026-05-18T17:00:00", tagged:[], readBy:[]}], completedDate:"2026-05-18", checklist:completedChecklist(["RAJ","SRIKANTH","LESLIE"],"2026-05-18") },
];

const SEED_TASKS = [
  { id:"t1", projectId:"p1", title:"Reissue fab drawing — 2 cols", assigned:"LESLIE", due:"", status:"In Progress", priority:"High", notes:"" },
  { id:"t4", projectId:"p5", title:"Issue preliminary drawings", assigned:"RAJ", due:"2026-07-11", status:"Urgent", priority:"Urgent", notes:"" },
  { id:"t5", projectId:"p6", title:"Issue preliminary drawings", assigned:"RAJ", due:"2026-07-15", status:"Urgent", priority:"Urgent", notes:"" },
  { id:"t9", projectId:"p12", title:"Review drawing before issue", assigned:"RAJ", due:"", status:"In Progress", priority:"High", notes:"" },
  { id:"t10", projectId:"p19", title:"Issue preliminary by 25 July", assigned:"LESLIE", due:"2026-07-25", status:"Urgent", priority:"Urgent", notes:"" },
  { id:"t11", projectId:"p23", title:"Review & update feedback", assigned:"RAJ", due:"", status:"In Progress", priority:"High", notes:"" },
];

// Seed a few calendar entries so the feature isn't empty on first load.
// Dates are relative to today so they always look current regardless of when this runs.
const SEED_CALENDAR = [
  { id:"ce1", date:_addDays(0),  member:"LESLIE", projectId:"p1",  subtasks:[
      { id:"st1a", text:"Confirm site access with builder", done:true },
      { id:"st1b", text:"Measure basement column locations", done:false },
      { id:"st1c", text:"Photograph existing steel for reference", done:false },
    ], createdBy:"LESLIE", ts:nowTs(), order:0, done:false, startTime:"09:00", durationMin:90 },
  { id:"ce2", date:_addDays(0),  member:"RAJ",    projectId:"p5",  subtasks:[
      { id:"st2a", text:"Finalise column schedule", done:true },
      { id:"st2b", text:"Issue to Dream Fabrication", done:false },
    ], createdBy:"RAJ",    ts:nowTs(), order:0, done:false, startTime:"13:00", durationMin:120 },
  { id:"ce3", date:_addDays(1),  member:"RAJ",    projectId:"p6",  subtasks:[
      { id:"st3a", text:"Issue preliminary drawings", done:false },
    ], createdBy:"RAJ",    ts:nowTs(), order:0, done:false, startTime:"", durationMin:60 },
  { id:"ce4", date:_addDays(2),  member:"LESLIE", projectId:"p19", subtasks:[
      { id:"st4a", text:"Prep talking points for client", done:false },
      { id:"st4b", text:"Call re: steel install date", done:false },
    ], createdBy:"LESLIE", ts:nowTs(), order:0, done:false, startTime:"10:30", durationMin:30 },
  { id:"ce5", date:_addDays(-1), member:"RAJ",    projectId:"p23", subtasks:[
      { id:"st5a", text:"Review feedback", done:true },
    ], createdBy:"RAJ",    ts:nowTs(), order:0, done:true,  startTime:"", durationMin:60 },
];

const fmtDate = d => d ? new Date(d+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"2-digit"}) : "—";
const daysLeft = d => d ? Math.ceil((new Date(d)-new Date(todayYmd()))/86400000) : null;
const clPct = cl => cl.length===0 ? 0 : Math.round((cl.filter(c=>c.done).length/cl.length)*100);
const relevantCL = (cl, type) => type === "Take-Off"
  ? cl.filter(c => c.takeOffOnly)
  : cl.filter(c => !c.takeOffOnly);

const IS = { width:"100%", background:"var(--c-input-bg)", border:"1px solid var(--c-input-border)", borderRadius:6, padding:"7px 10px", color:"var(--c-input-text)", fontSize:13, boxSizing:"border-box", outline:"none" };

// ═════════════════════════════════════════════════
// TICKTICK-STYLE LIGHT THEME — scoped to the Calendar tab.
// Matched against an actual TickTick screenshot: white surfaces,
// hairline gray gridlines, pale tinted task blocks (no left-border
// accent), square outline checkboxes, thin coral "now" line (no dot).
// ═════════════════════════════════════════════════
const TT = {
  bg: "#FFFFFF",
  panel: "#FFFFFF",
  border: "#EBEDF0",
  text: "#2B2F38",
  textSub: "#9099A8",
  textFaint: "#C2C7D0",
  now: "#FF7A7A",
  shadow: "0 10px 32px rgba(20,20,43,0.16)",
};
const IS_LIGHT = { width:"100%", background:"#FFFFFF", border:"1px solid #DDE1E6", borderRadius:6, padding:"7px 10px", color:"#2B2F38", fontSize:13, boxSizing:"border-box", outline:"none" };

function Modal({ title, onClose, children, wide, extraWide, light }) {
  const mw = extraWide ? 1020 : wide ? 860 : 500;
  const mob = useWindowWidth() < 768;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:1000,display:"flex",alignItems:mob?"flex-end":"center",justifyContent:"center",padding:mob?0:16}} onClick={onClose}>
      <div style={{background:"var(--c-panel)",border:mob?"none":"1px solid var(--c-border)",borderRadius:mob?"18px 18px 0 0":12,padding:mob?"20px 16px 36px":26,width:"100%",maxWidth:mob?"100%":mw,maxHeight:mob?"92vh":"96vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        {mob && <div style={{width:36,height:4,borderRadius:2,background:"var(--c-border)",margin:"0 auto 16px"}}/>}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <h3 style={{margin:0,color:"var(--c-t1)",fontSize:15,fontWeight:700}}>{title}</h3>
          <button onClick={onClose} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:20,padding:"4px 8px"}}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// A panel anchored next to whatever was clicked, instead of a centered modal with a
// backdrop — "blends into the view". Flips to whichever side (left/right) has more
// room, and clamps vertically so it never opens off-screen.
function AnchoredPanel({ anchorRect, width, title, onClose, children }) {
  const ref = useRef(null);
  const w = width || 380;
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = 12;
  const spaceRight = vw - anchorRect.right;
  const spaceLeft = anchorRect.left;
  const openRight = spaceRight >= w + gap || spaceRight >= spaceLeft;
  const left = openRight
    ? Math.min(anchorRect.right + gap, vw - w - gap)
    : Math.max(gap, anchorRect.left - w - gap);
  const top = Math.max(gap, Math.min(anchorRect.top, vh - 80));
  const maxHeight = vh - top - gap;

  return (
    <div ref={ref} onClick={e=>e.stopPropagation()} style={{
      position:"fixed", left, top, width:w, maxHeight, overflowY:"auto",
      background:"#FFFFFF", border:`1px solid ${TT.border}`, borderRadius:12,
      boxShadow:TT.shadow, padding:20, zIndex:1000, boxSizing:"border-box",
    }}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <h3 style={{margin:0,color:TT.text,fontSize:14,fontWeight:700}}>{title}</h3>
        <button onClick={onClose} style={{background:"none",border:"none",color:TT.textFaint,cursor:"pointer",fontSize:18}}>✕</button>
      </div>
      {children}
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel, confirmColor, onConfirm, onClose }) {
  const label = confirmLabel || "Delete";
  const color = confirmColor || "#EF4444";
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div style={{background:"var(--c-panel)",border:"1px solid #EF444466",borderRadius:12,padding:26,width:"100%",maxWidth:460}} onClick={e=>e.stopPropagation()}>
        <h3 style={{margin:0,color:"var(--c-t1)",fontSize:15,fontWeight:800,marginBottom:14}}>⚠ {title}</h3>
        <div style={{color:"var(--c-t2)",fontSize:13,lineHeight:1.5,marginBottom:20,whiteSpace:"pre-wrap"}}>{message}</div>
        <div style={{display:"flex",gap:10}}>
          <button autoFocus onClick={()=>{onConfirm();onClose();}} style={{flex:1,background:color,border:"none",borderRadius:6,padding:"10px 0",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>{label}</button>
          <button onClick={onClose} style={{padding:"10px 20px",background:"transparent",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:13}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════
// TEAM MODAL — admin-only roster management: add a member (with their login
// PIN), reset an existing member's PIN, or remove a member.
// ═════════════════════════════════════════════════
function TeamModal({ presence, currentUser, memberColor, teamNames, onClose }) {
  const { team, addMember, removeMember, updateMemberPin, updateMemberTeamsEmail, isAdmin, teamsMeetingUrl, setTeamsMeetingUrl } = useTeam();
  const [view, setView] = useState("roster"); // "roster" | "attendance"
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPin, setResetPin] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [editTeamsTarget, setEditTeamsTarget] = useState(null);
  const [teamsEmailInput, setTeamsEmailInput] = useState("");
  const [editMeetingUrl, setEditMeetingUrl] = useState(false);
  const [meetingUrlInput, setMeetingUrlInput] = useState("");
  // Attendance state
  const [selMember, setSelMember] = useState(teamNames[0]);
  const [selMonth, setSelMonth] = useState(() => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  });

  const add = async () => {
    const trimmed = name.trim().toUpperCase();
    if (!trimmed) { setError("Enter a name."); return; }
    if (team.some(m => m.name === trimmed)) { setError("That name is already on the team."); return; }
    if (!/^\d{4}$/.test(pin)) { setError("PIN must be exactly 4 digits."); return; }
    await addMember(trimmed, pin);
    setName(""); setPin(""); setError("");
  };

  const applyResetPin = async () => {
    if (!/^\d{4}$/.test(resetPin)) { setError("PIN must be exactly 4 digits."); return; }
    await updateMemberPin(resetTarget, resetPin);
    setResetTarget(null); setResetPin(""); setError("");
  };

  // Attendance helpers
  const sessions = (presence.sessions || []).filter(s => s.member === selMember && s.date.startsWith(selMonth));
  const byDate = {};
  sessions.forEach(s => { (byDate[s.date] = byDate[s.date]||[]).push(s); });
  const sortedDates = Object.keys(byDate).sort().reverse();
  const fmtTime = iso => { if (!iso) return "—"; const d = new Date(iso); return d.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",hour12:true}); };
  const fmtDateShort = ymd => { const [y,m,d] = ymd.split("-"); return new Date(y,m-1,d).toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"}); };
  const calcDuration = ss => {
    let total = 0;
    ss.forEach(s => { if (s.loginAt && s.logoutAt) total += new Date(s.logoutAt)-new Date(s.loginAt); });
    if (!total) return "—";
    const h = Math.floor(total/3600000), mn = Math.floor((total%3600000)/60000);
    return `${h}h ${mn}m`;
  };
  const months = [];
  for (let i = 0; i < 12; i++) { const d = new Date(); d.setMonth(d.getMonth()-i); months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`); }

  const tabBtn = (key, label) => (
    <button key={key} onClick={()=>setView(key)} style={{padding:"5px 18px",borderRadius:20,border:"none",background:view===key?"#F97316":"var(--c-deep)",color:view===key?"#fff":"var(--c-t3)",fontWeight:700,fontSize:12,cursor:"pointer"}}>{label}</button>
  );

  return (
    <Modal title="👥 Team" onClose={onClose} wide>
      {/* Internal tab switcher — Attendance only for admin */}
      <div style={{display:"flex",gap:8,marginBottom:18}}>
        {tabBtn("roster","Roster")}
        {isAdmin(currentUser) && tabBtn("attendance","Attendance")}
      </div>

      {view==="roster" && (
        <div onKeyDown={e=>{ if (e.key==="Enter" && e.target.tagName!=="BUTTON") { e.preventDefault(); resetTarget ? applyResetPin() : add(); } }}>
          <div style={{marginBottom:16}}>
            {team.map(m => (
              <div key={m.name} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",background:"var(--c-page)",borderRadius:8,marginBottom:6,border:"1px solid var(--c-border2)"}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:m.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:900,color:"#0F172A",flexShrink:0,marginTop:1}}>{m.name.slice(0,2)}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:13,fontWeight:800,color:"var(--c-t1)"}}>{m.name}</span>
                    {m.role==="admin" && <span style={{fontSize:9,fontWeight:800,color:"#F97316",background:"#F9731620",borderRadius:4,padding:"1px 6px"}}>ADMIN</span>}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:5,marginTop:3}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:isOnlineFresh(presence?.online?.[m.name])?"#22C55E":"#64748B"}}/>
                    <span style={{fontSize:11,color:isOnlineFresh(presence?.online?.[m.name])?"#22C55E":"var(--c-t4)"}}>{isOnlineFresh(presence?.online?.[m.name])?"Online":"Offline"}</span>
                  </div>
                  {editTeamsTarget===m.name ? (
                    <div style={{display:"flex",gap:6,marginTop:7,alignItems:"center"}}>
                      <span style={{fontSize:10,color:"#7C3AED",fontWeight:700,flexShrink:0}}>Teams:</span>
                      <input value={teamsEmailInput} onChange={e=>setTeamsEmailInput(e.target.value)} placeholder="email@company.com" autoFocus
                        style={{...IS,flex:1,fontSize:11,padding:"4px 7px"}}/>
                      <button onClick={()=>{ updateMemberTeamsEmail(m.name,teamsEmailInput); setEditTeamsTarget(null); }}
                        style={{background:"#7C3AED",border:"none",borderRadius:5,padding:"4px 10px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11}}>Save</button>
                      <button onClick={()=>setEditTeamsTarget(null)}
                        style={{background:"transparent",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 8px",color:"var(--c-t4)",cursor:"pointer",fontSize:11}}>✕</button>
                    </div>
                  ) : (
                    <div style={{display:"flex",alignItems:"center",gap:5,marginTop:4}}>
                      <span style={{fontSize:10,color:"#7C3AED",fontWeight:700}}>Teams:</span>
                      <span style={{fontSize:10,color:m.teamsEmail?"var(--c-t2)":"var(--c-t5)"}}>{m.teamsEmail||"Not set"}</span>
                      {isAdmin(currentUser) && (
                        <button onClick={()=>{setEditTeamsTarget(m.name);setTeamsEmailInput(m.teamsEmail||"");}}
                          style={{background:"none",border:"none",color:"#7C3AED",cursor:"pointer",fontSize:10,padding:"0 3px",fontWeight:700}}>✏</button>
                      )}
                    </div>
                  )}
                  {resetTarget===m.name && (
                    <div style={{display:"flex",gap:6,marginTop:8}}>
                      <input value={resetPin} onChange={e=>{setResetPin(e.target.value.replace(/\D/g,"").slice(0,4));setError("");}} placeholder="New 4-digit PIN" autoFocus style={{...IS,width:130,fontSize:12,padding:"5px 8px"}}/>
                      <button onClick={applyResetPin} style={{background:"#10B981",border:"none",borderRadius:5,padding:"4px 10px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11}}>Save</button>
                      <button onClick={()=>{setResetTarget(null);setResetPin("");setError("");}} style={{background:"transparent",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 8px",color:"var(--c-t4)",cursor:"pointer",fontSize:11}}>✕</button>
                    </div>
                  )}
                </div>
                {isAdmin(currentUser) && (
                  <div style={{display:"flex",gap:8,flexShrink:0,alignItems:"center"}}>
                    <button onClick={()=>{setResetTarget(m.name);setResetPin("");setError("");}} title="Reset PIN" style={{background:"none",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 8px",color:"var(--c-t3)",cursor:"pointer",fontSize:11,whiteSpace:"nowrap"}}>🔑 Reset PIN</button>
                    {m.role!=="admin" && (
                      <button onClick={()=>setConfirmRemove(m.name)} title="Remove from team" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14}}>🗑</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {isAdmin(currentUser) && (
            <div style={{borderTop:"1px solid var(--c-border)",paddingTop:14}}>
              <div style={{fontSize:11,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:8}}>+ Add Team Member</div>
              <div style={{display:"flex",gap:8}}>
                <input value={name} onChange={e=>{setName(e.target.value);setError("");}} placeholder="Name" style={{...IS,flex:1}}/>
                <input value={pin} onChange={e=>{setPin(e.target.value.replace(/\D/g,"").slice(0,4));setError("");}} placeholder="4-digit PIN" style={{...IS,width:130}}/>
                <button onClick={add} style={{background:"#F97316",border:"none",borderRadius:6,padding:"0 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>+ Add</button>
              </div>
              <div style={{fontSize:11,color:"var(--c-t5)",marginTop:6}}>The PIN you set here is what they'll use to log in.</div>
              {error && <div style={{color:"#EF4444",fontSize:11,marginTop:8,fontWeight:600}}>⚠ {error}</div>}
            </div>
          )}
          <div style={{borderTop:"1px solid var(--c-border)",paddingTop:14,marginTop:4}}>
            <div style={{fontSize:11,fontWeight:800,color:"#7C3AED",textTransform:"uppercase",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>🎥 Team Meeting Room</div>
            {editMeetingUrl ? (
              <div style={{display:"flex",gap:8}}>
                <input value={meetingUrlInput} onChange={e=>setMeetingUrlInput(e.target.value)} placeholder="Paste Teams meeting link…" autoFocus style={{...IS,flex:1,fontSize:12}}/>
                <button onClick={()=>{setTeamsMeetingUrl(meetingUrlInput.trim());setEditMeetingUrl(false);}} style={{background:"#7C3AED",border:"none",borderRadius:6,padding:"0 14px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:12}}>Save</button>
                <button onClick={()=>setEditMeetingUrl(false)} style={{background:"transparent",border:"1px solid var(--c-border)",borderRadius:6,padding:"0 10px",color:"var(--c-t4)",cursor:"pointer",fontSize:12}}>✕</button>
              </div>
            ) : (
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                {teamsMeetingUrl ? (
                  <a href={teamsMeetingUrl} target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:"#7C3AED",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {teamsMeetingUrl}
                  </a>
                ) : (
                  <span style={{fontSize:11,color:"var(--c-t5)",flex:1}}>No meeting room set</span>
                )}
                {isAdmin(currentUser) && <button onClick={()=>{setEditMeetingUrl(true);setMeetingUrlInput(teamsMeetingUrl||"");}} style={{background:"none",border:"1px solid #7C3AED55",borderRadius:5,padding:"3px 10px",color:"#7C3AED",cursor:"pointer",fontSize:11,fontWeight:700,flexShrink:0}}>{teamsMeetingUrl?"Edit":"+ Set Link"}</button>}
              </div>
            )}
            <div style={{fontSize:10,color:"var(--c-t5)",marginTop:5}}>One shared link the whole team can click to join instantly.</div>
          </div>
        </div>
      )}

      {view==="attendance" && (
        <div>
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
            {teamNames.map(m => (
              <button key={m} onClick={()=>setSelMember(m)} style={{padding:"5px 14px",borderRadius:20,border:"none",background:selMember===m?"#F97316":"var(--c-deep)",color:selMember===m?"#fff":"var(--c-t3)",fontWeight:700,fontSize:12,cursor:"pointer"}}>{m}</button>
            ))}
            <select value={selMonth} onChange={e=>setSelMonth(e.target.value)} style={{marginLeft:"auto",padding:"5px 10px",borderRadius:8,border:"1px solid var(--c-border)",background:"var(--c-deep)",color:"var(--c-t1)",fontSize:12}}>
              {months.map(m => { const [y,mo]=m.split("-"); return <option key={m} value={m}>{new Date(y,mo-1).toLocaleDateString("en-AU",{month:"long",year:"numeric"})}</option>; })}
            </select>
          </div>
          <div style={{background:"#F9731618",border:"1px solid #F9731633",borderRadius:10,padding:"10px 16px",marginBottom:12,display:"flex",gap:24,flexWrap:"wrap"}}>
            <div><div style={{fontSize:10,color:"var(--c-t4)",fontWeight:700,textTransform:"uppercase"}}>Working Days</div><div style={{fontSize:24,fontWeight:900,color:"#F97316"}}>{sortedDates.length}</div></div>
            <div><div style={{fontSize:10,color:"var(--c-t4)",fontWeight:700,textTransform:"uppercase"}}>Sessions</div><div style={{fontSize:24,fontWeight:900,color:"var(--c-t1)"}}>{sessions.length}</div></div>
          </div>
          {sortedDates.length === 0
            ? <div style={{color:"var(--c-t4)",textAlign:"center",padding:"24px 0"}}>No sessions recorded for this period.</div>
            : sortedDates.map(date => (
              <div key={date} style={{marginBottom:10,background:"var(--c-deep)",borderRadius:10,overflow:"hidden"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px",borderBottom:"1px solid var(--c-border2)"}}>
                  <span style={{fontWeight:700,fontSize:13,color:"var(--c-t1)"}}>{fmtDateShort(date)}</span>
                  <span style={{marginLeft:"auto",fontSize:11,color:"var(--c-t4)"}}>Total: {calcDuration(byDate[date])}</span>
                </div>
                {byDate[date].map((s,i) => (
                  <div key={s.id||i} style={{display:"flex",alignItems:"center",gap:16,padding:"7px 14px",borderBottom:i<byDate[date].length-1?"1px solid var(--c-border2)":"none"}}>
                    <span style={{fontSize:12,color:"#10B981",fontWeight:600}}>▶ {fmtTime(s.loginAt)}</span>
                    <span style={{fontSize:12,color:s.logoutAt?"#EF4444":"#F59E0B",fontWeight:600}}>{s.logoutAt?"⏹ "+fmtTime(s.logoutAt):"● Active"}</span>
                    {s.loginAt && s.logoutAt && <span style={{marginLeft:"auto",fontSize:11,color:"var(--c-t4)"}}>{calcDuration([s])}</span>}
                  </div>
                ))}
              </div>
            ))
          }
        </div>
      )}

      {confirmRemove && (
        <ConfirmModal
          title="Remove team member?"
          message={`${confirmRemove} will be removed from the team and won't be able to log in anymore. Their existing projects, tasks and calendar entries are kept as-is.`}
          confirmLabel="Remove"
          onConfirm={()=>{ removeMember(confirmRemove); setConfirmRemove(null); }}
          onClose={()=>setConfirmRemove(null)}
        />
      )}
    </Modal>
  );
}

// ═════════════════════════════════════════════════
// CLIENTS MODAL — admin-only: maintains the curated client/fabricator code
// list that the project form's Client field is picked from.
// ═════════════════════════════════════════════════
const INVOICE_STATUSES = ["Quote","Draft","Sent","Partial","Paid","Overdue"];
const INVOICE_STATUS_CLR = { Quote:"#8B5CF6", Draft:"#64748B", Sent:"#3B82F6", Partial:"#F59E0B", Paid:"#10B981", Overdue:"#EF4444" };

function ClientsModal({ projects, invoices, onAddInvoice, onUpdateInvoice, onRemoveInvoice, onClose }) {
  const { clients, addClient, removeClient, clientDetails, updateClientDetails } = useTeam();
  const [innerTab, setInnerTab] = useState("clients");

  // ── Clients tab state ──
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [editingClient, setEditingClient] = useState(null); // code string
  const [editFields, setEditFields] = useState({ companyName:"", contactName:"", email:"", phone:"" });

  const add = () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) { setError("Enter a client code."); return; }
    if (clients.includes(trimmed)) { setError("That client code already exists."); return; }
    addClient(trimmed);
    setCode(""); setError("");
  };

  // ── Invoicing tab state ──
  const [invFilter, setInvFilter] = useState("All");
  const [invClientFilter, setInvClientFilter] = useState("All");
  const [showInvForm, setShowInvForm] = useState(false);
  const [editingInv, setEditingInv] = useState(null); // invoice object | null
  const [confirmRemoveInv, setConfirmRemoveInv] = useState(null);

  const allClients = [...new Set([...clients, ...projects.map(p=>p.client).filter(Boolean)])].sort();
  const liveProjects = projects.filter(p => p.status !== "Completed");

  const filteredInvoices = invoices.filter(inv => {
    if (invFilter !== "All" && inv.status !== invFilter) return false;
    if (invClientFilter !== "All" && inv.client !== invClientFilter) return false;
    return true;
  }).sort((a,b) => (b.createdAt||0)-(a.createdAt||0));

  const totalOutstanding = invoices.filter(i=>i.status==="Sent"||i.status==="Overdue").reduce((s,i)=>s+(parseFloat(i.amount)||0),0);
  const totalPaid = invoices.filter(i=>i.status==="Paid").reduce((s,i)=>s+(parseFloat(i.amount)||0),0);

  const fmtAud = n => "$"+Number(n||0).toLocaleString("en-AU",{minimumFractionDigits:2,maximumFractionDigits:2});

  return (
    <Modal title="🏢 Clients & Invoicing" onClose={onClose} wide>
      {/* Inner tab bar */}
      <div style={{display:"flex",gap:0,marginBottom:16,borderBottom:"1px solid var(--c-border)"}}>
        {[["clients","🏢 Clients"],["invoicing","🧾 Invoicing"]].map(([k,l])=>(
          <button key={k} onClick={()=>setInnerTab(k)}
            style={{background:"none",border:"none",borderBottom:innerTab===k?"2px solid #F97316":"2px solid transparent",color:innerTab===k?"#F97316":"var(--c-t4)",fontWeight:innerTab===k?800:500,fontSize:12,padding:"6px 14px",cursor:"pointer",marginBottom:-1}}>
            {l}
          </button>
        ))}
      </div>

      {/* ── CLIENTS TAB ── */}
      {innerTab==="clients" && (
        <div onKeyDown={e=>{ if (e.key==="Enter" && e.target.tagName!=="BUTTON") { e.preventDefault(); add(); } }}>
          <div style={{marginBottom:16}}>
            {clients.length===0 ? (
              <div style={{textAlign:"center",color:"var(--c-t5)",padding:"20px 0",fontSize:13}}>No clients yet.</div>
            ) : clients.map(c => {
              const det = clientDetails?.[c] || {};
              const isEditing = editingClient === c;
              return (
                <div key={c} style={{background:"var(--c-page)",borderRadius:8,marginBottom:8,border:`1px solid ${isEditing?"#F97316":"var(--c-border2)"}`}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px"}}>
                    <span style={{fontSize:13,fontFamily:"monospace",fontWeight:800,color:"#F97316",minWidth:60}}>{c}</span>
                    <div style={{flex:1,minWidth:0}}>
                      {det.companyName && <div style={{fontSize:12,fontWeight:700,color:"var(--c-t2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{det.companyName}</div>}
                      {(det.contactName||det.email||det.phone) && (
                        <div style={{fontSize:11,color:"var(--c-t5)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {[det.contactName,det.email,det.phone].filter(Boolean).join(" · ")}
                        </div>
                      )}
                      {!det.companyName && !det.email && <div style={{fontSize:11,color:"var(--c-t5)",fontStyle:"italic"}}>No contact details — click ✎ to add</div>}
                    </div>
                    <span style={{fontSize:11,color:"var(--c-t5)",whiteSpace:"nowrap"}}>{projects.filter(p=>p.client===c).length} projects</span>
                    <button onClick={()=>{ if(isEditing){setEditingClient(null);}else{setEditingClient(c);setEditFields({companyName:det.companyName||"",contactName:det.contactName||"",email:det.email||"",phone:det.phone||""});} }}
                      style={{background:"none",border:"1px solid var(--c-border2)",borderRadius:5,padding:"3px 8px",color:"#F97316",cursor:"pointer",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{isEditing?"✓ Done":"✎ Edit"}</button>
                    <button onClick={()=>setConfirmRemove(c)} title="Remove client" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14}}>🗑</button>
                  </div>
                  {isEditing && (
                    <div style={{padding:"10px 12px",borderTop:"1px solid var(--c-border2)",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                      <div><div style={{fontSize:10,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:3}}>Company Name</div><input value={editFields.companyName} onChange={e=>setEditFields(f=>({...f,companyName:e.target.value}))} style={{...IS,width:"100%"}} placeholder="e.g. Dream Engineering"/></div>
                      <div><div style={{fontSize:10,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:3}}>Contact Name</div><input value={editFields.contactName} onChange={e=>setEditFields(f=>({...f,contactName:e.target.value}))} style={{...IS,width:"100%"}} placeholder="e.g. Satnam"/></div>
                      <div><div style={{fontSize:10,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:3}}>Email</div><input value={editFields.email} onChange={e=>setEditFields(f=>({...f,email:e.target.value}))} style={{...IS,width:"100%"}} placeholder="e.g. info@company.com.au" type="email"/></div>
                      <div><div style={{fontSize:10,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:3}}>Phone</div><input value={editFields.phone} onChange={e=>setEditFields(f=>({...f,phone:e.target.value}))} style={{...IS,width:"100%"}} placeholder="e.g. 0412 345 678"/></div>
                      <div style={{gridColumn:"1/-1",display:"flex",justifyContent:"flex-end",gap:8}}>
                        <button onClick={()=>setEditingClient(null)} style={{background:"none",border:"1px solid var(--c-border2)",borderRadius:6,padding:"5px 14px",cursor:"pointer",fontSize:12,color:"var(--c-t4)"}}>Cancel</button>
                        <button onClick={()=>{ updateClientDetails(c, editFields); setEditingClient(null); }}
                          style={{background:"#F97316",border:"none",borderRadius:6,padding:"5px 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:12}}>Save</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{borderTop:"1px solid var(--c-border)",paddingTop:14}}>
            <div style={{fontSize:11,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:8}}>+ Add Client</div>
            <div style={{display:"flex",gap:8}}>
              <input value={code} onChange={e=>{setCode(e.target.value);setError("");}} placeholder="e.g. ABC" style={{...IS,flex:1}}/>
              <button onClick={add} style={{background:"#F97316",border:"none",borderRadius:6,padding:"0 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>+ Add</button>
            </div>
            {error && <div style={{color:"#EF4444",fontSize:11,marginTop:8,fontWeight:600}}>⚠ {error}</div>}
          </div>
          {confirmRemove && (
            <ConfirmModal
              title="Remove client?"
              message={`"${confirmRemove}" will no longer be selectable for new projects. Existing projects already using it are kept as-is.`}
              confirmLabel="Remove"
              onConfirm={()=>{ removeClient(confirmRemove); setConfirmRemove(null); }}
              onClose={()=>setConfirmRemove(null)}
            />
          )}
        </div>
      )}

      {/* ── INVOICING TAB ── */}
      {innerTab==="invoicing" && (
        <div>
          {/* Summary cards */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <div style={{background:"#EF444415",border:"1px solid #EF444440",borderRadius:8,padding:"10px 14px"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#EF4444",textTransform:"uppercase",marginBottom:2}}>Outstanding</div>
              <div style={{fontSize:18,fontWeight:900,color:"#EF4444"}}>{fmtAud(totalOutstanding)}</div>
            </div>
            <div style={{background:"#10B98115",border:"1px solid #10B98140",borderRadius:8,padding:"10px 14px"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#10B981",textTransform:"uppercase",marginBottom:2}}>Total Paid</div>
              <div style={{fontSize:18,fontWeight:900,color:"#10B981"}}>{fmtAud(totalPaid)}</div>
            </div>
          </div>

          {/* Filters + New Invoice button */}
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
            <select value={invClientFilter} onChange={e=>setInvClientFilter(e.target.value)} style={{...IS,fontSize:11,padding:"4px 8px",flex:1,minWidth:100}}>
              <option value="All">All clients</option>
              {allClients.map(c=><option key={c}>{c}</option>)}
            </select>
            <select value={invFilter} onChange={e=>setInvFilter(e.target.value)} style={{...IS,fontSize:11,padding:"4px 8px",flex:1,minWidth:100}}>
              <option value="All">All statuses</option>
              {INVOICE_STATUSES.map(s=><option key={s}>{s}</option>)}
            </select>
            <button onClick={()=>setShowInvForm(true)}
              style={{background:"#F97316",border:"none",borderRadius:6,padding:"5px 12px",color:"#fff",fontWeight:800,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>
              + New Invoice
            </button>
          </div>

          {/* Invoice list */}
          {filteredInvoices.length===0 ? (
            <div style={{textAlign:"center",color:"var(--c-t5)",padding:"24px 0",fontSize:13}}>No invoices yet.</div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:360,overflowY:"auto"}}>
              {filteredInvoices.map(inv=>{
                const proj = projects.find(p=>p.id===inv.projectId);
                const sc = INVOICE_STATUS_CLR[inv.status]||"#64748B";
                return (
                  <div key={inv.id} style={{background:"var(--c-page)",border:"1px solid var(--c-border2)",borderRadius:8,padding:"10px 12px",display:"flex",alignItems:"center",gap:10}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                        <span style={{fontSize:12,fontWeight:800,color:"#F97316",fontFamily:"monospace"}}>{inv.invoiceNo||"—"}</span>
                        <span style={{fontSize:10,fontWeight:700,color:sc,background:`${sc}18`,borderRadius:10,padding:"1px 8px",border:`1px solid ${sc}44`}}>{inv.status}</span>
                        {inv.client&&<span style={{fontSize:10,color:"var(--c-t4)",fontWeight:700}}>{inv.client}</span>}
                      </div>
                      <div style={{fontSize:11,color:"var(--c-t3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {proj ? `${proj.jobCode||""} — ${proj.name||""}` : inv.projectLabel||"No project linked"}
                      </div>
                      <div style={{display:"flex",gap:10,marginTop:3}}>
                        {inv.issuedDate&&<span style={{fontSize:10,color:"var(--c-t5)"}}>Issued: {inv.issuedDate}</span>}
                        {inv.dueDate&&<span style={{fontSize:10,color:inv.status==="Overdue"?"#EF4444":"var(--c-t5)"}}>Due: {inv.dueDate}</span>}
                      </div>
                    </div>
                    <div style={{fontWeight:900,fontSize:14,color:"var(--c-t2)",whiteSpace:"nowrap"}}>{fmtAud(inv.amount)}</div>
                    <div style={{display:"flex",gap:6,flexShrink:0}}>
                      {inv.status!=="Paid" && (
                        <button onClick={()=>onUpdateInvoice(inv.id,{status:"Paid"})} title="Mark paid"
                          style={{background:"#10B98120",border:"1px solid #10B98150",borderRadius:5,padding:"3px 8px",color:"#10B981",fontSize:10,fontWeight:800,cursor:"pointer"}}>✓ Paid</button>
                      )}
                      <button onClick={()=>setEditingInv(inv)} title="Edit"
                        style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:13,padding:"2px 4px"}}>✎</button>
                      <button onClick={()=>setConfirmRemoveInv(inv.id)} title="Delete"
                        style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13,padding:"2px 4px"}}>×</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* New / Edit Invoice form */}
      {(showInvForm||editingInv) && (
        <InvoiceFormModal
          invoice={editingInv}
          projects={liveProjects}
          clients={allClients}
          onSave={inv => {
            if (editingInv) onUpdateInvoice(editingInv.id, inv);
            else onAddInvoice(inv);
            setShowInvForm(false); setEditingInv(null);
          }}
          onClose={()=>{ setShowInvForm(false); setEditingInv(null); }}
        />
      )}

      {confirmRemoveInv && (
        <ConfirmModal
          title="Delete invoice?"
          message="This invoice will be permanently removed."
          confirmLabel="Delete"
          onConfirm={()=>{ onRemoveInvoice(confirmRemoveInv); setConfirmRemoveInv(null); }}
          onClose={()=>setConfirmRemoveInv(null)}
        />
      )}
    </Modal>
  );
}

function SendDocModal({ inv, onClose }) {
  const { clientDetails } = useTeam();
  const det = clientDetails?.[inv.client] || {};
  const fmtCurrency = n => `$${(parseFloat(n)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",")}`;
  const lineItems = Array.isArray(inv.lineItems) && inv.lineItems.length > 0
    ? inv.lineItems
    : [{ id:"l0", desc:"Structural Steel Drafting Services", qty:1, unitPrice:inv.amount, amount:inv.amount }];
  const subtotal = lineItems.reduce((s,l) => s + (parseFloat(l.amount)||0), 0);
  const discountAmt = parseFloat(inv.discount)||0;
  const netAmount = subtotal - discountAmt;
  const gst = netAmount * 0.1;
  const total = netAmount + gst;
  const isQuote = inv.status === "Quote";
  const isVar = !isQuote && inv.claimNo && String(inv.claimNo).toLowerCase().includes("var");
  const docType = isQuote ? "QUOTE" : isVar ? "VARIATION" : inv.claimNo ? "PROGRESS CLAIM" : "TAX INVOICE";
  // Date formatted as DD/MM/YY
  const fmtDateShort = d => { if (!d) return "—"; const [y,m,dy] = d.split("-"); return `${dy}/${m}/${y.slice(2)}`; };

  const [toEmail, setToEmail] = useState(det.email || "");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendErr, setSendErr] = useState("");
  const previewRef = useRef(null);

  // Bill-to block: use saved client details, fallback to inv.client code
  const billToLines = [
    det.companyName || inv.client || "",
    det.contactName || "",
    det.email || "",
    det.phone || "",
  ].filter(Boolean);

  // HTML-escape all user-controlled values before injecting into the PDF template
  const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  *{box-sizing:border-box;}
  body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:0;padding:32px 36px;background:#fff;}
  .top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;}
  .asd-left .doc-type{font-size:22px;font-weight:900;color:#111;letter-spacing:0.5px;margin-bottom:6px;}
  .asd-left .asd-name{font-size:14px;font-weight:700;color:#111;}
  .asd-left .asd-info{font-size:11px;color:#444;line-height:1.7;}
  .top-right{text-align:right;}
  .top-right .date-label{font-size:10px;color:#777;text-transform:uppercase;letter-spacing:.4px;}
  .top-right .date-val{font-size:13px;font-weight:700;color:#111;margin-bottom:8px;}
  .top-right .inv-label{font-size:10px;color:#777;text-transform:uppercase;letter-spacing:.4px;}
  .top-right .inv-val{font-size:15px;font-weight:900;color:#111;}
  .divider{border:none;border-top:2px solid #111;margin:16px 0 14px;}
  .bill-section{margin-bottom:16px;}
  .bill-section .bill-label{font-size:10px;font-weight:900;color:#777;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
  .bill-section .bill-line{font-size:12px;color:#111;line-height:1.55;}
  table{width:100%;border-collapse:collapse;margin-bottom:0;}
  thead tr{background:#111;color:#fff;}
  thead th{padding:8px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.4px;font-weight:700;text-align:left;}
  thead th.r{text-align:right;}
  tbody td{padding:7px 10px;font-size:11px;color:#222;border-bottom:1px solid #E5E7EB;}
  tbody td.r{text-align:right;font-variant-numeric:tabular-nums;}
  tbody tr.remarks td{border-top:2px solid #E5E7EB;border-bottom:none;font-size:10px;color:#444;padding-top:10px;vertical-align:top;}
  .totals-side{float:right;width:220px;}
  .t-row{display:flex;justify-content:space-between;padding:4px 0;font-size:11px;color:#333;border-bottom:1px solid #F0F0F0;}
  .t-row.total{font-size:13px;font-weight:900;color:#111;border-top:2px solid #111;border-bottom:none;padding-top:6px;margin-top:2px;}
  .t-row span:last-child{font-variant-numeric:tabular-nums;}
  .clearfix::after{content:"";display:table;clear:both;}
  @media print{body{padding:18px 22px;}@page{margin:8mm;}}
</style>
</head>
<body>
<div class="top">
  <div class="asd-left">
    <div class="doc-type">${docType}</div>
    <div class="asd-name">${ASD_BUSINESS.name}</div>
    <div class="asd-info">
      ${ASD_BUSINESS.address}<br/>
      ${ASD_BUSINESS.email}<br/>
      ${ASD_BUSINESS.phone}<br/>
      ABN - ${ASD_BUSINESS.abn} &nbsp; ACN - ${ASD_BUSINESS.acn}
    </div>
  </div>
  <div class="top-right">
    <div class="date-label">Date</div>
    <div class="date-val">${fmtDateShort(inv.issuedDate)}</div>
    <div class="inv-label">${isQuote?"Quote No":"Invoice No"}</div>
    <div class="inv-val">${esc(inv.invoiceNo)||"—"}</div>
    ${inv.claimNo?`<div style="font-size:10px;color:#777;margin-top:4px;">${isVar?"Variation":"Claim"} ${esc(inv.claimNo)}${inv.claimPct?` · ${esc(inv.claimPct)}%`:""}</div>`:""}
  </div>
</div>
<hr class="divider"/>
<div class="bill-section">
  <div class="bill-label">Bill To</div>
  ${billToLines.map(l=>`<div class="bill-line">${esc(l)}</div>`).join("")}
</div>
<table>
  <thead>
    <tr><th>Description</th><th class="r" style="width:50px">Qty</th><th class="r" style="width:90px">Unit Price</th><th class="r" style="width:90px">Total</th></tr>
  </thead>
  <tbody>
    ${lineItems.map(l=>`<tr><td>${esc(l.desc)}</td><td class="r">${esc(l.qty)}</td><td class="r">${parseFloat(l.unitPrice)?fmtCurrency(l.unitPrice):""}</td><td class="r">${parseFloat(l.amount)?fmtCurrency(l.amount):"$0.00"}</td></tr>`).join("")}
    <tr class="remarks">
      <td colspan="2" style="padding-right:20px;">
        <b>Remarks / Payment Instructions:</b><br/>
        ${isQuote
          ? `Reference - ${esc(inv.invoiceNo)}<br/>This quote is valid for 30 days. To accept, please reply to this email.`
          : `Reference - ${esc(inv.invoiceNo)}<br/>${ASD_BUSINESS.accountName}<br/>BSB - ${ASD_BUSINESS.bsb}<br/>AC.No - ${ASD_BUSINESS.accountNo}`
        }
        ${inv.notes?`<br/>${esc(inv.notes)}`:""}
      </td>
      <td colspan="2" style="vertical-align:top;">
        <div class="totals-side">
          <div class="t-row"><span>SUBTOTAL</span><span>${fmtCurrency(subtotal)}</span></div>
          ${discountAmt>0?`<div class="t-row" style="color:#EF4444;"><span>DISCOUNT</span><span>–${fmtCurrency(discountAmt)}</span></div>`:""}
          <div class="t-row"><span>TAX RATE</span><span>10.00%</span></div>
          <div class="t-row"><span>TOTAL TAX</span><span>${fmtCurrency(gst)}</span></div>
          <div class="t-row total"><span>${isQuote?"QUOTE TOTAL":"Balance Due"}</span><span>${fmtCurrency(total)}</span></div>
        </div>
      </td>
    </tr>
  </tbody>
</table>
</body>
</html>`;

  // Load jsPDF + html2canvas dynamically on mount
  const libsLoaded = useRef(false);
  useEffect(() => {
    if (libsLoaded.current) return;
    libsLoaded.current = true;
    const loadScript = src => new Promise((res,rej) => {
      if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    Promise.all([
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"),
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"),
    ]).catch(() => {});
  }, []);

  const buildPdfBlob = async () => {
    const { jsPDF } = window.jspdf;
    const iframe = previewRef.current;
    if (!iframe) throw new Error("No preview");
    const canvas = await window.html2canvas(iframe.contentDocument.body, { scale:2, useCORS:true, backgroundColor:"#ffffff" });
    const imgData = canvas.toDataURL("image/jpeg", 0.92);
    const pdf = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const ratio = canvas.width / canvas.height;
    const imgH = pw / ratio;
    if (imgH <= ph) {
      pdf.addImage(imgData, "JPEG", 0, 0, pw, imgH);
    } else {
      // Multi-page
      let yOffset = 0;
      while (yOffset < canvas.height) {
        const sliceH = Math.min(canvas.height - yOffset, Math.floor(canvas.width * ph / pw));
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width; sliceCanvas.height = sliceH;
        sliceCanvas.getContext("2d").drawImage(canvas, 0, yOffset, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        if (yOffset > 0) pdf.addPage();
        pdf.addImage(sliceCanvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pw, pw * sliceH / canvas.width);
        yOffset += sliceH;
      }
    }
    return pdf.output("blob");
  };

  const downloadPdf = async () => {
    setSendErr(""); setSending(true);
    try {
      const blob = await buildPdfBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `ASD_${docType.replace(/ /g,"_")}_${inv.invoiceNo||"Invoice"}.pdf`;
      a.click(); URL.revokeObjectURL(url);
    } catch(e) { setSendErr("PDF generation failed — try Print instead. " + e.message); }
    setSending(false);
  };

  const openGmail = async () => {
    if (!toEmail.trim()) { setSendErr("Enter recipient email first."); return; }
    setSendErr(""); setSending(true);
    // First download the PDF for attachment
    try {
      const blob = await buildPdfBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `ASD_${docType.replace(/ /g,"_")}_${inv.invoiceNo||"Invoice"}.pdf`;
      a.click(); URL.revokeObjectURL(url);
    } catch(e) { /* ignore pdf error, open gmail anyway */ }
    // Open Gmail compose
    const clientLabel = det.companyName || inv.client || "";
    const subj = encodeURIComponent(`${docType} ${inv.invoiceNo||""} — Advanced Steel Drafting`);
    const body = encodeURIComponent(isQuote
      ? `Hi${det.contactName?` ${det.contactName}`:""},\n\nPlease find attached our Quote ${inv.invoiceNo||""} for the project: ${inv.projectLabel||clientLabel}.\n\nQuote Total (Inc-GST): ${fmtCurrency(total)}\nValid Until: ${inv.dueDate||"30 days from issue"}\n\nThis quote is valid for 30 days. To accept, simply reply to this email.\n\nPlease don't hesitate to reach out if you have any questions.\n\nKind regards,\nAdvanced Steel Drafting\n${ASD_BUSINESS.email}\n${ASD_BUSINESS.phone}`
      : `Hi${det.contactName?` ${det.contactName}`:""},\n\nPlease find attached ${docType} ${inv.invoiceNo||""} for the project: ${inv.projectLabel||clientLabel}.\n\nBalance Due (Inc-GST): ${fmtCurrency(total)}\nDue Date: ${fmtDateShort(inv.dueDate)}\n\nPayment via EFT:\nBSB: ${ASD_BUSINESS.bsb}\nAccount No: ${ASD_BUSINESS.accountNo}\nAccount Name: ${ASD_BUSINESS.accountName}\nReference: ${inv.invoiceNo||""}\n\nPlease don't hesitate to contact us if you have any questions.\n\nKind regards,\nAdvanced Steel Drafting\n${ASD_BUSINESS.email}\n${ASD_BUSINESS.phone}`
    );
    window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(toEmail.trim())}&su=${subj}&body=${body}`, "_blank");
    setSent(true);
    setSending(false);
  };

  const openPrint = () => {
    const w = window.open("","_blank","width=900,height=700");
    if (w) { w.document.write(htmlContent); w.document.close(); w.focus(); setTimeout(()=>w.print(), 500); }
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"#000A", zIndex:2000, display:"flex", alignItems:"center", justifyContent:"center", padding:12 }}
      onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div style={{ background:"var(--c-panel)", borderRadius:14, width:"min(820px,98vw)", maxHeight:"95vh", display:"flex", flexDirection:"column", boxShadow:"0 8px 48px #0008", overflow:"hidden" }}>
        {/* Header */}
        <div style={{ padding:"14px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid var(--c-border2)", flexShrink:0 }}>
          <div style={{ fontWeight:800, fontSize:14 }}>✉ Send {docType} — <span style={{ color:"#F97316", fontFamily:"monospace" }}>{inv.invoiceNo}</span></div>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:22, cursor:"pointer", color:"var(--c-t4)", lineHeight:1 }}>×</button>
        </div>
        {/* Send controls */}
        <div style={{ padding:"14px 20px", borderBottom:"1px solid var(--c-border2)", flexShrink:0 }}>
          <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
            <input
              value={toEmail} onChange={e=>{ setToEmail(e.target.value); setSent(false); setSendErr(""); }}
              placeholder="Recipient email address…"
              type="email"
              style={{ ...IS, flex:"1 1 200px", minWidth:0 }}
            />
            <button onClick={openGmail} disabled={sending||!toEmail.trim()}
              style={{ background:sent?"#10B981":"#4285F4", border:"none", borderRadius:7, padding:"8px 16px", color:"#fff", fontWeight:800, fontSize:12, cursor:toEmail.trim()?"pointer":"not-allowed", opacity:sending?0.7:1, whiteSpace:"nowrap", flexShrink:0 }}>
              {sent?"✓ Opened Gmail":"📧 Send via Gmail"}
            </button>
            <button onClick={downloadPdf} disabled={sending}
              style={{ background:"#EF4444", border:"none", borderRadius:7, padding:"8px 14px", color:"#fff", fontWeight:800, fontSize:12, cursor:"pointer", opacity:sending?0.7:1, whiteSpace:"nowrap", flexShrink:0 }}>
              {sending?"Generating…":"📥 Download PDF"}
            </button>
            <button onClick={openPrint}
              style={{ background:"none", border:"1px solid var(--c-border)", borderRadius:7, padding:"7px 14px", color:"var(--c-t3)", fontWeight:700, fontSize:12, cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
              🖨 Print
            </button>
          </div>
          {sent&&<div style={{ fontSize:11, color:"#10B981", marginTop:8, fontWeight:600 }}>Gmail opened — attach the downloaded PDF and send.</div>}
          {sendErr&&<div style={{ fontSize:11, color:"#EF4444", marginTop:8 }}>⚠ {sendErr}</div>}
          {!sent&&toEmail&&<div style={{ fontSize:10, color:"var(--c-t5)", marginTop:6 }}>PDF will auto-download. Gmail compose will open pre-filled — attach the PDF and click Send.</div>}
        </div>
        {/* Preview */}
        <div style={{ flex:1, overflowY:"auto", padding:"14px 20px", minHeight:0 }}>
          <div style={{ border:"1px solid var(--c-border2)", borderRadius:8, overflow:"hidden", background:"#fff", boxShadow:"0 2px 12px #0002" }}>
            <iframe
              ref={previewRef}
              srcDoc={htmlContent}
              style={{ width:"100%", height:580, border:"none", display:"block" }}
              title="Invoice Preview"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function InvoiceFormModal({ invoice, prefillProject, projects, clients, onSave, onSaveAndSend, onClose }) {
  const today = new Date().toISOString().slice(0,10);
  const [invoiceNo, setInvoiceNo] = useState(invoice?.invoiceNo||"");
  const [projectId, setProjectId] = useState(invoice?.projectId||prefillProject?.id||"");
  const [projectLabel, setProjectLabel] = useState(invoice?.projectLabel||prefillProject?.name||"");
  const [client, setClient] = useState(invoice?.client||prefillProject?.client||"");
  const [status, setStatus] = useState(invoice?.status||"Draft");
  const [issuedDate, setIssuedDate] = useState(invoice?.issuedDate||today);
  const [paymentTerms, setPaymentTerms] = useState(invoice?.paymentTerms||14);
  const [dueDate, setDueDate] = useState(invoice?.dueDate||"");
  const [notes, setNotes] = useState(invoice?.notes||"");
  const [claimNo, setClaimNo] = useState(invoice?.claimNo||"");
  const [claimPct, setClaimPct] = useState(invoice?.claimPct!=null?String(invoice.claimPct):"");
  const [discount, setDiscount] = useState(invoice?.discount!=null?String(invoice.discount):"");
  const [error, setError] = useState("");

  const mkLine = () => ({ id: Math.random().toString(36).slice(2)+Date.now().toString(36), desc:"", qty:"", unitPrice:"", amount:"" });
  const [lineItems, setLineItems] = useState(() => {
    if (invoice?.lineItems?.length) return invoice.lineItems;
    if (invoice?.amount) return [{ id:"legacy", desc:"Structural Steel Drafting Services", qty:1, unitPrice:String(invoice.amount), amount:String(invoice.amount) }];
    return [mkLine()];
  });

  // Auto-compute due date when issued date or terms change (only if due date not manually set)
  const dueDateManual = useRef(!!invoice?.dueDate);
  useEffect(() => {
    if (!dueDateManual.current && issuedDate && paymentTerms) {
      const d = new Date(issuedDate); d.setDate(d.getDate() + parseInt(paymentTerms));
      setDueDate(d.toISOString().slice(0,10));
    }
  }, [issuedDate, paymentTerms]);

  const subtotal = lineItems.reduce((s, li) => {
    const a = parseFloat(li.amount);
    if (!isNaN(a)) return s + a;
    const q = parseFloat(li.qty)||0, u = parseFloat(li.unitPrice)||0;
    return s + q * u;
  }, 0);
  const discountAmt = Math.min(parseFloat(discount)||0, subtotal);

  const updateLine = (id, field, val) => setLineItems(prev => prev.map(li => {
    if (li.id !== id) return li;
    const up = { ...li, [field]: val };
    if (field === "qty" || field === "unitPrice") {
      const q = parseFloat(field==="qty"?val:li.qty)||0;
      const u = parseFloat(field==="unitPrice"?val:li.unitPrice)||0;
      if (q && u) up.amount = String((q*u).toFixed(2));
    }
    return up;
  }));
  const removeLine = id => setLineItems(prev => prev.filter(li => li.id !== id));
  const addQuickLine = (desc, qty, unitPrice) => setLineItems(prev => [...prev, {
    id: Math.random().toString(36).slice(2)+Date.now().toString(36),
    desc, qty: String(qty), unitPrice: String(unitPrice),
    amount: String((parseFloat(qty)*parseFloat(unitPrice)).toFixed(2))
  }]);

  const handleProjectChange = pid => {
    setProjectId(pid);
    if (pid) { const p = projects.find(p=>p.id===pid); if (p) { if(p.client) setClient(p.client); if(!projectLabel) setProjectLabel(p.name||""); } }
  };

  const save = () => {
    if (!invoiceNo.trim()) { setError("Invoice number is required."); return; }
    if (subtotal <= 0) { setError("Add at least one line item with an amount."); return; }
    const cleanLines = lineItems.filter(li => {
      const a = parseFloat(li.amount)||((parseFloat(li.qty)||0)*(parseFloat(li.unitPrice)||0));
      return a > 0 || li.desc.trim();
    });
    onSave({
      invoiceNo: invoiceNo.trim(), projectId, projectLabel: projectLabel.trim(), client,
      amount: parseFloat((subtotal - discountAmt).toFixed(2)),
      lineItems: cleanLines,
      discount: discountAmt > 0 ? parseFloat(discountAmt.toFixed(2)) : 0,
      claimNo: claimNo.trim(),
      claimPct: claimPct ? parseFloat(claimPct) : null,
      paymentTerms: parseInt(paymentTerms),
      status, issuedDate, dueDate, notes,
    });
  };

  const lbl = {fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4};
  const QUICK = [
    ["Beam","beam","60"],["Column","column","45"],["Lift Shaft","lift shaft","600"],
    ["Site Measure","site measure","380"],["Complexity","complexity surcharge",""],
  ];

  return (
    <Modal title={invoice&&!prefillProject?"✎ Edit Invoice":"+ New Invoice"} onClose={onClose} wide>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>

        {/* Row 1 — Invoice No, Claim, Status */}
        <div style={{display:"grid",gridTemplateColumns:"1.2fr 1fr 1fr 1fr",gap:10}}>
          <div><div style={lbl}>Invoice No *</div>
            <input value={invoiceNo} onChange={e=>setInvoiceNo(e.target.value)} placeholder="e.g. 35HABN" style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div><div style={lbl}>Claim #</div>
            <input value={claimNo} onChange={e=>setClaimNo(e.target.value)} placeholder="e.g. 1 of 3" style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div><div style={lbl}>Claim %</div>
            <input value={claimPct} onChange={e=>setClaimPct(e.target.value)} placeholder="e.g. 70" type="number" min="0" max="100" style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div><div style={lbl}>Status</div>
            <select value={status} onChange={e=>setStatus(e.target.value)} style={{...IS,width:"100%"}}>
              {INVOICE_STATUSES.map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Row 2 — Project + Client */}
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10}}>
          <div><div style={lbl}>Linked Project</div>
            <select value={projectId} onChange={e=>handleProjectChange(e.target.value)} style={{...IS,width:"100%"}}>
              <option value="">— Manual reference —</option>
              {projects.map(p=><option key={p.id} value={p.id}>{p.jobCode?p.jobCode+" — ":""}{p.name}</option>)}
            </select>
            {!projectId&&<input value={projectLabel} onChange={e=>setProjectLabel(e.target.value)}
              placeholder="Job description or code" style={{...IS,width:"100%",boxSizing:"border-box",marginTop:6}}/>}
          </div>
          <div><div style={lbl}>Client</div>
            <select value={client} onChange={e=>setClient(e.target.value)} style={{...IS,width:"100%"}}>
              <option value="">— None —</option>
              {clients.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Row 3 — Dates */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <div><div style={lbl}>Date Issued</div>
            <input type="date" value={issuedDate} onChange={e=>setIssuedDate(e.target.value)} style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div><div style={lbl}>Payment Terms</div>
            <select value={paymentTerms} onChange={e=>{ setPaymentTerms(e.target.value); dueDateManual.current=false; }} style={{...IS,width:"100%"}}>
              {[7,14,30,60].map(d=><option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
          <div><div style={lbl}>Due Date</div>
            <input type="date" value={dueDate} onChange={e=>{ setDueDate(e.target.value); dueDateManual.current=true; }} style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
        </div>

        {/* Line Items */}
        <div>
          <div style={{...lbl,marginBottom:6}}>Line Items</div>
          {/* Quick-add buttons */}
          <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
            {QUICK.map(([label,desc,up])=>(
              <button key={label} onClick={()=>addQuickLine(desc,1,up||"")}
                style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:"1px solid var(--c-border)",background:"var(--c-bg2)",color:"var(--c-t3)",cursor:"pointer"}}>
                + {label}
              </button>
            ))}
            <button onClick={()=>setLineItems(p=>[...p,mkLine()])}
              style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:"1px dashed var(--c-border)",background:"none",color:"var(--c-t4)",cursor:"pointer"}}>
              + Blank row
            </button>
          </div>
          <div style={{border:"1px solid var(--c-border)",borderRadius:7,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead>
                <tr style={{background:"var(--c-bg2)"}}>
                  <th style={{padding:"5px 8px",textAlign:"left",fontWeight:700,color:"var(--c-t4)",borderBottom:"1px solid var(--c-border)"}}>Description</th>
                  <th style={{padding:"5px 6px",textAlign:"right",width:48,fontWeight:700,color:"var(--c-t4)",borderBottom:"1px solid var(--c-border)"}}>Qty</th>
                  <th style={{padding:"5px 6px",textAlign:"right",width:88,fontWeight:700,color:"var(--c-t4)",borderBottom:"1px solid var(--c-border)"}}>Unit $</th>
                  <th style={{padding:"5px 6px",textAlign:"right",width:88,fontWeight:700,color:"var(--c-t4)",borderBottom:"1px solid var(--c-border)"}}>Amount</th>
                  <th style={{width:24,borderBottom:"1px solid var(--c-border)"}}/>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li,idx)=>{
                  const lineAmt = parseFloat(li.amount)||((parseFloat(li.qty)||0)*(parseFloat(li.unitPrice)||0));
                  return (
                    <tr key={li.id} style={{borderBottom:idx<lineItems.length-1?"1px solid var(--c-border)":undefined}}>
                      <td style={{padding:"4px 6px"}}>
                        <input value={li.desc} onChange={e=>updateLine(li.id,"desc",e.target.value)}
                          placeholder="Description…" style={{...IS,width:"100%",boxSizing:"border-box",fontSize:11,padding:"3px 6px"}}/>
                      </td>
                      <td style={{padding:"4px 4px"}}>
                        <input value={li.qty} onChange={e=>updateLine(li.id,"qty",e.target.value)}
                          placeholder="1" type="number" min="0" step="0.5" style={{...IS,width:"100%",boxSizing:"border-box",fontSize:11,padding:"3px 4px",textAlign:"right"}}/>
                      </td>
                      <td style={{padding:"4px 4px"}}>
                        <input value={li.unitPrice} onChange={e=>updateLine(li.id,"unitPrice",e.target.value)}
                          placeholder="0.00" type="number" min="0" step="0.01" style={{...IS,width:"100%",boxSizing:"border-box",fontSize:11,padding:"3px 4px",textAlign:"right"}}/>
                      </td>
                      <td style={{padding:"4px 6px"}}>
                        <input value={li.amount} onChange={e=>updateLine(li.id,"amount",e.target.value)}
                          placeholder="0.00" type="number" min="0" step="0.01" style={{...IS,width:"100%",boxSizing:"border-box",fontSize:11,padding:"3px 4px",textAlign:"right",
                            color: lineAmt>0?"var(--c-t2)":"var(--c-t5)"}}/>
                      </td>
                      <td style={{padding:"4px 2px",textAlign:"center"}}>
                        {lineItems.length>1&&<button onClick={()=>removeLine(li.id)}
                          style={{background:"none",border:"none",color:"var(--c-t5)",cursor:"pointer",fontSize:13,lineHeight:1,padding:"2px 4px"}}>×</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{padding:"6px 10px",background:"var(--c-bg2)",borderTop:"1px solid var(--c-border)",display:"flex",justifyContent:"flex-end",gap:16,fontVariantNumeric:"tabular-nums",fontSize:11}}>
              <span style={{color:"var(--c-t4)"}}>Subtotal (ex-GST)</span>
              <span style={{fontWeight:800,color:"var(--c-t2)",minWidth:80,textAlign:"right"}}>${subtotal.toLocaleString("en-AU",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
            </div>
            <div style={{padding:"3px 10px",background:"var(--c-bg2)",borderTop:"1px solid var(--c-border)",display:"flex",justifyContent:"flex-end",alignItems:"center",gap:10,fontSize:11}}>
              <span style={{color:"var(--c-t4)"}}>Discount ($)</span>
              <input value={discount} onChange={e=>setDiscount(e.target.value)} placeholder="0.00"
                type="number" min="0" step="0.01"
                style={{...IS,width:88,fontSize:11,padding:"2px 6px",textAlign:"right",boxSizing:"border-box",color:discountAmt>0?"#EF4444":"var(--c-t5)"}}/>
            </div>
            <div style={{padding:"4px 10px 6px",background:"var(--c-bg2)",borderTop:"1px solid var(--c-border)",display:"flex",justifyContent:"flex-end",gap:16,fontVariantNumeric:"tabular-nums",fontSize:11,color:"var(--c-t5)"}}>
              <span>GST (10%)</span>
              <span style={{minWidth:80,textAlign:"right"}}>${((subtotal-discountAmt)*0.1).toLocaleString("en-AU",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
              <span style={{marginLeft:8}}>Balance Due (inc-GST)</span>
              <span style={{minWidth:80,textAlign:"right",fontWeight:700,color:"var(--c-t3)"}}>${((subtotal-discountAmt)*1.1).toLocaleString("en-AU",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div><div style={lbl}>Notes</div>
          <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Optional notes, references, site details…" rows={2} spellCheck
            style={{...IS,width:"100%",resize:"vertical",boxSizing:"border-box"}}/>
        </div>

        {error && <div style={{color:"#EF4444",fontSize:11,fontWeight:600}}>⚠ {error}</div>}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",paddingTop:4,flexWrap:"wrap"}}>
          <button onClick={onClose} style={{background:"none",border:"1px solid var(--c-border)",borderRadius:6,padding:"6px 16px",color:"var(--c-t4)",fontSize:12,cursor:"pointer"}}>Cancel</button>
          <button onClick={save} style={{background:"#F97316",border:"none",borderRadius:6,padding:"6px 18px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer"}}>
            {invoice&&!prefillProject?"Save Changes":"Create Invoice"}
          </button>
          {onSaveAndSend&&(
            <button onClick={()=>{
              if(!invoiceNo.trim()||subtotal<=0){ setError("Fill in invoice number and at least one line item first."); return; }
              const cleanLines=lineItems.filter(li=>{const a=parseFloat(li.amount)||((parseFloat(li.qty)||0)*(parseFloat(li.unitPrice)||0));return a>0||li.desc.trim();});
              onSaveAndSend({invoiceNo:invoiceNo.trim(),projectId,projectLabel:projectLabel.trim(),client,amount:parseFloat(subtotal.toFixed(2)),lineItems:cleanLines,claimNo:claimNo.trim(),claimPct:claimPct?parseFloat(claimPct):null,paymentTerms:parseInt(paymentTerms),status,issuedDate,dueDate,notes});
            }} style={{background:"#8B5CF6",border:"none",borderRadius:6,padding:"6px 18px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer"}}>
              ✉ Save & Send
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children, light }) {
  return (
    <div style={{marginBottom:13}}>
      <label style={{display:"block",color:light?"#9099A8":"#94A3B8",fontSize:11,fontWeight:700,letterSpacing:"0.06em",marginBottom:5,textTransform:"uppercase"}}>{label}</label>
      {children}
    </div>
  );
}

const AU_STATES = { "Victoria":"VIC","New South Wales":"NSW","Queensland":"QLD","South Australia":"SA","Western Australia":"WA","Tasmania":"TAS","Northern Territory":"NT","Australian Capital Territory":"ACT" };
function fmtAddr(item) {
  const a = item.address || {};
  const parts = [];
  if (a.house_number && a.road) parts.push(`${a.house_number} ${a.road}`);
  else if (a.road) parts.push(a.road);
  const suburb = a.suburb || a.neighbourhood || a.town || a.village || a.hamlet || a.city_district;
  if (suburb) parts.push(suburb);
  if (a.city && a.city !== suburb) parts.push(a.city);
  if (a.state) parts.push(AU_STATES[a.state] || a.state);
  if (a.postcode) parts.push(a.postcode);
  return parts.filter(Boolean).join(", ");
}

const _addrCache = new Map(); // module-level cache: query → suggestions array

function AddressAutocomplete({ value, onChange, style, placeholder }) {
  const [suggs, setSuggs]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const [activeIdx, setIdx]   = useState(-1);
  const debRef  = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    const close = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const search = q => {
    if (debRef.current) clearTimeout(debRef.current);
    if (!q || q.length < 3) { setSuggs([]); setOpen(false); return; }
    // Return cached result immediately if available
    if (_addrCache.has(q)) { const cached = _addrCache.get(q); setSuggs(cached); setOpen(cached.length > 0); setIdx(-1); return; }
    debRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        // viewbox = Victoria bounds (soft bias: bounded=0 lets non-VIC results through but ranked lower)
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=au&format=json&addressdetails=1&limit=10&viewbox=140.96,-33.98,149.98,-39.16&bounded=0&email=admin@advancedsteeldrafting.com`;
        const res = await fetch(url, { headers: { "Accept-Language": "en-AU" } });
        const data = await res.json();
        const formatted = data.map(d => ({ id: d.place_id, label: fmtAddr(d), raw: d }))
          .filter((d,i,arr) => d.label && arr.findIndex(x => x.label === d.label) === i)
          .sort((a,b) => (a.raw.address?.state==="Victoria"?0:1) - (b.raw.address?.state==="Victoria"?0:1))
          .slice(0, 7);
        _addrCache.set(q, formatted);
        setSuggs(formatted); setOpen(formatted.length > 0); setIdx(-1);
      } catch { setSuggs([]); }
      finally { setLoading(false); }
    }, 200);
  };

  const select = item => { onChange({ target: { value: item.label } }); setSuggs([]); setOpen(false); setIdx(-1); };

  const onKeyDown = e => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i + 1, suggs.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); select(suggs[activeIdx]); }
    else if (e.key === "Escape") { setOpen(false); setIdx(-1); }
  };

  return (
    <div ref={wrapRef} style={{ position:"relative" }}>
      <input type="text" value={value} autoComplete="off" placeholder={placeholder} style={style}
        onChange={e => { onChange(e); search(e.target.value); }}
        onKeyDown={onKeyDown} />
      {loading && <span style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", fontSize:11, color:"#64748B", pointerEvents:"none" }}>…</span>}
      {open && suggs.length > 0 && (
        <div style={{ position:"absolute", top:"calc(100% + 3px)", left:0, right:0, zIndex:9999,
          background:"#1E293B", border:"1px solid #334155", borderRadius:8,
          boxShadow:"0 10px 30px rgba(0,0,0,0.6)", overflow:"hidden" }}>
          {suggs.map((s, i) => (
            <div key={s.id} onMouseDown={() => select(s)} onMouseEnter={() => setIdx(i)}
              style={{ padding:"9px 13px", cursor:"pointer", fontSize:12,
                color: i === activeIdx ? "#fff" : "#CBD5E1",
                background: i === activeIdx ? "#334155" : "transparent",
                borderBottom: i < suggs.length - 1 ? "1px solid #1E293B" : "none", lineHeight:1.5 }}>
              📍 {s.label}
            </div>
          ))}
          <div style={{ fontSize:9, color:"#475569", padding:"4px 10px", textAlign:"right" }}>© OpenStreetMap contributors</div>
        </div>
      )}
    </div>
  );
}

function SpellCheckArea({ value, onChange, style, rows, placeholder, minHeight, ...rest }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult]     = useState(null);
  const [scErr, setScErr]       = useState("");

  const runCheck = async () => {
    if (!value.trim()) return;
    setChecking(true); setScErr(""); setResult(null);
    try {
      const res = await fetch("/api/spellcheck", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Check failed");
      setResult(data);
    } catch(e) { setScErr(e.message); }
    finally { setChecking(false); }
  };

  const accept = () => { onChange({ target: { value: result.text } }); setResult(null); };

  return (
    <div>
      <textarea value={value} onChange={onChange} rows={rows} placeholder={placeholder}
        style={minHeight ? { ...style, minHeight } : style} spellCheck {...rest} />
      <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:5, flexWrap:"wrap" }}>
        <button type="button" onClick={runCheck} disabled={checking || !value.trim()}
          style={{ background:"transparent", border:"1px solid #334155", borderRadius:5, padding:"3px 10px",
            color: checking||!value.trim() ? "#475569" : "#94A3B8", fontSize:11, fontWeight:700,
            cursor: checking||!value.trim() ? "not-allowed" : "pointer", display:"flex", alignItems:"center", gap:4 }}>
          {checking ? "⏳ Checking…" : "✓ Spell Check"}
        </button>
        {scErr && <span style={{ fontSize:11, color:"#EF4444" }}>{scErr}</span>}
      </div>
      {result && (
        <div style={{ marginTop:7, background:"#0A0F1E", border:`1px solid ${result.changes.length ? "#F59E0B55" : "#10B98155"}`,
          borderRadius:8, padding:"10px 12px" }}>
          {result.changes.length === 0 ? (
            <div style={{ fontSize:12, color:"#10B981", fontWeight:700 }}>✓ No spelling or grammar issues found</div>
          ) : (
            <div>
              <div style={{ fontSize:11, fontWeight:800, color:"#F59E0B", marginBottom:6 }}>
                {result.changes.length} suggestion{result.changes.length > 1 ? "s" : ""}:
              </div>
              <ul style={{ margin:"0 0 8px 16px", padding:0, fontSize:11, color:"#CBD5E1", lineHeight:1.8 }}>
                {result.changes.map((c,i) => <li key={i}>{c}</li>)}
              </ul>
              <div style={{ fontSize:11, color:"#94A3B8", background:"#1E293B", borderRadius:6,
                padding:"6px 10px", marginBottom:8, lineHeight:1.6 }}>{result.text}</div>
              <div style={{ display:"flex", gap:8 }}>
                <button type="button" onClick={accept}
                  style={{ background:"#10B981", border:"none", borderRadius:5, padding:"5px 14px",
                    color:"#fff", fontWeight:700, fontSize:12, cursor:"pointer" }}>✓ Accept All</button>
                <button type="button" onClick={() => setResult(null)}
                  style={{ background:"transparent", border:"1px solid #334155", borderRadius:5, padding:"5px 12px",
                    color:"#94A3B8", fontSize:12, cursor:"pointer" }}>Dismiss</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Badge({ label, map }) {
  const cfg=(map||PROJECT_STATUS)[label]||{color:"#6B7280",bg:"#6B728020"};
  return <span style={{background:cfg.bg,color:cfg.color,border:`1px solid ${cfg.color}33`,borderRadius:4,padding:"2px 8px",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{label}</span>;
}

function PriBadge({ label }) {
  return <span style={{color:PRIORITY_CLR[label]||"#6B7280",fontSize:11,fontWeight:700}}>▲ {(label||"").toUpperCase()}</span>;
}

function ProgressBar({ pct, color }) {
  const c = color||(pct>=80?"#10B981":pct>=50?"#3B82F6":"#F59E0B");
  return <div style={{background:"var(--c-page)",borderRadius:3,height:6,overflow:"hidden"}}><div style={{width:`${pct}%`,height:"100%",background:c,borderRadius:3,transition:"width 0.4s"}}/></div>;
}

function Avatar({ name, size }) {
  const { memberColor } = useTeam();
  const sz = size || 26;
  return <span title={name} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:sz,height:sz,borderRadius:"50%",background:memberColor[name]||"#6B7280",color:"#fff",fontSize:sz*0.38,fontWeight:800,border:"2px solid #0F172A",marginRight:-6,flexShrink:0}}>{name.slice(0,2)}</span>;
}

// ═════════════════════════════════════════════════
// ATTACHMENT HELPERS
// ═════════════════════════════════════════════════
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

const fileIcon = (type) => {
  if (!type) return "📄";
  if (type.startsWith("image/")) return "🖼";
  if (type.includes("pdf")) return "📕";
  if (type.includes("word") || type.includes("document")) return "📘";
  if (type.includes("excel") || type.includes("sheet")) return "📊";
  if (type.includes("zip") || type.includes("archive") || type.includes("compressed")) return "🗜";
  if (type.startsWith("video/")) return "🎬";
  if (type.startsWith("audio/")) return "🎵";
  return "📄";
};

const fmtFileSize = (bytes) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + " KB";
  return (bytes/(1024*1024)).toFixed(1) + " MB";
};

// Decides what to do when a user clicks/opens an attachment
const openAttachment = (att, setPreview) => {
  const src = att.url || att.dataUrl; // url = Storage link; dataUrl = legacy base64
  if (att.type.startsWith("image/")) {
    setPreview(att);
  } else if (
    att.type.includes("pdf") ||
    att.type.startsWith("video/") ||
    att.type.startsWith("audio/") ||
    att.type.startsWith("text/")
  ) {
    const win = window.open();
    if (win) {
      win.document.title = att.name;
      win.document.body.style.margin = "0";
      win.document.body.style.background = "#0F172A";
      const iframe = win.document.createElement("iframe");
      iframe.src = src;
      iframe.style.cssText = "border:none;width:100vw;height:100vh;display:block;";
      win.document.body.appendChild(iframe);
    } else {
      const link = document.createElement("a");
      link.href = src;
      link.download = att.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } else {
    const link = document.createElement("a");
    link.href = src;
    link.download = att.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};

// Tooltip label for the open/preview action by type
const openLabel = (type) => {
  if (!type) return "Download";
  if (type.startsWith("image/")) return "Preview";
  if (type.includes("pdf") || type.startsWith("video/") || type.startsWith("audio/") || type.startsWith("text/")) return "Open";
  return "Download";
};

// Icon for the open action button
const openIcon = (type) => {
  if (!type) return "⬇";
  if (type.startsWith("image/")) return "👁";
  if (type.includes("pdf") || type.startsWith("video/") || type.startsWith("audio/") || type.startsWith("text/")) return "↗";
  return "⬇";
};

function AttachmentsModal({ item, currentUser, onSave, onClose }) {
  const { memberColor: MEMBER_COLOR } = useTeam();
  const [attachments, setAttachments] = useState(item.attachments || []);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({}); // attId → 0-100
  const [preview, setPreview] = useState(null);
  const [errMsg, setErrMsg] = useState("");

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    setUploading(true);
    setErrMsg("");
    try {
      const newAtts = [];
      const rejected = [];
      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) { rejected.push(file.name); continue; }
        const attId = mkId();
        if (storage) {
          // Upload to Firebase Storage so base64 never lands in the Firestore doc
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const storagePath = `attachments/${item.id}/${attId}/${safeName}`;
          const r = storageFileRef(storage, storagePath);
          const task = uploadBytesResumable(r, file);
          const url = await new Promise((res, rej) => {
            task.on("state_changed",
              snap => setUploadProgress(p => ({ ...p, [attId]: Math.round(snap.bytesTransferred / snap.totalBytes * 100) })),
              rej,
              async () => { setUploadProgress(p => { const n = { ...p }; delete n[attId]; return n; }); res(await getDownloadURL(task.snapshot.ref)); }
            );
          });
          newAtts.push({ id: attId, name: file.name, type: file.type || "application/octet-stream", size: file.size, url, storagePath, member: currentUser, ts: nowTs() });
        } else {
          const dataUrl = await readFileAsDataUrl(file);
          newAtts.push({ id: attId, name: file.name, type: file.type || "application/octet-stream", size: file.size, dataUrl, member: currentUser, ts: nowTs() });
        }
      }
      if (rejected.length > 0)
        setErrMsg(`${rejected.length} file(s) exceeded 50MB limit: ${rejected.join(", ")}`);
      setAttachments([...attachments, ...newAtts]);
    } catch (err) {
      setErrMsg("Failed to upload file: " + err.message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const delAttachment = (id) => setAttachments(attachments.filter(a => a.id !== id));

  const downloadAtt = (att) => {
    const link = document.createElement("a");
    link.href = att.url || att.dataUrl; link.download = att.name;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const handleSave = () => {
    const original = item.attachments || [];
    const newAtts = attachments.filter(a => !original.some(o => o.id === a.id));
    const removedAtts = original.filter(o => !attachments.some(a => a.id === o.id));
    // Clean up Storage files for removed attachments (fire-and-forget)
    if (storage) {
      removedAtts.forEach(a => {
        if (a.storagePath) deleteObject(storageFileRef(storage, a.storagePath)).catch(() => {});
      });
    }
    const histEntries = [
      ...newAtts.map(a => ({ ts: nowTs(), member: currentUser, action: "attached", note: a.name })),
      ...removedAtts.map(a => ({ ts: nowTs(), member: currentUser, action: "removed file", note: a.name })),
    ];
    onSave(item.id, attachments, histEntries);
    onClose();
  };

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);

  return (
    <Modal title="📎 Attachments" onClose={onClose} wide>
      <div style={{fontSize:13,color:"var(--c-t2)",marginBottom:14,padding:"10px 12px",background:"var(--c-page)",borderRadius:6,borderLeft:"3px solid #F97316"}}>
        {item.label}
      </div>

      <div style={{border:"2px dashed #475569",borderRadius:8,padding:"24px 16px",textAlign:"center",marginBottom:14,background:"var(--c-page)",transition:"border-color 0.15s"}}
        onMouseEnter={e=>e.currentTarget.style.borderColor="#F97316"}
        onMouseLeave={e=>e.currentTarget.style.borderColor="#475569"}>
        <input type="file" multiple onChange={handleFileSelect} id="ck-file-upload" style={{display:"none"}} disabled={uploading}/>
        <label htmlFor="ck-file-upload" style={{cursor:uploading?"wait":"pointer",display:"block"}}>
          <div style={{fontSize:36,marginBottom:8}}>📎</div>
          <div style={{fontSize:13,fontWeight:700,color:"#F97316",marginBottom:4}}>
            {uploading ? "Reading files…" : "Click to attach files"}
          </div>
          <div style={{fontSize:11,color:"var(--c-t4)"}}>Images · PDFs · Word · Excel · ZIP (max 50MB each)</div>
        </label>
      </div>

      {Object.entries(uploadProgress).map(([id, pct]) => (
        <div key={id} style={{marginBottom:8}}>
          <div style={{height:4,background:"var(--c-border)",borderRadius:2,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${pct}%`,background:"#F97316",borderRadius:2,transition:"width 0.2s"}}/>
          </div>
          <div style={{fontSize:10,color:"var(--c-t4)",marginTop:2}}>{pct}% uploaded…</div>
        </div>
      ))}

      {errMsg && (
        <div style={{background:"#EF444420",border:"1px solid #EF4444",borderRadius:6,padding:"8px 12px",fontSize:12,color:"#EF4444",marginBottom:14}}>
          ⚠ {errMsg}
        </div>
      )}

      {attachments.length === 0 ? (
        <div style={{textAlign:"center",color:"var(--c-t5)",padding:"20px 0",fontSize:13}}>No attachments yet</div>
      ) : (
        <div style={{marginBottom:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:11,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",letterSpacing:"0.06em"}}>{attachments.length} file{attachments.length!==1?"s":""}</span>
            <span style={{fontSize:11,color:"var(--c-t5)"}}>Total: {fmtFileSize(totalSize)}</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:6,maxHeight:300,overflowY:"auto"}}>
            {attachments.map(att => {
              const isImage = att.type.startsWith("image/");
              const mc = MEMBER_COLOR[att.member]||"#6B7280";
              const actionLabel = openLabel(att.type);
              const actionIcon = openIcon(att.type);
              return (
                <div key={att.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"var(--c-page)",borderRadius:6,border:"1px solid var(--c-border2)"}}>
                  {/* ── Thumbnail / icon — click to open ── */}
                  {isImage ? (
                    <img
                      src={att.url||att.dataUrl} alt={att.name}
                      onClick={() => openAttachment(att, setPreview)}
                      title={actionLabel}
                      style={{width:44,height:44,objectFit:"cover",borderRadius:5,cursor:"pointer",border:"1px solid var(--c-border)",flexShrink:0}}
                    />
                  ) : (
                    <div
                      onClick={() => openAttachment(att, setPreview)}
                      title={actionLabel}
                      style={{width:44,height:44,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,background:"var(--c-panel)",borderRadius:5,flexShrink:0,cursor:"pointer"}}
                    >
                      {fileIcon(att.type)}
                    </div>
                  )}

                  {/* ── File info — click row to open ── */}
                  <div
                    onClick={() => openAttachment(att, setPreview)}
                    title={actionLabel}
                    style={{flex:1,minWidth:0,cursor:"pointer"}}
                  >
                    <div style={{fontSize:12,color:"var(--c-t1)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{att.name}</div>
                    <div style={{fontSize:10,color:"var(--c-t5)",display:"flex",gap:8,alignItems:"center",marginTop:2}}>
                      <span>{fmtFileSize(att.size)}</span>
                      <span style={{color:mc,fontWeight:700}}>{att.member}</span>
                      <span>{fmtTs(att.ts)}</span>
                    </div>
                  </div>

                  {/* ── Open / preview button ── */}
                  <button
                    onClick={() => openAttachment(att, setPreview)}
                    title={actionLabel}
                    style={{background:"none",border:"none",color:"var(--c-t3)",cursor:"pointer",fontSize:14,padding:"0 2px"}}
                  >
                    {actionIcon}
                  </button>

                  {/* ── Download (always available as explicit action) ── */}
                  <button onClick={() => downloadAtt(att)} title="Download" style={{background:"none",border:"none",color:"#3B82F6",cursor:"pointer",fontSize:14,padding:"0 2px"}}>⬇</button>

                  {/* ── Remove ── */}
                  <button onClick={() => delAttachment(att.id)} title="Remove" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14,padding:"0 2px"}}>✕</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Image full-screen preview overlay ── */}
      {preview && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.95)",zIndex:3000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:30}} onClick={()=>setPreview(null)}>
          <img src={preview.url||preview.dataUrl} alt={preview.name} style={{maxWidth:"90%",maxHeight:"85%",borderRadius:8,boxShadow:"0 0 40px rgba(0,0,0,0.8)"}} onClick={e=>e.stopPropagation()}/>
          <div style={{marginTop:16,color:"var(--c-t1)",fontSize:13}}>{preview.name} · {fmtFileSize(preview.size)}</div>
          <button onClick={()=>setPreview(null)} style={{position:"absolute",top:20,right:20,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:50,width:40,height:40,color:"var(--c-t1)",cursor:"pointer",fontSize:18}}>✕</button>
        </div>
      )}

      <div style={{display:"flex",gap:10}}>
        <button autoFocus onClick={handleSave} style={{flex:1,background:"#10B981",border:"none",borderRadius:6,padding:"10px 0",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>Save Changes</button>
        <button onClick={onClose} style={{padding:"10px 20px",background:"transparent",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:13}}>Cancel</button>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════
// SNIP MODAL — uses the real Windows Snipping Tool (Win+Shift+S), not the browser's
// screen-share API. A browser can never skip its own share-picker dialog (it's a hard
// security boundary, the same for every site), but a paste action needs no permission
// dialog at all — so the flow is: snip externally, then Ctrl+V here.
// Fullscreen drag-to-select crop overlay — mirrors Snipping Tool UX
function CropOverlay({ imageDataUrl, imageWidth, imageHeight, onCrop, onCancel }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null); // {x, y} start of drag

  const redraw = (sel) => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (sel) {
      const x = Math.min(sel.x1, sel.x2), y = Math.min(sel.y1, sel.y2);
      const w = Math.abs(sel.x2 - sel.x1), h = Math.abs(sel.y2 - sel.y1);
      if (w > 1 && h > 1) {
        const sx = x * imageWidth / canvas.width, sy = y * imageHeight / canvas.height;
        const sw = w * imageWidth / canvas.width, sh = h * imageHeight / canvas.height;
        ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
        ctx.strokeStyle = "#F97316"; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      }
    }
  };

  useEffect(() => {
    const img = new Image();
    img.onload = () => { imgRef.current = img; redraw(); };
    img.src = imageDataUrl;
    const onKey = e => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (imgRef.current) redraw();
  }, []);

  const pos = e => ({ x: e.clientX, y: e.clientY });

  const onMouseDown = e => { dragRef.current = pos(e); };
  const onMouseMove = e => {
    if (!dragRef.current) return;
    redraw({ x1: dragRef.current.x, y1: dragRef.current.y, ...pos(e), x2: e.clientX, y2: e.clientY });
  };
  const onMouseUp = e => {
    if (!dragRef.current) return;
    const { x: x1, y: y1 } = dragRef.current;
    const { x: x2, y: y2 } = pos(e);
    dragRef.current = null;
    const cx = Math.min(x1, x2), cy = Math.min(y1, y2);
    const cw = Math.abs(x2 - x1), ch = Math.abs(y2 - y1);
    if (cw < 5 || ch < 5) return;
    const canvas = canvasRef.current;
    const img = imgRef.current;
    const scaleX = imageWidth / canvas.width, scaleY = imageHeight / canvas.height;
    const out = document.createElement("canvas");
    out.width = Math.round(cw * scaleX); out.height = Math.round(ch * scaleY);
    out.getContext("2d").drawImage(img, cx * scaleX, cy * scaleY, out.width, out.height, 0, 0, out.width, out.height);
    onCrop(out.toDataURL("image/png"));
  };

  return (
    <div style={{position:"fixed",inset:0,zIndex:9999,cursor:"crosshair",userSelect:"none"}}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
      <canvas ref={canvasRef} style={{display:"block",width:"100vw",height:"100vh"}}/>
      <div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:"8px 18px",fontSize:12,color:"var(--c-t2)",fontWeight:600,boxShadow:"0 4px 20px #000a",pointerEvents:"auto",whiteSpace:"nowrap"}}>
        🖱 Drag to select area &nbsp;·&nbsp;
        <button onClick={onCancel} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontWeight:700,fontSize:12}}>✕ Cancel (Esc)</button>
      </div>
    </div>
  );
}

// Phases: waiting → cropping → captured → error
// ═════════════════════════════════════════════════
function ScreenshotModal({ item, currentUser, onSave, onClose }) {
  const [phase, setPhase]             = useState("waiting");
  const [capturedUrl, setCapturedUrl] = useState(null);
  const [capturedName, setCapturedName] = useState(null);
  const [capturedType, setCapturedType] = useState("image/png");
  const [errMsg, setErrMsg]           = useState("");
  const [lightbox, setLightbox]       = useState(null);
  const [cropData, setCropData]       = useState(null); // {dataUrl, width, height}
  const fileRef = useRef(null);
  const existingAtts = item.attachments || [];

  const acceptImage = (blob, name, type) => {
    const reader = new FileReader();
    reader.onload = () => {
      setCapturedUrl(reader.result);
      setCapturedName(name || null);
      setCapturedType(type || blob.type || "image/png");
      setPhase("captured");
    };
    reader.onerror = () => { setErrMsg("Couldn't read the image."); setPhase("error"); };
    reader.readAsDataURL(blob);
  };

  const onFileChange = e => {
    const file = e.target.files?.[0];
    if (file) acceptImage(file, file.name, file.type);
    e.target.value = "";
  };

  // Passive — catches Ctrl+V the instant it happens, no permission prompt at all
  useEffect(() => {
    if (phase !== "waiting") return;
    const handler = e => {
      const items = e.clipboardData?.items || [];
      const imgItem = Array.from(items).find(it => it.type.startsWith("image/"));
      if (imgItem) { e.preventDefault(); acceptImage(imgItem.getAsFile(), null, imgItem.type); }
      else { setErrMsg("No image found on the clipboard — snip with Win+Shift+S first, then paste here."); setPhase("error"); }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [phase]);

  // Reads the clipboard directly via the Clipboard API. `silent` suppresses the
  // "nothing there" error — used by the auto-check below, where that's the expected
  // outcome most of the time (e.g. focus returned without snipping anything yet).
  const tryClipboardRead = async (silent) => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const imgType = it.types.find(t => t.startsWith("image/"));
        if (imgType) { const blob = await it.getType(imgType); acceptImage(blob, null, imgType); return true; }
      }
      if (!silent) { setErrMsg("No image found on the clipboard — snip with Win+Shift+S first, then try again."); setPhase("error"); }
    } catch (err) {
      if (!silent) { setErrMsg(`Clipboard access error: ${err.message}`); setPhase("error"); }
    }
    return false;
  };
  const pasteFromClipboard = () => tryClipboardRead(false);

  // Auto-detect — the moment the browser window regains focus (e.g. you just used
  // Win+Shift+S, which switches away then back), silently check the clipboard so you
  // don't even need to press Ctrl+V. Falls back to nothing if permission isn't granted
  // yet — the keyboard paste listener above still works regardless.
  useEffect(() => {
    if (phase !== "waiting") return;
    const onFocus = () => tryClipboardRead(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const retake = () => { setCapturedUrl(null); setCapturedName(null); setPhase("waiting"); };

  const confirm = async () => {
    if (!capturedUrl) return;
    const ts   = nowTs();
    const ext  = capturedType.split("/")[1] || "png";
    const name = capturedName || `snip_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`;
    const approxSize = Math.round((capturedUrl.length - capturedUrl.indexOf(",") - 1) * 0.75);
    const attId = mkId();
    let attData;
    if (storage) {
      try {
        const blob = await fetch(capturedUrl).then(r => r.blob());
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `attachments/${item.id}/${attId}/${safeName}`;
        const r = storageFileRef(storage, storagePath);
        const task = uploadBytesResumable(r, blob);
        const url = await new Promise((res, rej) => {
          task.on("state_changed", null, rej, async () => res(await getDownloadURL(task.snapshot.ref)));
        });
        attData = { id: attId, name, type: capturedType, size: approxSize, url, storagePath, member: currentUser, ts };
      } catch {
        attData = { id: attId, name, type: capturedType, size: approxSize, dataUrl: capturedUrl, member: currentUser, ts };
      }
    } else {
      attData = { id: attId, name, type: capturedType, size: approxSize, dataUrl: capturedUrl, member: currentUser, ts };
    }
    onSave(item.id, [...(item.attachments || []), attData], [{ ts, member: currentUser, action: "attached", note: name }]);
    onClose();
  };

  const removeExisting = id => {
    const updated = existingAtts.filter(a => a.id !== id);
    onSave(item.id, updated, []);
  };

  const takeScreenshot = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream;
      await new Promise(res => { video.onloadedmetadata = res; });
      video.play();
      await new Promise(res => setTimeout(res, 150));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      stream.getTracks().forEach(t => t.stop());
      setCropData({ dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height });
      setPhase("cropping");
    } catch (err) {
      if (err.name !== "NotAllowedError") { setErrMsg(`Screen capture failed: ${err.message}`); setPhase("error"); }
    }
  };

  if (phase === "cropping" && cropData) {
    return <CropOverlay
      imageDataUrl={cropData.dataUrl} imageWidth={cropData.width} imageHeight={cropData.height}
      onCrop={dataUrl => { setCapturedUrl(dataUrl); setCapturedName("snip.png"); setCapturedType("image/png"); setCropData(null); setPhase("captured"); }}
      onCancel={() => { setCropData(null); setPhase("waiting"); }}
    />;
  }

  return (
    <Modal title="✂️ Screenshot & Images" onClose={onClose} wide>
      <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={onFileChange}/>
      {/* Checklist item context */}
      <div style={{fontSize:12,color:"var(--c-t2)",marginBottom:14,padding:"9px 12px",background:"var(--c-page)",borderRadius:6,borderLeft:"3px solid #F97316"}}>
        {item.label}
      </div>

      {/* ── WAITING — three options ── */}
      {phase==="waiting" && (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {/* Option 1: Direct screen capture */}
          <div style={{textAlign:"center",padding:"24px 20px",background:"#F9731610",border:"2px solid #F97316",borderRadius:10}}>
            <div style={{fontSize:40,marginBottom:10}}>📸</div>
            <div style={{fontSize:15,fontWeight:800,color:"var(--c-t1)",marginBottom:8}}>Take a Screenshot</div>
            <div style={{fontSize:12,color:"var(--c-t3)",marginBottom:16}}>Click below — your browser will ask you to pick a window or screen to capture.</div>
            <button onClick={takeScreenshot}
              style={{background:"#F97316",border:"none",borderRadius:8,padding:"11px 28px",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>
              📸 Take Screenshot Now
            </button>
          </div>
          {/* Option 2: Win+Shift+S */}
          <div style={{padding:"14px 20px",border:"1px solid var(--c-border)",borderRadius:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--c-t1)",marginBottom:4}}>
                  <kbd style={kbdStyle}>⊞ Win</kbd> + <kbd style={kbdStyle}>Shift</kbd> + <kbd style={kbdStyle}>S</kbd>
                </div>
                <div style={{fontSize:11,color:"var(--c-t4)"}}>Press the keys, drag to select area, then return here — auto-pastes on focus. Or press Ctrl+V manually.</div>
              </div>
              <button onClick={pasteFromClipboard}
                style={{background:"var(--c-page)",border:"1px solid #475569",borderRadius:7,padding:"7px 14px",color:"var(--c-t3)",fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0}}>
                📋 Paste (Ctrl+V)
              </button>
            </div>
          </div>
          {/* Option 3: Browse image */}
          <div style={{textAlign:"center",padding:"14px 20px",border:"1px solid var(--c-border)",borderRadius:10}}>
            <div style={{fontSize:12,color:"var(--c-t4)",marginBottom:8}}>Have an existing image file?</div>
            <button onClick={()=>fileRef.current?.click()}
              style={{background:"var(--c-page)",border:"1px solid #475569",borderRadius:7,padding:"7px 16px",color:"var(--c-t3)",fontWeight:700,fontSize:12,cursor:"pointer"}}>
              📁 Browse images…
            </button>
          </div>
        </div>
      )}

      {/* ── CAPTURED — review the snip ── */}
      {phase==="captured" && capturedUrl && (
        <>
          <div style={{position:"relative",background:"#000",borderRadius:10,overflow:"hidden",marginBottom:14}}>
            <img src={capturedUrl} alt="Snip preview"
              style={{width:"100%",maxHeight:380,objectFit:"contain",display:"block"}}/>
            <div style={{position:"absolute",top:10,right:10,background:"#10B98190",borderRadius:5,padding:"3px 10px",fontSize:11,fontWeight:800,color:"#fff"}}>
              PREVIEW
            </div>
          </div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={confirm}
              style={{flex:1,background:"#10B981",border:"none",borderRadius:8,padding:"13px 0",color:"#fff",fontWeight:900,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              ✓ Save Snip
            </button>
            <button onClick={takeScreenshot}
              style={{flex:1,background:"var(--c-panel)",border:"1px solid #475569",borderRadius:8,padding:"13px 0",color:"var(--c-t3)",fontWeight:700,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              📸 Retake
            </button>
            <button onClick={onClose}
              style={{padding:"13px 16px",background:"transparent",border:"1px solid var(--c-border)",borderRadius:8,color:"var(--c-t4)",cursor:"pointer",fontSize:13}}>
              ✕
            </button>
          </div>
        </>
      )}

      {/* ── ERROR ── */}
      {phase==="error" && (
        <div style={{textAlign:"center",padding:"24px 16px"}}>
          <div style={{fontSize:36,marginBottom:12}}>⚠️</div>
          <div style={{color:"#EF4444",fontSize:13,fontWeight:600,marginBottom:20}}>{errMsg}</div>
          <div style={{display:"flex",gap:10,justifyContent:"center"}}>
            <button onClick={retake} style={{background:"#F97316",border:"none",borderRadius:8,padding:"10px 24px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer"}}>Try Again</button>
            <button onClick={()=>fileRef.current?.click()} style={{background:"#3B82F620",border:"1px solid #3B82F6",borderRadius:8,padding:"10px 18px",color:"#3B82F6",fontWeight:700,fontSize:13,cursor:"pointer"}}>📁 Browse images</button>
            <button onClick={onClose} style={{padding:"10px 20px",background:"transparent",border:"1px solid var(--c-border)",borderRadius:8,color:"var(--c-t3)",cursor:"pointer",fontSize:13}}>Close</button>
          </div>
        </div>
      )}

      {/* ── EXISTING ATTACHMENTS ── */}
      {existingAtts.length>0 && (
        <div style={{marginTop:16,borderTop:"1px solid var(--c-border)",paddingTop:14}}>
          <div style={{fontSize:11,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:8}}>Saved ({existingAtts.length})</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {existingAtts.map(a => (
              <div key={a.id} style={{position:"relative",background:"var(--c-page)",borderRadius:6,overflow:"hidden",border:"1px solid var(--c-border)"}}>
                <img src={a.url||a.dataUrl} alt={a.name} onClick={()=>setLightbox(a)}
                  style={{width:80,height:80,objectFit:"cover",cursor:"zoom-in",display:"block"}}/>
                <button onClick={()=>removeExisting(a.id)}
                  style={{position:"absolute",top:2,right:2,background:"#EF4444",border:"none",borderRadius:"50%",width:16,height:16,color:"#fff",cursor:"pointer",fontSize:9,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {lightbox && (
        <div onClick={()=>setLightbox(null)} style={{position:"fixed",inset:0,background:"#000c",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",cursor:"zoom-out"}}>
          <img src={lightbox.url||lightbox.dataUrl} alt={lightbox.name} style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8,boxShadow:"0 0 40px #000"}}/>
        </div>
      )}
    </Modal>
  );
}
const kbdStyle = { background:"var(--c-panel)", border:"1px solid #475569", borderRadius:4, padding:"1px 7px", fontSize:12, fontFamily:"monospace", color:"var(--c-t1)" };

function LoginScreen({ onLogin, compact = false }) {
  const { teamNames: TEAM, verifyPin, teamReady } = useTeam();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [lockedUntil, setLockedUntil] = useState(() => {
    const v = Number(localStorage.getItem("asd_pin_locked_until") || 0);
    return v > Date.now() ? v : 0;
  });
  const [countdown, setCountdown] = useState(0);
  const syncing = !teamReady;

  useEffect(() => {
    if (!lockedUntil) return;
    const tick = () => {
      const rem = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (rem <= 0) {
        setLockedUntil(0);
        setCountdown(0);
        localStorage.removeItem("asd_pin_locked_until");
      } else {
        setCountdown(rem);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const handlePin = async digit => {
    if (pin.length >= 4 || syncing || lockedUntil) return;
    const next = pin + digit;
    setPin(next);
    setError("");
    if (next.length === 4) {
      let matched = null;
      for (const name of TEAM) { if (await verifyPin(name, next)) { matched = name; break; } }
      if (matched) {
        localStorage.removeItem("asd_pin_locked_until");
        localStorage.removeItem("asd_pin_attempts");
        onLogin(matched);
      } else {
        const attempts = Number(localStorage.getItem("asd_pin_attempts") || 0) + 1;
        localStorage.setItem("asd_pin_attempts", String(attempts));
        if (attempts >= 5) {
          const delaySec = Math.min(30 * Math.pow(2, attempts - 5), 900); // 30s → 60s → 120s … max 15 min
          const until = Date.now() + delaySec * 1000;
          localStorage.setItem("asd_pin_locked_until", String(until));
          setLockedUntil(until);
          setError(`Too many failed attempts.`);
        } else {
          setError(`Incorrect code. ${5 - attempts} attempt${5 - attempts === 1 ? "" : "s"} remaining.`);
        }
        setPin("");
      }
    }
  };

  return (
    <div style={{minHeight:compact?"auto":"100vh",background:"var(--c-page)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:compact?"32px 24px":"24px"}}>
      {/* Logo */}
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,marginBottom:40}}>
        <img src="/logo.jpg" alt="ASD" style={{width:80,height:80,borderRadius:16,objectFit:"cover",display:"block",boxShadow:"0 8px 32px rgba(0,0,0,0.6)"}}/>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:20,fontWeight:900,color:"var(--c-t1)",lineHeight:1.15,letterSpacing:"0.04em"}}>ADVANCED STEEL DRAFTING</div>
          <div style={{fontSize:11,color:"var(--c-t4)",letterSpacing:"0.18em",textTransform:"uppercase",marginTop:3}}>Team Portal</div>
        </div>
      </div>

      {/* Keypad */}
      <div style={{width:"100%",maxWidth:300,textAlign:"center"}}>
        <div style={{fontSize:13,fontWeight:700,color:"var(--c-t3)",marginBottom:20,letterSpacing:"0.04em"}}>Enter your unique code</div>

        {/* Dots */}
        <div style={{display:"flex",gap:16,justifyContent:"center",marginBottom:24}}>
          {[0,1,2,3].map(i=>(
            <div key={i} style={{width:14,height:14,borderRadius:"50%",background:i<pin.length?"#F97316":"var(--c-border)",border:`2px solid ${i<pin.length?"#F97316":"var(--c-border)"}`,transition:"background 0.15s, border-color 0.15s"}}/>
          ))}
        </div>

        {syncing && <div style={{color:"var(--c-t4)",fontSize:12,marginBottom:14}}>Syncing…</div>}
        {lockedUntil
          ? <div style={{color:"#EF4444",fontSize:13,marginBottom:14,fontWeight:700}}>Keypad locked — {countdown}s remaining</div>
          : error && <div style={{color:"#EF4444",fontSize:12,marginBottom:14,fontWeight:600}}>{error}</div>}

        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,maxWidth:260,margin:"0 auto",opacity:(syncing||lockedUntil)?0.35:1,pointerEvents:(syncing||lockedUntil)?"none":"auto"}}>
          {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((d,i)=>(
            <button key={i} onClick={()=>{ if(d==="⌫"){setPin(p=>p.slice(0,-1));setError("");} else if(d!=="") handlePin(String(d)); }}
              disabled={d===""||syncing}
              style={{background:d===""?"transparent":"var(--c-panel)",border:d===""?"none":"1px solid var(--c-border)",borderRadius:12,padding:"18px 0",fontSize:20,fontWeight:700,color:d==="⌫"?"#EF4444":"var(--c-t1)",cursor:d===""?"default":"pointer",opacity:d===""?0:1,transition:"opacity 0.15s"}}>
              {d}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Newest-first mini-feed for a project's notes — used in both ProjectForm (staged until
// Save) and the Quick View modal (persists immediately, like a chat message). Supports
// @mention tagging, mirroring the Notice Board's tag/read-receipt pattern.
function ProjectNotesPanel({ notes, currentUser, onAdd, onRemove, onMarkRead, onEdit, onSelfTag, onToggleDone }) {
  const { teamNames, memberColor } = useTeam();
  const [draft, setDraft] = useState("");
  const [tagged, setTagged] = useState([]);
  const [mention, setMention] = useState(null); // {start, query}
  const inputRef = useRef(null);
  const notesListRef = useRef(null);
  const [pendingDelete, setPendingDelete] = useState(null); // {id, note, timer}
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editText, setEditText] = useState("");

  const handleRemoveNote = (id) => {
    const note = notes.find(n => n.id === id);
    if (!note) return;
    const timer = setTimeout(() => { onRemove(id); setPendingDelete(null); }, 7000);
    setPendingDelete({ id, note, timer });
    // Optimistically hide by marking as pending; actual onRemove fires after timeout
  };
  const undoRemoveNote = () => {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    setPendingDelete(null);
  };
  // Clean up timer if component unmounts while pending
  useEffect(() => () => { if (pendingDelete) clearTimeout(pendingDelete.timer); }, [pendingDelete]);

  const mentionMatches = mention ? teamNames.filter(n => n.toUpperCase().startsWith(mention.query.toUpperCase())) : [];
  const onTextChange = e => {
    const val = e.target.value, pos = e.target.selectionStart;
    setDraft(val);
    const m = val.slice(0, pos).match(/@([A-Za-z0-9_]*)$/);
    setMention(m ? { start: pos - m[0].length, query: m[1] } : null);
  };
  const pickMention = name => {
    const before = draft.slice(0, mention.start);
    const after = draft.slice(mention.start + mention.query.length + 1);
    setDraft(`${before}@${name} ${after}`);
    setTagged(t => t.includes(name) ? t : [...t, name]);
    setMention(null);
    inputRef.current?.focus();
  };
  const sortedNotes = [...notes].sort((a,b)=>(b.ts||"").localeCompare(a.ts||"")).filter(n => !pendingDelete || n.id !== pendingDelete.id);

  const send = () => {
    if (!draft.trim()) return;
    // Capture any @NAME typed manually without selecting from the dropdown
    const textMentions = teamNames.filter(name => new RegExp(`@${name}(?:[^A-Za-z0-9_]|$)`, "i").test(draft));
    const allTagged = [...new Set([...tagged, ...textMentions])];
    onAdd(draft.trim(), allTagged);
    setDraft(""); setTagged([]); setMention(null);
    setTimeout(() => { if (notesListRef.current) notesListRef.current.scrollTop = 0; }, 50);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:6}}>
      {sortedNotes.length>0 && (
        <div ref={notesListRef} style={{display:"flex",flexDirection:"column",gap:6,width:"100%",maxHeight:"240px",overflowY:"auto",overflowX:"hidden"}}>
          {sortedNotes.map(n => {
            const iAmTagged = n.tagged.includes(currentUser);
            const iHaveRead = n.readBy.includes(currentUser);
            const isEditing = editingNoteId===n.id && onEdit;
            return (
              <div key={n.id}>
                {/* Edit box appears as a separate row ABOVE the note */}
                {isEditing && (
                  <div style={{display:"flex",gap:6,marginBottom:4}}>
                    <textarea autoFocus spellCheck value={editText} onChange={e=>setEditText(e.target.value)}
                      onKeyDown={e=>{
                        if(e.key==="Enter"&&!e.shiftKey){
                          e.preventDefault(); e.stopPropagation();
                          if(editText.trim()) onEdit(n.id,editText.trim()); else handleRemoveNote(n.id);
                          setEditingNoteId(null);
                        }
                        if(e.key==="Escape") setEditingNoteId(null);
                      }}
                      onBlur={()=>{
                        if(editText.trim()) onEdit(n.id,editText.trim()); else handleRemoveNote(n.id);
                        setEditingNoteId(null);
                      }}
                      style={{flex:1,background:"var(--c-panel)",border:"1px solid #F97316",borderRadius:6,padding:"6px 8px",color:"var(--c-t1)",fontSize:12,resize:"vertical",minHeight:52,fontFamily:"inherit"}}/>
                    <div style={{display:"flex",flexDirection:"column",gap:4}}>
                      <button onMouseDown={e=>{e.preventDefault();if(editText.trim())onEdit(n.id,editText.trim());else handleRemoveNote(n.id);setEditingNoteId(null);}}
                        style={{background:"#10B981",border:"none",borderRadius:5,padding:"4px 8px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11}}>✓</button>
                      <button onMouseDown={e=>{e.preventDefault();setEditingNoteId(null);}}
                        style={{background:"transparent",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 8px",color:"var(--c-t4)",cursor:"pointer",fontSize:11}}>✕</button>
                    </div>
                  </div>
                )}
                {/* Original note card */}
                <div style={{background:"var(--c-page)",border:`1px solid ${iAmTagged&&!iHaveRead?"#F9731666":isEditing?"#F9731633":n.done&&!n.tagged.length?"#10B98133":"var(--c-border2)"}`,borderRadius:6,padding:"7px 10px",opacity:isEditing?0.5:1,minWidth:0,width:"100%",boxSizing:"border-box"}}>
                  <div style={{display:"flex",justifyContent:"space-between",gap:8}}>
                    <div onClick={()=>{if(onEdit&&!isEditing){setEditingNoteId(n.id);setEditText(n.text);}}} title={onEdit&&!isEditing?"Click to edit":""}
                      style={{flex:1,minWidth:0,fontSize:12,color:n.done&&!n.tagged.length?"var(--c-t5)":"var(--c-t2)",lineHeight:1.4,whiteSpace:"pre-wrap",wordBreak:"break-word",overflowWrap:"break-word",cursor:onEdit&&!isEditing?"text":"default",maxHeight:"calc(1.4em * 5)",overflowY:"auto",textDecoration:n.done&&!n.tagged.length?"line-through":"none"}}>{n.text}</div>
                    <button onClick={()=>handleRemoveNote(n.id)} type="button" style={{background:"none",border:"none",color:"var(--c-t5)",cursor:"pointer",fontSize:12,flexShrink:0,alignSelf:"flex-start"}}>×</button>
                  </div>
                  {(n.author||n.ts) && <div style={{fontSize:9,fontWeight:700,color:n.author?memberColor[n.author]||"#475569":"#475569",marginTop:3}}>{n.author}{n.author&&n.ts?" · ":""}<span style={{color:"var(--c-t5)",fontWeight:400}}>{fmtTs(n.ts)}</span></div>}
                  {n.tagged.length>0 && (
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:5}}>
                      {n.tagged.map(t => {
                        const read = n.readBy.includes(t);
                        const tc = memberColor[t]||"#64748B";
                        return <span key={t} title={read?`${t} has read this`:`${t} hasn't read this yet`} style={{fontSize:9,fontWeight:700,color:read?tc:"#475569",background:read?`${tc}1A`:"var(--c-panel)",border:`1px solid ${read?tc+"44":"var(--c-border)"}`,borderRadius:4,padding:"1px 6px"}}>{read?"✓ ":""}{t}</span>;
                      })}
                    </div>
                  )}
                  <div style={{marginTop:5,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    {onToggleDone && (
                      <>
                        <div onClick={()=>onToggleDone(n.id)} title={n.done?"Mark as not done":"Mark as done"}
                          style={{width:14,height:14,borderRadius:3,border:`1.5px solid ${n.done?"#10B981":"#475569"}`,background:n.done?"#10B981":"transparent",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                          {n.done && <span style={{color:"#fff",fontSize:9,lineHeight:1}}>✓</span>}
                        </div>
                        <span onClick={()=>onToggleDone(n.id)} style={{fontSize:10,cursor:"pointer",color:n.done?"#10B981":"var(--c-t5)",fontWeight:n.done?700:400}}>
                          {n.done?"Done":"Mark done"}
                        </span>
                      </>
                    )}
                    {!iAmTagged && onSelfTag && (
                      <button type="button" onClick={()=>onSelfTag(n.id)}
                        style={{marginLeft:"auto",background:"transparent",border:"1px solid var(--c-border)",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,color:"var(--c-t4)",fontWeight:600,lineHeight:1.4}}>
                        👤 Tag me
                      </button>
                    )}
                  </div>
                  {iAmTagged && (()=>{
                    const isScheduled = (n.scheduledBy||[]).includes(currentUser);
                    const isCompleted = (n.scheduleCompletedBy||[]).includes(currentUser);
                    if (iHaveRead && isScheduled && isCompleted) return <div style={{marginTop:4,display:"flex",alignItems:"center",gap:4}}><span style={{fontSize:10,color:"#10B981",fontWeight:700,background:"#10B98115",border:"1px solid #10B98133",borderRadius:4,padding:"2px 7px"}}>📅 Scheduled & Completed</span></div>;
                    if (iHaveRead && isScheduled) return <div style={{marginTop:4,display:"flex",alignItems:"center",gap:4}}><span style={{fontSize:10,color:"#10B981",fontWeight:700,background:"#10B98115",border:"1px solid #10B98133",borderRadius:4,padding:"2px 7px"}}>📅 Scheduled</span></div>;
                    if (iHaveRead && !isScheduled) return <div style={{marginTop:4}}><span style={{fontSize:10,color:"#64748B",fontWeight:600,background:"#47556910",border:"1px solid #47556930",borderRadius:4,padding:"2px 7px"}}>✕ Unscheduled</span></div>;
                    return <div style={{marginTop:4,display:"flex",alignItems:"center",gap:5}}><span style={{width:6,height:6,borderRadius:"50%",background:"#F97316",flexShrink:0,animation:"asd-tag-pulse 1.6s ease-in-out infinite",display:"inline-block"}}/><span style={{fontSize:10,color:"#F97316",fontWeight:600}}>Awaiting scheduling</span></div>;
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {pendingDelete && (
        <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--c-panel)",border:"1px solid #F9731666",borderRadius:6,padding:"7px 10px"}}>
          <span style={{flex:1,fontSize:11,color:"var(--c-t3)"}}>Note deleted</span>
          <button onClick={undoRemoveNote} style={{background:"#F9731620",border:"1px solid #F97316",borderRadius:5,padding:"3px 10px",color:"#F97316",fontWeight:700,cursor:"pointer",fontSize:11}}>↩ Undo</button>
        </div>
      )}
      <div style={{position:"relative"}}>
        {mention && mentionMatches.length>0 && (
          <div style={{position:"absolute",bottom:"100%",left:0,right:0,marginBottom:4,background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:6,overflow:"hidden",zIndex:10}}>
            {mentionMatches.map(name => (
              <div key={name} onMouseDown={e=>{e.preventDefault();e.stopPropagation();pickMention(name);}} style={{padding:"7px 10px",fontSize:12,color:memberColor[name]||"#94A3B8",cursor:"pointer",fontWeight:700}}>@{name}</div>
            ))}
          </div>
        )}
        <div style={{display:"flex",gap:6}}>
          <input ref={inputRef} value={draft} onChange={onTextChange}
            onKeyDown={e=>{
              if(e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); if(mention && mentionMatches.length>0) pickMention(mentionMatches[0]); else send(); }
              else if(e.key==="Escape" && mention){ setMention(null); }
            }}
            placeholder="Add a note… (type @ to tag)" style={{...IS,flex:1}}/>
          <button onClick={send} disabled={!draft.trim()} type="button" style={{background:draft.trim()?"#F97316":"#334155",border:"none",borderRadius:6,padding:"0 14px",color:"#fff",fontWeight:800,cursor:draft.trim()?"pointer":"not-allowed",fontSize:13}}>+ Add</button>
        </div>
      </div>
    </div>
  );
}

function ProjectForm({ initial, currentUser, onSave, onClose, masterTemplate, existingProjects }) {
  const { teamNames: TEAM, clients } = useTeam();
  // If an existing project's client isn't in the curated list anymore (e.g. removed
  // by the admin since), keep showing it so the form doesn't silently lose the value.
  const blank = {
    jobCode: "", name: "", client: "", type: "Residential", status: "PENDING",
    priority: "Medium", phase: "MODELLING STAGE", assigned: [], due: "", pct: 0,
    notes: [], completedDate: "", checklist: makeChecklist(masterTemplate), siteMeasureRequired: "TBC",
  };
  const startVal = initial ? { ...blank, ...initial, jobCode: initial.jobCode || "", notes: noteList(initial.notes) } : blank;
  const [f, setF] = useState(startVal);
  const [addrCopied, setAddrCopied] = useState(false);
  const s = (k, v) => setF(p => ({ ...p, [k]: v }));
  const tog = m => s("assigned", f.assigned.includes(m) ? f.assigned.filter(x => x !== m) : [...f.assigned, m]);
  const copyAddress = () => { if (!f.name.trim()) return; navigator.clipboard.writeText(f.name.trim()).then(() => { setAddrCopied(true); setTimeout(() => setAddrCopied(false), 1800); }); };
  const canSave = !!f.jobCode.trim() && !!f.name.trim();
  const save = () => canSave && onSave(f);
  const clientOptions = f.client && !clients.includes(f.client) ? [f.client, ...clients] : clients;

  // Duplicate detection — exclude the project currently being edited
  const editingId = initial?.id;
  const others = (existingProjects || []).filter(p => p.id !== editingId);
  const normAddr = str => (str || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const codeVal = f.jobCode.trim().toUpperCase();
  const codeMatch = codeVal.length >= 2 ? others.find(p => (p.jobCode || "").toUpperCase() === codeVal) : null;
  const addrNorm = normAddr(f.name);
  const addrMatch = addrNorm.length > 4 ? others.find(p => { const pn = normAddr(p.name); return pn.length > 4 && (pn === addrNorm || pn.includes(addrNorm) || addrNorm.includes(pn)); }) : null;

  return (
    <div onKeyDown={e=>{ if (e.key==="Enter" && !["TEXTAREA","BUTTON","INPUT"].includes(e.target.tagName)) { e.preventDefault(); save(); } }}>
      <div style={{background:"linear-gradient(135deg,#F9731620 0%,#F9731610 100%)",border:"2px solid #F97316",borderRadius:10,padding:"16px 18px",marginBottom:18,boxShadow:"0 0 20px rgba(249,115,22,0.15)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <span style={{fontSize:16}}>🏷</span>
          <span style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.1em",textTransform:"uppercase"}}>Job Code (Required — Primary Identifier)</span>
        </div>
        <input type="text" value={f.jobCode} onChange={e=>s("jobCode",e.target.value.toUpperCase())} placeholder="e.g. USS-009 / DF-006 / GS-003" autoFocus
          style={{width:"100%",background:"var(--c-page)",border:`1px solid ${codeMatch?"#F59E0B44":"#F9731644"}`,borderRadius:7,padding:"10px 14px",color:"#F97316",fontSize:18,fontWeight:900,fontFamily:"monospace",letterSpacing:"0.1em",textTransform:"uppercase",outline:"none",boxSizing:"border-box"}}/>
        {codeMatch && (
          <div style={{marginTop:7,background:"#F59E0B18",border:"1px solid #F59E0B66",borderRadius:6,padding:"7px 10px",display:"flex",alignItems:"flex-start",gap:7}}>
            <span style={{fontSize:14,flexShrink:0}}>⚠️</span>
            <div>
              <div style={{fontSize:11,fontWeight:800,color:"#F59E0B"}}>Job code already exists</div>
              <div style={{fontSize:11,color:"var(--c-t3)",marginTop:1}}>{codeMatch.jobCode}: {codeMatch.name}{codeMatch.client?` · ${codeMatch.client}`:""}</div>
            </div>
          </div>
        )}
        <div style={{marginTop:10}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
            <label style={{color:"var(--c-t3)",fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase"}}>Project Address</label>
            {f.name.trim() && <button onClick={copyAddress} style={{background:"none",border:"none",cursor:"pointer",fontSize:10,fontWeight:700,color:addrCopied?"#10B981":"#64748B",padding:"0 2px",transition:"color 0.2s"}}>{addrCopied?"✓ Copied":"⎘ Copy"}</button>}
          </div>
          <AddressAutocomplete value={f.name} onChange={e=>s("name",e.target.value)} placeholder="e.g. 55 Molesworth St, Kew" style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          {addrMatch && (
            <div style={{marginTop:7,background:"#F59E0B18",border:"1px solid #F59E0B66",borderRadius:6,padding:"7px 10px",display:"flex",alignItems:"flex-start",gap:7}}>
              <span style={{fontSize:14,flexShrink:0}}>⚠️</span>
              <div>
                <div style={{fontSize:11,fontWeight:800,color:"#F59E0B"}}>Similar address already in system</div>
                <div style={{fontSize:11,color:"var(--c-t3)",marginTop:1}}>{addrMatch.jobCode}: {addrMatch.name}{addrMatch.client?` · ${addrMatch.client}`:""}</div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Field label="Client"><select style={IS} value={f.client} onChange={e=>s("client",e.target.value)}><option value="">Select client…</option>{clientOptions.map(c=><option key={c}>{c}</option>)}</select></Field>
        <Field label="Type"><select style={IS} value={f.type} onChange={e=>s("type",e.target.value)}>{PROJECT_TYPES.map(x=><option key={x}>{x}</option>)}</select></Field>
        <Field label="Status"><select style={IS} value={f.status} onChange={e=>s("status",e.target.value)}>{SELECTABLE_PROJECT_STATUS.map(x=><option key={x}>{x}</option>)}</select></Field>
        <Field label="Priority"><select style={IS} value={f.priority} onChange={e=>s("priority",e.target.value)}>{PRIORITY.map(x=><option key={x}>{x}</option>)}</select></Field>
        <Field label="Due Date"><input type="date" style={IS} value={f.due} onChange={e=>s("due",e.target.value)}/></Field>
        <Field label="Site Measure Required"><select style={IS} value={f.siteMeasureRequired||"No"} onChange={e=>s("siteMeasureRequired",e.target.value)}><option>No</option><option>Yes</option><option>TBC</option></select></Field>
        {f.status==="Completed"&&<Field label="Completed Date"><input type="date" style={IS} value={f.completedDate||""} onChange={e=>s("completedDate",e.target.value)}/></Field>}
      </div>
      <Field label="Assigned To">
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {TEAM.map(m=>(
            <button key={m} onClick={()=>tog(m)} style={{padding:"4px 12px",borderRadius:20,border:"1px solid",borderColor:f.assigned.includes(m)?"#F97316":"#334155",background:f.assigned.includes(m)?"#F9731620":"transparent",color:f.assigned.includes(m)?"#F97316":"#64748B",cursor:"pointer",fontSize:12,fontWeight:700}}>{m}</button>
          ))}
        </div>
      </Field>
      <Field label="Notes">
        <ProjectNotesPanel notes={f.notes} currentUser={currentUser}
          onAdd={(text,tagged)=>s("notes",[{ id:mkId(), text, author:currentUser, ts:nowTs(), tagged:tagged||[], readBy:[] }, ...f.notes])}
          onRemove={id=>s("notes", f.notes.filter(n=>n.id!==id))}
          onMarkRead={id=>s("notes", f.notes.map(n=>n.id===id && !n.readBy.includes(currentUser) ? {...n, readBy:[...n.readBy,currentUser]} : n))}/>
      </Field>
      <div style={{display:"flex",gap:10,marginTop:6}}>
        <button onClick={save} disabled={!canSave} style={{flex:1,background:canSave?"#F97316":"#334155",border:"none",borderRadius:6,padding:"10px 0",color:"#fff",fontWeight:800,cursor:canSave?"pointer":"not-allowed",fontSize:13}}>
          {canSave?"Save Project":"Enter Job Code to save"}
        </button>
        <button onClick={onClose} style={{padding:"10px 16px",background:"transparent",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:13}}>Cancel</button>
      </div>
    </div>
  );
}

function TaskForm({ initial, projects, onSave, onClose }) {
  const { teamNames: TEAM } = useTeam();
  const blank = { title:"", projectId:projects[0]?.id||"", assigned:TEAM[0], due:"", status:"Not Started", priority:"Medium", notes:"" };
  const [f, setF] = useState(initial||blank);
  const s = (k,v) => setF(p=>({...p,[k]:v}));
  const canSaveTask = !!f.title.trim();
  const save = () => canSaveTask && onSave(f);
  return (
    <div onKeyDown={e=>{ if (e.key==="Enter" && !["TEXTAREA","BUTTON","INPUT"].includes(e.target.tagName)) { e.preventDefault(); save(); } }}>
      <Field label="Task"><input style={IS} value={f.title} onChange={e=>s("title",e.target.value)} placeholder="Task title (required)"/></Field>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Field label="Project"><select style={IS} value={f.projectId} onChange={e=>s("projectId",e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.jobCode||p.name}</option>)}</select></Field>
        <Field label="Assigned"><select style={IS} value={f.assigned} onChange={e=>s("assigned",e.target.value)}>{TEAM.map(m=><option key={m}>{m}</option>)}</select></Field>
        <Field label="Status"><select style={IS} value={f.status} onChange={e=>s("status",e.target.value)}>{Object.keys(TASK_STATUS).map(x=><option key={x}>{x}</option>)}</select></Field>
        <Field label="Priority"><select style={IS} value={f.priority} onChange={e=>s("priority",e.target.value)}>{PRIORITY.map(x=><option key={x}>{x}</option>)}</select></Field>
        <Field label="Due Date"><input type="date" style={IS} value={f.due} onChange={e=>s("due",e.target.value)}/></Field>
      </div>
      <Field label="Notes"><textarea spellCheck style={{...IS,minHeight:55,resize:"vertical"}} value={f.notes} onChange={e=>s("notes",e.target.value)}/></Field>
      <div style={{display:"flex",gap:10,marginTop:6}}>
        <button onClick={save} disabled={!canSaveTask} style={{flex:1,background:canSaveTask?"#3B82F6":"var(--c-border)",border:"none",borderRadius:6,padding:"9px 0",color:"#fff",fontWeight:800,cursor:canSaveTask?"pointer":"not-allowed",fontSize:13,opacity:canSaveTask?1:0.5}}>Save Task</button>
        <button onClick={onClose} style={{padding:"9px 16px",background:"transparent",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:13}}>Cancel</button>
      </div>
    </div>
  );
}

function ChecklistMini({ checklist, type, onClick }) {
  const rel=relevantCL(checklist, type);
  const pct=clPct(rel), done=rel.filter(c=>c.done).length, tot=rel.length;
  const flagged = rel.filter(c=>c.flag).length;
  const c=pct===100?"#10B981":pct>=60?"#3B82F6":"#F59E0B";
  return (
    <button onClick={e=>{e.stopPropagation();e.preventDefault();onClick();}}
      style={{display:"block",width:"100%",cursor:"pointer",marginTop:10,padding:"8px 10px",background:"var(--c-page)",borderRadius:6,border:`1px solid ${flagged>0?"#F59E0B66":"var(--c-border2)"}`,textAlign:"left"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
        <span style={{fontSize:11,color:"var(--c-t4)",fontWeight:700}}>CHECKLIST</span>
        <span style={{fontSize:11,fontWeight:800,color:c}}>{done}/{tot} · {pct}%</span>
      </div>
      <ProgressBar pct={pct} color={c}/>
      {flagged>0 && (
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:7,paddingTop:6,borderTop:"1px dashed #F59E0B33"}}>
          <span style={{fontSize:11,fontWeight:800,color:"#F59E0B"}}>🚩 {flagged} flagged for review</span>
        </div>
      )}
    </button>
  );
}

function InlinePicker({ open, onToggle, onClose, label, children, minWidth }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);
  return (
    <div ref={ref} style={{position:"relative"}}>
      <button
        onClick={e=>{e.stopPropagation();e.preventDefault();onToggle();}}
        style={{background:"transparent",border:"none",padding:0,cursor:"pointer",display:"flex",alignItems:"center",gap:3}}
      >
        {label}
        <span style={{fontSize:8,color:"var(--c-t5)",lineHeight:1,marginLeft:1,opacity:0.7}}>{open?"▲":"▼"}</span>
        <span style={{fontSize:9,color:"var(--c-t5)",opacity:0.8}}>▾</span>
      </button>
      {open && (
        <div onClick={e=>e.stopPropagation()}
          style={{position:"absolute",top:"calc(100% + 5px)",left:0,zIndex:500,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:4,minWidth:minWidth||120,boxShadow:"0 8px 24px rgba(0,0,0,0.6)"}}>
          {children}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project, tasks, currentUser, onClick, onEdit, onDelete, onComplete, onCopy, onChecklist, onStatusChange, onFieldChange, onAddNote, onRemoveNote, onMarkNoteRead, onEditNote, onSelfTagNote, onToggleNoteDone }) {
  const { teamNames, memberColor } = useTeam();
  const isMob = useWindowWidth() < 768;
  const pt=tasks.filter(t=>t.projectId===project.id), done=pt.filter(t=>t.status==="Completed").length, dl=daysLeft(project.due), cl=project.checklist||[], pn=noteList(project.notes);
  const myUnreadTagged = pn.filter(n=>n.tagged.includes(currentUser) && !n.readBy.includes(currentUser));
  const [openPicker, setOpenPicker] = useState(null); // "status" | "priority" | "phase" | "assign" | null
  const toggle = key => setOpenPicker(p => p===key ? null : key);
  const handleCardClick = e => { if (e.target.closest("button")) return; onClick(); };
  const cfg = PROJECT_STATUS[project.status] || { color:"#6B7280", bg:"#6B728020" };
  const priClr = PRIORITY_CLR[project.priority] || "#6B7280";

  return (
    <div style={{background:"var(--c-panel)",border:`1px solid ${myUnreadTagged.length>0?"#F97316":"#334155"}`,boxShadow:myUnreadTagged.length>0?"0 0 0 2px #F9731633":"none",borderRadius:10,padding:18}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
            <span style={{fontSize:12,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731666",borderRadius:4,padding:"2px 7px",letterSpacing:"0.05em"}}>{project.jobCode||"NO-CODE"}</span>
            <span style={{color:"var(--c-t5)",fontSize:10}}>{project.client}</span>
          </div>
          <div onClick={onClick} style={{color:"var(--c-t1)",fontWeight:600,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.3,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#334155",textUnderlineOffset:2}}>{project.name}</div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:1}}>
            <span style={{color:"var(--c-t4)",fontSize:10}}>{project.type}</span>
            {project.siteMeasureRequired==="Yes" && <span title="Site measure required" style={{color:"#10B981",fontSize:12,fontWeight:700,background:"#10B98120",border:"1px solid #10B98144",borderRadius:3,padding:"1px 5px"}}>📐 Site Measure</span>}
            {project.siteMeasureRequired==="TBC" && <span title="Site measure in question — to be confirmed" style={{color:"#EF4444",fontSize:12,fontWeight:700,background:"#EF444420",border:"1px solid #EF444444",borderRadius:3,padding:"1px 5px"}}>📐? Site Measure: TBC</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:isMob?2:4,marginLeft:8}}>
          <button onClick={e=>{e.stopPropagation();e.preventDefault();onComplete();}} title="Mark complete" style={{background:"none",border:"none",color:"#10B981",cursor:"pointer",fontSize:14,padding:isMob?4:2}}>✓</button>
          <button onClick={e=>{e.stopPropagation();e.preventDefault();onEdit();}} title="Edit" style={{background:"#F9731620",border:"1px solid #F9731644",color:"#F97316",cursor:"pointer",fontSize:12,padding:isMob?"4px 7px":"2px 6px",borderRadius:4,fontWeight:700}}>{isMob?"✎":"✎ Edit"}</button>
          {!isMob&&<button onClick={e=>{e.stopPropagation();e.preventDefault();onCopy&&onCopy();}} title="Copy project" style={{background:"#3B82F620",border:"1px solid #3B82F644",color:"#3B82F6",cursor:"pointer",fontSize:12,padding:"2px 6px",borderRadius:4,fontWeight:700}}>⎘ Copy</button>}
          <button onClick={e=>{e.stopPropagation();e.preventDefault();onDelete();}} title="Delete" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14,padding:isMob?4:2}}>🗑</button>
        </div>
      </div>

      {/* ── Three inline pickers row ── */}
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>

        {/* STATUS */}
        <InlinePicker open={openPicker==="status"} onToggle={()=>toggle("status")} onClose={()=>setOpenPicker(null)} minWidth={130}
          label={<span style={{background:cfg.bg,color:cfg.color,border:`1px solid ${cfg.color}33`,borderRadius:4,padding:"2px 8px",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{project.status}</span>}>
          {SELECTABLE_PROJECT_STATUS.map(s => {
            const sc=PROJECT_STATUS[s]; const active=s===project.status;
            return <button key={s} onClick={e=>{e.stopPropagation();e.preventDefault();onStatusChange(project.id,s);setOpenPicker(null);}}
              style={{display:"block",width:"100%",textAlign:"left",padding:"6px 10px",borderRadius:5,border:"none",background:active?`${sc.color}22`:"transparent",color:active?sc.color:"var(--c-t2)",fontSize:12,fontWeight:active?800:500,cursor:"pointer",marginBottom:1}}>
              {active&&<span style={{marginRight:5}}>✓</span>}{s}
            </button>;
          })}
        </InlinePicker>

        {/* PRIORITY */}
        <InlinePicker open={openPicker==="priority"} onToggle={()=>toggle("priority")} onClose={()=>setOpenPicker(null)} minWidth={110}
          label={<span style={{color:priClr,fontSize:11,fontWeight:700}}>▲ {project.priority.toUpperCase()}</span>}>
          {PRIORITY.map(pri => {
            const pc=PRIORITY_CLR[pri]; const active=pri===project.priority;
            return <button key={pri} onClick={e=>{e.stopPropagation();e.preventDefault();onFieldChange(project.id,"priority",pri);setOpenPicker(null);}}
              style={{display:"block",width:"100%",textAlign:"left",padding:"6px 10px",borderRadius:5,border:"none",background:active?`${pc}22`:"transparent",color:active?pc:"#CBD5E1",fontSize:12,fontWeight:active?800:500,cursor:"pointer",marginBottom:1}}>
              {active&&<span style={{marginRight:5}}>✓</span>}▲ {pri}
            </button>;
          })}
        </InlinePicker>


      </div>

      {cl.length>0 && <ChecklistMini checklist={cl} type={project.type} onClick={onChecklist}/>}
      <div style={{marginTop:8,borderTop:"1px solid var(--c-border2)",paddingTop:8}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:9,fontWeight:800,color:myUnreadTagged.length>0?"#F97316":"#475569",textTransform:"uppercase",marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
          Notes{pn.length>0?` (${pn.length})`:""}
          {myUnreadTagged.length>0&&<span style={{background:"#F97316",color:"#0F172A",fontSize:8,fontWeight:800,borderRadius:8,padding:"1px 6px"}}>🔔 tagged</span>}
        </div>
        <ProjectNotesPanel notes={pn} currentUser={currentUser}
          onAdd={(text,tagged)=>onAddNote&&onAddNote(project.id,text,tagged)}
          onRemove={id=>onRemoveNote&&onRemoveNote(project.id,id)}
          onMarkRead={id=>onMarkNoteRead&&onMarkNoteRead(project.id,id,currentUser)}
          onEdit={(id,text)=>onEditNote&&onEditNote(project.id,id,text)}
          onSelfTag={onSelfTagNote}
          onToggleDone={onToggleNoteDone}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:10}}>
        <InlinePicker open={openPicker==="assign"} onToggle={()=>toggle("assign")} onClose={()=>setOpenPicker(null)} minWidth={140}
          label={
            <div style={{display:"flex",alignItems:"center",gap:3,cursor:"pointer"}}>
              {project.assigned.length===0
                ? <span style={{color:"var(--c-t5)",fontSize:11,fontWeight:600}}>+ Assign</span>
                : project.assigned.map(m=><Avatar key={m} name={m}/>)}
            </div>
          }>
          {teamNames.map(m => {
            const isOn = project.assigned.includes(m);
            const mc = memberColor[m]||"#64748B";
            return <button key={m} onClick={e=>{e.stopPropagation();e.preventDefault();
              onFieldChange(project.id,"assigned",isOn?project.assigned.filter(x=>x!==m):[...project.assigned,m]);
            }} style={{display:"flex",alignItems:"center",gap:8,width:"100%",textAlign:"left",padding:"6px 10px",borderRadius:5,border:"none",background:isOn?`${mc}22`:"transparent",color:isOn?mc:"#CBD5E1",fontSize:12,fontWeight:isOn?800:500,cursor:"pointer",marginBottom:1}}>
              <div style={{width:16,height:16,borderRadius:"50%",background:isOn?mc:"transparent",border:`2px solid ${isOn?mc:"#475569"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:900,color:"#0F172A",flexShrink:0}}>{isOn?"✓":""}</div>
              {m}
            </button>;
          })}
        </InlinePicker>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          {pt.length>0&&<span style={{color:"var(--c-t4)",fontSize:11}}>{done}/{pt.length} tasks</span>}
          <InlinePicker open={openPicker==="due"} onToggle={()=>toggle("due")} onClose={()=>setOpenPicker(null)} minWidth={170}
            label={<span style={{fontSize:11,fontWeight:700,color:dl!==null&&dl<0?"#EF4444":dl!==null&&dl<=7?"#F59E0B":project.due?"#64748B":"#334155"}}>
              {project.due?(dl<0?`${Math.abs(dl)}d overdue`:dl===0?"Due today":`${dl}d left`):"+ Due date"}
            </span>}>
            <div style={{padding:"8px 10px"}}>
              <input type="date" value={project.due||""} autoFocus
                onChange={e=>{onFieldChange(project.id,"due",e.target.value);setOpenPicker(null);}}
                style={{...IS,fontSize:12,width:"100%",marginBottom:6}}/>
              {project.due&&<button onMouseDown={e=>{e.preventDefault();onFieldChange(project.id,"due","");setOpenPicker(null);}} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:11,width:"100%",textAlign:"left",padding:"2px 0"}}>✕ Clear date</button>}
            </div>
          </InlinePicker>
        </div>
      </div>
    </div>
  );
}

function ChecklistTab({ projects, currentUser, onUpdateChecklist, onFieldChange, initialId, masterTemplate, setMasterTemplate, onSyncProject, onReorderMaster, projectsWithUpdates, deletedMasterItems, setDeletedMasterItems, onToggleNoteDone, onSelfTagClNote, onUpdateClNoteTags }) {
  const { memberColor: MEMBER_COLOR, teamNames: TEAM_NAMES, isAdmin } = useTeam();
  const canDelete = isAdmin(currentUser) || currentUser === "LESLIE";
  const [editMode, setEditMode] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [clSortBy, setClSortBy] = useState("jobCode"); // "jobCode" | "priority" — must be before sortCLProjects
  const initialProject = initialId ? projects.find(p=>p.id===initialId) : null;
  const initialIsCompleted = initialProject?.status === "Completed";
  const activeProjects = projects.filter(p => p.status !== "Completed" && p.status !== "ON HOLD");
  const completedProjects = projects.filter(p => p.status === "Completed");
  const sortCLProjects = arr => clSortBy === "priority"
    ? [...arr].sort((a,b) => { const ra = (PRIORITY_RANK[a.priority]??9), rb = (PRIORITY_RANK[b.priority]??9); return ra!==rb?ra-rb:(a.jobCode||"").localeCompare(b.jobCode||"",undefined,{numeric:true,sensitivity:"base"}); })
    : [...arr].sort((a,b) => (a.jobCode||"").localeCompare(b.jobCode||"",undefined,{numeric:true,sensitivity:"base"}));
  const visibleProjects = sortCLProjects((showCompleted || initialIsCompleted) ? [...activeProjects, ...completedProjects] : activeProjects);

  const clSelKey = `asd_cl_sel_${currentUser}`;
  const [selId, setSelId_] = useState(() => { try { return initialId || localStorage.getItem(clSelKey) || activeProjects[0]?.id || null; } catch { return initialId || activeProjects[0]?.id || null; } });
  const setSelId = id => { setSelId_(id); try { if (id) localStorage.setItem(clSelKey, id); } catch {} };
  const [clFilter, setClFilter] = useState("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newSection, setNewSection] = useState("Modelling");
  const [screenshotItemId, setScreenshotItemId] = useState(null);
  const [addingSubId, setAddingSubId] = useState(null);
  const [subDraft, setSubDraft] = useState("");
  const [editSubKey, setEditSubKey] = useState(null); // {itemId, subId}
  const [editSubText, setEditSubText] = useState("");
  const [commentItemId, setCommentItemId] = useState(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [clNoteDraft, setClNoteDraft] = useState("");
  const [clNoteEditId, setClNoteEditId] = useState(null);
  const [clNoteEditText, setClNoteEditText] = useState("");
  const [clNoteMention, setClNoteMention] = useState(null); // {start, query}
  const [clNoteTagged, setClNoteTagged] = useState([]);
  const [clNoteTagEditId, setClNoteTagEditId] = useState(null);
  const clNoteInputRef = useRef(null);
  const [copiedTrackerAddr, setCopiedTrackerAddr] = useState(null);
  const clScrollRef = useRef(null);
  const sectionRefs = useRef({});

  const scrollToSection = sec => {
    const el = sectionRefs.current[sec];
    const container = clScrollRef.current;
    if (!el || !container) return;
    const containerTop = container.getBoundingClientRect().top;
    const elTop = el.getBoundingClientRect().top;
    container.scrollTop += (elTop - containerTop);
  };

  const selProject = projects.find(p => p.id === selId) || null;
  const cl = selProject?.checklist || [];

  const toggle = id => {
    const next = cl.map(c => c.id===id ? {
      ...c, done:!c.done,
      history:[{ ts:nowTs(), member:currentUser, action:c.done?"unchecked":"checked" }]
    } : c);
    onUpdateChecklist(selId, next);
  };
  const delItem = id => onUpdateChecklist(selId, cl.filter(c=>c.id!==id));
  const addItem = () => {
    if (!newLabel.trim()) return;
    const newItem = { id:mkId(), section:newSection, label:newLabel.trim(), done:false, note:"", history:[{ ts:nowTs(), member:currentUser, action:"created" }], flag:null };
    onUpdateChecklist(selId, [...cl, newItem]);
    setNewLabel("");
  };
  const handleFlag = id => {
    const item = cl.find(c=>c.id===id);
    const next = cl.map(c => c.id===id ? (item.flag ? {
      ...c, flag:null, history:[{ ts:nowTs(), member:currentUser, action:"unflagged" }]
    } : {
      ...c, flag:{ member:currentUser, ts:nowTs(), reason:"" }, history:[{ ts:nowTs(), member:currentUser, action:"flagged" }]
    }) : c);
    onUpdateChecklist(selId, next);
  };
  const saveAttachments = (id, attachments, histEntries) => {
    const next = cl.map(c => c.id===id ? {
      ...c, attachments,
      history: histEntries.slice(-1)
    } : c);
    onUpdateChecklist(selId, next);
  };
  const addSubItem = (itemId, text) => {
    if (!text.trim()) return;
    onUpdateChecklist(selId, cl.map(c => c.id===itemId ? { ...c, subItems:[...(c.subItems||[]), {id:mkId(), text:text.trim()}] } : c));
    setSubDraft(""); setAddingSubId(itemId); // keep input open for more
  };
  const removeSubItem = (itemId, subId) => {
    onUpdateChecklist(selId, cl.map(c => c.id===itemId ? { ...c, subItems:(c.subItems||[]).filter(s=>s.id!==subId) } : c));
  };
  const toggleSubItem = (itemId, subId) => {
    onUpdateChecklist(selId, cl.map(c => c.id===itemId ? {
      ...c, subItems:(c.subItems||[]).map(s=>s.id===subId?{...s,done:!s.done}:s)
    } : c));
  };
  const saveSubEdit = (itemId, subId) => {
    if (!editSubText.trim()) { removeSubItem(itemId, subId); }
    else { onUpdateChecklist(selId, cl.map(c => c.id===itemId ? { ...c, subItems:(c.subItems||[]).map(s=>s.id===subId?{...s,text:editSubText.trim()}:s) } : c)); }
    setEditSubKey(null); setEditSubText("");
  };
  const addComment = (itemId, text) => {
    if (!text.trim()) return;
    const comment = { id:mkId(), text:text.trim(), author:currentUser, ts:nowTs() };
    onUpdateChecklist(selId, cl.map(c => c.id===itemId ? { ...c, comments:[...(c.comments||[]), comment] } : c));
    setCommentDraft("");
  };
  const removeComment = (itemId, commentId) => {
    onUpdateChecklist(selId, cl.map(c => c.id===itemId ? { ...c, comments:(c.comments||[]).filter(cm=>cm.id!==commentId) } : c));
  };

  const clNotes = selProject?.checklistNotes || [];
  const addClNote = () => {
    if (!clNoteDraft.trim()) return;
    const textMentions = TEAM_NAMES.filter(name => new RegExp(`@${name}(?:[^A-Za-z0-9_]|$)`, "i").test(clNoteDraft));
    const allTagged = [...new Set([...clNoteTagged, ...textMentions])];
    const note = { id:mkId(), text:clNoteDraft.trim(), author:currentUser, ts:nowTs(), tagged:allTagged, readBy:[] };
    onFieldChange(selId, "checklistNotes", [note, ...clNotes]);
    setClNoteDraft(""); setClNoteTagged([]); setClNoteMention(null);
  };
  const removeClNote = id => onFieldChange(selId, "checklistNotes", clNotes.filter(n=>n.id!==id));
  const saveClNoteEdit = id => {
    if (!clNoteEditText.trim()) { removeClNote(id); }
    else { onFieldChange(selId, "checklistNotes", clNotes.map(n => n.id===id ? {...n, text:clNoteEditText.trim(), editedAt:nowTs()} : n)); }
    setClNoteEditId(null); setClNoteEditText("");
  };

  const isTakeOffProject = selProject?.type === "Take-Off";
  const filteredCL = cl.filter(c => {
    // Take-Off items only shown for TAKE-OFF projects; all other items hidden for TAKE-OFF projects
    if (c.takeOffOnly && !isTakeOffProject) return false;
    if (!c.takeOffOnly && isTakeOffProject) return false;
    if (clFilter==="Done" && !c.done) return false;
    if (clFilter==="Pending" && c.done) return false;
    if (clFilter==="Flagged" && !c.flag) return false;
    if (searchTerm && !c.label.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  const relCL = relevantCL(cl, selProject?.type);
  const totalDone = relCL.filter(c=>c.done).length;
  const flaggedItems = relCL.filter(c=>c.flag);
  const flaggedCount = flaggedItems.length;
  const flaggedSnipshots = flaggedItems.reduce((s,c)=>s+(c.attachments||[]).length,0);
  const flaggedComments  = flaggedItems.reduce((s,c)=>s+(c.comments||[]).length,0);
  const pct = relCL.length===0 ? 0 : Math.round((totalDone/relCL.length)*100);
  const pc = pct===100?"#10B981":pct>=60?"#3B82F6":"#F59E0B";
  const mc = MEMBER_COLOR[currentUser];

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:12,color:"var(--c-t4)",fontWeight:600}}>
          {editMode ? "Editing master template" : "Per-project checklists"}
        </div>
        <button onClick={()=>setEditMode(m=>!m)} style={{background:editMode?"#10B98120":(projectsWithUpdates>0?"#F59E0B20":"var(--c-panel)"),border:`1px solid ${editMode?"#10B981":(projectsWithUpdates>0?"#F59E0B":"var(--c-border)")}`,color:editMode?"#10B981":(projectsWithUpdates>0?"#F59E0B":"var(--c-t3)"),borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:12,fontWeight:800,display:"flex",alignItems:"center",gap:6}}>
          {editMode ? "← Back" : "✎ Checklist Edit"}
          {!editMode && projectsWithUpdates>0 && <span style={{background:"#F59E0B",color:"#0F172A",borderRadius:8,padding:"1px 6px",fontSize:10,fontWeight:900}}>{projectsWithUpdates}</span>}
        </button>
      </div>

      {editMode ? (
        <MasterChecklistTab masterTemplate={masterTemplate} setMasterTemplate={setMasterTemplate} projects={projects} onSync={onSyncProject} onReorder={onReorderMaster} deletedMasterItems={deletedMasterItems} setDeletedMasterItems={setDeletedMasterItems}/>
      ) : (
        <>
        <div style={{display:"grid",gridTemplateColumns:"220px 1fr",gap:12,height:"calc(100vh - 120px)"}}>
          <div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,overflow:"hidden",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"12px 14px",borderBottom:"1px solid var(--c-border)"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <div style={{fontSize:11,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase"}}>Projects</div>
                <div style={{display:"flex",gap:2,background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:5,padding:2}}>
                  <button onClick={()=>setClSortBy("jobCode")} style={{padding:"3px 7px",borderRadius:3,border:"none",background:clSortBy==="jobCode"?"var(--c-panel)":"transparent",color:clSortBy==="jobCode"?"var(--c-t1)":"var(--c-t4)",fontWeight:clSortBy==="jobCode"?700:400,fontSize:9,cursor:"pointer",whiteSpace:"nowrap"}}>↕ Code</button>
                  <button onClick={()=>setClSortBy("priority")} style={{padding:"3px 7px",borderRadius:3,border:"none",background:clSortBy==="priority"?"#7C3AED":"transparent",color:clSortBy==="priority"?"#fff":"var(--c-t4)",fontWeight:clSortBy==="priority"?700:400,fontSize:9,cursor:"pointer",whiteSpace:"nowrap"}}>▲ Pri</button>
                </div>
              </div>
              <button onClick={()=>setShowCompleted(s=>!s)} style={{width:"100%",background:showCompleted||initialIsCompleted?"#10B98118":"transparent",border:`1px solid ${showCompleted||initialIsCompleted?"#10B98144":"#334155"}`,borderRadius:5,padding:"4px 8px",cursor:"pointer",fontSize:10,fontWeight:700,color:showCompleted||initialIsCompleted?"#10B981":"#64748B"}}>
                {showCompleted||initialIsCompleted?"✓ Showing all":"Show completed"} ({completedProjects.length})
              </button>
            </div>
            <div style={{overflowY:"auto",flex:1}}>
              {visibleProjects.flatMap((p, _ci, _ca) => {
                const pcl=relevantCL(p.checklist||[], p.type);
                const ppct=pcl.length===0?0:Math.round((pcl.filter(c=>c.done).length/pcl.length)*100);
                const pc2=ppct===100?"#10B981":ppct>=60?"#3B82F6":"#F59E0B";
                const sel=p.id===selId;
                const pFlags    = pcl.filter(c=>c.flag).length;
                const pSnips    = pcl.reduce((s,c)=>s+(c.attachments||[]).length,0);
                const pComments = pcl.reduce((s,c)=>s+(c.comments||[]).length,0);
                const isCompleted = p.status === "Completed";
                const priClr2 = PRIORITY_CLR[p.priority]||"#6B7280";
                const rows2 = [];
                if (clSortBy==="priority" && (_ci===0 || _ca[_ci-1].priority!==p.priority)) {
                  rows2.push(<div key={`clhdr-${p.priority}-${_ci}`} style={{padding:"5px 14px",background:`${priClr2}12`,borderBottom:`1px solid ${priClr2}33`,display:"flex",alignItems:"center",gap:6}}>
                    <span style={{color:priClr2,fontWeight:800,fontSize:10}}>▲ {(p.priority||"—").toUpperCase()}</span>
                  </div>);
                }
                rows2.push(
                  <div key={p.id} onClick={()=>setSelId(p.id)} style={{padding:"10px 14px",borderBottom:"1px solid var(--c-border2)",cursor:"pointer",background:sel?"#F9731618":"transparent",borderLeft:sel?"3px solid #F97316":isCompleted?"3px solid #10B98144":"3px solid transparent"}}>
                    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:3}}>
                      {isCompleted && <span style={{fontSize:8,color:"#10B981",fontWeight:800}}>✓</span>}
                      <span style={{fontSize:10,fontFamily:"monospace",fontWeight:900,color:sel?"#F97316":"#F97316CC",background:sel?"#F9731620":"#F9731610",borderRadius:3,padding:"1px 5px"}}>{p.jobCode||"—"}</span>
                      {clSortBy==="priority" && <span style={{fontSize:9,color:priClr2,fontWeight:700,marginLeft:"auto"}}>▲ {p.priority||"—"}</span>}
                    </div>
                    <div style={{fontSize:11,color:sel?"var(--c-t1)":"var(--c-t3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginBottom:4}}>{p.name}</div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <span style={{fontSize:10,color:"var(--c-t5)"}}>{p.client}</span>
                      <div style={{display:"flex",gap:4,alignItems:"center"}}>
                        {pFlags>0    && <span style={{fontSize:9,color:"#F59E0B",fontWeight:700,background:"#F59E0B18",borderRadius:3,padding:"1px 4px"}}>🚩{pFlags}</span>}
                        {pSnips>0    && <span style={{fontSize:9,color:"#3B82F6",fontWeight:700,background:"#3B82F618",borderRadius:3,padding:"1px 4px"}}>✂️{pSnips}</span>}
                        {pComments>0 && <span style={{fontSize:9,color:"#22C55E",fontWeight:700,background:"#22C55E18",borderRadius:3,padding:"1px 4px"}}>💬{pComments}</span>}
                        <span style={{fontSize:10,fontWeight:800,color:pc2}}>{ppct}%</span>
                      </div>
                    </div>
                    <div style={{background:"var(--c-page)",borderRadius:2,height:4,overflow:"hidden"}}><div style={{width:`${ppct}%`,height:"100%",background:pc2,borderRadius:2}}/></div>
                  </div>
                );
                return rows2;
              })}
            </div>
          </div>
          {!selProject ? (
            <div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{color:"#334155",fontSize:14}}>Select a project</span></div>
          ) : (
            <div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,overflow:"hidden",display:"flex",flexDirection:"column"}}>
              <div style={{padding:"16px 20px",borderBottom:"1px solid var(--c-border)",background:"var(--c-deep)"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,background:`${mc}18`,border:`1px solid ${mc}44`,borderRadius:20,padding:"4px 12px 4px 6px",marginBottom:10,width:"fit-content"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:mc,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:900,color:"#0F172A"}}>{currentUser.slice(0,2)}</div>
                  <span style={{fontSize:12,fontWeight:700,color:mc}}>{currentUser}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                      <span style={{fontSize:13,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731666",borderRadius:4,padding:"3px 10px"}}>{selProject.jobCode||"—"}</span>
                      <span style={{fontSize:11,color:"var(--c-t4)"}}>{selProject.client} · {selProject.phase}</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      <div style={{fontSize:13,color:"var(--c-t2)",fontWeight:600}}>{selProject.name}</div>
                      {selProject.name && (
                        <button onClick={()=>{navigator.clipboard.writeText(selProject.name);setCopiedTrackerAddr(selProject.id);setTimeout(()=>setCopiedTrackerAddr(i=>i===selProject.id?null:i),1800);}}
                          title="Copy address"
                          style={{background:"none",border:"none",cursor:"pointer",fontSize:10,fontWeight:700,color:copiedTrackerAddr===selProject.id?"#10B981":"#475569",padding:"0 2px",flexShrink:0,transition:"color 0.2s"}}>
                          {copiedTrackerAddr===selProject.id?"✓":"⎘"}
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:24,fontWeight:900,color:pc,fontFamily:"monospace",lineHeight:1}}>{pct}%</div><div style={{fontSize:10,color:"var(--c-t5)"}}>{totalDone}/{cl.length}</div></div>
                </div>
                <div style={{background:"var(--c-page)",borderRadius:4,height:8,overflow:"hidden",marginBottom:10}}><div style={{width:`${pct}%`,height:"100%",background:pc,borderRadius:4}}/></div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <input value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} placeholder="Search…" style={{...IS,width:150,fontSize:12,padding:"5px 8px",flex:"0 0 auto"}}/>
                  <div style={{display:"flex",background:"var(--c-page)",borderRadius:5,padding:2,gap:2}}>
                    {["All","Pending","Done","Flagged"].map(f=><button key={f} onClick={()=>setClFilter(f)} style={{padding:"3px 10px",borderRadius:3,border:"none",background:clFilter===f?(f==="Flagged"?"#F59E0B30":"var(--c-panel)"):"transparent",color:clFilter===f?(f==="Flagged"?"#F59E0B":"var(--c-t1)"):"var(--c-t5)",cursor:"pointer",fontSize:11,fontWeight:clFilter===f?700:400}}>
                      {f==="Flagged"&&"🚩 "}{f}
                      {f==="Flagged"&&flaggedCount>0&&<span style={{marginLeft:4,fontSize:9}}>{flaggedCount}</span>}
                      {f==="Flagged"&&flaggedSnipshots>0&&<span style={{marginLeft:3,fontSize:9,color:"#3B82F6",fontWeight:700}}>✂️{flaggedSnipshots}</span>}
                      {f==="Flagged"&&flaggedComments>0&&<span style={{marginLeft:3,fontSize:9,color:"#22C55E",fontWeight:700}}>💬{flaggedComments}</span>}
                    </button>)}
                  </div>
                </div>
              </div>
              {/* Checklist project notes */}
              <div style={{borderBottom:"1px solid var(--c-border)",background:"var(--c-deep)"}}>
                <div style={{padding:"10px 18px 0"}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#F97316",textTransform:"uppercase",marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
                    📝 Project Notes
                    {clNotes.length>0&&<span style={{background:"#F97316",color:"#0F172A",borderRadius:8,padding:"0 6px",fontSize:9,fontWeight:900}}>{clNotes.length}</span>}
                  </div>
                  {clNotes.length>0 && (
                    <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8,maxHeight:160,overflowY:"auto"}}>
                      {clNotes.map(n=>{
                        const mc = MEMBER_COLOR[n.author]||"#64748B";
                        const isEditing = clNoteEditId===n.id;
                        const isTagged = (n.tagged||[]).includes(currentUser);
                        return (
                          <div key={n.id} style={{background:"var(--c-panel)",borderRadius:6,padding:"7px 10px",borderLeft:`3px solid ${mc}`,opacity:n.done?0.5:1}}>
                            {isEditing ? (
                              <textarea autoFocus spellCheck value={clNoteEditText} onChange={e=>setClNoteEditText(e.target.value)}
                                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();saveClNoteEdit(n.id);}if(e.key==="Escape"){setClNoteEditId(null);setClNoteEditText("");}}}
                                style={{...IS,width:"100%",fontSize:12,padding:"4px 6px",resize:"vertical",minHeight:54,marginBottom:4,boxSizing:"border-box"}}/>
                            ) : (
                              <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
                                <div onClick={()=>onToggleNoteDone?.(selId,n.id,"Tracker")}
                                  title={n.done?"Mark as not done":"Mark as done"}
                                  style={{width:15,height:15,borderRadius:3,border:"1.5px solid #F97316",background:n.done?"#F97316":"transparent",cursor:"pointer",flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center"}}>
                                  {n.done && <span style={{color:"#fff",fontSize:10,lineHeight:1}}>✓</span>}
                                </div>
                                <div style={{flex:1,fontSize:12,color:"var(--c-t2)",lineHeight:1.4,whiteSpace:"pre-wrap",marginBottom:4,textDecoration:n.done?"line-through":"none"}}>{n.text}{n.editedAt&&<span style={{fontSize:9,color:"var(--c-t5)",marginLeft:6}}>(edited)</span>}</div>
                              </div>
                            )}
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:4}}>
                              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                                <span style={{background:`${mc}22`,border:`1px solid ${mc}44`,borderRadius:10,padding:"1px 8px",fontSize:9,fontWeight:800,color:mc}}>@{n.author}</span>
                                <span style={{fontSize:9,color:"var(--c-t5)"}}>{fmtTs(n.ts)}</span>
                                {(n.tagged||[]).map(t=>(
                                  <span key={t} style={{background:`${MEMBER_COLOR[t]||"#64748B"}22`,border:`1px solid ${MEMBER_COLOR[t]||"#64748B"}44`,borderRadius:10,padding:"1px 8px",fontSize:9,fontWeight:800,color:MEMBER_COLOR[t]||"#64748B"}}>@{t}</span>
                                ))}
                              </div>
                              <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
                                {isTagged ? (
                                  <button type="button" onClick={()=>onUpdateClNoteTags?.(selId,n.id,(n.tagged||[]).filter(t=>t!==currentUser))}
                                    style={{background:"transparent",border:"1px solid #EF444444",borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:10,color:"#EF4444",fontWeight:600,lineHeight:1.4}}>
                                    ✕ Remove me
                                  </button>
                                ) : onSelfTagClNote ? (
                                  <button type="button" onClick={()=>onSelfTagClNote(selId,n.id)}
                                    style={{background:"transparent",border:"1px solid var(--c-border)",borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:10,color:"var(--c-t4)",fontWeight:600,lineHeight:1.4}}>
                                    👤 Tag me
                                  </button>
                                ) : null}
                                <button type="button" onClick={()=>setClNoteTagEditId(clNoteTagEditId===n.id?null:n.id)}
                                  title="Edit tags" style={{background:clNoteTagEditId===n.id?"#F9731618":"transparent",border:`1px solid ${clNoteTagEditId===n.id?"#F97316":"var(--c-border)"}`,borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:10,color:clNoteTagEditId===n.id?"#F97316":"var(--c-t4)",fontWeight:600,lineHeight:1.4}}>
                                  @ Tags
                                </button>
                                {n.author===currentUser&&(isEditing
                                  ? <><button onClick={()=>saveClNoteEdit(n.id)} style={{background:"#10B981",border:"none",borderRadius:4,padding:"2px 8px",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer"}}>Save</button>
                                      <button onClick={()=>{setClNoteEditId(null);setClNoteEditText("");}} style={{background:"none",border:"none",color:"var(--c-t4)",fontSize:10,cursor:"pointer"}}>Cancel</button></>
                                  : <><button onClick={()=>{setClNoteEditId(n.id);setClNoteEditText(n.text);}} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:11,padding:0}}>✎</button>
                                      <button onClick={()=>removeClNote(n.id)} style={{background:"none",border:"none",color:"#334155",cursor:"pointer",fontSize:11,padding:0}}>×</button></>
                                )}
                              </div>
                            </div>
                            {clNoteTagEditId===n.id && (
                              <div style={{marginTop:6,padding:"6px 8px",background:"var(--c-page)",borderRadius:5,border:"1px solid var(--c-border)"}}>
                                <div style={{fontSize:9,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:5,letterSpacing:"0.05em"}}>Edit Tags</div>
                                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                                  {TEAM_NAMES.map(name=>{
                                    const inTag=(n.tagged||[]).includes(name);
                                    const mc2=MEMBER_COLOR[name]||"#64748B";
                                    return (
                                      <button key={name} type="button"
                                        onClick={()=>onUpdateClNoteTags?.(selId,n.id,inTag?(n.tagged||[]).filter(t=>t!==name):[...(n.tagged||[]),name])}
                                        style={{background:inTag?`${mc2}22`:"transparent",border:`1px solid ${inTag?mc2:"var(--c-border)"}`,borderRadius:10,padding:"2px 9px",cursor:"pointer",fontSize:9,fontWeight:inTag?800:400,color:inTag?mc2:"var(--c-t4)"}}>
                                        {inTag?`✓ ${name}`:name}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div style={{position:"relative",display:"flex",gap:6,paddingBottom:10}}>
                    {clNoteMention && (() => {
                      const matches = TEAM_NAMES.filter(n=>n!==currentUser && n.toUpperCase().startsWith(clNoteMention.query.toUpperCase()));
                      return matches.length>0 ? (
                        <div style={{position:"absolute",bottom:"100%",left:0,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:4,zIndex:99,display:"flex",flexDirection:"column",gap:2,marginBottom:4,minWidth:140}}>
                          {matches.map(name=>(
                            <button key={name} onMouseDown={e=>{
                              e.preventDefault();
                              const before = clNoteDraft.slice(0, clNoteMention.start);
                              const after = clNoteDraft.slice(clNoteMention.start + clNoteMention.query.length + 1);
                              setClNoteDraft(`${before}@${name} ${after}`);
                              setClNoteTagged(t=>t.includes(name)?t:[...t,name]);
                              setClNoteMention(null);
                              clNoteInputRef.current?.focus();
                            }} style={{background:"transparent",border:"none",borderRadius:5,padding:"4px 10px",color:`${MEMBER_COLOR[name]||"#94A3B8"}`,fontSize:12,fontWeight:700,cursor:"pointer",textAlign:"left"}}>
                              @{name}
                            </button>
                          ))}
                        </div>
                      ) : null;
                    })()}
                    <input ref={clNoteInputRef} value={clNoteDraft}
                      onChange={e=>{
                        const val=e.target.value, pos=e.target.selectionStart;
                        setClNoteDraft(val);
                        const m=val.slice(0,pos).match(/@([A-Za-z0-9_]*)$/);
                        setClNoteMention(m?{start:pos-m[0].length,query:m[1]}:null);
                      }}
                      onKeyDown={e=>{
                        if(e.key==="Escape"&&clNoteMention){setClNoteMention(null);return;}
                        if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();addClNote();}
                      }}
                      placeholder="Add a note… type @ to tag a team member"
                      style={{...IS,flex:1,fontSize:12,padding:"6px 10px"}}/>
                    <button onClick={addClNote} disabled={!clNoteDraft.trim()}
                      style={{background:clNoteDraft.trim()?"#F97316":"#334155",border:"none",borderRadius:6,padding:"0 14px",color:"#fff",fontWeight:800,cursor:clNoteDraft.trim()?"pointer":"not-allowed",fontSize:12}}>Post</button>
                  </div>
                </div>
              </div>
              {/* Section jump nav */}
              <div style={{display:"flex",gap:4,flexWrap:"wrap",padding:"8px 18px",borderBottom:"1px solid var(--c-border)",background:"var(--c-deep)"}}>
                {CL_SECTIONS.map(sec=>{
                  const count = filteredCL.filter(c=>c.section===sec).length;
                  const doneCount = filteredCL.filter(c=>c.section===sec&&c.done).length;
                  const sc=SECTION_CLR[sec];
                  const hasItems = cl.filter(c=>c.section===sec).length>0;
                  if(!hasItems) return null;
                  return (
                    <button key={sec} onClick={()=>scrollToSection(sec)}
                      style={{background:`${sc}18`,border:`1px solid ${sc}44`,borderRadius:12,padding:"3px 10px",color:count===0?"#334155":sc,cursor:count===0?"default":"pointer",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",gap:4,opacity:count===0?0.4:1}}>
                      {sec}
                      {count>0&&<span style={{background:`${sc}33`,borderRadius:8,padding:"0 5px",fontSize:9}}>{doneCount}/{count}</span>}
                    </button>
                  );
                })}
              </div>
              <div ref={clScrollRef} style={{flex:1,overflowY:"auto",padding:"14px 18px 60vh",maxHeight:"calc(100vh - 220px)",position:"relative"}}>
                {CL_SECTIONS.map(sec=>{
                  const items=filteredCL.filter(c=>c.section===sec);
                  if(!items.length)return null;
                  const sc=SECTION_CLR[sec];
                  return (
                    <div key={sec} ref={el=>sectionRefs.current[sec]=el} style={{marginBottom:20}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <div style={{width:3,height:14,background:sc,borderRadius:2}}/>
                        <span style={{fontSize:12,fontWeight:800,color:sc,textTransform:"uppercase"}}>{sec}</span>
                      </div>
                      {items.map(item=>{
                        const attCount = (item.attachments||[]).length;
                        const comments = item.comments||[];
                        const showComments = commentItemId===item.id;
                        return (
                        <div key={item.id} style={{background:item.done?"var(--c-deep)":"var(--c-page)",borderRadius:7,marginBottom:3,borderLeft:`2px solid ${item.flag?"#F59E0B":item.done?sc+"66":"var(--c-border2)"}`}}>
                          {/* Main row */}
                          <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px"}}>
                            <div onClick={()=>toggle(item.id)} style={{width:20,height:20,borderRadius:5,border:`2px solid ${item.done?sc:"#475569"}`,background:item.done?sc:"transparent",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                              {item.done && <span style={{color:"#0F172A",fontSize:12,fontWeight:900}}>✓</span>}
                            </div>
                            <span style={{flex:1,color:item.done?"var(--c-t5)":"var(--c-t2)",fontSize:13,textDecoration:item.done?"line-through":"none"}}>{item.label}</span>
                            {attCount > 0 && (
                              <button onClick={() => setScreenshotItemId(item.id)} title={`${attCount} screenshot${attCount!==1?"s":""}`}
                                style={{fontSize:10,color:"#3B82F6",background:"#3B82F618",border:"1px solid #3B82F644",borderRadius:4,padding:"2px 7px",fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:3}}>
                                ✂️ {attCount}
                              </button>
                            )}
                            {item.flag && <span style={{fontSize:10,color:"#F59E0B",background:"#F59E0B18",borderRadius:3,padding:"1px 5px"}}>🚩 {item.flag.member}</span>}
                            {item.flag && attCount>0 && <span style={{fontSize:9,color:"#3B82F6",background:"#3B82F618",border:"1px solid #3B82F644",borderRadius:3,padding:"1px 5px",fontWeight:700}}>✂️ {attCount}</span>}
                            {item.flag && comments.length>0 && <span style={{fontSize:9,color:"#22C55E",background:"#22C55E18",border:"1px solid #22C55E44",borderRadius:3,padding:"1px 5px",fontWeight:700}}>💬 {comments.length}</span>}
                            {item.done && item.history && item.history.length>0 && (
                              <span style={{fontSize:9,color:"var(--c-t5)",whiteSpace:"nowrap"}}>{item.history[item.history.length-1].member} · {fmtTs(item.history[item.history.length-1].ts)}</span>
                            )}
                            <button onClick={()=>setScreenshotItemId(item.id)} title="Snip screenshot" style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:14,padding:"0 3px"}}>✂️</button>
                            <button onClick={()=>handleFlag(item.id)} title={item.flag?"Unflag":"Flag"} style={{background:"none",border:"none",color:item.flag?"#F59E0B":"#334155",cursor:"pointer",fontSize:14,padding:"0 3px"}}>🚩</button>
                            <button onClick={()=>{setCommentItemId(commentItemId===item.id?null:item.id);setCommentDraft("");}} title="Comments"
                              style={{background:"none",border:"none",color:showComments?"#3B82F6":comments.length>0?"#3B82F6":"#334155",cursor:"pointer",fontSize:13,padding:"0 3px",position:"relative"}}>
                              💬{comments.length>0&&<span style={{position:"absolute",top:-4,right:-4,background:"#3B82F6",color:"#fff",borderRadius:"50%",fontSize:8,fontWeight:900,width:12,height:12,display:"flex",alignItems:"center",justifyContent:"center"}}>{comments.length}</span>}
                            </button>
                            {canDelete && (
                              <button onClick={()=>delItem(item.id)} title="Delete item"
                                style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14,padding:"0 3px"}}>🗑</button>
                            )}
                          </div>
                          {/* SubItems */}
                          {(item.subItems||[]).length > 0 && (
                            <div style={{paddingLeft:42,paddingRight:12,paddingBottom:6,borderTop:"1px solid var(--c-border2)",paddingTop:6}}>
                              {(item.subItems||[]).map(si=>(
                                <div key={si.id} style={{display:"flex",alignItems:"center",gap:7,padding:"3px 0"}}>
                                  <span style={{color:"var(--c-t4)",fontSize:10,flexShrink:0}}>–</span>
                                  <span style={{flex:1,fontSize:12,color:"var(--c-t3)"}}>{si.text}</span>
                                  {canDelete && (
                                    <button onClick={()=>removeSubItem(item.id,si.id)} title="Delete sub-task"
                                      style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:11,padding:0,flexShrink:0,lineHeight:1}}>×</button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {/* Comments */}
                          {showComments && (
                            <div style={{paddingLeft:42,paddingRight:12,paddingBottom:10,borderTop:"1px solid var(--c-border2)",paddingTop:8}}>
                              <div style={{fontSize:9,fontWeight:700,color:"#3B82F6",textTransform:"uppercase",marginBottom:6}}>Comments</div>
                              {comments.length>0 && (
                                <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
                                  {comments.map(cm=>(
                                    <div key={cm.id} style={{background:"var(--c-panel)",borderRadius:6,padding:"6px 10px",borderLeft:"2px solid #3B82F644"}}>
                                      <div style={{fontSize:12,color:"var(--c-t2)",lineHeight:1.4,whiteSpace:"pre-wrap"}}>{cm.text}</div>
                                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4}}>
                                        <span style={{fontSize:9,color:"var(--c-t5)",fontWeight:700}}>{cm.author} · {fmtTs(cm.ts)}</span>
                                        {cm.author===currentUser && <button onClick={()=>removeComment(item.id,cm.id)} style={{background:"none",border:"none",color:"#334155",cursor:"pointer",fontSize:10,padding:0}}>×</button>}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div style={{display:"flex",gap:6}}>
                                <input value={commentDraft} onChange={e=>setCommentDraft(e.target.value)}
                                  onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();addComment(item.id,commentDraft);}if(e.key==="Escape")setCommentItemId(null);}}
                                  placeholder="Add a comment…"
                                  style={{...IS,flex:1,fontSize:12,padding:"5px 8px"}}/>
                                <button onClick={()=>addComment(item.id,commentDraft)} disabled={!commentDraft.trim()}
                                  style={{background:commentDraft.trim()?"#3B82F6":"#334155",border:"none",borderRadius:6,padding:"0 12px",color:"#fff",fontWeight:700,cursor:commentDraft.trim()?"pointer":"not-allowed",fontSize:12}}>Send</button>
                              </div>
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  );
                })}
                {filteredCL.length===0&&<div style={{textAlign:"center",color:"#334155",padding:"40px 0"}}>No items match.</div>}
              </div>
              <div style={{padding:"14px 20px",borderTop:"1px solid var(--c-border)",background:"var(--c-deep)"}}>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <select value={newSection} onChange={e=>setNewSection(e.target.value)} style={{...IS,width:150,flex:"0 0 auto",fontSize:12,padding:"6px 8px"}}>{CL_SECTIONS.map(s=><option key={s}>{s}</option>)}</select>
                  <input value={newLabel} onChange={e=>setNewLabel(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addItem()} placeholder="New item…" style={{...IS,flex:1,minWidth:160,fontSize:12}}/>
                  <button onClick={addItem} style={{background:"#F97316",border:"none",borderRadius:6,padding:"7px 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>+ Add</button>
                </div>
              </div>
            </div>
          )}
        </div>
        {screenshotItemId && cl.find(c=>c.id===screenshotItemId) && (
          <ScreenshotModal
            item={cl.find(c=>c.id===screenshotItemId)}
            currentUser={currentUser}
            onSave={saveAttachments}
            onClose={()=>setScreenshotItemId(null)}
          />
        )}
        </>
      )}
    </div>
  );
}

function MasterChecklistTab({ masterTemplate, setMasterTemplate, projects, onSync, onReorder, deletedMasterItems, setDeletedMasterItems }) {
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newSection, setNewSection] = useState("Modelling");
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [showDeletedItems, setShowDeletedItems] = useState(false);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [addingSubId, setAddingSubId] = useState(null);
  const [subDraft, setSubDraft] = useState("");
  const [editSubKey, setEditSubKey] = useState(null); // {itemId, subId}
  const [editSubText, setEditSubText] = useState("");

  const onDragStart = (e, id) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };
  const onDragOver = (e, id) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id !== draggingId) setDragOverId(id);
  };
  const onDrop = (e, targetId) => {
    e.preventDefault();
    if (!draggingId || draggingId === targetId) { setDraggingId(null); setDragOverId(null); return; }
    const dragItem = masterTemplate.find(c => c.id === draggingId);
    const targetItem = masterTemplate.find(c => c.id === targetId);
    if (!dragItem || !targetItem || dragItem.section !== targetItem.section) { setDraggingId(null); setDragOverId(null); return; }
    const next = [...masterTemplate];
    const fromPos = next.findIndex(c => c.id === draggingId);
    next.splice(fromPos, 1);
    const toPos = next.findIndex(c => c.id === targetId);
    next.splice(toPos, 0, dragItem);
    setMasterTemplate(next);
    onReorder?.(next);
    setDraggingId(null); setDragOverId(null);
  };
  const onDragEnd = () => { setDraggingId(null); setDragOverId(null); };

  const addMasterSub = (itemId, text) => {
    if (!text.trim()) return;
    setMasterTemplate(t => t.map(c => c.id===itemId ? { ...c, subItems:[...(c.subItems||[]), {id:mkId(), text:text.trim()}] } : c));
    setSubDraft("");
  };
  const removeMasterSub = (itemId, subId) => {
    setMasterTemplate(t => t.map(c => c.id===itemId ? { ...c, subItems:(c.subItems||[]).filter(s=>s.id!==subId) } : c));
  };
  const saveMasterSubEdit = (itemId, subId) => {
    if (!editSubText.trim()) removeMasterSub(itemId, subId);
    else setMasterTemplate(t => t.map(c => c.id===itemId ? { ...c, subItems:(c.subItems||[]).map(s=>s.id===subId?{...s,text:editSubText.trim()}:s) } : c));
    setEditSubKey(null); setEditSubText("");
  };
  const moveSubItem = (itemId, subId, dir) => {
    setMasterTemplate(t => t.map(c => {
      if (c.id !== itemId) return c;
      const subs = [...(c.subItems||[])];
      const idx = subs.findIndex(s => s.id === subId);
      const swapIdx = idx + dir;
      if (swapIdx < 0 || swapIdx >= subs.length) return c;
      [subs[idx], subs[swapIdx]] = [subs[swapIdx], subs[idx]];
      return { ...c, subItems: subs };
    }));
  };

  const projectsWithUpdates = projects.filter(p => {
    if (p.status === "Completed") return false;
    const u = getProjectUpdates(p, masterTemplate);
    return u.newItems.length > 0 || u.changedItems.length > 0;
  });

  const addItem = () => {
    if (!newLabel.trim()) return;
    setMasterTemplate([...masterTemplate, { id: `tpl_custom_${mkId()}`, section: newSection, label: newLabel.trim() }]);
    setNewLabel("");
  };
  const delItem = id => {
    const item = masterTemplate.find(c => c.id === id);
    if (item) setDeletedMasterItems(d => [...d, { ...item, _deletedAt: nowTs() }]);
    setMasterTemplate(masterTemplate.filter(c => c.id !== id));
  };
  const restoreMasterItem = id => {
    const item = (deletedMasterItems||[]).find(c => c.id === id);
    if (!item) return;
    const { _deletedAt, ...restored } = item;
    setMasterTemplate(t => [...t, restored]);
    setDeletedMasterItems(d => d.filter(x => x.id !== id));
  };
  const permanentDeleteMasterItem = id => setDeletedMasterItems(d => d.filter(x => x.id !== id));
  const saveEdit = () => {
    setMasterTemplate(masterTemplate.map(c => c.id === editingId ? { ...c, label: editLabel } : c));
    setEditingId(null); setEditLabel("");
  };
  // Items are grouped/displayed by section, so "up/down" moves within the item's
  // own section — swap absolute positions with the neighboring same-section item.
  const moveItem = (id, dir) => {
    const item = masterTemplate.find(c => c.id === id);
    if (!item) return;
    const sectionIds = masterTemplate.filter(c => c.section === item.section).map(c => c.id);
    const idx = sectionIds.indexOf(id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sectionIds.length) return;
    const otherId = sectionIds[swapIdx];
    const aPos = masterTemplate.findIndex(c => c.id === id);
    const bPos = masterTemplate.findIndex(c => c.id === otherId);
    const next = [...masterTemplate];
    [next[aPos], next[bPos]] = [next[bPos], next[aPos]];
    setMasterTemplate(next);
    onReorder?.(next);
  };

  return (
    <div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,overflow:"hidden",display:"flex",flexDirection:"column",height:"calc(100vh - 120px)"}}>
      <div style={{padding:"16px 20px",borderBottom:"1px solid var(--c-border)",background:"var(--c-deep)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
          <div>
            <div style={{fontSize:15,fontWeight:800,color:"var(--c-t1)"}}>📋 Master Checklist Template</div>
            <div style={{fontSize:12,color:"var(--c-t4)"}}>Source of truth. Push changes to projects below.</div>
          </div>
          <button onClick={()=>setShowSyncModal(true)} style={{background:"#F97316",border:"none",borderRadius:6,padding:"8px 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:6}}>
            📤 Push to Projects
            {projectsWithUpdates.length>0 && <span style={{background:"#fff",color:"#F97316",borderRadius:10,padding:"1px 7px",fontSize:11,fontWeight:900}}>{projectsWithUpdates.length}</span>}
          </button>
        </div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"14px 20px"}}>
        {CL_SECTIONS.map(sec=>{
          const items=masterTemplate.filter(c=>c.section===sec);
          if(!items.length)return null;
          const sc=SECTION_CLR[sec];
          return (
            <div key={sec} style={{marginBottom:20}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <div style={{width:3,height:14,background:sc,borderRadius:2}}/>
                <span style={{fontSize:12,fontWeight:800,color:sc,textTransform:"uppercase"}}>{sec}</span>
                <span style={{fontSize:11,color:"var(--c-t5)"}}>{items.length}</span>
              </div>
              {items.map((item,idx)=>{
                const subs = item.subItems||[];
                const showSubArea = subs.length>0 || addingSubId===item.id;
                return (
                <div key={item.id}
                  draggable
                  onDragStart={e=>onDragStart(e,item.id)}
                  onDragOver={e=>onDragOver(e,item.id)}
                  onDrop={e=>onDrop(e,item.id)}
                  onDragEnd={onDragEnd}
                  style={{background:"var(--c-page)",borderRadius:7,marginBottom:4,borderLeft:`2px solid ${sc}66`,
                    opacity:draggingId===item.id?0.4:1,
                    outline:dragOverId===item.id&&draggingId!==item.id?"2px solid #F97316":"none",
                    transition:"opacity 0.15s"}}>
                  {/* Main row */}
                  <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px"}}>
                    <span title="Drag to reorder" style={{cursor:"grab",color:"#334155",fontSize:14,lineHeight:1,flexShrink:0,userSelect:"none"}}>⠿</span>
                    <div style={{display:"flex",flexDirection:"column",gap:1}}>
                      <button onClick={()=>moveItem(item.id,-1)} disabled={idx===0} title="Move up" style={{background:"none",border:"none",color:idx===0?"#334155":"#64748B",cursor:idx===0?"default":"pointer",fontSize:9,lineHeight:1,padding:"1px 2px"}}>▲</button>
                      <button onClick={()=>moveItem(item.id,1)} disabled={idx===items.length-1} title="Move down" style={{background:"none",border:"none",color:idx===items.length-1?"#334155":"#64748B",cursor:idx===items.length-1?"default":"pointer",fontSize:9,lineHeight:1,padding:"1px 2px"}}>▼</button>
                    </div>
                    <span style={{fontSize:9,fontFamily:"monospace",color:"var(--c-t5)",background:"var(--c-panel)",borderRadius:3,padding:"1px 5px"}}>{item.id}</span>
                    {editingId===item.id ? (
                      <>
                        <input value={editLabel} onChange={e=>setEditLabel(e.target.value)} autoFocus onKeyDown={e=>e.key==="Enter"&&saveEdit()} style={{...IS,flex:1,fontSize:13,padding:"4px 8px"}}/>
                        <button onClick={saveEdit} style={{background:"#10B981",border:"none",borderRadius:5,padding:"4px 10px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11}}>Save</button>
                        <button onClick={()=>{setEditingId(null);setEditLabel("");}} style={{background:"transparent",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 8px",color:"var(--c-t4)",cursor:"pointer",fontSize:11}}>✕</button>
                      </>
                    ) : (
                      <>
                        <span style={{flex:1,color:"var(--c-t2)",fontSize:13}}>{item.label}</span>
                        <button onClick={()=>{setAddingSubId(addingSubId===item.id?null:item.id);setSubDraft("");}} title="Add sub-task"
                          style={{background:"none",border:"none",color:addingSubId===item.id?"#F97316":"#334155",cursor:"pointer",fontSize:13,padding:"0 2px",fontWeight:700}}>+</button>
                        <button onClick={()=>{setEditingId(item.id);setEditLabel(item.label);}} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:14}}>✎</button>
                        <button onClick={()=>delItem(item.id)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14}}>🗑</button>
                      </>
                    )}
                  </div>
                  {/* Sub-items */}
                  {showSubArea && (
                    <div style={{paddingLeft:78,paddingRight:12,paddingBottom:8}}>
                      {subs.map((si, siIdx)=>(
                        <div key={si.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                          <span style={{color:sc,fontSize:12,flexShrink:0}}>•</span>
                          {editSubKey?.itemId===item.id&&editSubKey?.subId===si.id ? (
                            <>
                              <input autoFocus value={editSubText} onChange={e=>setEditSubText(e.target.value)}
                                onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();saveMasterSubEdit(item.id,si.id);}if(e.key==="Escape"){setEditSubKey(null);setEditSubText("");}}}
                                style={{...IS,flex:1,fontSize:12,padding:"2px 6px"}}/>
                              <button onClick={()=>saveMasterSubEdit(item.id,si.id)} style={{background:"#10B981",border:"none",borderRadius:4,padding:"2px 8px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11,flexShrink:0}}>Save</button>
                              <button onClick={()=>{setEditSubKey(null);setEditSubText("");}} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:12,padding:0,flexShrink:0}}>✕</button>
                            </>
                          ) : (
                            <>
                              <div style={{display:"flex",flexDirection:"column",flexShrink:0}}>
                                <button onClick={()=>moveSubItem(item.id,si.id,-1)} disabled={siIdx===0} style={{background:"none",border:"none",color:siIdx===0?"#334155":"#64748B",cursor:siIdx===0?"default":"pointer",fontSize:8,lineHeight:1,padding:"1px 2px"}}>▲</button>
                                <button onClick={()=>moveSubItem(item.id,si.id,1)} disabled={siIdx===subs.length-1} style={{background:"none",border:"none",color:siIdx===subs.length-1?"#334155":"#64748B",cursor:siIdx===subs.length-1?"default":"pointer",fontSize:8,lineHeight:1,padding:"1px 2px"}}>▼</button>
                              </div>
                              <span style={{flex:1,fontSize:12,color:"var(--c-t3)",lineHeight:1.4}}>{si.text}</span>
                              <button onClick={()=>{setEditSubKey({itemId:item.id,subId:si.id});setEditSubText(si.text);}} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:13,padding:0,flexShrink:0}}>✎</button>
                              <button onClick={()=>removeMasterSub(item.id,si.id)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:11,padding:0,flexShrink:0}}>×</button>
                            </>
                          )}
                        </div>
                      ))}
                      {addingSubId===item.id && (
                        <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                          <span style={{color:sc,fontSize:12,flexShrink:0}}>•</span>
                          <input autoFocus value={subDraft} onChange={e=>setSubDraft(e.target.value)}
                            onKeyDown={e=>{
                              if(e.key==="Enter"){e.preventDefault();if(subDraft.trim())addMasterSub(item.id,subDraft);}
                              if(e.key==="Escape"){setAddingSubId(null);setSubDraft("");}
                            }}
                            onBlur={()=>{if(subDraft.trim())addMasterSub(item.id,subDraft);else setAddingSubId(null);setSubDraft("");}}
                            placeholder="Add sub-task… (Enter to save, Esc to cancel)"
                            style={{...IS,flex:1,fontSize:12,padding:"2px 6px"}}/>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {(deletedMasterItems||[]).length > 0 && (
        <div style={{borderTop:"1px solid var(--c-border)",background:"var(--c-panel)"}}>
          <button onClick={()=>setShowDeletedItems(s=>!s)} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6,padding:"12px 20px",width:"100%"}}>
            🗑 Recently Deleted ({deletedMasterItems.length}) {showDeletedItems?"▲":"▼"}
          </button>
          {showDeletedItems && (
            <div style={{maxHeight:200,overflowY:"auto",padding:"0 20px 12px"}}>
              {(deletedMasterItems||[]).map(item => {
                const sc = SECTION_CLR[item.section] || "#64748B";
                return (
                  <div key={item.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 12px",background:"var(--c-page)",borderRadius:7,marginBottom:4,borderLeft:`2px solid #334155`,opacity:0.7}}>
                    <span style={{fontSize:9,fontFamily:"monospace",color:"#334155",background:"var(--c-panel)",borderRadius:3,padding:"1px 5px"}}>{item.section}</span>
                    <span style={{flex:1,color:"var(--c-t4)",fontSize:13,textDecoration:"line-through"}}>{item.label}</span>
                    <span style={{fontSize:9,color:"var(--c-t5)"}}>{fmtTs(item._deletedAt)}</span>
                    <button onClick={()=>restoreMasterItem(item.id)} style={{background:"#10B98120",border:"1px solid #10B98144",borderRadius:5,padding:"3px 8px",color:"#10B981",cursor:"pointer",fontSize:11,fontWeight:700}}>↩ Restore</button>
                    <button onClick={()=>{ if (window.confirm(`Permanently erase "${item.label}" from trash? This cannot be undone.`)) permanentDeleteMasterItem(item.id); }} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:12}}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div style={{padding:"14px 20px",borderTop:"1px solid var(--c-border)",background:"var(--c-deep)"}}>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <select value={newSection} onChange={e=>setNewSection(e.target.value)} style={{...IS,width:150,flex:"0 0 auto",fontSize:12,padding:"6px 8px"}}>{CL_SECTIONS.map(s=><option key={s}>{s}</option>)}</select>
          <input value={newLabel} onChange={e=>setNewLabel(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addItem()} placeholder="New master item…" style={{...IS,flex:1,minWidth:160,fontSize:12}}/>
          <button onClick={addItem} style={{background:"#F97316",border:"none",borderRadius:6,padding:"7px 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>+ Add</button>
        </div>
      </div>
      {showSyncModal && <SyncModal masterTemplate={masterTemplate} projects={projects} onSync={onSync} onClose={()=>setShowSyncModal(false)}/>}
    </div>
  );
}

function SyncModal({ masterTemplate, projects, onSync, onClose }) {
  const activeProjects = projects.filter(p => p.status !== "Completed");
  const projectUpdates = activeProjects.map(p => ({
    project: p,
    updates: getProjectUpdates(p, masterTemplate),
  })).filter(pu => pu.updates.newItems.length > 0 || pu.updates.changedItems.length > 0);
  const [selProjectIds, setSelProjectIds] = useState(new Set(projectUpdates.map(pu => pu.project.id)));
  const allNewItemIds = [...new Set(projectUpdates.flatMap(pu => pu.updates.newItems.map(i => i.id)))];
  const allChangedItemIds = [...new Set(projectUpdates.flatMap(pu => pu.updates.changedItems.map(c => c.master.id)))];
  const [selItemIds, setSelItemIds] = useState(new Set(allNewItemIds));
  const [selChangedIds, setSelChangedIds] = useState(new Set(allChangedItemIds));
  const togProj = id => { const next = new Set(selProjectIds); if (next.has(id)) next.delete(id); else next.add(id); setSelProjectIds(next); };
  const togItem = id => { const next = new Set(selItemIds); if (next.has(id)) next.delete(id); else next.add(id); setSelItemIds(next); };
  const togChanged = id => { const next = new Set(selChangedIds); if (next.has(id)) next.delete(id); else next.add(id); setSelChangedIds(next); };
  const handlePush = () => {
    selProjectIds.forEach(pid => onSync(pid, [...selItemIds], [...selChangedIds]));
    onClose();
  };
  const itemsByMaster = allNewItemIds.map(id => masterTemplate.find(m => m.id === id)).filter(Boolean);
  const changedByMaster = allChangedItemIds.map(id => masterTemplate.find(m => m.id === id)).filter(Boolean);
  if (projectUpdates.length === 0) {
    return <Modal title="Push Updates" onClose={onClose}>
      <div style={{textAlign:"center",padding:"30px 0",color:"#10B981",fontWeight:700}}>✨ All projects are up to date</div>
      <button autoFocus onClick={onClose} style={{width:"100%",marginTop:14,padding:"9px 0",background:"transparent",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer"}}>Close</button>
    </Modal>;
  }
  return (
    <Modal title="Push Master Updates" onClose={onClose} extraWide>
      {itemsByMaster.length > 0 && (
        <div style={{background:"var(--c-page)",borderRadius:8,padding:14,marginBottom:14}}>
          <div style={{fontSize:12,fontWeight:800,color:"var(--c-t1)",marginBottom:10}}>New items ({selItemIds.size}/{itemsByMaster.length})</div>
          <div style={{maxHeight:200,overflowY:"auto"}}>
            {itemsByMaster.map(item => {
              const sc = SECTION_CLR[item.section]||"#64748B";
              const sel = selItemIds.has(item.id);
              return <div key={item.id} onClick={()=>togItem(item.id)} style={{display:"flex",gap:8,alignItems:"center",padding:"6px 8px",background:sel?`${sc}15`:"transparent",borderRadius:5,marginBottom:2,cursor:"pointer"}}>
                <div style={{width:16,height:16,borderRadius:4,border:`2px solid ${sel?sc:"#475569"}`,background:sel?sc:"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>{sel&&<span style={{color:"#0F172A",fontSize:10,fontWeight:900}}>✓</span>}</div>
                <span style={{flex:1,fontSize:12,color:"var(--c-t2)"}}>{item.label}</span>
              </div>;
            })}
          </div>
        </div>
      )}
      {changedByMaster.length > 0 && (
        <div style={{background:"var(--c-page)",borderRadius:8,padding:14,marginBottom:14}}>
          <div style={{fontSize:12,fontWeight:800,color:"var(--c-t1)",marginBottom:10}}>Relabeled items ({selChangedIds.size}/{changedByMaster.length})</div>
          <div style={{maxHeight:200,overflowY:"auto"}}>
            {changedByMaster.map(item => {
              const sc = SECTION_CLR[item.section]||"#64748B";
              const sel = selChangedIds.has(item.id);
              const sample = projectUpdates.flatMap(pu=>pu.updates.changedItems).find(c=>c.master.id===item.id);
              return <div key={item.id} onClick={()=>togChanged(item.id)} style={{display:"flex",gap:8,alignItems:"center",padding:"6px 8px",background:sel?`${sc}15`:"transparent",borderRadius:5,marginBottom:2,cursor:"pointer"}}>
                <div style={{width:16,height:16,borderRadius:4,border:`2px solid ${sel?sc:"#475569"}`,background:sel?sc:"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>{sel&&<span style={{color:"#0F172A",fontSize:10,fontWeight:900}}>✓</span>}</div>
                <div style={{flex:1,fontSize:12,minWidth:0}}>
                  {sample && <div style={{color:"var(--c-t4)",textDecoration:"line-through",fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sample.existing.label}</div>}
                  <div style={{color:"var(--c-t2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</div>
                </div>
              </div>;
            })}
          </div>
        </div>
      )}
      <div style={{background:"var(--c-page)",borderRadius:8,padding:14,marginBottom:18}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:800,color:"var(--c-t1)"}}>Target projects ({selProjectIds.size}/{projectUpdates.length})</div>
          <button onClick={()=>setSelProjectIds(selProjectIds.size===projectUpdates.length ? new Set() : new Set(projectUpdates.map(pu=>pu.project.id)))} style={{background:"transparent",border:"1px solid #475569",borderRadius:5,padding:"3px 10px",color:"var(--c-t3)",cursor:"pointer",fontSize:11,fontWeight:700}}>
            {selProjectIds.size===projectUpdates.length ? "Deselect all" : "Select all"}
          </button>
        </div>
        <div style={{maxHeight:240,overflowY:"auto"}}>
          {projectUpdates.map(({project: p, updates: u}) => {
            const sel = selProjectIds.has(p.id);
            return <div key={p.id} onClick={()=>togProj(p.id)} style={{display:"flex",gap:10,alignItems:"center",padding:"8px 10px",background:sel?"#F9731615":"transparent",borderRadius:5,marginBottom:3,cursor:"pointer"}}>
              <div style={{width:16,height:16,borderRadius:4,border:`2px solid ${sel?"#F97316":"#475569"}`,background:sel?"#F97316":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>{sel&&<span style={{color:"#0F172A",fontSize:10,fontWeight:900}}>✓</span>}</div>
              <span style={{fontSize:10,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",borderRadius:3,padding:"1px 5px"}}>{p.jobCode||"—"}</span>
              <span style={{flex:1,fontSize:12,color:"var(--c-t1)"}}>{p.name}</span>
              {u.newItems.length>0 && <span style={{fontSize:10,color:"#10B981"}}>+{u.newItems.length}</span>}
              {u.changedItems.length>0 && <span style={{fontSize:10,color:"#3B82F6"}}>✎{u.changedItems.length}</span>}
            </div>;
          })}
        </div>
      </div>
      <div style={{display:"flex",gap:10}}>
        <button autoFocus onClick={handlePush} style={{flex:1,background:"#F97316",border:"none",borderRadius:6,padding:"10px 0",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>📤 Push to {selProjectIds.size} project(s)</button>
        <button onClick={onClose} style={{padding:"10px 20px",background:"transparent",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer"}}>Cancel</button>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════
// CALENDAR — shared, per-member day scheduling
// Visible to everyone; any member can add to any member's day.
// ═════════════════════════════════════════════════
const CAL_MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const CAL_DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

const isToday = d => d === TODAY;

// Build a 6-row Mon-start month grid, including leading/trailing days from adjacent months
function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay()+6)%7; // 0=Mon
  const gridStart = new Date(year, month, 1-startOffset);
  return Array.from({length:42}, (_,i) => {
    const d = new Date(gridStart); d.setDate(gridStart.getDate()+i);
    return { date:d, ymd:ymd(d), inMonth:d.getMonth()===month };
  });
}

function EventModal({ date, member, projects, initial, prefillStartTime, prefillDuration, prefillProjectId, prefillTask, onSave, onDelete, onClose, anchorRect, minDate }) {
  const activeProjects = projects
    .filter(p => p.status !== "Completed" && p.status !== "ON HOLD")
    .sort((a, b) => (a.jobCode || "").localeCompare(b.jobCode || "", undefined, { numeric: true, sensitivity: "base" }));
  const [eventDate, setEventDate] = useState(initial?.date || date);
  const [projectId, setProjectId] = useState(initial?.projectId || prefillProjectId || "");
  const [task, setTask] = useState(initial?.task || prefillTask || "");
  const [startTime, setStartTime] = useState(initial?.startTime || prefillStartTime || "");
  const [durationMin, setDurationMin] = useState(initial?.durationMin ?? prefillDuration ?? 60);
  // Subtasks — migrate any legacy freeform `note` string into a single subtask on first open
  const [subtasks, setSubtasks] = useState(() => {
    if (initial?.subtasks?.length) return initial.subtasks;
    if (initial?.note?.trim()) return [{ id:mkId(), text:initial.note.trim(), done:false }];
    return [];
  });
  const [newSubtask, setNewSubtask] = useState("");
  // A project link is no longer required — a manual task detail on its own is enough to save
  const canSave = !!projectId || !!task.trim();
  const BASE_PRESETS = [15,30,45,60,90,120,180,240];
  const DURATION_PRESETS = BASE_PRESETS.includes(durationMin) ? BASE_PRESETS : [...BASE_PRESETS, durationMin].sort((a,b)=>a-b);

  const addSubtask = () => {
    if (!newSubtask.trim()) return;
    setSubtasks(s => [...s, { id:mkId(), text:newSubtask.trim(), done:false }]);
    setNewSubtask("");
  };
  const toggleSubtask = id => setSubtasks(s => s.map(st => st.id===id ? {...st, done:!st.done} : st));
  const removeSubtask = id => setSubtasks(s => s.filter(st => st.id!==id));
  const subDone = subtasks.filter(s=>s.done).length;
  const save = () => canSave && onSave({date:eventDate,projectId,task,subtasks,startTime,durationMin});
  const deleteEvent = () => initial && onDelete && onDelete(initial.id);
  const title = initial ? `✎ Edit task` : `📅 Add to ${member}'s day`;

  const body = (
      /* Enter anywhere in the form saves, except inside the subtask input (which has its own Enter handler).
         Delete/Backspace removes the event entirely, but only when focus isn't in a text field —
         otherwise editing the task detail or a subtask would delete the whole event by mistake. */
      <div onKeyDown={e=>{
        if (e.key==="Enter" && e.target.tagName!=="BUTTON") { e.preventDefault(); save(); }
        else if ((e.key==="Delete"||e.key==="Backspace") && initial && onDelete && !["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) {
          e.preventDefault(); deleteEvent();
        }
      }}>
      <Field label="Date" light>
        <input type="date" style={IS_LIGHT} value={eventDate} min={minDate||undefined} onChange={e=>setEventDate(e.target.value)}/>
      </Field>
      <Field label="Task detail" light>
        <input type="text" autoFocus style={IS_LIGHT} value={task} onChange={e=>setTask(e.target.value)} placeholder="e.g. Call client re: install date"/>
      </Field>
      <Field label="Project (optional — leave blank for a manual task)" light>
        <select style={IS_LIGHT} value={projectId} onChange={e=>setProjectId(e.target.value)}>
          <option value="">No project — manual task</option>
          {activeProjects.map(p => <option key={p.id} value={p.id}>{p.jobCode||"—"} — {p.name}</option>)}
        </select>
      </Field>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Field label="Start time (optional)" light>
          <input type="time" style={IS_LIGHT} value={startTime} onChange={e=>setStartTime(e.target.value)}/>
        </Field>
        <Field label="Duration" light>
          <select style={IS_LIGHT} value={durationMin} onChange={e=>setDurationMin(+e.target.value)}>
            {DURATION_PRESETS.map(m => (
              <option key={m} value={m}>{m<60 ? `${m} min` : m===60 ? "1 hour" : `${(m/60).toFixed(m%60===0?0:1)} hours`}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={`Subtasks (optional)${subtasks.length>0?` — ${subDone}/${subtasks.length} done`:""}`} light>
        {subtasks.length > 0 && (
          <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:8}}>
            {subtasks.map(st => (
              <div key={st.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 9px",background:"#F7F8FA",borderRadius:6,border:`1px solid ${TT.border}`}}>
                <div onClick={()=>toggleSubtask(st.id)} style={{width:16,height:16,borderRadius:3,border:`1.5px solid ${st.done?"#3B5BFF":"#B9BFC8"}`,background:st.done?"#3B5BFF":"#FFFFFF",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {st.done && <span style={{color:"#fff",fontSize:11,fontWeight:900}}>✓</span>}
                </div>
                <span style={{flex:1,fontSize:14,color:st.done?TT.textFaint:TT.text,textDecoration:st.done?"line-through":"none"}}>{st.text}</span>
                <button onClick={()=>removeSubtask(st.id)} style={{background:"none",border:"none",color:TT.textFaint,cursor:"pointer",fontSize:14}}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div style={{display:"flex",gap:8}}>
          <input value={newSubtask} onChange={e=>setNewSubtask(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); addSubtask(); } }}
            placeholder="e.g. Confirm bolt sizes, check site access…" style={{...IS_LIGHT,flex:1,fontSize:14}}/>
          <button onClick={addSubtask} style={{background:"#3B5BFF14",border:"1px solid #3B5BFF44",borderRadius:6,padding:"0 14px",color:"#3B5BFF",fontWeight:800,cursor:"pointer",fontSize:13}}>+ Add</button>
        </div>
      </Field>

      <div style={{display:"flex",gap:10,marginTop:6}}>
        {initial && onDelete && (
          <button onClick={deleteEvent} title="Delete (or press Delete/Backspace)" style={{padding:"10px 14px",background:"#EF444414",border:"1px solid #EF444444",borderRadius:6,color:"#EF4444",cursor:"pointer",fontSize:13,fontWeight:700}}>🗑 Delete</button>
        )}
        <button onClick={save} disabled={!canSave}
          style={{flex:1,background:canSave?"#3B5BFF":"#E5E7EB",border:"none",borderRadius:6,padding:"10px 0",color:"#fff",fontWeight:800,cursor:canSave?"pointer":"not-allowed",fontSize:13}}>
          {initial ? "Save Changes" : "+ Add to Calendar"}
        </button>
        <button onClick={onClose} style={{padding:"10px 16px",background:"transparent",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",fontSize:13}}>Cancel</button>
      </div>
      </div>
  );

  // Anchored next to whatever was clicked when we have a rect to work with (matches
  // TickTick's "blends into the view" behaviour) — falls back to a centered modal
  // for entry points with no sensible anchor (e.g. the "+ Add" row inside another modal).
  return anchorRect ? (
    <AnchoredPanel anchorRect={anchorRect} width={400} title={title} onClose={onClose}>
      {body}
    </AnchoredPanel>
  ) : (
    <Modal title={title} onClose={onClose} light>
      {body}
    </Modal>
  );
}

function fmtTime12(hhmm) {
  if (!hhmm) return null;
  const [h,m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2,"0")} ${period}`;
}
function fmtDuration(min) {
  if (!min) return null;
  if (min < 60) return `${min}m`;
  const h = Math.floor(min/60), m = min%60;
  return m===0 ? `${h}h` : `${h}h ${m}m`;
}
// "9:00 AM – 10:00 AM (1h)" — start, end (derived from duration), and total in brackets.
// When eventTz/eventDate are given and differ from this device's zone, appends the
// viewer's local equivalent so cross-timezone teammates never misread whose clock it is.
function fmtTimeRange(startTime, durationMin, eventTz, eventDate) {
  if (!startTime) return null;
  const start = fmtTime12(startTime);
  const [h,m] = startTime.split(":").map(Number);
  const endTotal = h*60 + m + (durationMin||0);
  const end = durationMin ? fmtTime12(`${String(Math.floor(endTotal/60)%24).padStart(2,"0")}:${String(endTotal%60).padStart(2,"0")}`) : null;
  const base = end ? `${start} – ${end} (${fmtDuration(durationMin)})` : start;
  if (!eventTz || !eventDate || eventTz === DEVICE_TZ) return base;
  const converted = convertWallTime(eventDate, startTime, eventTz, DEVICE_TZ);
  return `${base} · ${fmtTime12(converted.time)} your time`;
}

function DayDetailModal({ date, member, events, projects, currentUser, onAdd, onEdit, onRemove, onToggleDone, onReorder, onToggleSubtask, onClose }) {
  const { memberColor: MEMBER_COLOR, isAdmin } = useTeam();
  const mc = MEMBER_COLOR[member];
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  // Sort: by explicit order field, falling back to insertion order
  const sorted = events.slice().sort((a,b)=>(a.order??0)-(b.order??0));
  const doneCount = sorted.filter(e=>e.done).length;

  const handleDrop = (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return; }
    const ids = sorted.map(e=>e.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(targetId);
    const reordered = ids.slice();
    reordered.splice(fromIdx,1);
    reordered.splice(toIdx,0,dragId);
    onReorder(reordered);
    setDragId(null); setOverId(null);
  };

  return (
    <Modal title={`${member}'s schedule`} onClose={onClose} light>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,padding:"10px 12px",background:"#F7F8FA",borderRadius:6,borderLeft:`3px solid ${mc}`}}>
        <span style={{fontSize:13,color:TT.text}}>{new Date(date+"T00:00:00").toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</span>
        {sorted.length>0 && <span style={{fontSize:11,color:TT.textSub,fontWeight:700}}>{doneCount}/{sorted.length} done</span>}
      </div>

      {sorted.length===0 ? (
        <div style={{textAlign:"center",color:TT.textFaint,padding:"20px 0",fontSize:13}}>Nothing scheduled yet.</div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
          {sorted.map(ev => {
            const proj = projects.find(p=>p.id===ev.projectId);
            const timeRange = fmtTimeRange(ev.startTime, ev.durationMin, ev.tz, ev.date);
            const isOver = overId === ev.id && dragId !== ev.id;
            return (
              <div key={ev.id}
                draggable
                onDragStart={()=>setDragId(ev.id)}
                onDragOver={e=>{ e.preventDefault(); if(overId!==ev.id) setOverId(ev.id); }}
                onDragLeave={()=>setOverId(o=>o===ev.id?null:o)}
                onDrop={()=>handleDrop(ev.id)}
                onDragEnd={()=>{ setDragId(null); setOverId(null); }}
                style={{
                  display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",
                  background:ev.done?"#F7F8FA":"#FFFFFF",borderRadius:7,
                  border:isOver?"1px dashed #3B5BFF":`1px solid ${TT.border}`,
                  opacity:dragId===ev.id?0.4:1,
                  cursor:"grab",
                }}>
                <div title="Drag to reorder or move days" style={{color:TT.textFaint,fontSize:13,paddingTop:2,cursor:"grab",userSelect:"none"}}>⠿</div>

                {/* Checkbox */}
                <div onClick={()=>onToggleDone(ev.id)} style={{width:18,height:18,borderRadius:4,border:`1.5px solid ${ev.done?mc:"#B9BFC8"}`,background:ev.done?mc:"#FFFFFF",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",marginTop:1}}>
                  {ev.done && <span style={{color:"#fff",fontSize:11,fontWeight:900}}>✓</span>}
                </div>

                <div onClick={e=>onEdit(ev, e.currentTarget.getBoundingClientRect())} style={{flex:1,minWidth:0,cursor:"pointer"}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:3}}>
                    <span style={{fontSize:11,fontFamily:"monospace",fontWeight:900,color:mc,background:`${mc}16`,border:`1px solid ${mc}44`,borderRadius:4,padding:"1px 7px"}}>{proj?.jobCode||"—"}</span>
                    {timeRange && <span style={{fontSize:10,fontWeight:700,color:"#3B5BFF",background:"#3B5BFF14",borderRadius:4,padding:"1px 6px"}}>🕐 {timeRange}</span>}
                  </div>
                  <div style={{fontSize:12,color:ev.done?TT.textFaint:TT.text,fontWeight:600,textDecoration:ev.done?"line-through":"none"}}>{ev.task || proj?.name || "(deleted project)"}</div>
                  {ev.task && proj?.name && (
                    <div style={{fontSize:11,color:TT.textFaint}}>{proj.name}</div>
                  )}
                  {(ev.subtasks||[]).length > 0 && (
                    <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:3}} onClick={e=>e.stopPropagation()}>
                      {ev.subtasks.map(st => (
                        <div key={st.id} onClick={()=>onToggleSubtask(ev.id, st.id)} style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
                          <div style={{width:13,height:13,borderRadius:3,border:`1.5px solid ${st.done?mc:"#B9BFC8"}`,background:st.done?mc:"#FFFFFF",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                            {st.done && <span style={{color:"#fff",fontSize:8,fontWeight:900}}>✓</span>}
                          </div>
                          <span style={{fontSize:11,color:st.done?TT.textFaint:TT.textSub,textDecoration:st.done?"line-through":"none"}}>{st.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{fontSize:10,color:TT.textFaint,marginTop:4}}>Added by {ev.createdBy}</div>
                </div>
                {(!ev.inboxItemType || ev.createdBy===currentUser || isAdmin(currentUser)) && (
                  <button onClick={()=>onRemove(ev.id)} title="Remove" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14,flexShrink:0}}>✕</button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div style={{fontSize:11,color:TT.textFaint,textAlign:"center",marginBottom:10}}>⠿ Drag a task to reorder, or drag it onto another day on the calendar to move it</div>
      {date >= TODAY && <button onClick={e=>onAdd(e.currentTarget.getBoundingClientRect())} style={{width:"100%",background:"#3B5BFF14",border:"1px solid #3B5BFF",color:"#3B5BFF",borderRadius:6,padding:"9px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>+ Add Project</button>}
    </Modal>
  );
}

function AllDayDetailModal({ date, events, projects, currentUser, onAddFor, onRemove, onClose }) {
  const { teamNames: TEAM, memberColor: MEMBER_COLOR } = useTeam();
  const [addingFor, setAddingFor] = useState(null); // member name | null — shows EventModal nested
  const [addAnchorRect, setAddAnchorRect] = useState(null);
  const byMember = TEAM.map(m => ({ member:m, items: events.filter(e=>e.member===m) }));
  return (
    <Modal title="📅 Team schedule" onClose={onClose} wide light>
      <div style={{fontSize:13,color:TT.text,marginBottom:16,padding:"10px 12px",background:"#F7F8FA",borderRadius:6,borderLeft:"3px solid #3B5BFF"}}>
        {new Date(date+"T00:00:00").toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:14,marginBottom:6,maxHeight:420,overflowY:"auto"}}>
        {byMember.map(({member,items}) => {
          const mc = MEMBER_COLOR[member];
          return (
            <div key={member}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:mc,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:900,color:"#fff"}}>{member.slice(0,2)}</div>
                  <span style={{fontSize:13,fontWeight:800,color:mc}}>{member}</span>
                  <span style={{fontSize:11,color:TT.textFaint}}>{items.length} item{items.length!==1?"s":""}</span>
                </div>
                {date >= TODAY && <button onClick={e=>{ setAddingFor(member); setAddAnchorRect(e.currentTarget.getBoundingClientRect()); }} style={{background:"none",border:"none",color:"#3B5BFF",cursor:"pointer",fontSize:11,fontWeight:700}}>+ Add</button>}
              </div>
              {items.length===0 ? (
                <div style={{fontSize:11,color:TT.textFaint,paddingLeft:30,marginBottom:4}}>Nothing scheduled</div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:6,paddingLeft:0}}>
                  {items.map(ev => {
                    const proj = projects.find(p=>p.id===ev.projectId);
                    const timeRange = fmtTimeRange(ev.startTime, ev.durationMin, ev.tz, ev.date);
                    return (
                      <div key={ev.id} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"8px 12px",background:ev.done?"#F7F8FA":"#FFFFFF",borderRadius:7,border:`1px solid ${mc}33`,borderLeft:`3px solid ${mc}`}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:2,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontFamily:"monospace",fontWeight:900,color:mc,background:`${mc}16`,border:`1px solid ${mc}44`,borderRadius:4,padding:"1px 6px"}}>{proj?.jobCode||"—"}</span>
                            {timeRange && <span style={{fontSize:10,fontWeight:700,color:"#3B5BFF"}}>🕐 {timeRange}</span>}
                            {ev.done && <span style={{fontSize:9,fontWeight:800,color:"#22A06B"}}>✓ done</span>}
                          </div>
                          <div style={{fontSize:13,color:ev.done?TT.textFaint:TT.text,fontWeight:600,textDecoration:ev.done?"line-through":"none"}}>{ev.task || proj?.name || "(deleted project)"}</div>
                          {ev.task && proj?.name && (
                            <div style={{fontSize:11,color:TT.textFaint}}>{proj.name}</div>
                          )}
                          {(ev.subtasks||[]).length > 0 && (
                            <div style={{fontSize:11,color:ev.subtasks.every(s=>s.done)?"#22A06B":TT.textSub,marginTop:2,fontWeight:700}}>
                              ☑ {ev.subtasks.filter(s=>s.done).length}/{ev.subtasks.length} subtasks
                            </div>
                          )}
                        </div>
                        <button onClick={()=>onRemove(ev.id)} title="Remove" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13,flexShrink:0}}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {addingFor && (
        <EventModal
          date={date}
          member={addingFor}
          projects={projects}
          anchorRect={addAnchorRect}
          minDate={TODAY}
          onSave={({date,projectId,task,subtasks,startTime,durationMin})=>{ onAddFor(addingFor,{date,projectId,task,subtasks,startTime,durationMin}); setAddingFor(null); setAddAnchorRect(null); }}
          onClose={()=>{ setAddingFor(null); setAddAnchorRect(null); }}
        />
      )}
    </Modal>
  );
}

// ═════════════════════════════════════════════════
// TEAM TIMELINE — every event, every member, all time
// Grouped by date, sorted chronologically, Past/Today/Upcoming sectioned
// ═════════════════════════════════════════════════
function TeamTimeline({ calendarEvents, projects, onRemove, onDayClick }) {
  const { memberColor: MEMBER_COLOR } = useTeam();
  const [range, setRange] = useState("upcoming"); // "all" | "upcoming" | "past"

  // Group all events by date
  const byDate = {};
  calendarEvents.forEach(e => { (byDate[e.date] = byDate[e.date]||[]).push(e); });
  let dates = Object.keys(byDate).sort(); // chronological ascending

  if (range === "upcoming") dates = dates.filter(d => d >= TODAY);
  else if (range === "past") dates = dates.filter(d => d < TODAY);
  // "all" — no filter

  if (range === "past") dates = dates.slice().reverse(); // most recent past first

  const fmtFull = d => new Date(d+"T00:00:00").toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short",year:"numeric"});

  return (
    <div>
      {/* Range filter */}
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {[["upcoming","Upcoming"],["past","Past"],["all","All time"]].map(([key,label]) => (
          <button key={key} onClick={()=>setRange(key)} style={{
            padding:"5px 12px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:700,
            background:range===key?"#3B5BFF14":"transparent",
            border:`1px solid ${range===key?"#3B5BFF":TT.border}`,
            color:range===key?"#3B5BFF":TT.textSub,
          }}>{label}</button>
        ))}
      </div>

      {dates.length === 0 ? (
        <div style={{textAlign:"center",color:TT.textFaint,padding:"50px 0",fontSize:13}}>
          {range==="upcoming" ? "Nothing scheduled going forward." : range==="past" ? "No past entries." : "Nothing on the calendar yet."}
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:10,maxHeight:600,overflowY:"auto",paddingRight:4}}>
          {dates.map(d => {
            const events = byDate[d].slice().sort((a,b)=>a.member.localeCompare(b.member));
            const today = isToday(d);
            const isPast = d < TODAY;
            return (
              <div key={d} style={{background:"#FFFFFF",border:`1px solid ${today?"#3B5BFF":TT.border}`,borderRadius:9,overflow:"hidden"}}>
                <div onClick={()=>onDayClick(d)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 14px",background:today?"#3B5BFF0F":"#F7F8FA",cursor:"pointer"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:13,fontWeight:800,color:today?"#3B5BFF":isPast?TT.textSub:TT.text}}>{fmtFull(d)}</span>
                    {today && <span style={{fontSize:9,fontWeight:800,color:"#3B5BFF",background:"#3B5BFF1A",borderRadius:3,padding:"1px 6px"}}>TODAY</span>}
                    {isPast && !today && <span style={{fontSize:9,fontWeight:700,color:TT.textSub,background:"#E7E9EC",borderRadius:3,padding:"1px 6px"}}>PAST</span>}
                  </div>
                  <span style={{fontSize:11,color:TT.textFaint}}>{events.length} item{events.length!==1?"s":""}</span>
                </div>
                <div style={{padding:"8px 14px 12px",display:"flex",flexDirection:"column",gap:6}}>
                  {events.map(ev => {
                    const proj = projects.find(p=>p.id===ev.projectId);
                    const mc = MEMBER_COLOR[ev.member];
                    const timeRange = fmtTimeRange(ev.startTime, ev.durationMin, ev.tz, ev.date);
                    return (
                      <div key={ev.id} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"7px 10px",background:ev.done?"#F7F8FA":"#FFFFFF",borderRadius:6,borderLeft:`3px solid ${mc}`}}>
                        <div style={{width:18,height:18,borderRadius:"50%",background:mc,display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,fontWeight:900,color:"#fff",flexShrink:0,marginTop:1}}>{ev.member.slice(0,2)}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:2}}>
                            <span style={{fontSize:11,fontWeight:800,color:mc}}>{ev.member}</span>
                            <span style={{fontSize:10,fontFamily:"monospace",fontWeight:900,color:mc,background:`${mc}16`,border:`1px solid ${mc}44`,borderRadius:4,padding:"1px 6px"}}>{proj?.jobCode||"—"}</span>
                            {timeRange && <span style={{fontSize:10,fontWeight:700,color:"#3B5BFF"}}>🕐 {timeRange}</span>}
                            {ev.done && <span style={{fontSize:9,fontWeight:800,color:"#22A06B"}}>✓ done</span>}
                          </div>
                          <div style={{fontSize:13,color:ev.done?TT.textFaint:TT.text,textDecoration:ev.done?"line-through":"none"}}>{ev.task || proj?.name || "(deleted project)"}</div>
                          {ev.task && proj?.name && (
                            <div style={{fontSize:11,color:TT.textFaint}}>{proj.name}</div>
                          )}
                          {(ev.subtasks||[]).length > 0 && (
                            <div style={{fontSize:11,color:ev.subtasks.every(s=>s.done)?"#22A06B":TT.textSub,marginTop:2,fontWeight:700}}>
                              ☑ {ev.subtasks.filter(s=>s.done).length}/{ev.subtasks.length} subtasks
                            </div>
                          )}
                        </div>
                        <button onClick={()=>onRemove(ev.id)} title="Remove" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13,flexShrink:0}}>✕</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════
// DAY HOUR VIEW — TickTick-style vertical 24h column
// Tasks positioned/sized by start time + duration.
// Hour range is adjustable (Work Hours / Full 24h / Custom).
// ═════════════════════════════════════════════════
const HOUR_PX = 44; // pixel height per hour row (smaller = more visible hours per screen)

function hourLabel(h) {
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}

// ═════════════════════════════════════════════════
// QUICK ADD CARD — inline, in-grid task creation.
// Renders directly on the hour grid at the drawn position —
// no modal, no backdrop. TickTick-style "blend into the view" entry.
// ═════════════════════════════════════════════════
// Relative-day label exactly like TickTick's quick-add header ("Today", "Tomorrow", "2 days ago"…)
function relativeDayLabel(dateYmd) {
  const diff = Math.round((new Date(dateYmd+"T00:00:00") - new Date(TODAY+"T00:00:00")) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return diff > 0 ? `in ${diff} days` : `${Math.abs(diff)} days ago`;
}
const fmtDayMonth = dateYmd => new Date(dateYmd+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short"});

function QuickAddCard({ date, top, height, left, width, startTime, durationMin, projects, member, onConfirm, onMoreDetails, onCancel }) {
  const activeProjects = projects
    .filter(p => p.status !== "Completed" && p.status !== "ON HOLD")
    .sort((a, b) => (a.jobCode || "").localeCompare(b.jobCode || "", undefined, { numeric: true, sensitivity: "base" }));
  const [task, setTask] = useState("");
  const [projectId, setProjectId] = useState("");
  const inputRef = useRef(null);
  const cardRef = useRef(null);

  useEffect(() => {
    // Autofocus the task input so the user can start typing immediately
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleOutside = e => {
      if (cardRef.current && !cardRef.current.contains(e.target)) onCancel();
    };
    // Slight delay so the triggering pointerup doesn't immediately dismiss the card
    const t = setTimeout(() => document.addEventListener("mousedown", handleOutside), 50);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", handleOutside); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A project link is optional — a manual task on its own is enough to save
  const canSave = !!projectId || !!task.trim();
  const confirm = () => { if (canSave) onConfirm(projectId, task); };
  const moreDetails = () => { if (canSave) onMoreDetails(projectId, task, cardRef.current?.getBoundingClientRect()); };

  return (
    <div ref={cardRef}
      onClick={e=>e.stopPropagation()}
      onPointerDown={e=>e.stopPropagation()}
      style={{
        position:"absolute", top, height:Math.max(height,180), left, width,
        background:"#FFFFFF", border:"none", borderRadius:10,
        zIndex:20, boxShadow:TT.shadow, padding:"12px 14px",
        display:"flex", flexDirection:"column", gap:10, boxSizing:"border-box",
      }}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:TT.textSub}}>
          <span>📅</span>
          <span>{date ? `${relativeDayLabel(date)}, ${fmtDayMonth(date)}, ` : ""}{fmtTime12(startTime)}</span>
        </div>
        <span style={{color:TT.textFaint,fontSize:13}}>🚩</span>
      </div>
      <input ref={inputRef} type="text" value={task} onChange={e=>setTask(e.target.value)}
        onKeyDown={e=>{ if(e.key==="Enter") confirm(); if(e.key==="Escape") onCancel(); }}
        placeholder="What would you like to do?"
        style={{background:"transparent",border:"none",color:TT.text,fontSize:16,outline:"none",minWidth:0,padding:0}}/>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:12,color:TT.textFaint,flexShrink:0}}>📁</span>
        <select value={projectId} onChange={e=>setProjectId(e.target.value)}
          style={{flex:1,background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:5,padding:"4px 6px",color:projectId?TT.text:TT.textFaint,fontSize:13,outline:"none",minWidth:0}}>
          <option value="">No project — manual task</option>
          {activeProjects.map(p => <option key={p.id} value={p.id}>{p.jobCode||"—"} — {p.name}</option>)}
        </select>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingTop:8,borderTop:`1px solid ${TT.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:TT.textSub}}>
          <span>🕐</span>
          <span>{fmtTimeRange(startTime, durationMin)}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button onClick={moreDetails} disabled={!canSave} title="More options" style={{
            background:"none",border:"none",color:TT.textSub,fontSize:15,cursor:canSave?"pointer":"not-allowed",padding:0,
          }}>⋯</button>
          <button onClick={confirm} disabled={!canSave} title="Add" style={{
            background:"none",border:"none",color:canSave?"#3B5BFF":TT.textFaint,fontSize:18,fontWeight:700,cursor:canSave?"pointer":"not-allowed",padding:0,lineHeight:1,
          }}>➤</button>
        </div>
      </div>
    </div>
  );
}

// Right-click menu for a task block — Edit / Delete. Also doubles as the "selection"
// for keyboard Delete/Backspace: opening it on an event marks that event selected,
// so pressing Delete works whether or not the menu itself is still open.
function TaskContextMenu({ x, y, onEdit, onDelete, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return (
    <div ref={ref} onClick={e=>e.stopPropagation()} style={{
      position:"fixed", top:y, left:x, zIndex:2000, background:"#FFFFFF", border:`1px solid ${TT.border}`,
      borderRadius:8, padding:4, minWidth:130, boxShadow:TT.shadow,
    }}>
      <button onClick={()=>{onEdit();onClose();}} style={{display:"flex",alignItems:"center",gap:8,width:"100%",textAlign:"left",padding:"7px 10px",borderRadius:5,border:"none",background:"transparent",color:TT.text,fontSize:12,fontWeight:600,cursor:"pointer"}}>✎ Edit</button>
      {onDelete ? (
        <button onClick={()=>{onDelete();onClose();}} style={{display:"flex",alignItems:"center",gap:8,width:"100%",textAlign:"left",padding:"7px 10px",borderRadius:5,border:"none",background:"transparent",color:"#EF4444",fontSize:12,fontWeight:600,cursor:"pointer"}}>🗑 Delete</button>
      ) : (
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",color:"#94A3B8",fontSize:12,fontWeight:600,userSelect:"none"}} title="Only the assigner or an admin can delete this scheduled item">🔒 Delete</div>
      )}
      <div style={{fontSize:9,color:TT.textFaint,padding:"4px 10px 2px",borderTop:`1px solid ${TT.border}`,marginTop:2}}>{onDelete ? "or press Delete" : "scheduled — protected"}</div>
    </div>
  );
}

function DayHourView({ date, events, projects, member, currentUser, hourRange, onAddAt, onEdit, onToggleDone, onRemove, onMoveTime, onResize, onToggleSubtask, draggingInboxItem, onDropInboxItem, onCopyEvent, onGcalClick }) {
  const { memberColor: MEMBER_COLOR, isAdmin } = useTeam();
  const [contextMenu, setContextMenu] = useState(null); // {x, y, ev} | null — also acts as the "selected" event for keyboard delete
  const mc = MEMBER_COLOR[member];
  const scrollRef = useRef(null);
  const areaRef = useRef(null);
  const wasMovedRef = useRef(false); // tracks if the last interaction involved real movement, to suppress the click-to-edit that follows a drag
  const [ctrlHeld, setCtrlHeld] = useState(false);
  useEffect(() => {
    const h = e => setCtrlHeld(e.ctrlKey || e.metaKey);
    window.addEventListener("keydown", h);
    window.addEventListener("keyup", h);
    return () => { window.removeEventListener("keydown", h); window.removeEventListener("keyup", h); };
  }, []);

  // Unified pointer-interaction state machine:
  // mode: null | "draw" (creating new) | "move" (dragging existing) | "resize" (stretching bottom edge)
  const [interaction, setInteraction] = useState(null);
  // { mode, id?, startY, startTop, startHeight, currentTop, currentHeight }
  const [quickAdd, setQuickAdd] = useState(null); // { top, height, startTime, durationMin } | null — inline create card

  const timed = events.filter(e => e.startTime);
  const untimed = events.filter(e => !e.startTime);

  const hours = [];
  for (let h = hourRange.start; h < hourRange.end; h++) hours.push(h);
  const totalHeight = hours.length * HOUR_PX;

  const timeToOffset = (hhmm) => {
    const [h,m] = hhmm.split(":").map(Number);
    return (h + m/60 - hourRange.start) * HOUR_PX;
  };
  const offsetToTime = (offsetPx) => {
    const decimalHour = hourRange.start + offsetPx / HOUR_PX;
    const clamped = Math.max(hourRange.start, Math.min(hourRange.end, decimalHour));
    const snapped = Math.round(clamped * 4) / 4; // snap to 15 min
    const h = Math.floor(snapped);
    const m = Math.round((snapped - h) * 60);
    const mm = m === 60 ? 0 : m, hh = m === 60 ? h+1 : h;
    return `${String(Math.min(hh,23)).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
  };
  const minutesBetween = (px) => Math.max(15, Math.round(px / HOUR_PX * 60 / 15) * 15);

  const getOffsetY = (clientY) => {
    const rect = areaRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(totalHeight, clientY - rect.top));
  };

  // ── Pointer handlers for the empty grid area: draw-to-create ──
  const handleAreaPointerDown = e => {
    if (e.target !== e.currentTarget) return; // only on truly empty space
    const y = getOffsetY(e.clientY);
    const snappedTop = Math.round(y / (HOUR_PX/4)) * (HOUR_PX/4);
    setInteraction({ mode:"draw", startY:y, startTop:snappedTop, currentTop:snappedTop, currentHeight:HOUR_PX/4 });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  // ── Pointer handlers for existing task blocks: move or resize ──
  const beginMove = (e, ev, top, height) => {
    e.preventDefault(); // prevent text selection during drag
    e.stopPropagation();
    const y = getOffsetY(e.clientY);
    setInteraction({ mode:"move", id:ev.id, grabOffset:y-top, startTop:top, currentTop:top, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };
  const beginResize = (e, ev, top, height) => {
    e.preventDefault();
    e.stopPropagation();
    setInteraction({ mode:"resize", id:ev.id, startTop:top, currentTop:top, startHeight:height, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };
  // Dragging the top edge moves the start time while keeping the end time fixed —
  // the bottom edge stays anchored at top+height as the user drags.
  const beginResizeTop = (e, ev, top, height) => {
    e.preventDefault();
    e.stopPropagation();
    setInteraction({ mode:"resizeTop", id:ev.id, startTop:top, currentTop:top, fixedBottom:top+height, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = e => {
    if (!interaction) return;
    const y = getOffsetY(e.clientY);
    if (interaction.mode === "draw") {
      const top = Math.min(interaction.startTop, y);
      const rawHeight = Math.abs(y - interaction.startTop);
      const snappedHeight = Math.max(HOUR_PX/4, Math.round(rawHeight / (HOUR_PX/4)) * (HOUR_PX/4));
      setInteraction(i => ({ ...i, currentTop: Math.round(top/(HOUR_PX/4))*(HOUR_PX/4), currentHeight: snappedHeight, moved:true }));
    } else if (interaction.mode === "move") {
      const rawTop = y - interaction.grabOffset;
      const snappedTop = Math.max(0, Math.min(totalHeight-interaction.currentHeight, Math.round(rawTop/(HOUR_PX/4))*(HOUR_PX/4)));
      setInteraction(i => ({ ...i, currentTop: snappedTop, moved: i.moved || snappedTop !== i.startTop }));
    } else if (interaction.mode === "resize") {
      const rawHeight = y - interaction.startTop;
      const snappedHeight = Math.max(HOUR_PX/4, Math.round(rawHeight/(HOUR_PX/4))*(HOUR_PX/4));
      setInteraction(i => ({ ...i, currentHeight: Math.min(snappedHeight, totalHeight-i.startTop), moved: i.moved || snappedHeight !== i.startHeight }));
    } else if (interaction.mode === "resizeTop") {
      const snappedTop = Math.max(0, Math.min(interaction.fixedBottom-HOUR_PX/4, Math.round(y/(HOUR_PX/4))*(HOUR_PX/4)));
      const newHeight = interaction.fixedBottom - snappedTop;
      setInteraction(i => ({ ...i, currentTop: snappedTop, currentHeight: newHeight, moved: i.moved || snappedTop !== i.startTop }));
    }
  };

  const handlePointerUp = e => {
    if (!interaction) return;
    const isCopy = (e.ctrlKey || e.metaKey) && onCopyEvent;
    if (interaction.mode === "draw") {
      // A draw with no real movement defaults to a 60-min slot; either way, show the inline quick-add card
      const startTime = offsetToTime(interaction.currentTop);
      const durationMin = interaction.moved ? minutesBetween(interaction.currentHeight) : 60;
      const height = interaction.moved ? interaction.currentHeight : HOUR_PX;
      setQuickAdd({ top: interaction.moved ? interaction.currentTop : interaction.startTop, height, startTime, durationMin });
    } else if (interaction.mode === "move" && interaction.moved) {
      const newTime = offsetToTime(interaction.currentTop);
      isCopy ? onCopyEvent(interaction.id, { startTime: newTime }) : onMoveTime(interaction.id, newTime);
    } else if (interaction.mode === "resize" && interaction.moved) {
      onResize(interaction.id, minutesBetween(interaction.currentHeight));
    } else if (interaction.mode === "resizeTop" && interaction.moved) {
      const newTime = offsetToTime(interaction.currentTop);
      if (isCopy) { onCopyEvent(interaction.id, { startTime: newTime }); } else { onMoveTime(interaction.id, newTime); onResize(interaction.id, minutesBetween(interaction.currentHeight)); }
    }
    // Clear interaction one tick later so the click handler (which fires right after
    // pointerup) can still read `wasMoved` via the ref below to decide whether to open edit.
    wasMovedRef.current = interaction.mode !== "draw" && interaction.moved;
    setInteraction(null);
  };

  // Simple lane assignment for overlapping tasks (side-by-side columns)
  const positioned = timed.map(ev => {
    const top = timeToOffset(ev.startTime);
    const height = Math.max(14, (ev.durationMin||60) / 60 * HOUR_PX - 2);
    return { ev, top, height };
  }).sort((a,b)=>a.top-b.top);
  const lanes = [];
  positioned.forEach(item => {
    let lane = lanes.findIndex(l => l.every(o => item.top >= o.top+o.height || item.top+item.height <= o.top));
    if (lane === -1) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push(item);
    item.lane = lane;
  });
  const laneCount = Math.max(1, lanes.length);

  const now = new Date();
  const isViewingToday = date === ymd(now);
  const nowOffset = (now.getHours() + now.getMinutes()/60 - hourRange.start) * HOUR_PX;
  const showNowLine = isViewingToday && now.getHours() >= hourRange.start && now.getHours() < hourRange.end;

  useEffect(() => {
    if (scrollRef.current) {
      const target = isViewingToday ? Math.max(0, nowOffset - 120) : 0;
      scrollRef.current.scrollTop = target;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // Delete/Backspace removes whichever task was right-clicked (selected via the context menu),
  // as long as focus isn't in a text field.
  useEffect(() => {
    if (!contextMenu) return;
    const handler = e => {
      if ((e.key==="Delete"||e.key==="Backspace") && !["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) {
        e.preventDefault();
        onRemove(contextMenu.ev.id);
        setContextMenu(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [contextMenu, onRemove]);

  // Apply a global grabbing cursor + userSelect:none while dragging so the
  // cursor stays consistent even if the pointer drifts off the task block.
  useEffect(() => {
    const active = interaction?.mode === "move" || interaction?.mode === "resize" || interaction?.mode === "resizeTop";
    if (active) {
      document.body.style.cursor = interaction.mode === "move" ? "grabbing" : "ns-resize";
      document.body.style.userSelect = "none";
    } else {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    return () => { document.body.style.cursor = ""; document.body.style.userSelect = ""; };
  }, [interaction?.mode]);

  return (
    <div>
      {/* Unscheduled tray */}
      {untimed.length > 0 && (
        <div style={{marginBottom:12,padding:"10px 12px",background:TT.panel,border:`1px solid ${TT.border}`,borderRadius:8}}>
          <div style={{fontSize:10,fontWeight:800,color:TT.textSub,textTransform:"uppercase",marginBottom:7}}>Unscheduled ({untimed.length})</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {untimed.map(ev => {
              const proj = projects.find(p=>p.id===ev.projectId);
              return (
                <div key={ev.id} onClick={e=>onEdit(ev, e.currentTarget.getBoundingClientRect())} style={{
                  display:"flex",alignItems:"center",gap:6,padding:"5px 9px",borderRadius:6,cursor:"pointer",
                  background:ev.done?"#F7F8FA":`${mc}1A`, border:`1px solid ${ev.done?TT.border:mc+"33"}`,
                }}>
                  <div onClick={e=>{e.stopPropagation();onToggleDone(ev.id);}} style={{width:14,height:14,borderRadius:3,border:`1.5px solid ${ev.done?"#C2C7D0":"#B9BFC8"}`,background:ev.done?"#C2C7D0":"#FFFFFF",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {ev.done && <span style={{color:"#fff",fontSize:9,fontWeight:900}}>✓</span>}
                  </div>
                  <span style={{fontSize:11,fontFamily:"monospace",fontWeight:800,color:ev.done?TT.textFaint:mc,textDecoration:ev.done?"line-through":"none"}}>{proj?.jobCode||"—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Hour grid */}
      <div ref={scrollRef} style={{position:"relative",height:"calc(100vh - 140px)",overflowY:"auto",border:`1px solid ${TT.border}`,borderRadius:10,background:TT.bg}}>
        <div style={{position:"relative",height:totalHeight,display:"flex"}}>
          {/* Hour labels column */}
          <div style={{width:54,flexShrink:0,borderRight:`1px solid ${TT.border}`}}
            onWheel={e=>{ if (scrollRef.current) { scrollRef.current.scrollTop += e.deltaY; e.stopPropagation(); } }}>
            {hours.map(h => (
              <div key={h} style={{height:HOUR_PX,boxSizing:"border-box",borderTop:`1px solid ${TT.border}`,paddingTop:2,paddingRight:8,textAlign:"right"}}>
                <span style={{fontSize:10,color:TT.textSub,fontWeight:600}}>{hourLabel(h)}</span>
              </div>
            ))}
          </div>

          {/* Task area */}
          <div
            ref={areaRef}
            style={{position:"relative",flex:1,touchAction:"none",cursor:interaction?.mode==="draw"?"ns-resize":"default"}}
            onPointerDown={e=>{ if(!quickAdd) handleAreaPointerDown(e); }}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={()=>setInteraction(null)}
            onWheel={e=>{ if (!interaction && scrollRef.current) { scrollRef.current.scrollTop += e.deltaY; e.stopPropagation(); } }}
            onDragOver={e=>{ if(draggingInboxItem){ e.preventDefault(); e.dataTransfer.dropEffect=date>=TODAY?"move":"none"; } }}
            onDrop={e=>{ if(!draggingInboxItem||date<TODAY) return; e.preventDefault(); const offsetY=getOffsetY(e.clientY); onDropInboxItem?.(date,offsetToTime(offsetY)); }}
          >
            {/* Hour gridlines */}
            {hours.map(h => (
              <div key={h} style={{position:"absolute",top:(h-hourRange.start)*HOUR_PX,left:0,right:0,height:HOUR_PX,borderTop:`1px solid ${TT.border}`,boxSizing:"border-box",pointerEvents:"none"}}/>
            ))}
            {/* Half-hour faint lines */}
            {hours.map(h => (
              <div key={"h"+h} style={{position:"absolute",top:(h-hourRange.start)*HOUR_PX+HOUR_PX/2,left:0,right:0,height:0,borderTop:`1px solid ${TT.border}`,pointerEvents:"none"}}/>
            ))}

            {/* Now indicator — thin coral line, no dot (matches TickTick) */}
            {showNowLine && (
              <div style={{position:"absolute",top:nowOffset,left:0,right:0,height:1.5,background:TT.now,zIndex:5,pointerEvents:"none"}}/>
            )}

            {/* Selected-slot bar — live while drawing, sticks while the quick-add card is open */}
            {(interaction?.mode==="draw" || quickAdd) && (
              <div style={{
                position:"absolute",
                top: quickAdd ? quickAdd.top : interaction.currentTop,
                height: quickAdd ? quickAdd.height : interaction.currentHeight,
                left:3, right:3,
                background:"#3B5BFF", borderRadius:6, zIndex:8, pointerEvents:"none",
                display:"flex", alignItems:"center", paddingLeft:8,
              }}>
                <span style={{fontSize:11,fontWeight:700,color:"#fff"}}>
                  {fmtTime12(offsetToTime(quickAdd ? quickAdd.top : interaction.currentTop))}
                </span>
              </div>
            )}

            {/* Inline quick-add card — replaces the old popup modal for the common case */}
            {quickAdd && (
              <QuickAddCard
                date={date}
                top={quickAdd.top} height={quickAdd.height} left={3} width="calc(100% - 6px)"
                startTime={quickAdd.startTime} durationMin={quickAdd.durationMin}
                projects={projects} member={member}
                onConfirm={(projectId,task)=>{
                  onAddAt(quickAdd.startTime, quickAdd.durationMin, { projectId, task, quick:true });
                  setQuickAdd(null);
                }}
                onMoreDetails={(projectId,task,rect)=>{
                  onAddAt(quickAdd.startTime, quickAdd.durationMin, { projectId, task, quick:false, anchorRect:rect });
                  setQuickAdd(null);
                }}
                onCancel={()=>setQuickAdd(null)}
              />
            )}

            {/* Task blocks */}
            {positioned.map(({ev,top,height,lane}) => {
              const isActive = interaction && interaction.id === ev.id;
              const displayTop = isActive && (interaction.mode==="move"||interaction.mode==="resizeTop") ? interaction.currentTop : top;
              const displayHeight = isActive && (interaction.mode==="resize"||interaction.mode==="resizeTop") ? interaction.currentHeight : height;
              const proj = projects.find(p=>p.id===ev.projectId);
              const widthPct = 100/laneCount;
              const effectiveStart = isActive && (interaction.mode==="move"||interaction.mode==="resizeTop") ? offsetToTime(displayTop) : ev.startTime;
              const effectiveDuration = isActive && (interaction.mode==="resize"||interaction.mode==="resizeTop") ? minutesBetween(displayHeight) : ev.durationMin;
              const timeRange = fmtTimeRange(effectiveStart, effectiveDuration, ev.tz, ev.date);
              const subtasks = ev.subtasks || [];
              const subDone = subtasks.filter(s=>s.done).length;
              if (ev.gcal) return (
                <div key={ev.id}
                  onClick={e=>{ e.stopPropagation(); onGcalClick?.(ev); }}
                  title="Click to view meeting details"
                  style={{
                    position:"absolute", top:displayTop, height:displayHeight, left:`calc(${lane*widthPct}% + 3px)`, width:`calc(${widthPct}% - 6px)`,
                    background:"#7C3AED18", borderLeft:"3px solid #7C3AED", borderTop:"1px solid #7C3AED44", borderRight:"1px solid #7C3AED44", borderBottom:"1px solid #7C3AED44",
                    borderRadius:5, padding:"3px 7px", cursor:"pointer", overflow:"hidden", zIndex:2, boxSizing:"border-box",
                  }}>
                  <div style={{overflow:"hidden",height:"100%"}}>
                    <div style={{fontSize:9,fontWeight:900,color:"#7C3AED",textTransform:"uppercase",letterSpacing:"0.06em",opacity:0.8,marginBottom:1}}>📅 Meeting</div>
                    <div style={{fontSize:13,fontWeight:800,color:"#7C3AED",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ev.task}</div>
                    {timeRange && displayHeight > 36 && (
                      <div style={{fontSize:12,fontWeight:600,color:"#7C3AED",opacity:0.85,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{timeRange}</div>
                    )}
                    {ev.location && displayHeight > 56 && (
                      <div style={{fontSize:10,color:"#64748B",marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>📍 {ev.location}</div>
                    )}
                    {ev.meetLink && displayHeight > 64 && (
                      <div style={{marginTop:3}}>
                        <span style={{fontSize:10,background:"#7C3AED",color:"#fff",borderRadius:4,padding:"2px 8px",fontWeight:700}}>Join</span>
                      </div>
                    )}
                  </div>
                </div>
              );
              return (
                <Fragment key={ev.id}>
                  {/* Ghost at original position while dragging */}
                  {isActive && interaction.mode==="move" && (
                    <div style={{
                      position:"absolute", top, height, left:`calc(${lane*widthPct}% + 3px)`, width:`calc(${widthPct}% - 6px)`,
                      background:`${mc}0C`, border:`1.5px dashed ${mc}40`, borderRadius:5,
                      pointerEvents:"none", zIndex:1, boxSizing:"border-box",
                    }}/>
                  )}
                <div
                  onPointerDown={e=>beginMove(e, ev, top, height)}
                  onClick={e=>{ e.stopPropagation(); if(!wasMovedRef.current) onEdit(ev, e.currentTarget.getBoundingClientRect()); }}
                  onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); setContextMenu({x:e.clientX,y:e.clientY,ev,rect:e.currentTarget.getBoundingClientRect()}); }}
                  title="Drag to reschedule · Ctrl+drag to copy · drag top/bottom edge to resize · click to edit · right-click to delete"
                  style={{
                    position:"absolute", top:displayTop, height:displayHeight, left:`calc(${lane*widthPct}% + 3px)`, width:`calc(${widthPct}% - 6px)`,
                    background:ev.done?"#F7F8FA":`${mc}22`, borderLeft:`3px solid ${ev.done?"#C2C7D0":mc}`,
                    borderRadius:5, padding:"3px 7px 3px 9px",
                    cursor:isActive&&(interaction.mode==="resize"||interaction.mode==="resizeTop")?"ns-resize":isActive&&ctrlHeld?"copy":isActive&&interaction.mode==="move"?"grabbing":"grab",
                    overflow:"visible", zIndex:isActive?9:2,
                    boxShadow:isActive&&interaction.mode==="move"?"0 12px 32px rgba(0,0,0,0.18),0 4px 12px rgba(0,0,0,0.1)":isActive?TT.shadow:"none",
                    touchAction:"none", boxSizing:"border-box", userSelect:"none", transition:"box-shadow 0.15s",
                  }}>
                  {/* Time tooltip during move/resize */}
                  {isActive && interaction.mode !== "draw" && (
                    <div style={{
                      position:"absolute",
                      top: interaction.mode==="resize" ? "auto" : -18,
                      bottom: interaction.mode==="resize" ? -18 : "auto",
                      left:0, background:mc, color:"#fff", fontSize:9, fontWeight:800,
                      padding:"1px 6px", borderRadius:4, pointerEvents:"none", zIndex:20,
                      whiteSpace:"nowrap", boxShadow:"0 1px 4px rgba(0,0,0,0.25)",
                    }}>
                      {interaction.mode==="resize"
                        ? fmtTime12(offsetToTime(displayTop+displayHeight))
                        : fmtTime12(effectiveStart)}
                    </div>
                  )}
                  {isActive && ctrlHeld && interaction.mode==="move" && (
                    <div style={{position:"absolute",top:-7,right:-7,width:16,height:16,borderRadius:"50%",background:"#22C55E",color:"#fff",fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",zIndex:20,pointerEvents:"none",boxShadow:"0 1px 4px rgba(0,0,0,0.25)"}}>+</div>
                  )}
                  <div style={{overflow:"hidden",height:"100%"}}>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      <div onClick={e=>{e.stopPropagation();onToggleDone(ev.id);}} style={{width:16,height:16,borderRadius:3,border:`1.5px solid ${ev.done?"#C2C7D0":"#B9BFC8"}`,background:ev.done?"#C2C7D0":"#FFFFFF",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                        {ev.done && <span style={{color:"#fff",fontSize:10,fontWeight:900}}>✓</span>}
                      </div>
                      <span style={{fontSize:13,fontFamily:"monospace",fontWeight:800,color:ev.done?TT.textFaint:mc,textDecoration:ev.done?"line-through":"none",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{proj?.jobCode||"—"}</span>
                      {subtasks.length>0 && displayHeight<=36 && (
                        <span style={{fontSize:11,fontWeight:800,color:subDone===subtasks.length?mc:TT.textSub,marginLeft:"auto",flexShrink:0}}>{subDone}/{subtasks.length}</span>
                      )}
                    </div>
                    {timeRange && displayHeight > 22 && (
                      <div style={{fontSize:12,fontWeight:700,color:ev.done?TT.textFaint:mc,opacity:0.85,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",lineHeight:1.2}}>
                        {timeRange}
                      </div>
                    )}
                    {ev.task && displayHeight > 38 && (
                      <div style={{fontSize:13,fontWeight:700,color:ev.done?TT.textFaint:TT.text,marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",textDecoration:ev.done?"line-through":"none"}}>{ev.task}</div>
                    )}
                    {displayHeight > 52 && (
                      <div style={{display:"flex",alignItems:"center",gap:6,marginTop:1}}>
                        {subtasks.length>0 && (
                          <span style={{fontSize:11,fontWeight:800,color:subDone===subtasks.length?mc:TT.textSub,flexShrink:0}}>☑ {subDone}/{subtasks.length}</span>
                        )}
                      </div>
                    )}
                    {displayHeight > 56 && proj?.name && (
                      <div style={{fontSize:11,color:TT.textSub,marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{proj.name}</div>
                    )}
                    {displayHeight > 64 && proj?.assignedBy && (
                      <div style={{fontSize:10,color:TT.textFaint,marginTop:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>by {proj.assignedBy}</div>
                    )}
                    {/* Inline checkable subtask list — only when the block is tall enough to show them */}
                    {subtasks.length>0 && displayHeight > 72 && (
                      <div style={{marginTop:3,display:"flex",flexDirection:"column",gap:1}}>
                        {subtasks.slice(0, Math.max(1,Math.floor((displayHeight-70)/15))).map(st => (
                          <div key={st.id} onClick={e=>{e.stopPropagation(); onToggleSubtask(ev.id, st.id);}} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
                            <div style={{width:11,height:11,borderRadius:2,border:`1.5px solid ${st.done?"#C2C7D0":"#B9BFC8"}`,background:st.done?"#C2C7D0":"#FFFFFF",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                              {st.done && <span style={{color:"#fff",fontSize:8,fontWeight:900}}>✓</span>}
                            </div>
                            <span style={{fontSize:11,color:st.done?TT.textFaint:TT.textSub,textDecoration:st.done?"line-through":"none",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{st.text}</span>
                          </div>
                        ))}
                        {subtasks.length > Math.max(1,Math.floor((displayHeight-70)/15)) && (
                          <span style={{fontSize:9,color:TT.textFaint,fontWeight:700}}>+{subtasks.length-Math.max(1,Math.floor((displayHeight-70)/15))} more</span>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Resize handle — top edge (adjusts start time, end time stays fixed) */}
                  <div
                    onPointerDown={e=>beginResizeTop(e, ev, top, height)}
                    title="Drag to resize from the start"
                    style={{
                      position:"absolute", left:0, right:0, top:-3, height:7, cursor:"ns-resize",
                      display:"flex", alignItems:"center", justifyContent:"center",
                    }}>
                    <div style={{width:24,height:3,borderRadius:2,background:ev.done?"#C2C7D0":mc,opacity:0.5}}/>
                  </div>
                  {/* Resize handle — bottom edge */}
                  <div
                    onPointerDown={e=>beginResize(e, ev, top, height)}
                    title="Drag to resize"
                    style={{
                      position:"absolute", left:0, right:0, bottom:-3, height:7, cursor:"ns-resize",
                      display:"flex", alignItems:"center", justifyContent:"center",
                    }}>
                    <div style={{width:24,height:3,borderRadius:2,background:ev.done?"#C2C7D0":mc,opacity:0.5}}/>
                  </div>
                </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{fontSize:10,color:TT.textFaint,textAlign:"center",marginTop:8}}>Drag on empty space to create a task · Drag a task to move it · Drag its bottom edge to resize · Right-click to delete</div>
      {contextMenu && (
        <TaskContextMenu x={contextMenu.x} y={contextMenu.y}
          onEdit={()=>onEdit(contextMenu.ev, contextMenu.rect)}
          onDelete={(!contextMenu.ev.inboxItemType || contextMenu.ev.createdBy===currentUser || isAdmin(currentUser)) ? ()=>onRemove(contextMenu.ev.id) : null}
          onClose={()=>setContextMenu(null)}
        />
      )}
    </div>
  );
}

function HourRangeSettings({ hourRange, hourPreset, onChange, onClose }) {
  const PRESETS = [
    { key:"work", label:"Work Hours", range:{start:6,end:21} },
    { key:"full", label:"Full 24 Hours", range:{start:0,end:24} },
    { key:"extended", label:"Extended (5am–11pm)", range:{start:5,end:23} },
  ];
  const [customStart, setCustomStart] = useState(hourRange.start);
  const [customEnd, setCustomEnd] = useState(hourRange.end);

  const applyCustom = () => {
    if (customStart < customEnd) onChange("custom", { start:customStart, end:customEnd });
  };

  return (
    <div onClick={e=>e.stopPropagation()} style={{
      position:"absolute", top:"calc(100% + 6px)", right:0, zIndex:600, width:260,
      background:"#FFFFFF", border:`1px solid ${TT.border}`, borderRadius:10, padding:14,
      boxShadow:TT.shadow,
    }}>
      <div style={{fontSize:11,fontWeight:800,color:TT.textSub,textTransform:"uppercase",marginBottom:10}}>Day View Hours</div>
      {PRESETS.map(p => {
        const active = hourPreset===p.key;
        return (
          <button key={p.key} onClick={()=>onChange(p.key,p.range)} style={{
            display:"block",width:"100%",textAlign:"left",padding:"8px 10px",borderRadius:6,marginBottom:4,cursor:"pointer",
            background:active?"#3B5BFF14":"transparent", border:`1px solid ${active?"#3B5BFF":"transparent"}`,
            color:active?"#3B5BFF":TT.text, fontSize:12,fontWeight:active?800:500,
          }}>
            {active && <span style={{marginRight:6}}>✓</span>}{p.label}
          </button>
        );
      })}
      <div style={{borderTop:`1px solid ${TT.border}`,marginTop:8,paddingTop:10}}>
        <div style={{fontSize:11,fontWeight:700,color:hourPreset==="custom"?"#3B5BFF":TT.textSub,marginBottom:8}}>
          {hourPreset==="custom" && "✓ "}Custom range
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <select value={customStart} onChange={e=>setCustomStart(+e.target.value)} style={{...IS_LIGHT,fontSize:11,padding:"5px 6px"}}>
            {Array.from({length:24},(_,h)=>h).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <span style={{color:TT.textSub,fontSize:11}}>to</span>
          <select value={customEnd} onChange={e=>setCustomEnd(+e.target.value)} style={{...IS_LIGHT,fontSize:11,padding:"5px 6px"}}>
            {Array.from({length:24},(_,h)=>h+1).map(h => <option key={h} value={h}>{hourLabel(h===24?0:h)}{h===24?" (mid)":""}</option>)}
          </select>
        </div>
        <button onClick={applyCustom} disabled={customStart>=customEnd} style={{
          width:"100%",marginTop:8,padding:"7px 0",borderRadius:6,border:"none",fontSize:11,fontWeight:700,
          background:customStart<customEnd?"#3B5BFF":"#E5E7EB", color:"#fff", cursor:customStart<customEnd?"pointer":"not-allowed",
        }}>Apply</button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════
// WEEK HOUR VIEW — 7 parallel day columns, TickTick-style.
// Drag a task vertically to change time, or sideways onto
// another day's column to reschedule the date too.
// ═════════════════════════════════════════════════
function getWeekDays(anchorYmd) {
  const d = new Date(anchorYmd+"T00:00:00");
  const dow = (d.getDay()+6)%7; // 0=Mon
  const monday = new Date(d); monday.setDate(d.getDate()-dow);
  return Array.from({length:7}, (_,i) => { const nd=new Date(monday); nd.setDate(monday.getDate()+i); return ymd(nd); });
}

function WeekHourView({ weekDates, eventsByDay, projects, member, currentUser, hourRange, onAddAt, onEdit, onToggleDone, onMoveTask, onResize, onToggleSubtask, onRemove, draggingInboxItem, onDropInboxItem, onCopyEvent, onGcalClick }) {
  const { memberColor: MEMBER_COLOR, isAdmin } = useTeam();
  const scrollRef = useRef(null);
  const containerRef = useRef(null);
  const mc = MEMBER_COLOR[member];
  const colRefs = useRef({});
  const wasMovedRef = useRef(false); // suppresses click-to-edit immediately after a real drag
  const [contextMenu, setContextMenu] = useState(null); // {x, y, ev} | null — also acts as the "selected" event for keyboard delete
  const [ctrlHeld, setCtrlHeld] = useState(false);
  useEffect(() => {
    const h = e => setCtrlHeld(e.ctrlKey || e.metaKey);
    window.addEventListener("keydown", h);
    window.addEventListener("keyup", h);
    return () => { window.removeEventListener("keydown", h); window.removeEventListener("keyup", h); };
  }, []);

  // Unified pointer interaction across the whole week grid.
  // mode: null | "draw" | "move" | "resize"
  // For draw/move/resize we track which column (date) is currently active, since
  // move can cross columns; draw/resize stay within the column they started in.
  const [interaction, setInteraction] = useState(null);
  const [quickAdd, setQuickAdd] = useState(null); // { date, top, height, startTime, durationMin } | null — inline create card

  const hours = [];
  for (let h = hourRange.start; h < hourRange.end; h++) hours.push(h);
  const totalHeight = hours.length * HOUR_PX;

  const timeToOffset = (hhmm) => {
    const [h,m] = hhmm.split(":").map(Number);
    return (h + m/60 - hourRange.start) * HOUR_PX;
  };
  const offsetToTime = (offsetPx) => {
    const decimalHour = hourRange.start + offsetPx / HOUR_PX;
    const clamped = Math.max(hourRange.start, Math.min(hourRange.end, decimalHour));
    const snapped = Math.round(clamped * 4) / 4;
    const h = Math.floor(snapped);
    const m = Math.round((snapped - h) * 60);
    const mm = m === 60 ? 0 : m, hh = m === 60 ? h+1 : h;
    return `${String(Math.min(hh,23)).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
  };
  const minutesBetween = (px) => Math.max(15, Math.round(px / HOUR_PX * 60 / 15) * 15);

  const now = new Date();
  const nowOffset = (now.getHours() + now.getMinutes()/60 - hourRange.start) * HOUR_PX;
  const showNowLine = now.getHours() >= hourRange.start && now.getHours() < hourRange.end;

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, nowOffset - 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekDates[0]]);

  // Delete/Backspace removes whichever task was right-clicked (selected via the context menu),
  // as long as focus isn't in a text field.
  useEffect(() => {
    if (!contextMenu) return;
    const handler = e => {
      if ((e.key==="Delete"||e.key==="Backspace") && !["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) {
        e.preventDefault();
        onRemove?.(contextMenu.ev.id);
        setContextMenu(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [contextMenu, onRemove]);

  useEffect(() => {
    const active = interaction?.mode === "move" || interaction?.mode === "resize" || interaction?.mode === "resizeTop";
    if (active) {
      document.body.style.cursor = interaction.mode === "move" ? "grabbing" : "ns-resize";
      document.body.style.userSelect = "none";
    } else {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    return () => { document.body.style.cursor = ""; document.body.style.userSelect = ""; };
  }, [interaction?.mode]);

  // Per-day lane assignment so overlapping tasks split into side-by-side columns within that day
  const laneForDay = (dymd) => {
    const timed = (eventsByDay[dymd]||[]).filter(e=>e.startTime);
    const positioned = timed.map(ev => ({ ev, top: timeToOffset(ev.startTime), height: Math.max(14,(ev.durationMin||60)/60*HOUR_PX-2) })).sort((a,b)=>a.top-b.top);
    const lanes = [];
    positioned.forEach(item => {
      let lane = lanes.findIndex(l => l.every(o => item.top>=o.top+o.height || item.top+item.height<=o.top));
      if (lane===-1) { lane=lanes.length; lanes.push([]); }
      lanes[lane].push(item); item.lane = lane;
    });
    return { positioned, laneCount: Math.max(1,lanes.length) };
  };

  const WEEKDAY_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

  const getOffsetYInCol = (clientY, dymd) => {
    const el = colRefs.current[dymd];
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(totalHeight, clientY - rect.top));
  };

  // Find which column the pointer is currently over, by clientX
  const findColumnAt = (clientX) => {
    for (const dymd of weekDates) {
      const el = colRefs.current[dymd];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) return dymd;
    }
    return null;
  };

  const handleAreaPointerDown = (e, dymd) => {
    if (e.target !== e.currentTarget) return;
    const y = getOffsetYInCol(e.clientY, dymd);
    const snappedTop = Math.round(y / (HOUR_PX/4)) * (HOUR_PX/4);
    setInteraction({ mode:"draw", date:dymd, startY:snappedTop, currentTop:snappedTop, currentHeight:HOUR_PX/4 });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const beginMove = (e, ev, top, height, dymd) => {
    e.preventDefault();
    e.stopPropagation();
    const y = getOffsetYInCol(e.clientY, dymd);
    setInteraction({ mode:"move", id:ev.id, originDate:dymd, date:dymd, grabOffset:y-top, startTop:top, currentTop:top, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };
  const beginResize = (e, ev, top, height, dymd) => {
    e.preventDefault();
    e.stopPropagation();
    setInteraction({ mode:"resize", id:ev.id, date:dymd, startTop:top, currentTop:top, startHeight:height, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };
  // Dragging the top edge moves the start time while keeping the end time fixed
  const beginResizeTop = (e, ev, top, height, dymd) => {
    e.preventDefault();
    e.stopPropagation();
    setInteraction({ mode:"resizeTop", id:ev.id, date:dymd, startTop:top, currentTop:top, fixedBottom:top+height, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = e => {
    if (!interaction) return;
    const hoverDate = findColumnAt(e.clientX) || interaction.date;

    if (interaction.mode === "draw") {
      // Drawing is locked to the column it started in — ignore horizontal drift
      const y = getOffsetYInCol(e.clientY, interaction.date);
      const startY = interaction.startY;
      const top = Math.min(startY, y);
      const rawHeight = Math.abs(y - startY);
      const snappedHeight = Math.max(HOUR_PX/4, Math.round(rawHeight/(HOUR_PX/4))*(HOUR_PX/4));
      setInteraction(i => ({ ...i, currentTop: Math.round(top/(HOUR_PX/4))*(HOUR_PX/4), currentHeight: snappedHeight, moved:true }));
    } else if (interaction.mode === "move") {
      const y = getOffsetYInCol(e.clientY, hoverDate);
      const rawTop = y - interaction.grabOffset;
      const snappedTop = Math.max(0, Math.min(totalHeight-interaction.currentHeight, Math.round(rawTop/(HOUR_PX/4))*(HOUR_PX/4)));
      setInteraction(i => ({ ...i, date:hoverDate, currentTop:snappedTop, moved: i.moved || snappedTop!==i.startTop || hoverDate!==i.originDate }));
    } else if (interaction.mode === "resize") {
      // Resize is locked to the column/task it started on
      const y = getOffsetYInCol(e.clientY, interaction.date);
      const rawHeight = y - interaction.startTop;
      const snappedHeight = Math.max(HOUR_PX/4, Math.round(rawHeight/(HOUR_PX/4))*(HOUR_PX/4));
      setInteraction(i => ({ ...i, currentHeight: Math.min(snappedHeight, totalHeight-i.startTop), moved: i.moved || snappedHeight!==i.startHeight }));
    } else if (interaction.mode === "resizeTop") {
      // Also locked to the column/task it started on
      const y = getOffsetYInCol(e.clientY, interaction.date);
      const snappedTop = Math.max(0, Math.min(interaction.fixedBottom-HOUR_PX/4, Math.round(y/(HOUR_PX/4))*(HOUR_PX/4)));
      const newHeight = interaction.fixedBottom - snappedTop;
      setInteraction(i => ({ ...i, currentTop: snappedTop, currentHeight: newHeight, moved: i.moved || snappedTop !== i.startTop }));
    }
  };

  const handlePointerUp = e => {
    if (!interaction) return;
    const isCopy = (e.ctrlKey || e.metaKey) && onCopyEvent;
    if (interaction.mode === "draw") {
      const startTime = offsetToTime(interaction.currentTop);
      const durationMin = interaction.moved ? minutesBetween(interaction.currentHeight) : 60;
      const height = interaction.moved ? interaction.currentHeight : HOUR_PX;
      const top = interaction.moved ? interaction.currentTop : interaction.startY;
      setQuickAdd({ date: interaction.date, top, height, startTime, durationMin });
    } else if (interaction.mode === "move" && interaction.moved) {
      const newTime = offsetToTime(interaction.currentTop);
      isCopy ? onCopyEvent(interaction.id, { date: interaction.date, startTime: newTime }) : onMoveTask(interaction.id, interaction.date, newTime);
    } else if (interaction.mode === "resize" && interaction.moved) {
      onResize(interaction.id, minutesBetween(interaction.currentHeight));
    } else if (interaction.mode === "resizeTop" && interaction.moved) {
      const newTime = offsetToTime(interaction.currentTop);
      if (isCopy) { onCopyEvent(interaction.id, { date: interaction.date, startTime: newTime }); } else { onMoveTask(interaction.id, interaction.date, newTime); onResize(interaction.id, minutesBetween(interaction.currentHeight)); }
    }
    wasMovedRef.current = interaction.mode !== "draw" && !!interaction.moved;
    setInteraction(null);
  };

  return (
    <div>
      <div ref={scrollRef} style={{position:"relative",height:"calc(100vh - 140px)",overflowY:"auto",border:`1px solid ${TT.border}`,borderRadius:10,background:TT.bg}}>
        {/* Sticky day-of-week header row */}
        <div style={{display:"flex",position:"sticky",top:0,zIndex:10,background:"#FFFFFF",borderBottom:`1px solid ${TT.border}`}}>
          <div style={{width:54,flexShrink:0}}/>
          {weekDates.map((dymd,i) => {
            const today = isToday(dymd);
            const dayCount = (eventsByDay[dymd]||[]).length;
            return (
              <div key={dymd} style={{flex:1,textAlign:"center",padding:"8px 4px",borderLeft:`1px solid ${TT.border}`}}>
                <div style={{fontSize:10,fontWeight:700,color:today?"#3B5BFF":TT.textSub,textTransform:"uppercase"}}>{WEEKDAY_SHORT[i]}</div>
                <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:22,height:22,borderRadius:"50%",fontSize:14,fontWeight:today?900:700,color:today?"#fff":TT.text,background:today?"#3B5BFF":"transparent",marginTop:1}}>{new Date(dymd+"T00:00:00").getDate()}</div>
                {dayCount>0 && <div style={{fontSize:8,color:TT.textFaint,marginTop:1}}>{dayCount} task{dayCount!==1?"s":""}</div>}
              </div>
            );
          })}
        </div>

        <div ref={containerRef} style={{position:"relative",height:totalHeight,display:"flex"}}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={()=>setInteraction(null)}
        >
          {/* Hour labels */}
          <div style={{width:54,flexShrink:0,borderRight:`1px solid ${TT.border}`}}
            onWheel={e=>{ if (scrollRef.current) { scrollRef.current.scrollTop += e.deltaY; e.stopPropagation(); } }}>
            {hours.map(h => (
              <div key={h} style={{height:HOUR_PX,boxSizing:"border-box",borderTop:`1px solid ${TT.border}`,paddingTop:2,paddingRight:8,textAlign:"right"}}>
                <span style={{fontSize:10,color:TT.textSub,fontWeight:600}}>{hourLabel(h)}</span>
              </div>
            ))}
          </div>

          {/* 7 day columns */}
          {weekDates.map(dymd => {
            const today = isToday(dymd);
            const { positioned, laneCount } = laneForDay(dymd);
            const isDrawingHere = interaction?.mode==="draw" && interaction.date===dymd;
            const isMoveTargetHere = interaction?.mode==="move" && interaction.date===dymd;
            const isQuickAddHere = quickAdd?.date===dymd;
            return (
              <div key={dymd}
                ref={el => colRefs.current[dymd] = el}
                style={{position:"relative",flex:1,borderLeft:`1px solid ${TT.border}`,background:today?"#3B5BFF08":"transparent",touchAction:"none",cursor:interaction?.mode==="draw"?"ns-resize":"default"}}
                onPointerDown={e=>{ if(!quickAdd) handleAreaPointerDown(e,dymd); }}
                onWheel={e=>{ if (!interaction && scrollRef.current) { scrollRef.current.scrollTop += e.deltaY; e.stopPropagation(); } }}
                onDragOver={e=>{ if(draggingInboxItem){ e.preventDefault(); e.dataTransfer.dropEffect=dymd>=TODAY?"move":"none"; } }}
                onDrop={e=>{ if(!draggingInboxItem||dymd<TODAY) return; e.preventDefault(); const offsetY=Math.max(0,Math.min(totalHeight,e.clientY-(colRefs.current[dymd]?.getBoundingClientRect().top||0))); onDropInboxItem?.(dymd,offsetToTime(offsetY)); }}
              >
                {hours.map(h => (
                  <div key={h} style={{position:"absolute",top:(h-hourRange.start)*HOUR_PX,left:0,right:0,height:HOUR_PX,borderTop:`1px solid ${TT.border}`,boxSizing:"border-box",pointerEvents:"none"}}/>
                ))}
                {today && showNowLine && (
                  <div style={{position:"absolute",top:nowOffset,left:0,right:0,zIndex:5,height:1.5,background:TT.now,pointerEvents:"none"}}/>
                )}

                {/* Selected-slot bar — live while drawing, sticks while the quick-add card is open */}
                {(isDrawingHere || isQuickAddHere) && (
                  <div style={{
                    position:"absolute",
                    top: isQuickAddHere ? quickAdd.top : interaction.currentTop,
                    height: isQuickAddHere ? quickAdd.height : interaction.currentHeight,
                    left:2, right:2,
                    background:"#3B5BFF", borderRadius:5, zIndex:8, pointerEvents:"none",
                    display:"flex", alignItems:"center", overflow:"hidden", paddingLeft:5,
                  }}>
                    <span style={{fontSize:8,fontWeight:800,color:"#fff",whiteSpace:"nowrap"}}>
                      {fmtTime12(offsetToTime(isQuickAddHere ? quickAdd.top : interaction.currentTop))}
                    </span>
                  </div>
                )}

                {/* Inline quick-add card — replaces the popup modal for the common case */}
                {isQuickAddHere && (
                  <QuickAddCard
                    date={quickAdd.date}
                    top={quickAdd.top} height={quickAdd.height} left={2} width="calc(100% - 4px)"
                    startTime={quickAdd.startTime} durationMin={quickAdd.durationMin}
                    projects={projects} member={member}
                    onConfirm={(projectId,task)=>{
                      onAddAt(quickAdd.date, quickAdd.startTime, quickAdd.durationMin, { projectId, task, quick:true });
                      setQuickAdd(null);
                    }}
                    onMoreDetails={(projectId,task,rect)=>{
                      onAddAt(quickAdd.date, quickAdd.startTime, quickAdd.durationMin, { projectId, task, quick:false, anchorRect:rect });
                      setQuickAdd(null);
                    }}
                    onCancel={()=>setQuickAdd(null)}
                  />
                )}

                {/* Move ghost preview (only rendered in the destination column while actively over it) */}
                {isMoveTargetHere && interaction.originDate !== dymd && (
                  <div style={{
                    position:"absolute", top:interaction.currentTop, height:interaction.currentHeight, left:2, right:2,
                    background:"#3B5BFF33", border:"1.5px dashed #3B5BFF", borderRadius:5, zIndex:8, pointerEvents:"none",
                  }}/>
                )}

                {positioned.map(({ev,top,height,lane}) => {
                  const isActive = interaction && interaction.id === ev.id;
                  // Hide the original block while it's being moved into a different column (ghost preview stands in for it there)
                  const hideOriginal = isActive && interaction.mode==="move" && interaction.date !== dymd;
                  if (hideOriginal) return null;
                  const displayTop = isActive && (interaction.mode==="move"||interaction.mode==="resizeTop") && interaction.date===dymd ? interaction.currentTop : top;
                  const displayHeight = isActive && (interaction.mode==="resize"||interaction.mode==="resizeTop") ? interaction.currentHeight : height;
                  const effectiveStart = isActive && (interaction.mode==="move"||interaction.mode==="resizeTop") ? offsetToTime(displayTop) : ev.startTime;
                  const widthPct = 100/laneCount;
                  // ── Google Calendar meeting block ──
                  if (ev.gcal) return (
                    <div key={ev.id}
                      onClick={e=>{ e.stopPropagation(); onGcalClick?.(ev); }}
                      title="Click to view meeting details"
                      style={{
                        position:"absolute", top:displayTop, height:displayHeight, left:`calc(${lane*widthPct}% + 2px)`, width:`calc(${widthPct}% - 4px)`,
                        background:"#7C3AED18", borderLeft:"3px solid #7C3AED", borderTop:"1px solid #7C3AED44", borderRight:"1px solid #7C3AED44", borderBottom:"1px solid #7C3AED44",
                        borderRadius:4, padding:"2px 5px", cursor:"pointer", overflow:"hidden", zIndex:2, boxSizing:"border-box",
                      }}>
                      <div style={{overflow:"hidden",height:"100%"}}>
                        <div style={{fontSize:9,fontWeight:900,color:"#7C3AED",textTransform:"uppercase",letterSpacing:"0.06em",opacity:0.8,marginBottom:1}}>📅 Meeting</div>
                        <div style={{fontSize:12,fontWeight:800,color:"#7C3AED",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ev.task}</div>
                        {fmtTimeRange(ev.startTime, ev.durationMin, ev.tz, ev.date) && displayHeight > 30 && (
                          <div style={{fontSize:11,fontWeight:600,color:"#7C3AED",opacity:0.85,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{fmtTimeRange(ev.startTime, ev.durationMin, ev.tz, ev.date)}</div>
                        )}
                        {ev.location && displayHeight > 52 && (
                          <div style={{fontSize:10,color:"#64748B",marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>📍 {ev.location}</div>
                        )}
                        {ev.meetLink && displayHeight > 60 && (
                          <span style={{fontSize:10,background:"#7C3AED",color:"#fff",borderRadius:4,padding:"1px 7px",fontWeight:700,marginTop:3,display:"inline-block"}}>Join</span>
                        )}
                      </div>
                    </div>
                  );
                  const proj = projects.find(p=>p.id===ev.projectId);
                  const subtasks = ev.subtasks || [];
                  const subDone = subtasks.filter(s=>s.done).length;
                  const maxVisibleSubs = Math.max(1, Math.floor((displayHeight-44)/13));
                  return (
                    <Fragment key={ev.id}>
                      {/* Ghost at original position while dragging within the same column */}
                      {isActive && interaction.mode==="move" && interaction.date===dymd && (
                        <div style={{
                          position:"absolute", top, height, left:`calc(${lane*widthPct}% + 2px)`, width:`calc(${widthPct}% - 4px)`,
                          background:`${mc}0C`, border:`1.5px dashed ${mc}40`, borderRadius:4,
                          pointerEvents:"none", zIndex:1, boxSizing:"border-box",
                        }}/>
                      )}
                    <div
                      onPointerDown={e=>beginMove(e, ev, top, height, dymd)}
                      onClick={e=>{ e.stopPropagation(); if(!wasMovedRef.current) onEdit(ev, e.currentTarget.getBoundingClientRect()); }}
                      onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); setContextMenu({x:e.clientX,y:e.clientY,ev,rect:e.currentTarget.getBoundingClientRect()}); }}
                      title="Drag to reschedule · Ctrl+drag to copy · drag top/bottom edge to resize · click to edit · right-click to delete"
                      style={{
                        position:"absolute", top:displayTop, height:displayHeight, left:`calc(${lane*widthPct}% + 2px)`, width:`calc(${widthPct}% - 4px)`,
                        background:ev.done?"#F7F8FA":`${mc}22`, borderLeft:`3px solid ${ev.done?"#C2C7D0":mc}`,
                        borderRadius:4, padding:"2px 5px 2px 7px",
                        cursor:isActive&&(interaction.mode==="resize"||interaction.mode==="resizeTop")?"ns-resize":isActive&&ctrlHeld?"copy":isActive&&interaction.mode==="move"?"grabbing":"grab",
                        overflow:"visible", zIndex:isActive?9:2,
                        boxShadow:isActive&&interaction.mode==="move"?"0 12px 32px rgba(0,0,0,0.18),0 4px 12px rgba(0,0,0,0.1)":isActive?TT.shadow:"none",
                        touchAction:"none", boxSizing:"border-box", userSelect:"none", transition:"box-shadow 0.15s",
                      }}>
                      {/* Time tooltip during move/resize */}
                      {isActive && interaction.mode !== "draw" && (
                        <div style={{
                          position:"absolute",
                          top: interaction.mode==="resize" ? "auto" : -18,
                          bottom: interaction.mode==="resize" ? -18 : "auto",
                          left:0, background:mc, color:"#fff", fontSize:9, fontWeight:800,
                          padding:"1px 6px", borderRadius:4, pointerEvents:"none", zIndex:20,
                          whiteSpace:"nowrap", boxShadow:"0 1px 4px rgba(0,0,0,0.25)",
                        }}>
                          {interaction.mode==="resize"
                            ? fmtTime12(offsetToTime(displayTop+displayHeight))
                            : fmtTime12(effectiveStart)}
                        </div>
                      )}
                      {isActive && ctrlHeld && interaction.mode==="move" && (
                        <div style={{position:"absolute",top:-7,right:-7,width:16,height:16,borderRadius:"50%",background:"#22C55E",color:"#fff",fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",zIndex:20,pointerEvents:"none",boxShadow:"0 1px 4px rgba(0,0,0,0.25)"}}>+</div>
                      )}
                      <div style={{overflow:"hidden",height:"100%"}}>
                        <div style={{display:"flex",alignItems:"center",gap:3}}>
                          <div onClick={e=>{e.stopPropagation();onToggleDone(ev.id);}} style={{width:12,height:12,borderRadius:2,border:`1.5px solid ${ev.done?"#C2C7D0":"#B9BFC8"}`,background:ev.done?"#C2C7D0":"#FFFFFF",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                            {ev.done && <span style={{color:"#fff",fontSize:8,fontWeight:900}}>✓</span>}
                          </div>
                          <span style={{fontSize:12,fontFamily:"monospace",fontWeight:800,color:ev.done?TT.textFaint:mc,textDecoration:ev.done?"line-through":"none",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{proj?.jobCode||"—"}</span>
                          {subtasks.length>0 && (
                            <span style={{fontSize:10,fontWeight:800,color:subDone===subtasks.length?mc:TT.textSub,marginLeft:"auto",flexShrink:0}}>{subDone}/{subtasks.length}</span>
                          )}
                        </div>
                        {fmtTimeRange(ev.startTime, ev.durationMin, ev.tz, ev.date) && displayHeight > 18 && (
                          <div style={{fontSize:11,fontWeight:700,color:ev.done?TT.textFaint:mc,opacity:0.85,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",lineHeight:1.2}}>
                            {fmtTimeRange(ev.startTime, ev.durationMin, ev.tz, ev.date)}
                          </div>
                        )}
                        {ev.task && displayHeight > 34 && (
                          <div style={{fontSize:11,fontWeight:700,color:ev.done?TT.textFaint:TT.text,marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ev.task}</div>
                        )}
                        {proj?.assignedBy && displayHeight > 50 && (
                          <div style={{fontSize:10,color:TT.textFaint,marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>by {proj.assignedBy}</div>
                        )}
                        {subtasks.length>0 && displayHeight > 58 && (
                          <div style={{marginTop:2,display:"flex",flexDirection:"column",gap:1}}>
                            {subtasks.slice(0,maxVisibleSubs).map(st => (
                              <div key={st.id} onClick={e=>{e.stopPropagation(); onToggleSubtask(ev.id, st.id);}} style={{display:"flex",alignItems:"center",gap:3,cursor:"pointer"}}>
                                <div style={{width:9,height:9,borderRadius:2,border:`1.5px solid ${st.done?"#C2C7D0":"#B9BFC8"}`,background:st.done?"#C2C7D0":"#FFFFFF",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                  {st.done && <span style={{color:"#fff",fontSize:6,fontWeight:900}}>✓</span>}
                                </div>
                                <span style={{fontSize:10,color:st.done?TT.textFaint:TT.textSub,textDecoration:st.done?"line-through":"none",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{st.text}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      {/* Resize handle — top edge (adjusts start time, end time stays fixed) */}
                      <div
                        onPointerDown={e=>beginResizeTop(e, ev, top, height, dymd)}
                        title="Drag to resize from the start"
                        style={{position:"absolute", left:0, right:0, top:-3, height:6, cursor:"ns-resize", display:"flex", alignItems:"center", justifyContent:"center"}}>
                        <div style={{width:16,height:2.5,borderRadius:2,background:ev.done?"#C2C7D0":mc,opacity:0.5}}/>
                      </div>
                      {/* Resize handle — bottom edge */}
                      <div
                        onPointerDown={e=>beginResize(e, ev, top, height, dymd)}
                        title="Drag to resize"
                        style={{position:"absolute", left:0, right:0, bottom:-3, height:6, cursor:"ns-resize", display:"flex", alignItems:"center", justifyContent:"center"}}>
                        <div style={{width:16,height:2.5,borderRadius:2,background:ev.done?"#C2C7D0":mc,opacity:0.5}}/>
                      </div>
                    </div>
                    </Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{fontSize:10,color:TT.textFaint,textAlign:"center",marginTop:8}}>Drag on empty space to create · Drag a task to move it (up/down for time, sideways for day) · Drag its top/bottom edge to resize · Right-click to delete</div>
      {contextMenu && (
        <TaskContextMenu x={contextMenu.x} y={contextMenu.y}
          onEdit={()=>onEdit(contextMenu.ev, contextMenu.rect)}
          onDelete={(!contextMenu.ev.inboxItemType || contextMenu.ev.createdBy===currentUser || isAdmin(currentUser)) ? ()=>onRemove?.(contextMenu.ev.id) : null}
          onClose={()=>setContextMenu(null)}
        />
      )}
    </div>
  );
}

// Side-by-side week view for team calendars — shows all members simultaneously with hover tooltips
function TeamSideView({ calendarEvents, projects, selDate, onUpdateEvent }) {
  const { teamNames: TEAM, memberColor: MEMBER_COLOR } = useTeam();
  const [hoveredEvent, setHoveredEvent] = useState(null);
  const [hoverPos, setHoverPos]         = useState(null);
  const weekDates = getWeekDays(selDate);

  return (
    <div style={{overflowX:"auto",paddingBottom:8}}>
      <div style={{display:"grid",gridTemplateColumns:`70px repeat(${TEAM.length},1fr)`,gap:5,minWidth:70+TEAM.length*160}}>

        {/* Header: member name chips */}
        <div/>
        {TEAM.map(m=>{
          const c=MEMBER_COLOR[m];
          const weekCount=calendarEvents.filter(e=>e.member===m&&weekDates.includes(e.date)).length;
          return(
            <div key={m} style={{padding:"7px 10px",borderRadius:8,textAlign:"center",background:`${c}14`,border:`1px solid ${c}33`}}>
              <div style={{fontSize:13,fontWeight:900,color:c,letterSpacing:"0.02em"}}>{m}</div>
              <div style={{fontSize:9,color:"#94A3B8",marginTop:2}}>{weekCount} event{weekCount!==1?"s":""} this week</div>
            </div>
          );
        })}

        {/* Rows: one per day */}
        {weekDates.map(date=>{
          const d=new Date(date+"T00:00:00");
          const isToday=date===TODAY;
          const isPast=date<TODAY;
          return(
            <Fragment key={date}>
              {/* Day label */}
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",justifyContent:"flex-start",paddingRight:8,paddingTop:8}}>
                <span style={{fontSize:9,fontWeight:700,textTransform:"uppercase",color:isToday?"#3B5BFF":TT.textSub}}>
                  {d.toLocaleDateString("en-AU",{weekday:"short"})}
                </span>
                <span style={{fontSize:20,fontWeight:900,lineHeight:1.1,color:isToday?"#3B5BFF":TT.text}}>{d.getDate()}</span>
                <span style={{fontSize:9,color:TT.textFaint}}>{d.toLocaleDateString("en-AU",{month:"short"})}</span>
              </div>

              {/* Events per member */}
              {TEAM.map(m=>{
                const c=MEMBER_COLOR[m];
                const evs=calendarEvents
                  .filter(e=>e.member===m&&e.date===date&&!e.gcal)
                  .sort((a,b)=>(a.startTime||"").localeCompare(b.startTime||""));
                return(
                  <div key={m} style={{
                    minHeight:62,padding:4,borderRadius:7,display:"flex",flexDirection:"column",gap:3,
                    border:`1px solid ${isToday?c+"55":TT.border}`,
                    background:isToday?`${c}07`:isPast?"#FAFBFC":"#FFFFFF",
                    opacity:isPast?0.72:1,
                  }}>
                    {evs.length===0
                      ? <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:9,color:TT.textFaint}}>—</span></div>
                      : evs.map(ev=>{
                          const proj=projects.find(p=>p.id===ev.projectId);
                          return(
                            <div key={ev.id}
                              onMouseEnter={e=>{setHoveredEvent({ev,proj,member:m});setHoverPos({x:e.clientX,y:e.clientY});}}
                              onMouseMove={e=>setHoverPos({x:e.clientX,y:e.clientY})}
                              onMouseLeave={()=>setHoveredEvent(null)}
                              onClick={()=>onUpdateEvent(ev.id,{done:!ev.done})}
                              style={{
                                padding:"3px 6px",borderRadius:4,fontSize:10,cursor:"pointer",userSelect:"none",
                                background:ev.done?`${c}12`:`${c}22`,color:ev.done?TT.textFaint:c,
                                border:`1px solid ${c}30`,opacity:ev.done?0.5:1,
                                display:"flex",alignItems:"center",gap:3,overflow:"hidden",
                                textDecoration:ev.done?"line-through":"none",
                              }}
                            >
                              {ev.startTime&&<span style={{fontSize:8,fontWeight:700,flexShrink:0,opacity:0.75}}>{ev.startTime}</span>}
                              <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>
                                {proj?.jobCode?`${proj.jobCode} · `:""}{ev.task||proj?.name||"—"}
                              </span>
                              {ev.done&&<span style={{fontSize:8,flexShrink:0}}>✓</span>}
                            </div>
                          );
                        })
                    }
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      {/* Hover tooltip */}
      {hoveredEvent&&hoverPos&&createPortal(
        <div style={{
          position:"fixed",pointerEvents:"none",zIndex:9999,
          left:Math.min(hoverPos.x+14,window.innerWidth-280),
          top:Math.min(hoverPos.y+10,window.innerHeight-220),
          width:264,background:"#FFFFFF",
          border:`1px solid ${TT.border}`,borderRadius:10,
          padding:"10px 13px",boxShadow:"0 8px 30px rgba(0,0,0,0.18)",
        }}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:MEMBER_COLOR[hoveredEvent.member],flexShrink:0}}/>
            <span style={{fontSize:11,fontWeight:800,color:MEMBER_COLOR[hoveredEvent.member]}}>{hoveredEvent.member}</span>
            {hoveredEvent.ev.done&&<span style={{marginLeft:"auto",fontSize:9,fontWeight:700,color:"#10B981",background:"#10B98115",borderRadius:4,padding:"1px 5px"}}>✓ Done</span>}
          </div>
          <div style={{fontSize:13,fontWeight:800,color:TT.text,marginBottom:4,lineHeight:1.3}}>{hoveredEvent.ev.task||"Task"}</div>
          {hoveredEvent.proj&&<div style={{fontSize:11,color:"#F97316",fontWeight:700,marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{hoveredEvent.proj.jobCode} · {hoveredEvent.proj.name}</div>}
          <div style={{display:"flex",gap:10,marginBottom:4}}>
            {hoveredEvent.ev.startTime&&<span style={{fontSize:11,color:TT.textSub}}>🕐 {hoveredEvent.ev.startTime}</span>}
            {hoveredEvent.ev.durationMin>0&&<span style={{fontSize:11,color:TT.textSub}}>{hoveredEvent.ev.durationMin}min</span>}
          </div>
          {(hoveredEvent.ev.subtasks||[]).length>0&&(
            <div style={{borderTop:`1px solid ${TT.border}`,paddingTop:5,display:"flex",flexDirection:"column",gap:2}}>
              {hoveredEvent.ev.subtasks.map(st=>(
                <div key={st.id} style={{fontSize:10,color:st.done?TT.textFaint:TT.textSub,display:"flex",alignItems:"center",gap:4}}>
                  <span style={{fontSize:9,color:st.done?"#10B981":"#94A3B8"}}>{st.done?"✓":"○"}</span>
                  <span style={{textDecoration:st.done?"line-through":"none"}}>{st.text}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{marginTop:6,fontSize:9,color:TT.textFaint,borderTop:`1px solid ${TT.border}`,paddingTop:5,textAlign:"center"}}>Click event to toggle done · hover to preview</div>
        </div>,
        document.body
      )}
    </div>
  );
}

function CalendarTab({ projects, tasks, feedback, calendarEvents, currentUser, onAddEvent, onRemoveEvent, onUpdateEvent, onMoveEvent, onReorderDay, onToggleSubtask, onCompleteProject, onCompleteTask, onToggleNoteDone, draggingNoticeItem, onCopyEvent, draggingMyInboxItem, onMarkMyInboxItemRead, onSelMemberChange }) {
  const { teamNames: TEAM, memberColor: MEMBER_COLOR, isAdmin } = useTeam();
  const canViewTeamSide = currentUser === "LESLIE" || isAdmin(currentUser);
  const now = new Date();
  const calKey = k => `asd_cal_${k}_${currentUser}`;
  const [viewYear, setViewYear] = useState(() => { try { const s = localStorage.getItem(calKey("viewYear")); return s ? parseInt(s) : now.getFullYear(); } catch { return now.getFullYear(); } });
  const [viewMonth, setViewMonth] = useState(() => { try { const s = localStorage.getItem(calKey("viewMonth")); return s ? parseInt(s) : now.getMonth(); } catch { return now.getMonth(); } });
  const [viewMode, setViewMode] = useState(() => localStorage.getItem(calKey("viewMode")) || "single");
  const [singleSubView, setSingleSubView] = useState(() => localStorage.getItem(calKey("singleSubView")) || "week");
  const [selDate, setSelDate] = useState(() => { try { return localStorage.getItem(calKey("selDate")) || todayYmd(); } catch { return todayYmd(); } });
  const [hourRange, setHourRange] = useState(() => { try { return JSON.parse(localStorage.getItem(calKey("hourRange"))) || { start: 6, end: 21 }; } catch { return { start: 6, end: 21 }; } });
  const [hourPreset, setHourPreset] = useState(() => localStorage.getItem(calKey("hourPreset")) || "work");
  const [showHourSettings, setShowHourSettings] = useState(false);
  const [allSubView, setAllSubView] = useState(() => localStorage.getItem(calKey("allSubView")) || "timeline");
  useEffect(() => { localStorage.setItem(calKey("viewMode"), viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem(calKey("singleSubView"), singleSubView); }, [singleSubView]);
  useEffect(() => { localStorage.setItem(calKey("allSubView"), allSubView); }, [allSubView]);
  useEffect(() => { localStorage.setItem(calKey("hourRange"), JSON.stringify(hourRange)); }, [hourRange]);
  useEffect(() => { localStorage.setItem(calKey("hourPreset"), hourPreset); }, [hourPreset]);
  useEffect(() => { localStorage.setItem(calKey("selDate"), selDate); }, [selDate]);
  useEffect(() => { localStorage.setItem(calKey("viewYear"), viewYear); }, [viewYear]);
  useEffect(() => { localStorage.setItem(calKey("viewMonth"), viewMonth); }, [viewMonth]);
  const [selMember, setSelMember] = useState(currentUser); // defaults to your own calendar; switchable via the dropdown next to the tab
  const [showMemberSwitch, setShowMemberSwitch] = useState(false);
  const memberSwitchRef = useRef(null);
  useEffect(() => {
    if (!showMemberSwitch) return;
    const handler = e => { if (memberSwitchRef.current && !memberSwitchRef.current.contains(e.target)) setShowMemberSwitch(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMemberSwitch]);
  const [dayModal, setDayModal] = useState(null);   // ymd string | null — shows DayDetailModal
  const [addModal, setAddModal] = useState(null);    // ymd string | null — shows EventModal directly
  const [addModalFromInbox, setAddModalFromInbox] = useState(false);
  const [prefillTime, setPrefillTime] = useState(""); // time string to prefill when adding from grid click/draw
  const [prefillDuration, setPrefillDuration] = useState(60); // duration to prefill when adding via draw-to-create
  const [prefillProjectId, setPrefillProjectId] = useState(""); // project already chosen in the inline quick-add card
  const [prefillTask, setPrefillTask] = useState(""); // task detail typed in the inline quick-add card
  const [prefillNoteId, setPrefillNoteId] = useState(null); // noteId when scheduling from a tagged note
  const [editingEvent, setEditingEvent] = useState(null); // event object | null — shows EventModal in edit mode
  const [eventAnchorRect, setEventAnchorRect] = useState(null); // DOMRect | null — anchors the add/edit panel next to whatever was clicked
  const [dragEventId, setDragEventId] = useState(null);   // id of task being dragged across days on the grid
  const [dragOverDay, setDragOverDay] = useState(null);    // ymd of day currently hovered during cross-day drag

  const [showInbox, setShowInbox] = useState(true);
  const [draggingInboxItem, setDraggingInboxItem] = useState(null); // { type, projectId, taskTitle }
  const [gcalDetailEvent, setGcalDetailEvent] = useState(null); // GCal meeting to show detail modal for
  const [confirmDoneId, setConfirmDoneId] = useState(null); // event id awaiting done confirmation

  // Intercept done toggle: require explicit confirmation before marking done; allow immediate uncheck
  const handleToggleDone = (id) => {
    const ev = calendarEvents.find(e => e.id === id);
    if (!ev) return;
    if (ev.done) {
      onUpdateEvent(id, { done: false }); // uncheck always immediate
    } else {
      setConfirmDoneId(id); // mark-as-done needs confirm
    }
  };

  // ── Google Calendar integration ────────────────────────────────────────────
  // "checking" → initial; "connected" → token valid; "disconnected" → needs auth; "error" → fetch failed
  const [gcalStatus, setGcalStatus]   = useState("checking");
  const [gcalConnected, setGcalConnected] = useState(false);
  const [gcalEvents, setGcalEvents]   = useState([]);
  const [gcalLoading, setGcalLoading] = useState(false);
  const [gcalError, setGcalError]     = useState("");
  const [gcalListOpen, setGcalListOpen] = useState(false);
  const [gcalListPos, setGcalListPos]   = useState(null);
  const gcalBtnRef  = useRef(null);

  // Fetch events from Railway server (server holds the refresh token — no re-auth ever)
  const fetchGcalEvents = useCallback(async () => {
    setGcalLoading(true); setGcalError("");
    try {
      const res = await fetch(`/gcal/events?user=${encodeURIComponent(currentUser)}`);
      if (res.status === 401) { setGcalConnected(false); setGcalStatus("disconnected"); return; }
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const { items } = await res.json();
      setGcalEvents(items || []);
      setGcalConnected(true);
      setGcalStatus("connected");
    } catch(e) { setGcalError(e.message); setGcalStatus("error"); }
    finally { setGcalLoading(false); }
  }, [currentUser]);

  // Remove a meeting from local list only (server re-fetches will restore it on next sync)
  const deleteGcalEvent = useCallback(id => {
    setGcalEvents(prev => prev.filter(e => e.id !== id));
  }, []);

  // Opens a popup to Railway's OAuth flow — user signs in once, refresh token stored on server permanently
  const connectGcal = useCallback(() => {
    const popup = window.open(`/gcal/auth/url?user=${encodeURIComponent(currentUser)}`, "gcal-auth", "width=520,height=640,left=200,top=100");
    if (!popup) { setGcalError("Popup blocked — allow popups for this site."); setGcalStatus("error"); return; }
    const onMsg = e => {
      if (!e.data?.gcalAuth) return;
      window.removeEventListener("message", onMsg);
      if (e.data.gcalAuth === "connected") { setGcalConnected(true); fetchGcalEvents(); }
      else { setGcalError(`Connection failed: ${e.data.reason || "unknown error"}`); setGcalStatus("error"); }
    };
    window.addEventListener("message", onMsg);
    // Cleanup if popup closed without postMessage (user dismissed)
    const poll = setInterval(() => { if (popup.closed) { clearInterval(poll); window.removeEventListener("message", onMsg); } }, 500);
  }, [currentUser, fetchGcalEvents]);

  // On mount: check if this user already has Calendar connected, then fetch events
  useEffect(() => {
    fetch(`/gcal/status?user=${encodeURIComponent(currentUser)}`)
      .then(r => r.json())
      .then(d => {
        if (d.connected) { setGcalConnected(true); fetchGcalEvents(); }
        else { setGcalStatus("disconnected"); }
      })
      .catch(() => { setGcalStatus("error"); });
  }, [currentUser]);

  // Auto-refresh every 30 minutes while connected so the token stays proven and
  // events stay current without requiring a manual "Sync now" click.
  useEffect(() => {
    if (!gcalConnected) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") fetchGcalEvents();
    }, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [gcalConnected, fetchGcalEvents]);

  // Format Google Calendar events: group by date ymd
  const gcalByDay = {};
  gcalEvents.forEach(e => {
    const day = e.start ? e.start.slice(0,10) : null;
    if (day) (gcalByDay[day] = gcalByDay[day] || []).push(e);
  });
  const gcalUpcoming = gcalEvents.slice(0, 8);

  // Merge local inbox drags + MyInbox drags from parent + notice board drags from parent
  const myInboxDrag = draggingMyInboxItem ? {
    type: draggingMyInboxItem.type,
    projectId: draggingMyInboxItem.project?.id || "",
    taskTitle: (draggingMyInboxItem.text||"").slice(0, 100),
    id: draggingMyInboxItem.id,
  } : null;
  const effectiveDraggingItem = draggingNoticeItem ? { type:"notice", projectId:"", taskTitle: draggingNoticeItem.text?.slice(0,120)||"" } : draggingInboxItem || myInboxDrag || null;

  const dropInboxItem = (date, timeHint) => {
    if (!effectiveDraggingItem || date < TODAY) return;
    const dayCount = calendarEvents.filter(e => e.member === selMember && e.date === date).length;
    // Determine link-back fields for MyInbox-sourced items
    const src = draggingMyInboxItem;
    const noteId = effectiveDraggingItem.type === "note-tag"
      ? effectiveDraggingItem.noteId
      : (src?.type === "note" || src?.type === "checklist") ? src.id : undefined;
    const fbId = src?.type === "feedback" ? src.id : undefined;
    const inboxItemType = src ? src.type : undefined;
    const canActForOthers = currentUser === "LESLIE" || isAdmin(currentUser);
    const member = src ? ((canActForOthers && selMember !== currentUser) ? selMember : currentUser) : selMember;
    onAddEvent({ id:mkId(), date, member, projectId:effectiveDraggingItem.projectId||"", task:effectiveDraggingItem.taskTitle||"", subtasks:[], startTime:timeHint||"", durationMin:effectiveDraggingItem.type==="project"?120:90, createdBy:currentUser, ts:nowTs(), order:dayCount, done:false, ...(noteId?{noteId}:{}), ...(fbId?{fbId}:{}), ...(inboxItemType?{inboxItemType}:{}) });
    if (src) onMarkMyInboxItemRead?.(src.type, src.id, src.project?.id);
    setDraggingInboxItem(null); setDragOverDay(null);
  };

  const grid = buildMonthGrid(viewYear, viewMonth);

  // Helper: hides past events linked to completed projects (reduces clutter).
  // Future events are always shown regardless of project status — a project may complete
  // mid-schedule, and the remaining calendar entries should still be visible.
  const isActiveEvent = e => {
    if (!e.projectId) return true;
    if (e.date >= TODAY) return true;
    const proj = projects.find(p => p.id === e.projectId);
    return !proj || proj.status !== "Completed";
  };

  // Convert Google Calendar events into the same shape as app events (future only, timed only)
  const gcalAsEvents = gcalConnected ? gcalEvents
    .filter(ev => !ev.allDay && ev.start)
    .map(ev => {
      const startDt = new Date(ev.start);
      const evDate = startDt.toLocaleDateString("en-CA"); // YYYY-MM-DD in local TZ
      const endDt = ev.end ? new Date(ev.end) : null;
      const durationMin = endDt ? Math.max(15, Math.round((endDt - startDt) / 60000)) : 60;
      return {
        id: `gcal_${ev.id}`,
        gcal: true,
        date: evDate,
        member: currentUser,
        task: ev.title || "Meeting",
        projectId: "",
        startTime: `${String(startDt.getHours()).padStart(2,"0")}:${String(startDt.getMinutes()).padStart(2,"0")}`,
        durationMin,
        done: false,
        meetLink: ev.meetLink || "",
        location: ev.location || "",
        description: ev.description || "",
        organizer: ev.organizer || "",
        attendees: ev.attendees || [],
      };
    })
    .filter(ev => ev.date >= TODAY)
  : [];

  const displayCalEvents = [...calendarEvents, ...gcalAsEvents];

  const eventsForMember = displayCalEvents.filter(e => e.member === selMember && (e.gcal || isActiveEvent(e)));
  const eventsByDay = {};
  eventsForMember.forEach(e => { (eventsByDay[e.date] = eventsByDay[e.date]||[]).push(e); });

  // All-members grouping: { ymd: { MEMBER: [events...] } } — exclude completed-project events
  const allEventsByDay = {};
  calendarEvents.filter(isActiveEvent).forEach(e => {
    if (!allEventsByDay[e.date]) allEventsByDay[e.date] = {};
    (allEventsByDay[e.date][e.member] = allEventsByDay[e.date][e.member]||[]).push(e);
  });

  // Work Inbox — items assigned to selMember anywhere in the app with no scheduled future event
  const scheduledProjectIds = new Set(
    calendarEvents.filter(e => e.member === selMember && e.date >= TODAY).map(e => e.projectId).filter(Boolean)
  );
  const inboxProjects = projects.filter(p =>
    p.status !== "Completed" && (p.assigned || []).includes(selMember) && !scheduledProjectIds.has(p.id)
  );
  const inboxTasks = (tasks || []).filter(t => {
    if (t.assigned !== selMember) return false;
    if (t.status === "Done" || t.status === "Completed") return false;
    const proj = projects.find(p => p.id === t.projectId);
    // Hide tasks from completed projects, and tasks for projects the member isn't tagged on
    if (!proj || proj.status === "Completed") return false;
    if (!(proj.assigned || []).includes(selMember)) return false;
    return true;
  });
  // noteIds that are already scheduled as calendar events for this member
  const scheduledNoteIds = new Set(calendarEvents.filter(e => e.member===selMember && e.noteId).map(e => e.noteId));
  const inboxNotes = [];
  projects.forEach(p => {
    noteList(p.notes || []).forEach(n => {
      if (!(n.tagged||[]).includes(selMember)) return;
      if (n.done || scheduledNoteIds.has(n.id)) return;
      inboxNotes.push({ noteId:n.id, projectId:p.id, project:p, text:n.text, author:n.author, ts:n.ts, source:"Project Notes", done:!!n.done });
    });
    (p.checklistNotes || []).forEach(n => {
      if (!(n.tagged||[]).includes(selMember)) return;
      if (n.done || scheduledNoteIds.has(n.id)) return;
      inboxNotes.push({ noteId:n.id, projectId:p.id, project:p, text:n.text, author:n.author, ts:n.ts, source:"Tracker", done:!!n.done });
    });
  });
  const inboxFeedback = (feedback||[]).filter(f => (f.tagged||[]).includes(selMember) && f.status !== "Resolved").map(f => ({
    fbId: f.id,
    projectId: f.projectId,
    project: projects.find(p=>p.id===f.projectId),
    text: f.text,
    author: f.createdBy,
    ts: f.ts,
  }));
  const inboxCount = inboxTasks.length + inboxNotes.length + inboxFeedback.length;

  const goMonth = delta => {
    let m = viewMonth + delta, y = viewYear;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    setViewMonth(m); setViewYear(y);
  };
  const goToday = () => { setViewYear(now.getFullYear()); setViewMonth(now.getMonth()); };

  const mc = MEMBER_COLOR[selMember];

  // Month grid (with its nav/header) renders only when explicitly selected:
  // - "all" mode + grid sub-view, or
  // - "single" mode + month sub-view
  const showMonthGrid = (viewMode==="all" && allSubView==="grid") || (viewMode==="single" && singleSubView==="month");

  return (<>
    <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
      {/* ── Main calendar panel ── */}
      <div style={{flex:1,minWidth:0,background:TT.panel,border:`1px solid ${TT.border}`,borderRadius:12,padding:"12px 16px"}}>
        {/* Member selector + Whole Team — sits just above Day/Week/Month */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
          <div ref={memberSwitchRef} style={{position:"relative"}}>
            <button onClick={()=>{ setViewMode("single"); setShowMemberSwitch(s=>!s); }} style={{
              display:"flex",alignItems:"center",gap:5,padding:"5px 10px",borderRadius:7,
              background:viewMode==="single"?"#3B5BFF14":"var(--c-deep)",
              border:viewMode==="single"?`1px solid #3B5BFF44`:`1px solid ${TT.border}`,
              color:viewMode==="single"?"#3B5BFF":TT.textSub,fontWeight:viewMode==="single"?700:500,
              cursor:"pointer",fontSize:12,
            }}>
              {selMember}{selMember!==currentUser?" (viewing)":""}
              <span style={{fontSize:9,opacity:0.6}}>▾</span>
            </button>
            {showMemberSwitch && (
              <div style={{position:"absolute",top:"calc(100% + 6px)",left:0,zIndex:500,background:"#FFFFFF",border:`1px solid ${TT.border}`,borderRadius:8,padding:4,minWidth:150,boxShadow:TT.shadow}}>
                {TEAM.map(m => {
                  const active = m === selMember;
                  const c = MEMBER_COLOR[m];
                  return <button key={m} onClick={()=>{ setSelMember(m); setShowMemberSwitch(false); onSelMemberChange?.(m); }} style={{
                    display:"block",width:"100%",textAlign:"left",padding:"6px 10px",borderRadius:5,border:"none",
                    background:active?`${c}16`:"transparent",color:active?c:TT.text,fontSize:12,fontWeight:active?800:500,cursor:"pointer",marginBottom:1,
                  }}>
                    {active&&<span style={{marginRight:5}}>✓</span>}{m}{m===currentUser?" (you)":""}
                  </button>;
                })}
              </div>
            )}
          </div>
          <button onClick={()=>setViewMode("all")} style={{
            padding:"5px 10px",borderRadius:7,cursor:"pointer",fontSize:12,
            background:viewMode==="all"?"#3B5BFF14":"var(--c-deep)",
            border:viewMode==="all"?`1px solid #3B5BFF44`:`1px solid ${TT.border}`,
            color:viewMode==="all"?"#3B5BFF":TT.textSub,fontWeight:viewMode==="all"?700:500,
          }}>Whole Team</button>
          {canViewTeamSide&&<button onClick={()=>setViewMode("side-by-side")} style={{
            padding:"5px 10px",borderRadius:7,cursor:"pointer",fontSize:12,
            background:viewMode==="side-by-side"?"#8B5CF614":"var(--c-deep)",
            border:viewMode==="side-by-side"?`1px solid #8B5CF644`:`1px solid ${TT.border}`,
            color:viewMode==="side-by-side"?"#8B5CF6":TT.textSub,fontWeight:viewMode==="side-by-side"?700:500,
          }}>⊞ Side by Side</button>}
          {/* ── Google Calendar compact control ── */}
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
            {gcalStatus === "checking" && (
              <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"5px 10px",borderRadius:7,border:"1px solid #e2e8f0",background:"var(--c-panel)",fontSize:12,color:"var(--c-t4)"}}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 9h18" stroke="currentColor" strokeWidth="2"/><path d="M8 2v4M16 2v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                Checking…
              </span>
            )}
            {gcalStatus === "connected" && (<>
              <button ref={gcalBtnRef}
                onClick={() => {
                  if (!gcalListOpen && gcalBtnRef.current) {
                    const r = gcalBtnRef.current.getBoundingClientRect();
                    setGcalListPos({ right: window.innerWidth - r.right, top: r.bottom + 6 });
                  }
                  setGcalListOpen(o => !o);
                }}
                disabled={gcalLoading}
                title="View Google Calendar meetings"
                style={{display:"inline-flex",alignItems:"center",gap:5,padding:"5px 10px",borderRadius:7,border:`1px solid ${gcalListOpen?"#7C3AED66":"#22C55E44"}`,background:gcalListOpen?"#7C3AED10":"#22C55E08",cursor:"pointer",fontSize:12,fontWeight:600,color:gcalListOpen?"#7C3AED":"#16A34A",transition:"all 0.15s"}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:"#22C55E",display:"inline-block",flexShrink:0}}/>
                {gcalLoading ? "Syncing…" : `${gcalEvents.filter(e => e.start && new Date(e.start) >= new Date()).length} meetings scheduled ▾`}
              </button>
              <button onClick={()=>fetchGcalEvents()} disabled={gcalLoading} title="Sync now"
                style={{display:"inline-flex",alignItems:"center",justifyContent:"center",padding:"5px 7px",borderRadius:7,border:"1px solid #22C55E44",background:"#22C55E08",cursor:gcalLoading?"not-allowed":"pointer",color:"#16A34A",transition:"all 0.15s",opacity:gcalLoading?0.5:1}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M23 4v6h-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M1 20v-6h6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </>)}
            {gcalStatus === "disconnected" && (
              <button onClick={connectGcal} title="Connect Google Calendar"
                style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:7,border:"1px solid #dadce0",background:"#fff",cursor:"pointer",fontSize:12,fontWeight:600,color:"#3c4043",boxShadow:"0 1px 2px rgba(0,0,0,0.08)"}}>
                <svg width="14" height="14" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                Connect Google Calendar
              </button>
            )}
            {gcalStatus === "error" && (
              <button onClick={connectGcal} title="Google Calendar token expired — click to reconnect (one-time OAuth)"
                style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:7,border:"1px solid #EF444444",background:"#EF444408",cursor:"pointer",fontSize:12,fontWeight:600,color:"#EF4444"}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:"#EF4444",display:"inline-block",flexShrink:0}}/>
                Reconnect Google Calendar
              </button>
            )}
          </div>
          {/* ── GCal meetings panel (portal) ── */}
          {gcalListOpen && gcalConnected && createPortal(<>
            <div style={{position:"fixed",inset:0,zIndex:3001}} onClick={()=>setGcalListOpen(false)}/>
            <div style={{
              position:"fixed",right:gcalListPos?.right??20,top:gcalListPos?.top??60,
              zIndex:3002,background:"var(--c-panel)",border:"1px solid var(--c-border)",
              borderRadius:10,boxShadow:"0 8px 32px rgba(0,0,0,0.28)",width:340,maxHeight:460,
              display:"flex",flexDirection:"column",overflow:"hidden"
            }} onClick={e=>e.stopPropagation()}>
              {/* Header */}
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",borderBottom:"1px solid var(--c-border)",flexShrink:0}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="2" stroke="#7C3AED" strokeWidth="2"/><path d="M3 9h18" stroke="#7C3AED" strokeWidth="2"/><path d="M8 2v4M16 2v4" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round"/></svg>
                <span style={{fontWeight:800,fontSize:13,color:"var(--c-t1)",flex:1}}>Google Calendar Meetings</span>
                <button onClick={()=>{ fetchGcalEvents(); }} disabled={gcalLoading}
                  title="Refresh from Google Calendar"
                  style={{background:"none",border:"1px solid var(--c-border)",borderRadius:5,padding:"3px 7px",cursor:"pointer",fontSize:11,color:"#4285F4",fontWeight:700,display:"inline-flex",alignItems:"center",gap:4}}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M23 4v6h-6" stroke="#4285F4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M1 20v-6h6" stroke="#4285F4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" stroke="#4285F4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  {gcalLoading ? "…" : "Sync"}
                </button>
                <button onClick={()=>setGcalListOpen(false)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--c-t4)",fontSize:16,lineHeight:1,padding:"2px 4px"}}>×</button>
              </div>
              {/* Meeting list */}
              <div style={{overflowY:"auto",flex:1}}>
                {gcalEvents.length === 0 ? (
                  <div style={{padding:"28px 14px",textAlign:"center",color:"var(--c-t4)",fontSize:12}}>
                    No upcoming meetings found.<br/>
                    <span style={{fontSize:11}}>Click Sync to refresh from Google Calendar.</span>
                  </div>
                ) : (
                  [...gcalEvents]
                    .sort((a,b) => new Date(a.start) - new Date(b.start))
                    .map(ev => {
                      const startDt = new Date(ev.start);
                      const endDt   = ev.end ? new Date(ev.end) : null;
                      const todayStr = new Date().toLocaleDateString("en-CA");
                      const evDateStr = startDt.toLocaleDateString("en-CA");
                      const isToday = evDateStr === todayStr;
                      const isTomorrow = evDateStr === new Date(Date.now()+86400000).toLocaleDateString("en-CA");
                      const dateLabel = isToday ? "Today" : isTomorrow ? "Tomorrow"
                        : startDt.toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"});
                      const timeLabel = ev.allDay ? "All day"
                        : startDt.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"})
                          + (endDt ? " – "+endDt.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"}) : "");
                      const nowMs = Date.now();
                      const isPast = endDt && endDt < nowMs;
                      const isActive = !ev.allDay && startDt <= nowMs && endDt >= nowMs;
                      return (
                        <div key={ev.id} style={{
                          display:"flex",alignItems:"flex-start",gap:10,
                          padding:"10px 14px",borderBottom:"1px solid var(--c-border)",
                          background:isActive?"#7C3AED08":isPast?"var(--c-page)":"transparent",
                          opacity:isPast?0.6:1
                        }}>
                          <div style={{flex:1,minWidth:0}}>
                            {isActive && <div style={{fontSize:9,fontWeight:800,color:"#7C3AED",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>● Live Now</div>}
                            {isPast && <div style={{fontSize:9,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>✓ Completed</div>}
                            <div style={{fontSize:12,fontWeight:700,color:"var(--c-t1)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ev.title}</div>
                            <div style={{fontSize:11,color:"var(--c-t3)",marginTop:2,display:"flex",gap:6,flexWrap:"wrap"}}>
                              <span style={{color:isToday?"#7C3AED":"var(--c-t3)",fontWeight:isToday?700:400}}>{dateLabel}</span>
                              <span>·</span>
                              <span>{timeLabel}</span>
                            </div>
                            {ev.location && <div style={{fontSize:10,color:"var(--c-t4)",marginTop:2}}>📍 {ev.location}</div>}
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:4,flexShrink:0,alignItems:"flex-end"}}>
                            {ev.meetLink && !isPast && (
                              <a href={ev.meetLink} target="_blank" rel="noreferrer"
                                style={{fontSize:10,fontWeight:700,background:"#7C3AED",color:"#fff",borderRadius:4,padding:"2px 7px",textDecoration:"none",whiteSpace:"nowrap"}}>
                                Join
                              </a>
                            )}
                            {!isPast && (
                              <button onClick={()=>deleteGcalEvent(ev.id)}
                                title="Hide from calendar (until next sync)"
                                style={{background:"none",border:"1px solid #EF444444",borderRadius:4,color:"#EF4444",cursor:"pointer",fontSize:10,fontWeight:700,padding:"2px 6px",whiteSpace:"nowrap"}}>
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                )}
              </div>
              <div style={{padding:"7px 14px",borderTop:"1px solid var(--c-border)",fontSize:10,color:"var(--c-t4)",flexShrink:0}}>
                Past meetings are kept permanently. Remove only hides upcoming meetings until the next sync.
              </div>
            </div>
          </>, document.body)}
        </div>

      {false && (
        <div>
          {showInbox && (
            <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:6,background:TT.bg}}>
              {inboxTasks.length > 0 && (
                <>
                  <div style={{fontSize:10,fontWeight:700,color:TT.textSub,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2}}>Assigned Tasks</div>
                  {inboxTasks.map(t => {
                    const proj = projects.find(p=>p.id===t.projectId);
                    return (
                      <div key={t.id}
                        draggable
                        onDragStart={e=>{ e.dataTransfer.effectAllowed="move"; setDraggingInboxItem({type:"task",projectId:t.projectId||"",taskTitle:t.title}); }}
                        onDragEnd={()=>setDraggingInboxItem(null)}
                        style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:TT.panel,borderRadius:7,border:`1px solid ${TT.border}`,cursor:"grab"}}>
                        <div onClick={()=>onCompleteTask?.(t.id)} title="Mark complete" style={{width:16,height:16,borderRadius:4,border:`1.5px solid #6B7280`,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}/>
                        {proj && <span style={{fontSize:11,fontFamily:"monospace",fontWeight:800,color:mc,flexShrink:0}}>{proj.jobCode}</span>}
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:12,color:TT.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</div>
                          {t.assignedBy && <div style={{fontSize:10,color:TT.textFaint,marginTop:1}}>Assigned by {t.assignedBy}</div>}
                        </div>
                        {t.due && <span style={{fontSize:10,color:TT.textSub,whiteSpace:"nowrap",flexShrink:0}}>{t.due}</span>}
                        <button onClick={e=>{e.stopPropagation();setAddModal(t.due>=TODAY?t.due:TODAY);setAddModalFromInbox(true);setPrefillProjectId(t.projectId||"");setPrefillTask(t.title);setPrefillTime("09:00");setPrefillDuration(90);}}
                          style={{background:"#F97316",color:"#fff",border:"none",borderRadius:5,padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                          + Schedule
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
              {inboxNotes.length > 0 && (
                <>
                  <div style={{fontSize:10,fontWeight:700,color:"#F97316",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2,marginTop:(inboxProjects.length>0||inboxTasks.length>0)?8:0}}>Tagged in Notes</div>
                  {inboxNotes.map((n,i) => {
                    return (
                      <div key={n.noteId+i}
                        draggable
                        onDragStart={e=>{ e.dataTransfer.effectAllowed="move"; setDraggingInboxItem({type:"note-tag",projectId:n.projectId,taskTitle:n.text.length>80?n.text.slice(0,77)+"…":n.text,noteId:n.noteId}); }}
                        onDragEnd={()=>setDraggingInboxItem(null)}
                        style={{display:"flex",alignItems:"flex-start",gap:8,padding:"8px 10px",background:TT.panel,borderRadius:7,border:`1.5px solid #F9731644`,cursor:"grab"}}>
                        <div onClick={e=>{e.stopPropagation();e.preventDefault();onToggleNoteDone?.(n.projectId,n.noteId,n.source);}}
                          title="Mark as done"
                          style={{width:16,height:16,borderRadius:4,border:`1.5px solid #F97316`,background:"transparent",cursor:"pointer",flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center"}}>
                        </div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                            <span style={{fontSize:11,fontFamily:"monospace",fontWeight:800,color:"#F97316",background:"#F9731618",borderRadius:3,padding:"1px 5px",flexShrink:0}}>{n.project.jobCode||"—"}</span>
                            <span style={{fontSize:9,color:"#F97316",fontWeight:700,background:"#F9731618",borderRadius:8,padding:"1px 6px",flexShrink:0}}>{n.source}</span>
                          </div>
                          <div style={{fontSize:12,color:TT.text,lineHeight:1.4,marginBottom:3}}>{n.text}</div>
                          {n.author && <div style={{fontSize:10,color:TT.textFaint}}>Tagged by {n.author}</div>}
                        </div>
                        <button onClick={e=>{e.stopPropagation();setAddModal(TODAY);setAddModalFromInbox(true);setPrefillProjectId(n.projectId);setPrefillTask(n.text.length>80?n.text.slice(0,77)+"…":n.text);setPrefillTime("09:00");setPrefillDuration(60);setPrefillNoteId(n.noteId);}}
                          style={{background:"#F97316",color:"#fff",border:"none",borderRadius:5,padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                          + Schedule
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
              {inboxFeedback.length > 0 && (
                <>
                  <div style={{fontSize:10,fontWeight:700,color:"#3B82F6",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2,marginTop:(inboxProjects.length>0||inboxTasks.length>0||inboxNotes.length>0)?8:0}}>Tagged in Feedback</div>
                  {inboxFeedback.map((f,i) => (
                    <div key={f.fbId+i}
                      draggable
                      onDragStart={e=>{ e.dataTransfer.effectAllowed="move"; setDraggingInboxItem({type:"feedback",projectId:f.projectId,taskTitle:f.text.length>80?f.text.slice(0,77)+"…":f.text}); }}
                      onDragEnd={()=>setDraggingInboxItem(null)}
                      style={{display:"flex",alignItems:"flex-start",gap:8,padding:"8px 10px",background:TT.panel,borderRadius:7,border:`1.5px solid #3B82F644`,cursor:"grab"}}>
                      <span style={{fontSize:13,flexShrink:0,marginTop:1}}>💬</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                          <span style={{fontSize:11,fontFamily:"monospace",fontWeight:800,color:"#3B82F6",background:"#3B82F618",borderRadius:3,padding:"1px 5px",flexShrink:0}}>{f.project?.jobCode||"—"}</span>
                          <span style={{fontSize:9,color:"#3B82F6",fontWeight:700,background:"#3B82F618",borderRadius:8,padding:"1px 6px",flexShrink:0}}>Feedback</span>
                        </div>
                        <div style={{fontSize:12,color:TT.text,lineHeight:1.4,marginBottom:3}}>{f.text}</div>
                        {f.author && <div style={{fontSize:10,color:TT.textFaint}}>From {f.author}</div>}
                      </div>
                      <button onClick={e=>{e.stopPropagation();setAddModal(TODAY);setAddModalFromInbox(true);setPrefillProjectId(f.projectId);setPrefillTask(f.text.length>80?f.text.slice(0,77)+"…":f.text);setPrefillTime("09:00");setPrefillDuration(60);}}
                        style={{background:"#3B82F6",color:"#fff",border:"none",borderRadius:5,padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                        + Schedule
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Side-by-Side: week navigation + team grid */}
      {viewMode==="side-by-side" && (
        <>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
            <button onClick={()=>setSelDate(d=>{const nd=new Date(d+"T00:00:00");nd.setDate(nd.getDate()-7);return ymd(nd);})}
              style={{background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 12px",fontSize:14}}>‹</button>
            <div style={{fontSize:13,fontWeight:800,color:TT.text,minWidth:200,textAlign:"center"}}>
              {(()=>{const wk=getWeekDays(selDate);const a=new Date(wk[0]+"T00:00:00"),b=new Date(wk[6]+"T00:00:00");const sm=a.getMonth()===b.getMonth();return sm?`${a.getDate()}–${b.getDate()} ${CAL_MONTHS[a.getMonth()]} ${a.getFullYear()}`:`${a.getDate()} ${CAL_MONTHS[a.getMonth()]} – ${b.getDate()} ${CAL_MONTHS[b.getMonth()]} ${b.getFullYear()}`;})()}
            </div>
            <button onClick={()=>setSelDate(d=>{const nd=new Date(d+"T00:00:00");nd.setDate(nd.getDate()+7);return ymd(nd);})}
              style={{background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 12px",fontSize:14}}>›</button>
            <button onClick={()=>setSelDate(todayYmd())} style={{background:"#FFFFFF",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 14px",fontSize:12,fontWeight:700}}>Today</button>
          </div>
          <TeamSideView calendarEvents={calendarEvents} projects={projects} selDate={selDate} onUpdateEvent={onUpdateEvent}/>
        </>
      )}

      {/* Day/Week/Month sub-toggle + date nav + hour-range adjuster — only in single-member mode */}
      {viewMode==="single" && (
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
          <div style={{display:"flex",gap:16,borderBottom:`1px solid ${TT.border}`}}>
            <button onClick={()=>setSingleSubView("day")} style={{
              padding:"6px 2px",background:"none",cursor:"pointer",fontSize:12,
              border:"none",borderBottom:singleSubView==="day"?"2px solid #3B5BFF":"2px solid transparent",
              color:singleSubView==="day"?"#3B5BFF":TT.textSub,fontWeight:singleSubView==="day"?700:500,
            }}>Day</button>
            <button onClick={()=>setSingleSubView("week")} style={{
              padding:"6px 2px",background:"none",cursor:"pointer",fontSize:12,
              border:"none",borderBottom:singleSubView==="week"?"2px solid #3B5BFF":"2px solid transparent",
              color:singleSubView==="week"?"#3B5BFF":TT.textSub,fontWeight:singleSubView==="week"?700:500,
            }}>Week</button>
            <button onClick={()=>setSingleSubView("month")} style={{
              padding:"6px 2px",background:"none",cursor:"pointer",fontSize:12,
              border:"none",borderBottom:singleSubView==="month"?"2px solid #3B5BFF":"2px solid transparent",
              color:singleSubView==="month"?"#3B5BFF":TT.textSub,fontWeight:singleSubView==="month"?700:500,
            }}>Month</button>
          </div>

          {(singleSubView==="day" || singleSubView==="week") && (
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <button onClick={()=>setSelDate(d=>{ const nd=new Date(d+"T00:00:00"); nd.setDate(nd.getDate()-(singleSubView==="week"?7:1)); return ymd(nd); })}
                style={{background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 12px",fontSize:14}}>‹</button>
              <div style={{fontSize:13,fontWeight:800,color:TT.text,minWidth:170,textAlign:"center"}}>
                {singleSubView==="day"
                  ? new Date(selDate+"T00:00:00").toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short",year:"numeric"})
                  : (()=>{ const wk=getWeekDays(selDate); const a=new Date(wk[0]+"T00:00:00"), b=new Date(wk[6]+"T00:00:00");
                      const sameMonth = a.getMonth()===b.getMonth();
                      return sameMonth
                        ? `${a.getDate()}–${b.getDate()} ${CAL_MONTHS[a.getMonth()]} ${a.getFullYear()}`
                        : `${a.getDate()} ${CAL_MONTHS[a.getMonth()]} – ${b.getDate()} ${CAL_MONTHS[b.getMonth()]} ${b.getFullYear()}`;
                    })()
                }
              </div>
              <button onClick={()=>setSelDate(d=>{ const nd=new Date(d+"T00:00:00"); nd.setDate(nd.getDate()+(singleSubView==="week"?7:1)); return ymd(nd); })}
                style={{background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 12px",fontSize:14}}>›</button>
              <button onClick={()=>setSelDate(todayYmd())} style={{background:"#FFFFFF",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 14px",fontSize:12,fontWeight:700}}>Today</button>

              <div style={{position:"relative"}}>
                <button onClick={()=>setShowHourSettings(s=>!s)} title="Adjust visible hours" style={{
                  background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 12px",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:5,
                }}>🕐 {hourLabel(hourRange.start)}–{hourLabel(hourRange.end===24?0:hourRange.end)} ▾</button>
                {showHourSettings && (
                  <HourRangeSettings
                    hourRange={hourRange}
                    hourPreset={hourPreset}
                    onChange={(preset,range)=>{ setHourPreset(preset); setHourRange(range); setShowHourSettings(false); }}
                    onClose={()=>setShowHourSettings(false)}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Day Hour View */}
      {viewMode==="single" && singleSubView==="day" && (
        <DayHourView
          date={selDate}
          events={displayCalEvents.filter(e=>e.member===selMember && e.date===selDate)}
          onGcalClick={setGcalDetailEvent}
          projects={projects}
          member={selMember}
          currentUser={currentUser}
          hourRange={hourRange}
          onAddAt={(time,durationMin,extra)=>{
            if (selDate < todayYmd()) return;
            if (extra?.quick && extra.projectId) {
              // Quick add: create the event immediately, no modal at all
              const dayCount = (eventsByDay[selDate]||[]).length;
              onAddEvent({ id:mkId(), date:selDate, member:selMember, projectId:extra.projectId, task:extra.task||"", subtasks:[], startTime:time, durationMin, createdBy:currentUser, ts:nowTs(), order:dayCount, done:false });
            } else {
              // Escalate to the full modal for subtasks / more detail, pre-filled with whatever was already chosen
              setAddModal(selDate); setPrefillTime(time); setPrefillDuration(durationMin||60); setPrefillProjectId(extra?.projectId||""); setPrefillTask(extra?.task||""); setEventAnchorRect(extra?.anchorRect||null);
            }
          }}
          onEdit={(ev,rect)=>{ setEditingEvent(ev); setEventAnchorRect(rect||null); }}
          onToggleDone={handleToggleDone}
          onRemove={(id)=>onRemoveEvent(id)}
          onMoveTime={(id,newTime)=>onUpdateEvent(id,{startTime:newTime})}
          onResize={(id,durationMin)=>onUpdateEvent(id,{durationMin})}
          onToggleSubtask={(eventId,subtaskId)=>onToggleSubtask(eventId,subtaskId)}
          draggingInboxItem={effectiveDraggingItem}
          onDropInboxItem={dropInboxItem}
          onCopyEvent={(id,overrides)=>onCopyEvent?.(id,overrides)}
        />
      )}

      {/* Week Hour View — default single-member view */}
      {viewMode==="single" && singleSubView==="week" && (
        <WeekHourView
          weekDates={getWeekDays(selDate)}
          eventsByDay={(()=>{
            const wk = getWeekDays(selDate);
            const map = {};
            wk.forEach(d => { map[d] = displayCalEvents.filter(e=>e.member===selMember && e.date===d); });
            return map;
          })()}
          projects={projects}
          member={selMember}
          currentUser={currentUser}
          hourRange={hourRange}
          onAddAt={(dymd,time,durationMin,extra)=>{
            if (dymd < todayYmd()) return;
            if (extra?.quick && extra.projectId) {
              const dayCount = (calendarEvents.filter(e=>e.member===selMember && e.date===dymd)).length;
              onAddEvent({ id:mkId(), date:dymd, member:selMember, projectId:extra.projectId, task:extra.task||"", subtasks:[], startTime:time, durationMin, createdBy:currentUser, ts:nowTs(), order:dayCount, done:false });
            } else {
              setAddModal(dymd); setPrefillTime(time); setPrefillDuration(durationMin||60); setPrefillProjectId(extra?.projectId||""); setPrefillTask(extra?.task||""); setEventAnchorRect(extra?.anchorRect||null);
            }
          }}
          onEdit={(ev,rect)=>{ setEditingEvent(ev); setEventAnchorRect(rect||null); }}
          onToggleDone={handleToggleDone}
          onMoveTask={(id,newDate,newTime)=>{
            const ev = calendarEvents.find(e=>e.id===id);
            if (!ev) return;
            if (ev.date === newDate) onUpdateEvent(id,{startTime:newTime});
            else if (newDate >= todayYmd()) onMoveEvent(id,newDate,newTime);
          }}
          onResize={(id,durationMin)=>onUpdateEvent(id,{durationMin})}
          onToggleSubtask={(eventId,subtaskId)=>onToggleSubtask(eventId,subtaskId)}
          onRemove={(id)=>onRemoveEvent(id)}
          draggingInboxItem={effectiveDraggingItem}
          onDropInboxItem={dropInboxItem}
          onCopyEvent={(id,overrides)=>onCopyEvent?.(id,overrides)}
          onGcalClick={setGcalDetailEvent}
        />
      )}

      {/* Legend — only in all-members mode */}
      {viewMode==="all" && (
        <div style={{display:"flex",gap:14,marginBottom:14,flexWrap:"wrap",alignItems:"center",padding:"8px 12px",background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:8}}>
          <span style={{fontSize:11,color:TT.textSub,fontWeight:700,textTransform:"uppercase"}}>Team</span>
          {TEAM.map(m => {
            const c = MEMBER_COLOR[m];
            const count = calendarEvents.filter(e=>e.member===m).length;
            return (
              <div key={m} style={{display:"flex",alignItems:"center",gap:5}}>
                <div style={{width:9,height:9,borderRadius:"50%",background:c}}/>
                <span style={{fontSize:12,fontWeight:700,color:c}}>{m}</span>
                <span style={{fontSize:10,color:TT.textFaint}}>({count})</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Grid vs Timeline sub-toggle — only in all-members mode */}
      {viewMode==="all" && (
        <div style={{display:"flex",gap:16,marginBottom:14,borderBottom:`1px solid ${TT.border}`}}>
          <button onClick={()=>setAllSubView("timeline")} style={{
            padding:"6px 2px",background:"none",cursor:"pointer",fontSize:12,
            border:"none",borderBottom:allSubView==="timeline"?"2px solid #3B5BFF":"2px solid transparent",
            color:allSubView==="timeline"?"#3B5BFF":TT.textSub,fontWeight:allSubView==="timeline"?700:500,
          }}>Full Timeline (past + upcoming)</button>
          <button onClick={()=>setAllSubView("grid")} style={{
            padding:"6px 2px",background:"none",cursor:"pointer",fontSize:12,
            border:"none",borderBottom:allSubView==="grid"?"2px solid #3B5BFF":"2px solid transparent",
            color:allSubView==="grid"?"#3B5BFF":TT.textSub,fontWeight:allSubView==="grid"?700:500,
          }}>Month Grid</button>
        </div>
      )}

      {/* Month nav — only when the month grid is the active view */}
      {showMonthGrid && (
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <button onClick={()=>goMonth(-1)} style={{background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 12px",fontSize:14}}>‹</button>
            <div style={{fontSize:15,fontWeight:800,color:TT.text,minWidth:160,textAlign:"center"}}>{CAL_MONTHS[viewMonth]} {viewYear}</div>
            <button onClick={()=>goMonth(1)} style={{background:"#F7F8FA",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 12px",fontSize:14}}>›</button>
          </div>
          <button onClick={goToday} style={{background:"#FFFFFF",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 14px",fontSize:12,fontWeight:700}}>Today</button>
        </div>
      )}

      {/* Full Timeline — every event, every member, all time, chronological */}
      {viewMode==="all" && allSubView==="timeline" && (
        <TeamTimeline
          calendarEvents={calendarEvents}
          projects={projects}
          onRemove={onRemoveEvent}
          onDayClick={(dymd)=>setDayModal(dymd)}
        />
      )}

      {/* Day-of-week header — only when the month grid is the active view */}
      {showMonthGrid && (
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:6,marginBottom:6}}>
          {CAL_DOW.map(d => <div key={d} style={{textAlign:"center",fontSize:11,fontWeight:800,color:TT.textSub,textTransform:"uppercase",padding:"4px 0"}}>{d}</div>)}
        </div>
      )}

      {/* Grid — only when the month grid is the active view */}
      {showMonthGrid && (
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:6}}>
        {grid.map(({date,ymd:dymd,inMonth}) => {
          const today = isToday(dymd);
          const isPast = dymd < TODAY;

          if (viewMode === "all") {
            const dayMap = allEventsByDay[dymd] || {};
            const membersWithEvents = TEAM.filter(m => (dayMap[m]||[]).length > 0);
            const totalCount = membersWithEvents.reduce((sum,m)=>sum+dayMap[m].length,0);
            return (
              <div key={dymd}
                onClick={()=>{ if (!isPast) setDayModal(dymd); }}
                style={{
                  minHeight:96, borderRadius:8, padding:"7px 8px", cursor: isPast ? "default" : "pointer",
                  background: isPast ? "#F1F5F9" : inMonth ? "#FFFFFF" : "#FAFBFC",
                  border:`1px solid ${TT.border}`,
                  opacity: isPast ? 0.55 : inMonth ? 1 : 0.5,
                  display:"flex", flexDirection:"column", gap:4,
                }}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:20,height:20,borderRadius:"50%",fontSize:12,fontWeight:today?900:600,color:today?"#fff":inMonth?TT.text:TT.textFaint,background:today?"#3B5BFF":"transparent"}}>{date.getDate()}</span>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:3,overflow:"hidden"}}>
                  {membersWithEvents.slice(0,6).map(m => {
                    const c = MEMBER_COLOR[m];
                    return (
                      <div key={m} title={`${m}: ${dayMap[m].length} item${dayMap[m].length!==1?"s":""}`}
                        style={{width:16,height:16,borderRadius:"50%",background:c,display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,fontWeight:900,color:"#fff",border:"1.5px solid #fff"}}>
                        {m.slice(0,1)}
                      </div>
                    );
                  })}
                </div>
                {totalCount>0 && <div style={{fontSize:9,color:TT.textFaint,fontWeight:700,marginTop:"auto"}}>{totalCount} total</div>}
              </div>
            );
          }

          // Single-member mode (existing behavior, now with drag-to-move + done state)
          const dayEvents = eventsByDay[dymd] || [];
          const isPastDay = dymd < TODAY;
          const isDropTarget = dragOverDay === dymd && (dragEventId || (effectiveDraggingItem && !isPastDay));
          return (
            <div key={dymd}
              onClick={()=>{ if (!isPastDay) setDayModal(dymd); }}
              onDragOver={e=>{
                if (dragEventId && !isPastDay) { e.preventDefault(); if(dragOverDay!==dymd) setDragOverDay(dymd); }
                else if (dragEventId && isPastDay) { e.dataTransfer.dropEffect="none"; }
                else if (effectiveDraggingItem && !isPastDay) { e.preventDefault(); e.dataTransfer.dropEffect="move"; if(dragOverDay!==dymd) setDragOverDay(dymd); }
                else if (effectiveDraggingItem && isPastDay) { e.dataTransfer.dropEffect="none"; }
              }}
              onDragLeave={()=>setDragOverDay(d=>d===dymd?null:d)}
              onDrop={e=>{
                e.preventDefault();
                if (dragEventId && !isPastDay) {
                  if ((e.ctrlKey || e.metaKey) && onCopyEvent) { onCopyEvent(dragEventId, { date: dymd }); }
                  else { onMoveEvent(dragEventId, dymd); }
                  setDragEventId(null); setDragOverDay(null);
                } else if (effectiveDraggingItem && !isPastDay) { dropInboxItem(dymd, ""); }
              }}
              style={{
                minHeight:92, borderRadius:8, padding:"7px 8px", cursor: isPastDay ? "default" : "pointer",
                background: isDropTarget ? `${mc}14` : isPastDay ? "#F1F5F9" : inMonth ? "#FFFFFF" : "#FAFBFC",
                border: isDropTarget ? `1.5px dashed ${mc}` : `1px solid ${TT.border}`,
                opacity: isPastDay ? 0.55 : inMonth ? 1 : 0.5,
                display:"flex", flexDirection:"column", gap:4,
              }}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:20,height:20,borderRadius:"50%",fontSize:12,fontWeight:today?900:600,color:today?"#fff":inMonth?TT.text:TT.textFaint,background:today?mc:"transparent"}}>{date.getDate()}</span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:2,overflow:"hidden"}}>
                {dayEvents.slice(0,3).map(ev => {
                  if (ev.gcal) {
                    const time = fmtTime12(ev.startTime);
                    return (
                      <div key={ev.id}
                        onClick={e=>{ e.stopPropagation(); if(ev.meetLink) window.open(ev.meetLink,"_blank"); }}
                        title={ev.task + (ev.meetLink?" — click to join":"")}
                        style={{fontSize:9,fontWeight:700,color:"#7C3AED",background:"#7C3AED18",borderLeft:"2px solid #7C3AED",borderRadius:3,padding:"1px 4px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:ev.meetLink?"pointer":"default",display:"flex",alignItems:"center",gap:3}}>
                        <span style={{flexShrink:0,fontSize:8}}>📅</span>
                        {time && <span style={{opacity:0.8}}>{time}</span>}
                        {ev.task}
                      </div>
                    );
                  }
                  const proj = projects.find(p=>p.id===ev.projectId);
                  const time = fmtTime12(ev.startTime);
                  return (
                    <div key={ev.id}
                      draggable
                      onDragStart={e=>{ e.stopPropagation(); setDragEventId(ev.id); }}
                      onDragEnd={e=>{ e.stopPropagation(); setDragEventId(null); setDragOverDay(null); }}
                      onClick={e=>{ e.stopPropagation(); setEditingEvent(ev); setEventAnchorRect(e.currentTarget.getBoundingClientRect()); }}
                      title="Drag onto another day to reschedule — click to edit"
                      style={{
                        fontSize:9,fontFamily:"monospace",fontWeight:800,
                        color:ev.done?TT.textFaint:mc,
                        background:ev.done?"#F7F8FA":`${mc}1F`,
                        border:"none",
                        borderRadius:3,padding:"1px 4px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                        textDecoration:ev.done?"line-through":"none",
                        cursor:"grab",
                        display:"flex",alignItems:"center",gap:3,
                      }}>
                      {ev.done && <span>✓</span>}
                      {time && <span style={{opacity:0.75}}>{time}</span>}
                      {proj?.jobCode || "—"}
                    </div>
                  );
                })}
                {dayEvents.length>3 && <div style={{fontSize:9,color:TT.textFaint,fontWeight:700}}>+{dayEvents.length-3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* Day detail / add modals */}
      {viewMode==="all" && dayModal && (
        <AllDayDetailModal
          date={dayModal}
          events={displayCalEvents.filter(e=>e.date===dayModal)}
          projects={projects}
          currentUser={currentUser}
          onAddFor={(member,fields)=>{
            onAddEvent({ id:mkId(), date:dayModal, member, ...fields, createdBy:currentUser, ts:nowTs(), order:0, done:false });
          }}
          onRemove={(id)=>onRemoveEvent(id)}
          onClose={()=>setDayModal(null)}
        />
      )}
      {viewMode==="single" && dayModal && (
        <DayDetailModal
          date={dayModal}
          member={selMember}
          events={(eventsByDay[dayModal]||[])}
          projects={projects}
          currentUser={currentUser}
          onAdd={(rect)=>{ setAddModal(dayModal); setEventAnchorRect(rect||null); }}
          onEdit={(ev,rect)=>{ setEditingEvent(ev); setEventAnchorRect(rect||null); }}
          onRemove={(id)=>onRemoveEvent(id)}
          onToggleDone={handleToggleDone}
          onReorder={(orderedIds)=>onReorderDay(dayModal, selMember, orderedIds)}
          onToggleSubtask={(eventId,subtaskId)=>onToggleSubtask(eventId,subtaskId)}
          onClose={()=>setDayModal(null)}
        />
      )}
      {addModal && (
        <EventModal
          date={addModal}
          member={selMember}
          projects={projects}
          prefillStartTime={prefillTime}
          prefillDuration={prefillDuration}
          prefillProjectId={prefillProjectId}
          prefillTask={prefillTask}
          anchorRect={eventAnchorRect}
          minDate={TODAY}
          onSave={({date,projectId,task,subtasks,startTime,durationMin})=>{
            const dayCount = (eventsByDay[date]||[]).length;
            const noteId = prefillNoteId || undefined;
            onAddEvent({ id:mkId(), date, member:selMember, projectId, task, subtasks, startTime, durationMin, createdBy:currentUser, ts:nowTs(), order:dayCount, done:false, ...(noteId?{noteId}:{}) });
            setAddModal(null); setAddModalFromInbox(false); setPrefillTime(""); setPrefillDuration(60); setPrefillProjectId(""); setPrefillTask(""); setPrefillNoteId(null); setEventAnchorRect(null);
          }}
          onClose={()=>{ setAddModal(null); setAddModalFromInbox(false); setPrefillTime(""); setPrefillDuration(60); setPrefillProjectId(""); setPrefillTask(""); setPrefillNoteId(null); setEventAnchorRect(null); }}
        />
      )}
      {editingEvent && (
        <EventModal
          date={editingEvent.date}
          member={editingEvent.member}
          projects={projects}
          initial={editingEvent}
          anchorRect={eventAnchorRect}
          minDate={editingEvent.date >= TODAY ? TODAY : undefined}
          onSave={({date,projectId,task,subtasks,startTime,durationMin})=>{
            onUpdateEvent(editingEvent.id, {date,projectId,task,subtasks,startTime,durationMin});
            setEditingEvent(null); setEventAnchorRect(null);
          }}
          onDelete={(id)=>{ onRemoveEvent(id); setEditingEvent(null); setEventAnchorRect(null); }}
          onClose={()=>{ setEditingEvent(null); setEventAnchorRect(null); }}
        />
      )}
      {/* Timezone notice — bottom of panel */}
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:10}}>
        <span title="Times you see are in this zone. Teammates in other zones get a 'your time' conversion automatically." style={{fontSize:10,color:TT.textFaint,fontWeight:600}}>
          🌐 {zoneAbbrev(DEVICE_TZ)} ({DEVICE_TZ})
        </span>
      </div>
      </div>
    </div>

    {/* ── Google Calendar Meeting Detail Modal ── */}
    {gcalDetailEvent && (()=>{
      const ev = gcalDetailEvent;
      const startDt = ev.start ? new Date(ev.start) : null;
      const endDt = ev.end ? new Date(ev.end) : null;
      const dateStr = startDt ? startDt.toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"}) : "";
      const timeStr = startDt && !ev.allDay ? startDt.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"}) + (endDt ? " – " + endDt.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"}) : "") : "All day";
      return (
        <div onClick={()=>setGcalDetailEvent(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div onClick={e=>e.stopPropagation()} style={{background:TT.panel,borderRadius:14,width:"100%",maxWidth:520,boxShadow:"0 20px 60px rgba(0,0,0,0.25)",overflow:"hidden"}}>
            {/* Header */}
            <div style={{background:"#7C3AED",padding:"18px 20px",display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div>
                <div style={{fontSize:11,fontWeight:700,color:"#DDD6FE",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:4}}>📅 Google Calendar Meeting</div>
                <div style={{fontSize:18,fontWeight:800,color:"#fff",lineHeight:1.3}}>{ev.task}</div>
              </div>
              <button onClick={()=>setGcalDetailEvent(null)} style={{background:"rgba(255,255,255,0.15)",border:"none",borderRadius:6,color:"#fff",cursor:"pointer",padding:"4px 10px",fontSize:16,fontWeight:700,flexShrink:0}}>✕</button>
            </div>
            {/* Body */}
            <div style={{padding:"18px 20px",display:"flex",flexDirection:"column",gap:14}}>
              {/* Date & time */}
              <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                <span style={{fontSize:18,flexShrink:0}}>🗓</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:TT.text}}>{dateStr}</div>
                  <div style={{fontSize:12,color:"#7C3AED",fontWeight:600,marginTop:2}}>{timeStr}</div>
                </div>
              </div>
              {/* Location */}
              {ev.location && (
                <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                  <span style={{fontSize:18,flexShrink:0}}>📍</span>
                  <div style={{fontSize:13,color:TT.text,lineHeight:1.5}}>{ev.location}</div>
                </div>
              )}
              {/* Organiser */}
              {ev.organizer && (
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  <span style={{fontSize:18,flexShrink:0}}>👤</span>
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:TT.textSub,textTransform:"uppercase",letterSpacing:"0.05em"}}>Organiser</div>
                    <div style={{fontSize:13,color:TT.text,fontWeight:600}}>{ev.organizer}</div>
                  </div>
                </div>
              )}
              {/* Attendees */}
              {ev.attendees && ev.attendees.length > 0 && (
                <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                  <span style={{fontSize:18,flexShrink:0}}>👥</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,fontWeight:700,color:TT.textSub,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>Participants ({ev.attendees.length})</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                      {ev.attendees.map((a,i)=>(
                        <span key={i} style={{fontSize:12,background:"#7C3AED14",color:"#7C3AED",borderRadius:20,padding:"3px 10px",fontWeight:600,border:"1px solid #7C3AED22"}}>{a}</span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {/* Description */}
              {ev.description && (
                <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                  <span style={{fontSize:18,flexShrink:0}}>📝</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,fontWeight:700,color:TT.textSub,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Description</div>
                    <div style={{fontSize:13,color:TT.text,lineHeight:1.6,whiteSpace:"pre-wrap",maxHeight:180,overflowY:"auto"}}>{ev.description.replace(/<[^>]*>/g,"")}</div>
                  </div>
                </div>
              )}
              {/* Join button + link */}
              {ev.meetLink && (
                <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:4}}>
                  <a href={ev.meetLink} target="_blank" rel="noopener noreferrer" style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8,background:"#7C3AED",color:"#fff",borderRadius:8,padding:"10px 20px",fontWeight:700,fontSize:14,textDecoration:"none"}}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="14" height="14" rx="2" stroke="#fff" strokeWidth="2"/><path d="M17 9l4-2v10l-4-2V9z" fill="#fff"/></svg>
                    Join Meeting
                  </a>
                  <div style={{fontSize:11,color:TT.textFaint,wordBreak:"break-all"}}>
                    <span style={{fontWeight:600,color:TT.textSub}}>Link: </span>
                    <a href={ev.meetLink} target="_blank" rel="noopener noreferrer" style={{color:"#7C3AED",textDecoration:"underline"}}>{ev.meetLink}</a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    })()}
    {confirmDoneId && (() => {
      const ev = calendarEvents.find(e => e.id === confirmDoneId);
      const label = ev?.task ? `"${ev.task}"` : "this task";
      return (
        <ConfirmModal
          title="*IS CHECKLIST COMPLETE"
          message={`Mark ${label} as done?`}
          confirmLabel="Yes, Complete"
          confirmColor="#10B981"
          onConfirm={() => { onUpdateEvent(confirmDoneId, { done: true }); setConfirmDoneId(null); }}
          onClose={() => setConfirmDoneId(null)}
        />
      );
    })()}
  </>);
}

// ═════════════════════════════════════════════════
// FEEDBACK TAB — client feedback logged per project, separate from the
// internal checklist/task workflow. Open/Resolved like a lightweight ticket.
// ═════════════════════════════════════════════════
function FeedbackTab({ projects, feedback, currentUser, onAdd, onUpdate, onRemove, onToggleStatus }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filterProject, setFilterProject] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [fbLightbox, setFbLightbox] = useState(null);

  const filtered = feedback.filter(f => {
    if (filterProject !== "All" && f.projectId !== filterProject) return false;
    if (filterStatus !== "All" && f.status !== filterStatus) return false;
    return true;
  }).slice().sort((a,b) => b.ts.localeCompare(a.ts));

  const openCount = feedback.filter(f=>f.status==="Open").length;

  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        <select value={filterProject} onChange={e=>setFilterProject(e.target.value)} style={{...IS,width:220}}>
          <option value="All">All projects</option>
          {[...projects].sort((a,b)=>(a.jobCode||"").localeCompare(b.jobCode||"",undefined,{numeric:true,sensitivity:"base"})).map(p=><option key={p.id} value={p.id}>{p.jobCode||"—"} — {p.name}</option>)}
        </select>
        <div style={{display:"flex",background:"var(--c-page)",borderRadius:5,padding:2,gap:2}}>
          {["All","Open","Resolved"].map(s => (
            <button key={s} onClick={()=>setFilterStatus(s)} style={{padding:"5px 12px",borderRadius:4,border:"none",background:filterStatus===s?"var(--c-panel)":"transparent",color:filterStatus===s?"var(--c-t1)":"var(--c-t4)",cursor:"pointer",fontSize:12,fontWeight:filterStatus===s?700:500}}>
              {s}{s==="Open"&&openCount>0?` (${openCount})`:""}
            </button>
          ))}
        </div>
        <div style={{flex:1}}/>
        <button onClick={()=>{setEditing(null);setShowModal(true);}} style={{background:"#F97316",border:"none",borderRadius:6,padding:"7px 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>+ Add Feedback</button>
      </div>

      {filtered.length===0 ? (
        <div style={{textAlign:"center",color:"#334155",padding:"60px 0"}}>No feedback logged yet.</div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {filtered.map(f => {
            const proj = projects.find(p=>p.id===f.projectId);
            const resolved = f.status==="Resolved";
            return (
              <div key={f.id} style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,padding:"14px 16px",opacity:resolved?0.7:1}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:8,flexWrap:"wrap"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731644",borderRadius:4,padding:"2px 7px"}}>{proj?.jobCode||"—"}</span>
                    <span style={{fontSize:12,color:"var(--c-t3)"}}>{proj?.name||"(deleted project)"}</span>
                    <span style={{fontSize:10,fontWeight:800,color:resolved?"#10B981":"#F59E0B",background:resolved?"#10B98120":"#F59E0B20",borderRadius:4,padding:"2px 8px"}}>{f.status}</span>
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    <button onClick={()=>onToggleStatus(f.id)} title={resolved?"Reopen":"Mark resolved"} style={{background:"none",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 8px",color:resolved?"#3B82F6":"#10B981",cursor:"pointer",fontSize:11,fontWeight:700}}>{resolved?"↺ Reopen":"✓ Resolve"}</button>
                    <button onClick={()=>{setEditing(f);setShowModal(true);}} title="Edit" style={{background:"none",border:"none",color:"#F97316",cursor:"pointer",fontSize:13}}>✎</button>
                    <button onClick={()=>setConfirmRemove(f.id)} title="Delete" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13}}>🗑</button>
                  </div>
                </div>
                <div style={{fontSize:13,color:"var(--c-t2)",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{f.text}</div>
                {f.attachments?.length>0 && (
                  <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:10}}>
                    {f.attachments.map(a => (
                      <div key={a.id} style={{background:"var(--c-page)",borderRadius:6,overflow:"hidden",border:"1px solid var(--c-border)",cursor:"pointer"}}
                        onClick={()=>{if(a.type?.startsWith("image/"))setFbLightbox(a); else window.open(a.url||a.dataUrl);}}>
                        {a.type?.startsWith("image/")
                          ? <img src={a.url||a.dataUrl} alt={a.name} style={{width:72,height:72,objectFit:"cover",display:"block"}}/>
                          : <div style={{width:72,height:72,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
                              <span style={{fontSize:22}}>📄</span>
                              <span style={{fontSize:8,color:"var(--c-t4)",textAlign:"center",padding:"0 4px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:68}}>{a.name}</span>
                            </div>}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{fontSize:11,color:"var(--c-t5)",marginTop:8}}>
                  {f.receivedDate?`Received ${fmtDate(f.receivedDate)} · `:""}Logged by {f.createdBy} · {fmtTs(f.ts)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <FeedbackModal
          initial={editing}
          projects={projects}
          currentUser={currentUser}
          onSave={(fields)=>{
            if (editing) onUpdate(editing.id, fields);
            else onAdd(fields);
            setShowModal(false); setEditing(null);
          }}
          onClose={()=>{setShowModal(false);setEditing(null);}}
        />
      )}

      {confirmRemove && (
        <ConfirmModal
          title="Delete feedback?"
          message="This feedback entry will be permanently removed."
          confirmLabel="Delete"
          onConfirm={()=>{ onRemove(confirmRemove); setConfirmRemove(null); }}
          onClose={()=>setConfirmRemove(null)}
        />
      )}
      {fbLightbox && (
        <div onClick={()=>setFbLightbox(null)} style={{position:"fixed",inset:0,background:"#000c",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",cursor:"zoom-out"}}>
          <img src={fbLightbox.url||fbLightbox.dataUrl} alt={fbLightbox.name} style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8,boxShadow:"0 0 40px #000"}}/>
        </div>
      )}
    </div>
  );
}

function FeedbackModal({ initial, projects, currentUser, onSave, onClose }) {
  const { teamNames } = useTeam();
  const others = teamNames.filter(n => n !== currentUser);
  const [projectId, setProjectId] = useState(initial?.projectId || "");
  const [projSearch, setProjSearch] = useState("");
  const [projOpen, setProjOpen] = useState(false);
  const [text, setText] = useState(initial?.text || "");
  const [receivedDate, setReceivedDate] = useState(initial?.receivedDate || TODAY);
  const [attachments, setAttachments] = useState(initial?.attachments || []);
  const [tagged, setTagged] = useState(initial?.tagged || []);
  const [tagEveryone, setTagEveryone] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const fileRef = useRef(null);
  const canSave = !!projectId && !!text.trim();

  const effectiveTagged = tagEveryone ? others : tagged;
  const toggleTag = name => setTagged(t => t.includes(name) ? t.filter(x=>x!==name) : [...t, name]);
  const save = () => canSave && onSave({ projectId, text: text.trim(), receivedDate, attachments, tagged: effectiveTagged });

  const sortedProjects = [...projects].sort((a,b) => {
    const aC = a.status==="Completed", bC = b.status==="Completed";
    if (aC !== bC) return aC ? 1 : -1;
    return (a.jobCode||"").localeCompare(b.jobCode||"", undefined, { numeric:true, sensitivity:"base" });
  });
  const pq = projSearch.toLowerCase().trim();
  const filteredProjects = sortedProjects.filter(p =>
    !pq ||
    (p.jobCode||"").toLowerCase().includes(pq) ||
    p.name.toLowerCase().includes(pq) ||
    (p.client||"").toLowerCase().includes(pq)
  );
  const selectedProject = projects.find(p => p.id === projectId);

  const addFiles = e => {
    const files = [...(e.target.files||[])];
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => setAttachments(a => [...a, { id:mkId(), name:file.name, type:file.type, dataUrl:ev.target.result }]);
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const isImage = type => type && type.startsWith("image/");

  return (
    <Modal title={initial?"✎ Edit Feedback":"💬 Add Client Feedback"} onClose={onClose}>
      <div onKeyDown={e=>{ if (e.key==="Enter" && !["TEXTAREA","BUTTON","INPUT"].includes(e.target.tagName)) { e.preventDefault(); save(); } }}>
        <Field label="Project">
          <div style={{position:"relative"}}>
            {/* Search input */}
            <input
              value={projOpen ? projSearch : (selectedProject ? `${selectedProject.jobCode||"—"} — ${selectedProject.name}` : "")}
              onChange={e=>{ setProjSearch(e.target.value); setProjOpen(true); if(!e.target.value){setProjectId("");} }}
              onFocus={()=>{ setProjSearch(""); setProjOpen(true); }}
              onBlur={()=>setTimeout(()=>setProjOpen(false),150)}
              placeholder="Search or select project…"
              style={{...IS,width:"100%"}}
              autoComplete="off"
            />
            {/* Dropdown list */}
            {projOpen && (
              <div style={{position:"absolute",top:"calc(100% + 2px)",left:0,right:0,zIndex:400,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,boxShadow:"0 6px 24px #000a",maxHeight:220,overflowY:"auto"}}>
                {filteredProjects.length === 0 ? (
                  <div style={{padding:"10px 12px",fontSize:12,color:"var(--c-t5)"}}>No projects match.</div>
                ) : filteredProjects.map(p => {
                  const isCompleted = p.status === "Completed";
                  return (
                    <div key={p.id}
                      onMouseDown={()=>{ setProjectId(p.id); setProjSearch(""); setProjOpen(false); }}
                      style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",cursor:"pointer",background:p.id===projectId?"#F9731618":"transparent",borderBottom:"1px solid var(--c-border2)"}}>
                      <span style={{fontSize:10,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731644",borderRadius:3,padding:"1px 5px",flexShrink:0}}>{p.jobCode||"—"}</span>
                      <span style={{fontSize:12,color:isCompleted?"var(--c-t4)":"var(--c-t1)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</span>
                      {isCompleted && <span style={{fontSize:9,color:"#10B981",fontWeight:700,flexShrink:0}}>✓ Done</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Field>
        <Field label="Date Received">
          <input type="date" style={IS} value={receivedDate} onChange={e=>setReceivedDate(e.target.value)}/>
        </Field>
        <Field label="Feedback">
          <SpellCheckArea autoFocus style={{...IS,width:"100%",resize:"vertical",boxSizing:"border-box"}} minHeight={100} value={text} onChange={e=>setText(e.target.value)} placeholder="What did the client say?"/>
        </Field>
        <Field label="Attachments">
          <input ref={fileRef} type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" style={{display:"none"}} onChange={addFiles}/>
          <button type="button" onClick={()=>fileRef.current?.click()}
            style={{width:"100%",background:"var(--c-page)",border:"2px dashed #334155",borderRadius:6,padding:"12px",color:"var(--c-t4)",cursor:"pointer",fontSize:12,textAlign:"center"}}>
            📎 Click to attach files, images or screenshots
          </button>
          {attachments.length>0 && (
            <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:8}}>
              {attachments.map(a => (
                <div key={a.id} style={{position:"relative",background:"var(--c-page)",borderRadius:6,overflow:"hidden",border:"1px solid var(--c-border)"}}>
                  {isImage(a.type)
                    ? <img src={a.url||a.dataUrl} alt={a.name} onClick={()=>setLightbox(a)} style={{width:80,height:80,objectFit:"cover",cursor:"pointer",display:"block"}}/>
                    : <div onClick={()=>window.open(a.url||a.dataUrl)} style={{width:80,height:80,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer",gap:4}}>
                        <span style={{fontSize:24}}>📄</span>
                        <span style={{fontSize:9,color:"var(--c-t4)",textAlign:"center",padding:"0 4px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:72}}>{a.name}</span>
                      </div>}
                  <button onClick={()=>setAttachments(at=>at.filter(x=>x.id!==a.id))}
                    style={{position:"absolute",top:2,right:2,background:"#EF4444",border:"none",borderRadius:"50%",width:16,height:16,color:"#fff",cursor:"pointer",fontSize:9,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                </div>
              ))}
            </div>
          )}
        </Field>
        <Field label="Notify Team Members">
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",userSelect:"none"}}>
              <input type="checkbox" checked={tagEveryone} onChange={e=>{setTagEveryone(e.target.checked);if(e.target.checked)setTagged([]);}}
                style={{width:15,height:15,accentColor:"#F97316",cursor:"pointer"}}/>
              <span style={{fontSize:12,color:"#F97316",fontWeight:700}}>Tag Everyone (whole team)</span>
            </label>
            {!tagEveryone && others.length > 0 && (
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {others.map(name=>{
                  const sel = tagged.includes(name);
                  return (
                    <button key={name} type="button" onClick={()=>toggleTag(name)}
                      style={{padding:"4px 12px",borderRadius:20,border:`1px solid ${sel?"#F97316":"#334155"}`,background:sel?"#F9731620":"transparent",color:sel?"#F97316":"#64748B",cursor:"pointer",fontSize:12,fontWeight:700}}>
                      @{name}
                    </button>
                  );
                })}
              </div>
            )}
            {tagEveryone && (
              <div style={{fontSize:11,color:"var(--c-t4)"}}>All team members will be notified in their calendar.</div>
            )}
          </div>
        </Field>
        <div style={{display:"flex",gap:10,marginTop:6}}>
          <button onClick={save} disabled={!canSave} style={{flex:1,background:canSave?"#F97316":"#334155",border:"none",borderRadius:6,padding:"10px 0",color:"#fff",fontWeight:800,cursor:canSave?"pointer":"not-allowed",fontSize:13}}>{initial?"Save Changes":"+ Add Feedback"}</button>
          <button onClick={onClose} style={{padding:"10px 16px",background:"transparent",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:13}}>Cancel</button>
        </div>
      </div>
      {lightbox && (
        <div onClick={()=>setLightbox(null)} style={{position:"fixed",inset:0,background:"#000c",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",cursor:"zoom-out"}}>
          <img src={lightbox.url||lightbox.dataUrl} alt={lightbox.name} style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8,boxShadow:"0 0 40px #000"}}/>
        </div>
      )}
    </Modal>
  );
}

// ═════════════════════════════════════════════════
// NOTICE BOARD — left-hand sidebar, visible on every tab, styled like a chat
// box: messages flow oldest→newest with the composer pinned at the bottom.
// A notice can tag teammates; each tagged person ticks it off once read, and
// once everyone tagged has read it, it auto-archives into History. Anything
// that's ever been on the active board ends up in History — nothing is
// silently dropped, only permanently deletable from History by an admin.
// ═════════════════════════════════════════════════
function NoticeBoard({ notices, currentUser, presence, onAdd, onMarkRead, onArchive, onUnarchive, onDeleteForever, onNoticeDragStart, onNoticeDragEnd, onToggleDnd }) {
  const { teamNames, memberColor, isAdmin, team, teamsMeetingUrl, setTeamsMeetingUrl } = useTeam();
  const [text, setText] = useState("");
  const [tagged, setTagged] = useState([]);
  const [view, setView] = useState("active"); // "active" | "history"
  const [mention, setMention] = useState(null); // {start, query}
  const [popups, setPopups] = useState([]);
  const [tooltipInfo, setTooltipInfo] = useState(null); // { member, x, y }
  const [dndMenu, setDndMenu] = useState(null); // { member, x, y }
  const [teamsMenu, setTeamsMenu] = useState(null); // { member, x, y, teamsEmail }
  const [editMeetingUrl, setEditMeetingUrl] = useState(false);
  const [meetingUrlInput, setMeetingUrlInput] = useState("");
  const [replyingTo, setReplyingTo] = useState(null); // { id, author, text }
  const feedRef = useRef(null);
  const inputRef = useRef(null);

  // Refresh every 30 s so "in meeting" status stays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);
  // Returns the active meeting { start, end } or null. Reads from Firestore-backed
  // presence.gcalTimes so data is shared across devices (localStorage bled across users).
  const getActiveMeeting = m => {
    try {
      const data = presence?.gcalTimes?.[m];
      if (!data || Array.isArray(data)) return null;
      if (Date.now() - data.fetchedAt > 2 * 60 * 60 * 1000) return null; // stale
      const now = new Date();
      return (data.meetings || []).find(ev => ev.start && ev.end && new Date(ev.start) <= now && new Date(ev.end) >= now) || null;
    } catch { return null; }
  };
  // Also in meeting if Teams Presence API reports InAMeeting for this member
  const isInMeeting = m => !!getActiveMeeting(m) || presence?.teamsPresence?.[m] === "InAMeeting";

  const seenPopupIds = useRef(new Set(
    JSON.parse(localStorage.getItem(`asd_seen_notice_tags_${currentUser}`) || "[]")
  ));
  const popupTimers = useRef({});

  const active = notices.filter(n=>!n.archivedAt);
  const history = notices.filter(n=>n.archivedAt).sort((a,b)=>b.archivedAt.localeCompare(a.archivedAt));
  const list = view==="active" ? active : history;
  const unreadTagged = active.filter(n => n.tagged.includes(currentUser) && !n.readBy.includes(currentUser));

  useEffect(() => {
    if (!feedRef.current) return;
    if (view === "history") {
      feedRef.current.scrollTop = 0;
    } else {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [active.length, view]);

  // Clear all timers on unmount
  useEffect(() => () => { Object.values(popupTimers.current).forEach(clearTimeout); }, []);

  // Pop up a toast the moment a tagged-and-unread notice first becomes visible to this user
  // (covers both freshly-posted notices and ones already pending from before this login).
  // Each popup gets its own independent 7-second timer so dismissing one never resets others.
  useEffect(() => {
    const fresh = unreadTagged.filter(n => !seenPopupIds.current.has(n.id));
    if (fresh.length === 0) return;
    const newPopups = fresh.map(n => {
      seenPopupIds.current.add(n.id);
      return { popupId: mkId(), noticeId: n.id, author: n.author, text: n.text };
    });
    localStorage.setItem(`asd_seen_notice_tags_${currentUser}`, JSON.stringify([...seenPopupIds.current]));
    setPopups(p => [...p, ...newPopups]);
    newPopups.forEach(popup => {
      popupTimers.current[popup.popupId] = setTimeout(() => {
        setPopups(p => p.filter(x => x.popupId !== popup.popupId));
        delete popupTimers.current[popup.popupId];
      }, 7000);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notices, currentUser]);

  const dismissPopup = popupId => {
    clearTimeout(popupTimers.current[popupId]);
    delete popupTimers.current[popupId];
    setPopups(ps => ps.filter(x => x.popupId !== popupId));
  };

  const togTag = m => setTagged(t => t.includes(m) ? t.filter(x=>x!==m) : [...t, m]);
  const post = () => {
    if (!text.trim()) return;
    const textMentions = teamNames.filter(name => new RegExp(`@${name}(?:[^A-Za-z0-9_]|$)`, "i").test(text));
    const allTagged = [...new Set([...tagged, ...textMentions])];
    onAdd(text.trim(), allTagged);
    setText(""); setTagged([]); setMention(null); setReplyingTo(null);
  };
  const startReply = n => {
    setReplyingTo({ id: n.id, author: n.author, text: n.text });
    setTagged(t => t.includes(n.author) ? t : [...t, n.author]);
    setText("");
    setView("active");
    setTimeout(() => inputRef.current?.focus(), 50);
  };
  const cancelReply = () => {
    setReplyingTo(null);
    setTagged(t => t.filter(m => m !== replyingTo?.author));
  };

  const mentionMatches = mention ? teamNames.filter(n => n.toUpperCase().startsWith(mention.query.toUpperCase())) : [];
  const onTextChange = e => {
    const val = e.target.value;
    const pos = e.target.selectionStart;
    setText(val);
    const m = val.slice(0, pos).match(/@([A-Za-z0-9_]*)$/);
    setMention(m ? { start: pos - m[0].length, query: m[1] } : null);
  };
  const pickMention = name => {
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + mention.query.length + 1);
    setText(`${before}@${name} ${after}`);
    setTagged(t => t.includes(name) ? t : [...t, name]);
    setMention(null);
    inputRef.current?.focus();
  };

  return (
    <div style={{width:230,flexShrink:0,position:"sticky",top:62,background:"var(--c-panel)",border:`1px solid ${unreadTagged.length>0?"#F97316":"#334155"}`,boxShadow:unreadTagged.length>0?"0 0 0 3px #F9731633":"none",borderRadius:10,height:"calc(100vh - 80px)",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {popups.length > 0 && createPortal(
        <div style={{position:"fixed",top:70,right:16,zIndex:1200,display:"flex",flexDirection:"column",gap:8,width:300,pointerEvents:"none"}}>
          {popups.map(p => (
            <div key={p.popupId} style={{background:"var(--c-panel)",border:"1px solid #F97316",borderRadius:8,padding:"10px 14px",boxShadow:"0 8px 24px rgba(0,0,0,0.55)",pointerEvents:"auto"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div style={{fontSize:12,fontWeight:800,color:"#F97316"}}>📌 {p.author} tagged you in the Notice Board</div>
                <button onClick={()=>dismissPopup(p.popupId)} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:14,lineHeight:1,flexShrink:0}}>×</button>
              </div>
              <div style={{fontSize:12,color:"var(--c-t2)",marginTop:4,lineHeight:1.4}}>{p.text.length>90?p.text.slice(0,90)+"…":p.text}</div>
            </div>
          ))}
        </div>,
        document.body
      )}
      <div style={{padding:"12px 14px",borderBottom:"1px solid var(--c-border)",flexShrink:0}}>
        {/* Team online/offline strip */}
        <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
          {teamNames.map(m => {
            const online = isOnlineFresh(presence?.online?.[m]);
            const inMtgAuto = isInMeeting(m);
            const memberStatus = presence?.dnd?.[m]; // false | "dnd" | "leave" | "meeting" | "onsite" | true (legacy)
            const isDnd      = memberStatus === "dnd"     || memberStatus === true;
            const isLeave    = memberStatus === "leave";
            const isOnSite   = memberStatus === "onsite";
            const inMtgManual = memberStatus === "meeting";
            const inMtg = inMtgAuto || inMtgManual;
            const isMe = m === currentUser;
            const color = memberColor[m] || "#64748B";
            // Priority: On Leave (black) > DND (red) > In Meeting (purple) > On-Site (orange) > Online (green) > Offline (grey)
            const dotColor = isLeave ? "#0F172A" : isDnd ? "#EF4444" : inMtg ? "#7C3AED" : isOnSite ? "#F97316" : online ? "#22C55E" : "#475569";
            const dotGlow  = isLeave ? "0 0 5px #0F172A" : isDnd ? "0 0 5px #EF4444" : inMtg ? "0 0 5px #7C3AED" : isOnSite ? "0 0 5px #F97316" : online ? "0 0 4px #22C55E" : "none";
            const memberTeamsEmail = team.find(tm => tm.name === m)?.teamsEmail;
            return (
              <div key={m} style={{display:"flex",alignItems:"center"}}
                onMouseEnter={e => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTooltipInfo({ member: m, x: r.left + r.width / 2, y: r.top });
                }}
                onMouseLeave={() => setTooltipInfo(null)}
                onClick={!isMe && memberTeamsEmail ? e => {
                  e.stopPropagation();
                  setTooltipInfo(null);
                  setTeamsMenu({ member: m, x: e.clientX, y: e.clientY, teamsEmail: memberTeamsEmail });
                } : undefined}
                onContextMenu={isMe ? e => {
                  e.preventDefault(); e.stopPropagation();
                  setTooltipInfo(null);
                  setDndMenu({ member: m, x: e.clientX, y: e.clientY });
                } : undefined}>
                <div style={{width:24,height:24,borderRadius:"50%",background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:900,color:"#fff",opacity:online||inMtg||isDnd||isLeave||isOnSite?1:0.4,border:isMe?"2px solid #F97316":"2px solid transparent",position:"relative",flexShrink:0,cursor:isMe?"context-menu":memberTeamsEmail?"pointer":"default"}}>
                  {m.slice(0,2)}
                  <div style={{position:"absolute",bottom:-1,right:-1,width:7,height:7,borderRadius:"50%",background:dotColor,border:"1.5px solid var(--c-panel)",boxShadow:dotGlow}}/>
                </div>
              </div>
            );
          })}
          {tooltipInfo && createPortal((() => {
            const m = tooltipInfo.member;
            const online = isOnlineFresh(presence?.online?.[m]);
            const activeMtg = getActiveMeeting(m);
            const inMtgAuto = !!activeMtg;
            const memberStatus = presence?.dnd?.[m];
            const isDnd       = memberStatus === "dnd"     || memberStatus === true;
            const isLeave     = memberStatus === "leave";
            const isOnSite    = memberStatus === "onsite";
            const inMtgManual = memberStatus === "meeting";
            const inMtg = inMtgAuto || inMtgManual;
            const isMe = m === currentUser;
            const systems = getActiveSystems(presence?.online?.[m]);
            const statusColor = isLeave ? "#94A3B8" : isDnd ? "#EF4444" : inMtg ? "#7C3AED" : isOnSite ? "#F97316" : online ? "#22C55E" : "#64748B";
            const statusLabel = isLeave ? "On Leave" : isDnd ? "Do Not Disturb" : inMtg ? "In a Meeting" : isOnSite ? "On-Site" : online ? "Online" : "Offline";
            // Format meeting time range for display
            const mtgTime = activeMtg ? (() => {
              const fmt = t => { const d = new Date(t); return d.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"}); };
              return `${fmt(activeMtg.start)} – ${fmt(activeMtg.end)}`;
            })() : null;
            // Clamp tooltip so it never overflows viewport
            const TW = 240;
            const clampedX = Math.max(TW / 2 + 8, Math.min((window.innerWidth || 1200) - TW / 2 - 8, tooltipInfo.x));
            const showAbove = tooltipInfo.y > 80;
            const tipY = showAbove ? tooltipInfo.y - 10 : tooltipInfo.y + 30;
            return (
              <div style={{position:"fixed",left:clampedX,top:tipY,transform:showAbove?"translateX(-50%) translateY(-100%)":"translateX(-50%)",background:"#0F172A",color:"#F1F5F9",fontSize:10,fontWeight:700,borderRadius:6,padding:"6px 10px",whiteSpace:"nowrap",zIndex:99999,pointerEvents:"none",boxShadow:"0 4px 16px rgba(0,0,0,0.7)",border:"1px solid #334155",lineHeight:1.6}}>
                {m}{isMe?" (you)":""}
                <span style={{marginLeft:5,color:statusColor,fontWeight:400}}>● {statusLabel}</span>
                {mtgTime && <div style={{color:"#7C3AED",fontWeight:600,fontSize:9,marginTop:2}}>🕐 {mtgTime}</div>}
                {isMe && <span style={{marginLeft:0,color:"#475569",fontWeight:400,fontSize:9,display:"block",marginTop:1}}>(right-click to set status)</span>}
                {systems.length > 0 && systems.map((s,i) => (
                  <div key={i} style={{color:"#94A3B8",fontWeight:400,fontSize:9,marginTop:1}}>💻 {s}</div>
                ))}
                {showAbove
                  ? <div style={{position:"absolute",top:"100%",left:"50%",transform:"translateX(-50%)",width:0,height:0,borderLeft:"5px solid transparent",borderRight:"5px solid transparent",borderTop:"5px solid #0F172A"}}/>
                  : <div style={{position:"absolute",bottom:"100%",left:"50%",transform:"translateX(-50%)",width:0,height:0,borderLeft:"5px solid transparent",borderRight:"5px solid transparent",borderBottom:"5px solid #0F172A"}}/>
                }
              </div>
            );
          })(), document.body)}
          {dndMenu && createPortal(<>
            <div style={{position:"fixed",inset:0,zIndex:9998}} onClick={()=>setDndMenu(null)} onContextMenu={e=>{e.preventDefault();setDndMenu(null);}}/>
            <div style={{
              position:"fixed",
              left: Math.min(dndMenu.x, (window.innerWidth  || 1200) - 196),
              top:  Math.min(dndMenu.y, (window.innerHeight || 800)  - 190),
              zIndex:9999,background:"var(--c-panel)",border:"1px solid var(--c-border)",
              borderRadius:8,padding:4,boxShadow:"0 8px 24px rgba(0,0,0,0.35)",minWidth:180
            }}>
              <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",padding:"4px 10px 6px",letterSpacing:"0.06em"}}>Set your status</div>
              {(() => {
                const ms = presence?.dnd?.[dndMenu.member];
                const isDndActive    = ms === "dnd"     || ms === true;
                const isLeaveActive  = ms === "leave";
                const isOnSiteActive = ms === "onsite";
                const isMtgActive    = ms === "meeting";
                return [
                  { label:"Available",      icon:"🟢", color:"#22C55E", active: !ms,             onClick:()=>{ onToggleDnd?.(dndMenu.member, false);      setDndMenu(null); } },
                  { label:"In a Meeting",   icon:"🟣", color:"#7C3AED", active: isMtgActive,     onClick:()=>{ onToggleDnd?.(dndMenu.member, "meeting");   setDndMenu(null); } },
                  { label:"Do Not Disturb", icon:"🔴", color:"#EF4444", active: isDndActive,     onClick:()=>{ onToggleDnd?.(dndMenu.member, "dnd");       setDndMenu(null); } },
                  { label:"On-Site",        icon:"🟠", color:"#F97316", active: isOnSiteActive,  onClick:()=>{ onToggleDnd?.(dndMenu.member, "onsite");    setDndMenu(null); } },
                  { label:"On Leave",       icon:"⚫", color:"#475569", active: isLeaveActive,   onClick:()=>{ onToggleDnd?.(dndMenu.member, "leave");     setDndMenu(null); } },
                ].map(opt => (
                  <button key={opt.label} onClick={opt.onClick}
                    style={{display:"flex",alignItems:"center",gap:8,width:"100%",background:opt.active?"#F9731618":"transparent",border:"none",borderRadius:5,padding:"7px 12px",cursor:"pointer",fontSize:12,fontWeight:opt.active?800:500,color:opt.active?opt.color:"var(--c-t2)",textAlign:"left"}}>
                    <span style={{fontSize:14}}>{opt.icon}</span>
                    {opt.label}
                    {opt.active && <span style={{marginLeft:"auto",fontSize:10,fontWeight:900,color:opt.color}}>✓</span>}
                  </button>
                ));
              })()}
            </div>
          </>, document.body)}
          {teamsMenu && createPortal(<>
            <div style={{position:"fixed",inset:0,zIndex:9998}} onClick={()=>setTeamsMenu(null)}/>
            <div style={{
              position:"fixed",
              left: Math.min(teamsMenu.x, (window.innerWidth||1200) - 180),
              top:  Math.min(teamsMenu.y, (window.innerHeight||800) - 120),
              background:"var(--c-panel)",border:"1px solid #7C3AED55",borderRadius:8,padding:"8px 0",zIndex:9999,
              boxShadow:"0 8px 24px rgba(0,0,0,0.55)",minWidth:172,
            }}>
              <div style={{padding:"4px 12px 8px",fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",borderBottom:"1px solid var(--c-border)",marginBottom:4}}>
                Teams — {teamsMenu.member}
              </div>
              {[
                { label:"📞 Call", href:`https://teams.microsoft.com/l/call/0/0?users=${teamsMenu.teamsEmail}`, color:"#10B981" },
                { label:"💬 Chat", href:`https://teams.microsoft.com/l/chat/0/0?users=${teamsMenu.teamsEmail}`, color:"#3B82F6" },
                ...(teamsMeetingUrl ? [{ label:"🎥 Join Team Meeting", href:teamsMeetingUrl, color:"#7C3AED" }] : []),
              ].map(opt => (
                <a key={opt.label} href={opt.href} target="_blank" rel="noopener noreferrer"
                  onClick={()=>setTeamsMenu(null)}
                  style={{display:"flex",alignItems:"center",gap:8,padding:"7px 14px",fontSize:12,fontWeight:700,color:opt.color,textDecoration:"none",cursor:"pointer"}}>
                  {opt.label}
                </a>
              ))}
            </div>
          </>, document.body)}
        </div>
        {teamsMeetingUrl ? (
          <a href={teamsMeetingUrl} target="_blank" rel="noopener noreferrer"
            style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"#7C3AED",borderRadius:6,padding:"5px 0",color:"#fff",fontSize:11,fontWeight:800,textDecoration:"none",marginBottom:10,width:"100%",boxShadow:"0 2px 8px #7C3AED44"}}>
            🎥 Join Team Meeting
          </a>
        ) : isAdmin(currentUser) && !editMeetingUrl ? (
          <button onClick={()=>{setEditMeetingUrl(true);setMeetingUrlInput("");}}
            style={{display:"flex",alignItems:"center",justifyContent:"center",gap:5,width:"100%",background:"none",border:"1px dashed #7C3AED55",borderRadius:6,padding:"5px 0",color:"#7C3AED88",fontSize:11,cursor:"pointer",fontWeight:700,marginBottom:10}}>
            🎥 + Set Meeting Room
          </button>
        ) : null}
        {editMeetingUrl && (
          <div style={{marginBottom:10,display:"flex",gap:5}}>
            <input value={meetingUrlInput} onChange={e=>setMeetingUrlInput(e.target.value)}
              placeholder="Paste Teams meeting link…" autoFocus
              style={{flex:1,fontSize:10,padding:"4px 7px",borderRadius:5,border:"1px solid #7C3AED",background:"var(--c-page)",color:"var(--c-t1)",outline:"none"}}/>
            <button onClick={()=>{setTeamsMeetingUrl(meetingUrlInput.trim());setEditMeetingUrl(false);}}
              style={{background:"#7C3AED",border:"none",borderRadius:5,padding:"3px 9px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:10}}>Save</button>
            <button onClick={()=>setEditMeetingUrl(false)}
              style={{background:"none",border:"1px solid var(--c-border)",borderRadius:5,padding:"3px 7px",color:"var(--c-t4)",cursor:"pointer",fontSize:10}}>✕</button>
          </div>
        )}
        <div style={{fontSize:13,fontWeight:800,color:"var(--c-t1)",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
          📌 Team Notice Board
          {unreadTagged.length>0 && <span style={{background:"#F97316",color:"#0F172A",fontSize:10,fontWeight:800,borderRadius:10,padding:"1px 7px"}}>{unreadTagged.length}</span>}
        </div>
        <div style={{display:"flex",background:"var(--c-page)",borderRadius:5,padding:2,gap:2}}>
          {["active","history"].map(v => (
            <button key={v} onClick={()=>setView(v)} style={{flex:1,padding:"5px 0",borderRadius:4,border:"none",background:view===v?"var(--c-panel)":"transparent",color:view===v?"var(--c-t1)":"var(--c-t4)",cursor:"pointer",fontSize:11,fontWeight:view===v?700:500,textTransform:"capitalize"}}>
              {v}{v==="active"&&active.length>0?` (${active.length})`:""}{v==="history"&&history.length>0?` (${history.length})`:""}
            </button>
          ))}
        </div>
      </div>

      <div ref={feedRef} style={{flex:1,overflowY:"auto",padding:"12px 14px",display:"flex",flexDirection:"column",gap:10}}>
        {list.length===0 ? (
          <div style={{textAlign:"center",color:"#334155",fontSize:11,padding:"20px 0"}}>{view==="active"?"No notices yet.":"Nothing archived yet."}</div>
        ) : list.map(n => {
          const mc = memberColor[n.author]||"#64748B";
          const canManage = currentUser === "LESLIE" || isAdmin(currentUser);
          const canArchive = view==="active" && (n.author===currentUser || canManage);
          const iAmTagged = n.tagged.includes(currentUser);
          const iHaveRead = n.readBy.includes(currentUser);
          return (
            <div key={n.id}
              draggable
              onDragStart={e=>{ e.dataTransfer.effectAllowed="move"; e.dataTransfer.setData("text/plain",n.text); onNoticeDragStart?.({id:n.id,text:n.text,author:n.author}); }}
              onDragEnd={()=>onNoticeDragEnd?.()}
              style={{background:"var(--c-page)",border:`1px solid ${n.tagged.includes(currentUser)&&!iHaveRead&&view==="active"?"#F9731666":"var(--c-border2)"}`,borderRadius:8,padding:"9px 11px",cursor:"grab"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:mc,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:900,color:"#0F172A",flexShrink:0}}>{n.author.slice(0,2)}</div>
                <span style={{fontSize:11,fontWeight:700,color:mc}}>{n.author}</span>
                <span style={{fontSize:9,color:"var(--c-t5)"}}>{fmtTs(n.ts)}</span>
              </div>
              <div style={{fontSize:12,color:"var(--c-t2)",lineHeight:1.4,whiteSpace:"pre-wrap",marginBottom:n.tagged.length>0?7:0}}>{n.text}</div>
              {n.tagged.length>0 && (
                <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:iAmTagged&&!iHaveRead&&view==="active"?7:0}}>
                  {n.tagged.map(t => {
                    const read = n.readBy.includes(t);
                    const tc = memberColor[t]||"#64748B";
                    return (
                      <span key={t} title={read?`${t} has read this`:`${t} hasn't read this yet`} style={{fontSize:9,fontWeight:700,color:read?tc:"#475569",background:read?`${tc}1A`:"var(--c-panel)",border:`1px solid ${read?tc+"44":"var(--c-border)"}`,borderRadius:4,padding:"1px 6px"}}>
                        {read?"✓ ":""}{t}
                      </span>
                    );
                  })}
                </div>
              )}
              {iAmTagged && !iHaveRead && view==="active" && (
                <button onClick={()=>onMarkRead(n.id, currentUser)} style={{width:"100%",background:"#F9731620",border:"1px solid #F97316",borderRadius:5,padding:"5px 0",color:"#F97316",fontWeight:700,cursor:"pointer",fontSize:11,animation:"asd-read-pulse 1.6s ease-in-out infinite"}}>✓ Mark as read</button>
              )}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginTop:6}}>
                {view==="active" && n.author!==currentUser && (
                  <button onClick={()=>startReply(n)} title={`Reply to ${n.author}`}
                    style={{background:"none",border:"1px solid var(--c-border)",borderRadius:4,padding:"2px 8px",color:"var(--c-t4)",cursor:"pointer",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",gap:3}}>
                    ↩ Reply
                  </button>
                )}
                <div style={{display:"flex",gap:8,marginLeft:"auto"}}>
                  {canArchive && <button onClick={()=>onArchive(n.id)} title="Archive to history" style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:10,fontWeight:700}}>Archive →</button>}
                  {view==="history" && canManage && <button onClick={()=>onUnarchive(n.id)} title="Push back to active" style={{background:"#3B82F620",border:"1px solid #3B82F644",color:"#3B82F6",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontWeight:700}}>← Push to Active</button>}
                  {canManage && <button onClick={()=>onDeleteForever(n.id)} title="Delete permanently" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:11}}>🗑</button>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{padding:"10px 14px",borderTop:"1px solid var(--c-border)",flexShrink:0}}>
        {replyingTo && (
          <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:6,background:"#F9731610",border:"1px solid #F9731633",borderRadius:5,padding:"4px 8px"}}>
            <span style={{fontSize:10,color:"#F97316",fontWeight:700,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>↩ Replying to {replyingTo.author}: {replyingTo.text.length>40?replyingTo.text.slice(0,40)+"…":replyingTo.text}</span>
            <button onClick={cancelReply} style={{background:"none",border:"none",color:"#F97316",cursor:"pointer",fontSize:13,lineHeight:1,flexShrink:0}}>×</button>
          </div>
        )}
        <div style={{fontSize:10,color:"var(--c-t5)",marginBottom:6}}>Posting as <span style={{color:memberColor[currentUser]||"#94A3B8",fontWeight:700}}>{currentUser}</span></div>
        {teamNames.length>1 && (
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:7}}>
            {teamNames.filter(m=>m!==currentUser).map(m => {
              const sel = tagged.includes(m);
              const tc = memberColor[m]||"#64748B";
              return (
                <button key={m} onClick={()=>togTag(m)} style={{fontSize:9,fontWeight:700,color:sel?tc:"#64748B",background:sel?`${tc}1A`:"var(--c-page)",border:`1px solid ${sel?tc+"66":"var(--c-border)"}`,borderRadius:4,padding:"2px 7px",cursor:"pointer"}}>
                  {sel?"✓ ":"@"}{m}
                </button>
              );
            })}
          </div>
        )}
        <div style={{position:"relative"}}>
          {mention && mentionMatches.length>0 && (
            <div style={{position:"absolute",bottom:"100%",left:0,right:0,marginBottom:6,background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:6,overflow:"hidden",zIndex:10}}>
              {mentionMatches.map(name => (
                <div key={name} onMouseDown={e=>{e.preventDefault();e.stopPropagation();pickMention(name);}} style={{padding:"7px 10px",fontSize:12,color:memberColor[name]||"#94A3B8",cursor:"pointer",fontWeight:700}}>@{name}</div>
              ))}
            </div>
          )}
          <div style={{display:"flex",gap:6}}>
            <input ref={inputRef} value={text} onChange={onTextChange} onKeyDown={e=>{
              if(e.key==="Enter"){ e.preventDefault(); if(mention && mentionMatches.length>0) pickMention(mentionMatches[0]); else post(); }
              else if(e.key==="Escape" && mention){ setMention(null); }
            }} placeholder="Share important news… (type @ to tag)" style={{...IS,fontSize:12,padding:"7px 9px"}}/>
            <button onClick={post} disabled={!text.trim()} style={{background:text.trim()?"#F97316":"#334155",border:"none",borderRadius:6,padding:"0 12px",color:"#fff",fontWeight:800,cursor:text.trim()?"pointer":"not-allowed",fontSize:13}}>➤</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// App-wide toast for @mentions left in any project's notes — scans every project (not just
// the one currently open) so a tag lands even if the tagged user is elsewhere in the app.
function ProjectNoteAlerts({ projects, currentUser, onOpenProject }) {
  const [popups, setPopups] = useState([]);
  const seen = useRef(new Set(
    JSON.parse(localStorage.getItem(`asd_seen_note_tags_${currentUser}`) || "[]")
  ));

  useEffect(() => {
    const fresh = [];
    const checkNote = (p, n) => {
      if ((n.tagged||[]).includes(currentUser) && !(n.readBy||[]).includes(currentUser) && !seen.current.has(n.id)) {
        seen.current.add(n.id);
        fresh.push({ popupId: mkId(), project: p, author: n.author, text: n.text });
      }
    };
    projects.forEach(p => {
      noteList(p.notes).forEach(n => checkNote(p, n));
      (p.checklistNotes || []).forEach(n => checkNote(p, n));
    });
    if (fresh.length > 0) {
      localStorage.setItem(`asd_seen_note_tags_${currentUser}`, JSON.stringify([...seen.current]));
      setPopups(p => [...p, ...fresh]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, currentUser]);

  useEffect(() => {
    if (popups.length === 0) return;
    const t = setTimeout(() => setPopups(p => p.slice(1)), 7000);
    return () => clearTimeout(t);
  }, [popups]);

  if (popups.length === 0) return null;
  return (
    <div style={{position:"fixed",bottom:16,right:16,zIndex:1000,display:"flex",flexDirection:"column",gap:8,width:300}}>
      {popups.map(p => (
        <div key={p.popupId} onClick={()=>{onOpenProject(p.project);setPopups(ps=>ps.filter(x=>x.popupId!==p.popupId));}}
          style={{background:"var(--c-panel)",border:"1px solid #F97316",borderRadius:8,padding:"10px 14px",boxShadow:"0 8px 24px rgba(0,0,0,0.45)",cursor:"pointer"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
            <div style={{fontSize:12,fontWeight:800,color:"#F97316"}}>🔔 {p.author} tagged you in {p.project.jobCode||p.project.name}</div>
            <button onClick={e=>{e.stopPropagation();setPopups(ps=>ps.filter(x=>x.popupId!==p.popupId));}} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:14,lineHeight:1,flexShrink:0}}>×</button>
          </div>
          <div style={{fontSize:12,color:"var(--c-t2)",marginTop:4,lineHeight:1.4}}>{p.text.length>90?p.text.slice(0,90)+"…":p.text}</div>
        </div>
      ))}
    </div>
  );
}

function MyInbox({ projects, tasks, feedback, currentUser, inboxUser: inboxUserProp, calendarEvents, onToggleCalendarTask, onCompleteTask, onOpenProject, onGoToChecklist, onGoToFeedback, onMarkUnscheduled, onDragStart, onDragEnd }) {
  const { isAdmin } = useTeam();
  const inboxUser = inboxUserProp || currentUser;
  const isViewing = inboxUser !== currentUser; // viewing someone else's inbox
  const canActForOthers = currentUser === "LESLIE" || isAdmin(currentUser);
  const isReadOnly = isViewing && !canActForOthers; // admin/LESLIE can still act; others are read-only
  const [filter, setFilter] = useState("unscheduled");

  const relTime = iso => {
    if (!iso) return "";
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d === 1) return "yesterday";
    if (d < 7) return `${d}d ago`;
    return fmtTs(iso).split(",")[0];
  };

  const taskItems = useMemo(() => {
    return (tasks || []).filter(t => {
      if (t.assigned !== inboxUser) return false;
      if (t.status === "Done" || t.status === "Completed") return false;
      const proj = projects.find(p => p.id === t.projectId);
      return proj && proj.status !== "Completed";
    }).map(t => ({
      id: t.id,
      type: "task",
      project: projects.find(p => p.id === t.projectId),
      author: t.assignedBy,
      text: t.title,
      ts: t.ts || t.createdAt || "",
      unread: true,
      taskObj: t,
    }));
  }, [tasks, projects, inboxUser]);

  const items = useMemo(() => {
    const arr = [];
    projects.forEach(p => {
      noteList(p.notes || []).forEach(n => {
        if (!(n.tagged||[]).includes(inboxUser)) return;
        arr.push({ id: n.id, type: "note", project: p, author: n.author, text: n.text, ts: n.ts, unread: !(n.readBy||[]).includes(inboxUser) && !n.done });
      });
      (p.checklistNotes || []).forEach(n => {
        if (!(n.tagged||[]).includes(inboxUser)) return;
        arr.push({ id: n.id, type: "checklist", project: p, author: n.author, text: n.text, ts: n.ts, unread: !(n.readBy||[]).includes(inboxUser) && !n.done });
      });
    });
    (feedback || []).forEach(f => {
      if (!(f.tagged||[]).includes(inboxUser)) return;
      arr.push({ id: f.id, type: "feedback", project: projects.find(p => p.id === f.projectId), author: f.createdBy, text: f.text, ts: f.ts, unread: !(f.readBy||[]).includes(inboxUser) });
    });
    return arr.sort((a, b) => (b.ts||"").localeCompare(a.ts||""));
  }, [projects, feedback, inboxUser]);

  const unreadCount = useMemo(() => taskItems.length + items.filter(i => i.unread).length, [taskItems, items]);
  const allItems = useMemo(() => [...taskItems, ...items], [taskItems, items]);
  const visible = filter === "unscheduled" ? allItems.filter(i => i.unread) : allItems;

  // Auto-switch tabs: go to "all" when nothing is unscheduled; go to "unscheduled" when new items arrive from 0
  const prevUnscheduledCount = useRef(null);
  useEffect(() => {
    const prev = prevUnscheduledCount.current;
    if (unreadCount === 0) {
      setFilter("all");
    } else if (prev !== null && prev === 0 && unreadCount > 0) {
      setFilter("unscheduled");
    }
    prevUnscheduledCount.current = unreadCount;
  }, [unreadCount]);

  const TYPE_META = {
    task:      { label: "Task",     icon: "✅", color: "#10B981" },
    note:      { label: "Notes",    icon: "📝", color: "#3B82F6" },
    checklist: { label: "Tracker",  icon: "📋", color: "#8B5CF6" },
    feedback:  { label: "Feedback", icon: "💬", color: "#F59E0B" },
  };

  const handleClick = item => {
    if (!item.project) return;
    if (item.type === "note")      onOpenProject(item.project, "notes");
    else if (item.type === "checklist") onGoToChecklist(item.project.id);
    else if (item.type === "feedback")  onGoToFeedback();
  };

  return (
    <div style={{
      width: 230, flexShrink: 0, position: "sticky", top: 62,
      background: "var(--c-panel)",
      border: `1px solid ${isViewing ? "#F97316" : unreadCount > 0 ? "#3B82F6" : "#334155"}`,
      boxShadow: isViewing ? "0 0 0 3px #F9731622" : unreadCount > 0 ? "0 0 0 3px #3B82F633" : "none",
      borderRadius: 10, height: "calc(100vh - 80px)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{padding:"10px 12px 0",borderBottom:"1px solid var(--c-border)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <span style={{fontSize:11,fontWeight:800,color: isViewing ? "#F97316" : "var(--c-t2)",textTransform:"uppercase",letterSpacing:"0.06em"}}>
            📬 {isViewing ? `${inboxUser}'s Inbox` : "My Inbox"}
          </span>
          {unreadCount > 0 && (
            <span style={{background: isViewing ? "#F97316" : "#3B82F6",color:"#fff",fontSize:9,fontWeight:800,borderRadius:8,padding:"1px 6px",minWidth:16,textAlign:"center"}}>
              {unreadCount}
            </span>
          )}
        </div>
        <div style={{display:"flex",gap:2,marginBottom:0}}>
          {[["unscheduled", "Unscheduled"], ["all", `All${unreadCount > 0 ? ` (${unreadCount})` : ""}`]].map(([v, label]) => (
            <button key={v} onClick={() => setFilter(v)}
              style={{flex:1,background:"none",border:"none",borderBottom:`2px solid ${filter===v?"#3B82F6":"transparent"}`,color:filter===v?"#3B82F6":"var(--c-t4)",cursor:"pointer",fontSize:10,fontWeight:filter===v?800:500,padding:"4px 0 5px",marginBottom:-1}}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Items */}
      <div style={{flex:1,overflowY:"auto",overflowX:"hidden"}}>
        {visible.length === 0 ? (
          <div style={{padding:20,textAlign:"center"}}>
            <div style={{fontSize:22,marginBottom:6}}>{filter==="unscheduled"?"✓":"📭"}</div>
            <div style={{fontSize:11,color:"var(--c-t5)"}}>{filter==="unscheduled"?"All scheduled!":"No items yet"}</div>
          </div>
        ) : visible.map(item => {
          const { label, icon, color } = TYPE_META[item.type] || TYPE_META.note;
          const proj = item.project;
          const linkedEvent = (calendarEvents||[]).find(e =>
            e.member === inboxUser && e.inboxItemType &&
            (e.noteId === item.id || e.fbId === item.id)
          );
          return (
            <div key={`${item.type}-${item.id}`}
              draggable={!isReadOnly}
              onDragStart={!isReadOnly ? (e => { e.dataTransfer.effectAllowed="move"; onDragStart?.(item); }) : undefined}
              onDragEnd={!isReadOnly ? (() => onDragEnd?.()) : undefined}
              onClick={() => handleClick(item)}
              style={{
                position:"relative",
                padding:"8px 10px 8px 12px",
                borderBottom:"1px solid var(--c-border2)",
                borderLeft: item.unread ? `3px solid ${color}` : "3px solid transparent",
                cursor: isReadOnly ? "pointer" : "grab",
                background: item.unread ? `${color}08` : "transparent",
                transition:"background 0.12s",
              }}
              onMouseEnter={e => e.currentTarget.style.background=`${color}18`}
              onMouseLeave={e => e.currentTarget.style.background=item.unread?`${color}08`:"transparent"}
            >
              {/* Source + time row */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontSize:9,fontWeight:800,color,background:`${color}18`,borderRadius:4,padding:"1px 5px",textTransform:"uppercase",letterSpacing:"0.04em"}}>
                  {icon} {label}
                </span>
                <div style={{display:"flex",alignItems:"center",gap:4}}>
                  <span style={{fontSize:9,color:"var(--c-t5)"}}>{relTime(item.ts)}</span>
                  {!isReadOnly && <span style={{fontSize:9,color:"var(--c-t5)",opacity:0.5}} title="Drag to calendar">⠿</span>}
                </div>
              </div>
              {/* Project */}
              {proj && (
                <div style={{fontSize:10,fontWeight:700,color:"#F97316",marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {proj.jobCode ? `${proj.jobCode} · ` : ""}{proj.name}
                </div>
              )}
              {/* Author line */}
              <div style={{fontSize:10,color:"var(--c-t4)",marginBottom:3}}>
                {item.type === "task" ? (item.author ? `Assigned by ${item.author}` : `Assigned to ${inboxUser}`) : `${item.author} tagged ${isViewing ? inboxUser : "you"}`}
              </div>
              {/* Text excerpt */}
              <div style={{fontSize:11,color:"var(--c-t2)",lineHeight:1.35,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>
                {item.text}
              </div>
              {/* Task: mark done */}
              {!isReadOnly && item.type === "task" && onCompleteTask && (
                <button
                  onClick={e => { e.stopPropagation(); onCompleteTask(item.id); }}
                  style={{marginTop:5,background:"none",border:"none",color:"#10B981",cursor:"pointer",fontSize:9,fontWeight:700,padding:0,textDecoration:"underline",textDecorationColor:"#10B981",textUnderlineOffset:2}}
                >
                  ✓ mark done
                </button>
              )}
              {/* Calendar task checkbox — shown when scheduled */}
              {!isReadOnly && item.type !== "task" && linkedEvent && (
                <div style={{display:"flex",alignItems:"center",gap:5,marginTop:5,cursor:"pointer"}}
                  onClick={e => { e.stopPropagation(); onToggleCalendarTask?.(linkedEvent.id); }}>
                  <div style={{
                    width:13,height:13,borderRadius:3,border:"1.5px solid #3B82F6",
                    background:linkedEvent.done?"#3B82F6":"transparent",
                    display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
                  }}>
                    {linkedEvent.done && <span style={{color:"#fff",fontSize:8,fontWeight:900,lineHeight:1}}>✓</span>}
                  </div>
                  <span style={{fontSize:9,color:linkedEvent.done?"#3B82F6":"#94A3B8",fontWeight:700}}>
                    {linkedEvent.done ? "Completed ✓" : `📅 Scheduled · ${fmtDate(linkedEvent.date)}`}
                  </span>
                </div>
              )}
              {/* Schedule prompt — shown when unread and not yet linked to a calendar event */}
              {!isReadOnly && item.type !== "task" && item.unread && !linkedEvent && (
                <div style={{marginTop:6,display:"flex",alignItems:"center",gap:5}}>
                  <span style={{fontSize:9,color:"#94A3B8",fontStyle:"italic",flex:1}}>↑ Drag to calendar to schedule</span>
                  <button
                    onClick={e => { e.stopPropagation(); onMarkUnscheduled?.(item); }}
                    style={{background:"none",border:"1px solid #475569",borderRadius:3,color:"#64748B",cursor:"pointer",fontSize:9,fontWeight:700,padding:"2px 6px",whiteSpace:"nowrap",flexShrink:0}}
                  >
                    Unscheduled
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stats({ projects, activeStatuses, onToggle, statusOrder, onReorder }) {
  const order = statusOrder || SELECTABLE_PROJECT_STATUS;
  const [dragOver, setDragOver] = useState(null);
  const dragSrc = useRef(null);
  const handleDrop = target => {
    const src = dragSrc.current;
    if (!src || src === target) return;
    const next = [...order];
    const fi = next.indexOf(src), ti = next.indexOf(target);
    next.splice(fi, 1); next.splice(ti, 0, src);
    onReorder?.(next);
    setDragOver(null); dragSrc.current = null;
  };
  return (
    <div style={{display:"grid",gridTemplateColumns:`repeat(${order.length},1fr)`,gap:8,marginBottom:14}}>
      {order.map(status => {
        const count = projects.filter(p=>p.status===status).length;
        const color = PROJECT_STATUS[status].color;
        const isActive = activeStatuses?.has(status);
        const isDragOver = dragOver === status;
        return (
          <div key={status}
            draggable
            onDragStart={()=>{ dragSrc.current = status; }}
            onDragEnd={()=>{ dragSrc.current = null; setDragOver(null); }}
            onDragEnter={e=>{ e.preventDefault(); setDragOver(status); }}
            onDragOver={e=>e.preventDefault()}
            onDrop={()=>handleDrop(status)}
            onClick={onToggle ? ()=>onToggle(status) : undefined}
            title="Click to filter · Drag to reorder"
            style={{background:isActive?`${color}18`:"var(--c-panel)",border:`1.5px solid ${isDragOver?color:isActive?color:"var(--c-border)"}`,borderRadius:8,padding:"10px 14px",cursor:"grab",transition:"border-color 0.15s,background 0.15s,opacity 0.15s",userSelect:"none",position:"relative",opacity:dragSrc.current===status?0.4:1,outline:isDragOver?`2px solid ${color}44`:"none",outlineOffset:2}}>
            {isActive && <div style={{position:"absolute",top:5,right:6,width:6,height:6,borderRadius:"50%",background:color}}/>}
            <div style={{fontSize:22,fontWeight:900,color,fontFamily:"monospace",lineHeight:1}}>{count}</div>
            <div style={{color:isActive?color:"var(--c-t4)",fontSize:10,fontWeight:700,marginTop:3,textTransform:"uppercase"}}>{status}</div>
          </div>
        );
      })}
    </div>
  );
}

function WorldClocks() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const fmt = tz => new Intl.DateTimeFormat("en-AU", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  }).format(now);
  return (
    <div style={{display:"flex",gap:6,alignItems:"center",marginLeft:8}}>
      {[
        {label:"IST", tz:"Asia/Kolkata", color:"#F97316"},
        {label:"MEL", tz:"Australia/Melbourne", color:"#3B82F6"},
      ].map(({label, tz, color}) => (
        <div key={tz} style={{background:"var(--c-panel)",border:`1px solid ${color}44`,borderRadius:6,padding:"3px 8px",borderLeft:`2px solid ${color}`}}>
          <div style={{fontSize:9,color:"var(--c-t4)",fontWeight:700,textTransform:"uppercase",lineHeight:1,marginBottom:2}}>{label}</div>
          <div style={{fontSize:11,fontWeight:900,fontFamily:"monospace",color,lineHeight:1}}>{fmt(tz)}</div>
        </div>
      ))}
    </div>
  );
}

// ═════════════════════════════════════════════════
// GLOBAL SYNC STATUS — tracks in-flight Firestore writes across all
// usePersistentState instances. Components subscribe via useSyncStatus().
// ═════════════════════════════════════════════════
const _sync = { pending: 0, hasError: false, lastSave: 0, blockedKey: null, blockedKb: null };
const _syncSubs = new Set();
const _notifySync = () => _syncSubs.forEach(fn => fn());

function useSyncStatus() {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick(n => n + 1);
    _syncSubs.add(fn);
    return () => _syncSubs.delete(fn);
  }, []);
  return { pending: _sync.pending, hasError: _sync.hasError, lastSave: _sync.lastSave, blockedKey: _sync.blockedKey, blockedKb: _sync.blockedKb };
}

// ═════════════════════════════════════════════════
// PERSISTENCE — localStorage always; Firestore real-time sync layered on top
// once a project is configured (see .env.example). With no Firebase config,
// this behaves exactly like the original browser-local-only persistence.
//
// Firestore IndexedDB persistence (enabled in firebase.js) means writes made
// while offline are queued locally and automatically synced when reconnected —
// even across browser restarts. The SDK handles retries; this hook handles
// the app-level write logic on top.
//
// One Firestore doc per collection holds its whole array as a single field.
// Writes are blocked if the serialised value exceeds 900 KB (under the 1 MB
// hard Firestore limit) to prevent silent write failures as data grows.
// ═════════════════════════════════════════════════
const FS_WARN_BYTES  = 700_000; // warn in console at 700 KB
const FS_BLOCK_BYTES = 900_000; // refuse to write at 900 KB (Firestore hard limit is 1 MB)

function usePersistentState(key, initialValue) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const stateRef = useRef(state);
  // Initialised to the local (localStorage) value so that on first Firestore connect,
  // state === lastFsValue means "nothing changed locally yet" and we can safely adopt
  // whatever Firestore sends without triggering a redundant write back.
  const lastFsValue = useRef(state);
  // true while the local state has diverged from Firestore and a write hasn't landed yet.
  // Blocks incoming Firestore snapshots from overwriting in-flight local changes.
  const localDirty = useRef(false);
  // Tracks the timestamp of the last localStorage write. Stored in localStorage so it
  // survives page refreshes. Used on the first Firestore snapshot to detect when Firestore
  // is behind our last local write (e.g. a debounce write that didn't complete before refresh).
  const localAt = useRef(Number(localStorage.getItem(key + "_localAt") || 0));
  // Set to true after the first Firestore snapshot reconciliation is complete.
  const reconciled = useRef(false);
  const [fsReady, setFsReady] = useState(!firebaseConfigured);

  // Rolling recovery snapshots — fires on mount then every 30 min.
  // Per-device keys prevent one device's snapshot from overwriting another's.
  // Writes gracefully fail before login (Firestore rules) and succeed after.
  useEffect(() => {
    if (!firebaseConfigured || !Array.isArray(initialValue)) return;
    let deviceId = localStorage.getItem("asd_device_id");
    if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 9); localStorage.setItem("asd_device_id", deviceId); }
    const recKey = key + "_REC_" + deviceId;
    const snap = () => {
      const val = stateRef.current;
      if (!Array.isArray(val) || val.length <= initialValue.length) return;
      const payload = { value: val, savedAt: Date.now(), device: navigator.userAgent.slice(0, 80) };
      setDoc(doc(db, "appState", recKey), payload)
        .then(() => console.log(`ASD Recovery: saved ${val.length} items for ${key} (device ${deviceId})`))
        .catch(err => { console.warn(`ASD Recovery: backup write failed for ${key}:`, err); });
    };
    snap();
    const retryT = setTimeout(snap, 5000); // retry once on startup for transient failures
    const iv = setInterval(snap, 30 * 60 * 1000); // roll every 30 min
    return () => { clearTimeout(retryT); clearInterval(iv); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { stateRef.current = state; }, [state]);

  // Skip initial mount: localAt was already read from localStorage on init and reflects the
  // last real user edit. Stamping it with "now" on every mount makes any tab opened with
  // stale empty data (e.g. asd_invoices=[]) win reconciliation against real Firestore data,
  // overwriting it. Only update localAt when state actually CHANGES after mount.
  const skipFirstWrite = useRef(true);
  useEffect(() => {
    if (skipFirstWrite.current) { skipFirstWrite.current = false; return; }
    const now = Date.now();
    localAt.current = now;
    try {
      localStorage.setItem(key, JSON.stringify(state));
      localStorage.setItem(key + "_localAt", String(now));
    } catch (err) {
      console.warn(`ASD Hub: couldn't write "${key}" to localStorage — storage may be full`, err);
    }
  }, [key, state]);

  useEffect(() => {
    if (!firebaseConfigured) return;
    let unsub = () => {};
    let cancelled = false;
    let retryTimer;

    const subscribe = () => {
      if (cancelled) return;
      const ref = doc(db, "appState", key);
      unsub = onSnapshot(ref, snap => {
        if (!reconciled.current) {
          reconciled.current = true;
          if (snap.exists()) {
            const val = snap.data().value;
            const fsUpdatedAt = snap.data()._updatedAt || 0;
            if (fsUpdatedAt >= localAt.current) {
              // Firestore is current or newer — adopt it as the baseline.
              lastFsValue.current = val;
              setState(val);
            } else {
              // localStorage is ahead of Firestore (e.g. a debounce write that was
              // in-flight when the page refreshed and never reached Firestore).
              // Push our local state up immediately so Firestore catches up.
              localDirty.current = true;
              const value = stateRef.current;
              setDoc(doc(db, "appState", key), { value, _schemaVersion: 1, _updatedAt: localAt.current })
                .then(() => { localDirty.current = false; })
                .catch(() => { localDirty.current = false; });
            }
          }
          // Never auto-seed Firestore when document doesn't exist — the first real user
          // action will create it. Auto-seeding was the root cause of the 2026-07-23 data loss.
          setFsReady(true);
          return;
        }

        // Normal snapshot handling after reconciliation.
        if (snap.exists()) {
          const val = snap.data().value;
          lastFsValue.current = val;
          if (!localDirty.current) {
            // No pending local write — adopt Firestore state directly.
            setState(val);
          } else if (Array.isArray(val)) {
            // Local write is in-flight. Instead of blocking the snapshot entirely, merge
            // new items from Firestore into local state so additions from other devices
            // are not lost when our write eventually overwrites the document.
            setState(prev => {
              if (!Array.isArray(prev)) return prev;
              const localIds = new Set(prev.map(item => item?.id).filter(Boolean));
              const newFromFs = val.filter(item => item?.id && !localIds.has(item.id));
              return newFromFs.length > 0 ? [...prev, ...newFromFs] : prev;
            });
          }
        }
        setFsReady(true);
      }, err => {
        console.error(`Firestore sync error for "${key}":`, err);
        if (!cancelled) retryTimer = setTimeout(subscribe, 3000);
      });
    };

    subscribe();
    return () => { cancelled = true; clearTimeout(retryTimer); unsub(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced write — fires whenever local state diverges from last known Firestore value.
  // Does NOT gate on fsReady so user edits reach Firestore even when the read side is slow.
  // With IndexedDB persistence the write lands in the local cache immediately and the SDK
  // syncs it to the server — so this promise resolves even when offline.
  const pendingFlushRef = useRef(null);

  // Flush any pending write immediately when the tab is hidden (user switches away or closes).
  // Belt-and-suspenders for the no-IndexedDB-persistence fallback path — with persistence
  // enabled the write is already queued in IndexedDB before the tab can close.
  useEffect(() => {
    if (!firebaseConfigured) return;
    const onHide = () => { if (document.visibilityState === "hidden" && pendingFlushRef.current) pendingFlushRef.current(); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!firebaseConfigured) return;
    // Same reference as lastFsValue → initial mount or just synced from Firestore. No write needed.
    if (state === lastFsValue.current) { localDirty.current = false; pendingFlushRef.current = null; return; }
    localDirty.current = true;

    const doWrite = async () => {
      pendingFlushRef.current = null;
      const value = stateRef.current;

      // Guard against hitting Firestore's 1 MB document limit.
      const bytes = JSON.stringify(value).length;
      if (bytes > FS_BLOCK_BYTES) {
        const kb = (bytes/1024).toFixed(0);
        console.error(`ASD Hub: "${key}" is ${kb} KB — write blocked (over 900 KB limit).`);
        _sync.blockedKey = key;
        _sync.blockedKb  = kb;
        _sync.hasError   = true;
        _notifySync();
        // IMPORTANT: do NOT clear localDirty here. If we clear it the next Firestore
        // snapshot will silently overwrite local data that was never saved — that is
        // what caused projects to disappear when this limit was previously hit.
        // localDirty stays true so Firestore snapshots are held off until the write succeeds.
        return;
      }
      _sync.blockedKey = null;
      if (bytes > FS_WARN_BYTES) {
        console.warn(`ASD Hub: "${key}" is ${(bytes/1024).toFixed(0)} KB — approaching the 1 MB Firestore document limit.`);
      }

      _sync.pending++;
      _notifySync();

      // _schemaVersion lets future migrations detect and transform old-shaped data safely.
      // _updatedAt provides an audit trail of when each document last changed.
      const payload = { value, _schemaVersion: 1, _updatedAt: Date.now() };

      // Retry up to 3 times with exponential back-off (1 s, 2 s, 4 s).
      // With IndexedDB persistence the first attempt almost always succeeds
      // (SDK queues locally); retries matter when persistence is unavailable.
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await setDoc(doc(db, "appState", key), payload);
          _sync.pending = Math.max(0, _sync.pending - 1);
          _sync.hasError = false;
          _sync.lastSave = Date.now();
          _notifySync();
          localDirty.current = false;
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (2 ** attempt)));
        }
      }

      // All retries exhausted.
      _sync.pending = Math.max(0, _sync.pending - 1);
      _sync.hasError = true;
      _notifySync();
      localDirty.current = false;
      console.error(`Firestore write failed for "${key}" after 3 attempts:`, lastErr);
    };

    pendingFlushRef.current = doWrite;
    const t = setTimeout(doWrite, 80);
    return () => { clearTimeout(t); pendingFlushRef.current = null; };
  }, [key, state]); // eslint-disable-line react-hooks/exhaustive-deps

  return [state, setState, fsReady];
}

// ── Sync status badge ─────────────────────────────────────────────────────────
// Shows real-time save status in the team portal header. Three states:
//  • Offline  → data is queued in IndexedDB and will sync automatically
//  • Saving…  → write in-flight to Firestore
//  • Error    → write failed after 3 retries (user should check connection)
//  • ✓ Saved  → everything up to date
function SyncBadge() {
  const { pending, hasError, blockedKey, blockedKb } = useSyncStatus();
  const [online, setOnline] = useState(navigator.onLine);
  // Only show "Saving…" if write takes longer than 400 ms — fast saves are invisible.
  const [showSaving, setShowSaving] = useState(false);
  // Auto-dismiss "✓ Saved" after 1.5 s.
  const [showSaved, setShowSaved] = useState(false);
  const savingTimer = useRef(null);
  const savedTimer = useRef(null);

  useEffect(() => {
    if (pending > 0) {
      clearTimeout(savedTimer.current);
      setShowSaved(false);
      if (!showSaving) savingTimer.current = setTimeout(() => setShowSaving(true), 400);
    } else {
      clearTimeout(savingTimer.current);
      if (showSaving) { setShowSaving(false); setShowSaved(true); savedTimer.current = setTimeout(() => setShowSaved(false), 1500); }
    }
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const up = () => setOnline(true);
    const dn = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", dn);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", dn); };
  }, []);

  let label, color, bg, title;
  if (!online) {
    label = "⚡ Offline — queued"; color = "#F59E0B"; bg = "#F59E0B18";
    title = "You're offline. Changes are saved locally and will sync automatically when reconnected.";
  } else if (blockedKey) {
    label = "⛔ Data too large"; color = "#EF4444"; bg = "#EF444418";
    title = `"${blockedKey}" is ${blockedKb} KB — over the 900 KB cloud limit. Your changes are safe in this browser but CANNOT sync to other devices until the data is reduced. Please contact your admin immediately.`;
  } else if (hasError) {
    label = "⚠ Sync error"; color = "#EF4444"; bg = "#EF444418";
    title = "A save failed after 3 retries. Check your internet connection — data is still safe in your browser.";
  } else if (showSaving) {
    label = "Saving…"; color = "#94A3B8"; bg = "transparent";
    title = "Saving changes to cloud…";
  } else if (showSaved) {
    label = "✓ Saved"; color = "#22C55E"; bg = "#22C55E18";
    title = "All changes saved to cloud.";
  } else {
    return null;
  }

  return (
    <div title={title} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 9px",background:bg,border:`1px solid ${color}44`,borderRadius:20,cursor:"default",userSelect:"none"}}>
      <span style={{fontSize:10,fontWeight:700,color,letterSpacing:"0.03em"}}>{label}</span>
    </div>
  );
}

// ── Data export ───────────────────────────────────────────────────────────────
// Downloads a complete JSON backup of all ASD app state from localStorage.
// Use this as a manual backup or to migrate data to a new browser/device.
function exportAllData(projectsOverride) {
  const snapshot = {};
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("asd_")) continue;
    try { snapshot[key] = JSON.parse(localStorage.getItem(key)); }
    catch { snapshot[key] = localStorage.getItem(key); }
  }
  // localStorage write of asd_projects silently fails when data exceeds ~5 MB;
  // use the live Firestore-backed state passed in from the component instead.
  if (Array.isArray(projectsOverride) && projectsOverride.length > 0) {
    snapshot["asd_projects"] = projectsOverride;
  }
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), appVersion: APP_VERSION, data: snapshot }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `asd-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ═════════════════════════════════════════════════
// Returns only the fields that changed between prev and next.
// Fields present in prev but absent/null/undefined in next get deleteField()
// so Firestore removes them rather than leaving stale values.
// Used by both collection hooks to write updateDoc instead of setDoc for existing docs,
// preventing concurrent edits from silently overwriting each other's changes.
function fieldDiff(prev, next) {
  const update = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  keys.delete("id"); // id lives in the doc path, never as a field
  for (const k of keys) {
    const pv = prev[k], nv = next[k];
    if (pv === nv) continue;
    // Deep-equal check for arrays/objects so minor reference changes don't trigger writes
    const pvStr = typeof pv === "object" ? JSON.stringify(pv) : pv;
    const nvStr = typeof nv === "object" ? JSON.stringify(nv) : nv;
    if (pvStr === nvStr) continue;
    update[k] = (nv === undefined || nv === null) ? deleteField() : nv;
  }
  return update;
}

// Per-project Firestore collection hook.
// Each project is stored as projects/{id} — no single-document size limit,
// only the changed project is written on every update.
// Drop-in replacement for usePersistentState("asd_projects", …):
//   const [projects, setProjects, projectsFsReady] = useProjectsCollection();
// ═════════════════════════════════════════════════
function useProjectsCollection() {
  const [projects, _setProjects] = useState(() => {
    try {
      const raw = localStorage.getItem("asd_projects");
      return raw ? JSON.parse(raw) : SEED_PROJECTS;
    } catch { return SEED_PROJECTS; }
  });
  const [fsReady, setFsReady] = useState(!firebaseConfigured);
  const stateRef = useRef(projects);
  const pendingWrites = useRef(new Map()); // id → { timer, flush }

  // Keep stateRef and localStorage in sync
  useEffect(() => {
    stateRef.current = projects;
    try { localStorage.setItem("asd_projects", JSON.stringify(projects)); } catch {}
  }, [projects]);

  // Rolling recovery snapshots for projects — fires on mount then every 30 min.
  useEffect(() => {
    if (!firebaseConfigured) return;
    let deviceId = localStorage.getItem("asd_device_id");
    if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 9); localStorage.setItem("asd_device_id", deviceId); }
    const recKey = "asd_projects_REC_" + deviceId;
    const snap = () => {
      const val = stateRef.current;
      if (!Array.isArray(val) || val.length <= SEED_PROJECTS.length) return;
      const payload = { value: val, savedAt: Date.now(), device: navigator.userAgent.slice(0, 80) };
      setDoc(doc(db, "appState", recKey), payload)
        .then(() => console.log(`ASD Recovery: saved ${val.length} projects (device ${deviceId})`))
        .catch(err => console.warn("ASD Recovery: backup write failed:", err));
    };
    snap();
    const retryT = setTimeout(snap, 5000);
    const iv = setInterval(snap, 30 * 60 * 1000);
    return () => { clearTimeout(retryT); clearInterval(iv); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Firestore collection subscription
  useEffect(() => {
    if (!firebaseConfigured) return;
    let isFirst = true;
    const colRef = collection(db, "projects");
    // Flush all pending project writes immediately when the tab is hidden (user navigates away or
    // puts the phone to sleep). Prevents stale debounced timers from firing hours later on wake
    // and overwriting newer data that other devices wrote while this tab was suspended.
    const onVisibilityHide = () => {
      if (document.visibilityState !== "hidden") return;
      for (const [id, { timer, flush }] of pendingWrites.current) {
        clearTimeout(timer);
        pendingWrites.current.set(id, { timer: null, flush }); // keep protection flag, fire write now
        flush();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityHide);

    const unsub = onSnapshot(colRef, snap => {
      if (isFirst) {
        isFirst = false;
        if (snap.empty) {
          // Migrate: write each local project as its own document.
          // Guard: never seed from SEED_PROJECTS data (e.g. new device with no localStorage)
          // — that would overwrite real Firestore data if the snapshot arrives late.
          const local = stateRef.current;
          const seedIds = new Set(SEED_PROJECTS.map(p => p.id));
          const isOnlySeedData = local.length === 0 || local.every(p => seedIds.has(p.id));
          if (local.length > 0 && !isOnlySeedData) {
            Promise.all(local.map(p => setDoc(doc(db, "projects", p.id), p)))
              .catch(e => { console.error("ASD: project migration error:", e); setFsReady(true); });
            // fsReady set by the next onSnapshot that fires after migration docs land
          } else {
            setFsReady(true);
          }
        } else {
          // Per-project merge: keep whichever version (local or Firestore) is newer by _updatedAt.
          // This prevents Firestore (which may lag local edits) from overwriting in-progress changes.
          const local = stateRef.current;
          const localMap = new Map(local.map(p => [p.id, p]));
          const merged = snap.docs.map(d => {
            const fs = { ...d.data(), id: d.id };
            const loc = localMap.get(d.id);
            if (loc && (loc._updatedAt || 0) > (fs._updatedAt || 0)) return loc;
            return fs;
          });
          // Keep local-only projects not yet in Firestore
          for (const [id, loc] of localMap) {
            if (!merged.find(p => p.id === id)) merged.push(loc);
          }
          _setProjects(merged);
          setFsReady(true);
        }
        return;
      }
      // Incremental updates from other devices
      _setProjects(prev => {
        let next = prev;
        for (const change of snap.docChanges()) {
          const id = change.doc.id;
          if (pendingWrites.current.has(id)) continue; // local write in-flight, skip
          const proj = { ...change.doc.data(), id };
          if (change.type === "added" || change.type === "modified") {
            const idx = next.findIndex(p => p.id === id);
            // Guard: skip if our local version is already newer (prevents stale overwrites)
            if (idx !== -1 && (next[idx]._updatedAt || 0) > (proj._updatedAt || 0)) continue;
            if (idx === -1) next = [...next, proj];
            else if (JSON.stringify(next[idx]) !== JSON.stringify(proj)) {
              next = [...next.slice(0, idx), proj, ...next.slice(idx + 1)];
            }
          } else if (change.type === "removed") {
            next = next.filter(p => p.id !== id);
          }
        }
        return next;
      });
      setFsReady(true);
    }, err => {
      console.error("ASD: projects collection error:", err);
      setFsReady(true);
    });
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVisibilityHide);
      pendingWrites.current.forEach(({ timer }) => clearTimeout(timer));
      pendingWrites.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setProjects = useCallback((updater) => {
    _setProjects(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next === prev) return prev;
      if (firebaseConfigured) {
        const prevMap = new Map(prev.map(p => [p.id, p]));
        const nextMap = new Map(next.map(p => [p.id, p]));
        for (const [id, p] of nextMap) {
          if (prevMap.get(id) !== p) {
            const existing = pendingWrites.current.get(id);
            if (existing) clearTimeout(existing.timer);
            const data = { ...p, _updatedAt: Date.now() };
            const prevProj = existing?.prevItem ?? prevMap.get(id);
            let _retries = 0;
            const flush = () => {
              if (_retries === 0) { _sync.pending++; _notifySync(); }
              let writeOp;
              if (prevProj) {
                const diff = fieldDiff(prevProj, data);
                writeOp = Object.keys(diff).length > 0
                  ? updateDoc(doc(db, "projects", id), diff)
                  : Promise.resolve();
              } else {
                writeOp = setDoc(doc(db, "projects", id), data);
              }
              writeOp
                .then(() => {
                  if (pendingWrites.current.get(id)?.flush === flush) pendingWrites.current.delete(id);
                  _retries = 0;
                  _sync.pending = Math.max(0, _sync.pending - 1);
                  _sync.hasError = false;
                  _sync.lastSave = Date.now();
                  _notifySync();
                })
                .catch(() => {
                  const stillCurrent = pendingWrites.current.get(id)?.flush === flush;
                  if (!stillCurrent) {
                    _sync.pending = Math.max(0, _sync.pending - 1);
                    _notifySync();
                    return;
                  }
                  if (_retries < 3) {
                    _retries++;
                    setTimeout(flush, _retries * 2000); // 2s, 4s, 6s
                  } else {
                    pendingWrites.current.delete(id);
                    _retries = 0;
                    _sync.pending = Math.max(0, _sync.pending - 1);
                    _sync.hasError = true;
                    _notifySync();
                  }
                });
            };
            const timer = setTimeout(flush, 0);
            pendingWrites.current.set(id, { timer, flush, prevItem: prevProj });
          }
        }
        for (const [id] of prevMap) {
          if (!nextMap.has(id)) {
            const existing = pendingWrites.current.get(id);
            if (existing) { clearTimeout(existing.timer); pendingWrites.current.delete(id); }
            deleteDoc(doc(db, "projects", id)).catch(e => console.error("ASD: deleteDoc error:", e));
          }
        }
      }
      return next;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return [projects, setProjects, fsReady];
}

// Generic per-document collection hook — same architecture as useProjectsCollection.
// Each item gets its own Firestore document so concurrent edits from different devices
// only conflict on the same item, not the entire array. Handles migration from the old
// usePersistentState single-document layout automatically.
function useCollectionState(collectionName, seedData = []) {
  const lsKey = `asd_${collectionName}`;
  const [items, _setItems] = useState(() => {
    try { const raw = localStorage.getItem(lsKey); return raw ? JSON.parse(raw) : (seedData||[]); }
    catch { return seedData||[]; }
  });
  const [fsReady, setFsReady] = useState(!firebaseConfigured);
  const stateRef = useRef(items);
  const pendingWrites = useRef(new Map()); // id → { timer, flush }

  useEffect(() => {
    stateRef.current = items;
    try { localStorage.setItem(lsKey, JSON.stringify(items)); } catch {}
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rolling recovery snapshots — fires on mount then every 30 min (same pattern as usePersistentState)
  useEffect(() => {
    if (!firebaseConfigured) return;
    let deviceId = localStorage.getItem("asd_device_id");
    if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 9); localStorage.setItem("asd_device_id", deviceId); }
    const recKey = `asd_${collectionName}_REC_${deviceId}`;
    const snap = () => {
      const val = stateRef.current;
      if (!Array.isArray(val) || val.length === 0) return;
      const payload = { value: val, savedAt: Date.now(), device: navigator.userAgent.slice(0, 80) };
      setDoc(doc(db, "appState", recKey), payload)
        .then(() => console.log(`ASD Recovery: saved ${val.length} ${collectionName} items (device ${deviceId})`))
        .catch(err => console.warn(`ASD Recovery: backup write failed for ${collectionName}:`, err));
    };
    snap();
    const retryT = setTimeout(snap, 5000);
    const iv = setInterval(snap, 30 * 60 * 1000);
    return () => { clearTimeout(retryT); clearInterval(iv); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!firebaseConfigured) return;
    let isFirst = true;
    const colRef = collection(db, collectionName);

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // Flush all pending writes immediately when tab hides (before browser suspends the page)
        for (const [id, { timer, flush }] of pendingWrites.current) {
          clearTimeout(timer);
          pendingWrites.current.set(id, { timer: null, flush });
          flush();
        }
      } else {
        // Re-fetch from Firestore on tab focus to catch any updates missed during sleep/inactivity
        getDocs(colRef).then(snap => {
          _setItems(prev => {
            const pending = pendingWrites.current;
            let next = prev;
            for (const d of snap.docs) {
              const id = d.id;
              if (pending.has(id)) continue;
              const item = { ...d.data(), id };
              const idx = next.findIndex(p => p.id === id);
              if (idx === -1) next = [...next, item];
              else if (JSON.stringify(next[idx]) !== JSON.stringify(item)) {
                next = [...next.slice(0, idx), item, ...next.slice(idx + 1)];
              }
            }
            return next;
          });
        }).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const migratedFlag = `asd_migrated_${collectionName}`;
    const alreadyMigrated = localStorage.getItem(migratedFlag) === "1";

    // One-time catch-up: reads the old usePersistentState appState doc and writes any
    // items not already in the new collection. Runs regardless of whether the collection
    // was empty or not, so items missed by the initial migration are recovered.
    const catchUpFromLegacy = (existingIds) => {
      if (alreadyMigrated) return Promise.resolve();
      return getDoc(doc(db, "appState", lsKey))
        .then(oldDoc => {
          // No legacy doc at all — migration is done (nothing to recover).
          if (!oldDoc.exists()) { try { localStorage.setItem(migratedFlag, "1"); } catch {} return; }
          const missed = (oldDoc.data().value || []).filter(x => x?.id && !existingIds.has(x.id));
          // Old doc exists but nothing is missing — we're done.
          if (missed.length === 0) { try { localStorage.setItem(migratedFlag, "1"); } catch {} return; }
          _setItems(prev => {
            const prevIds = new Set(prev.map(p => p.id));
            const toAdd = missed.filter(x => !prevIds.has(x.id));
            return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
          });
          // Only mark done once the writes have actually landed.
          return Promise.all(missed.map(item => setDoc(doc(db, collectionName, item.id), item)))
            .then(() => { try { localStorage.setItem(migratedFlag, "1"); } catch {} });
        })
        .catch(e => console.error(`ASD: ${collectionName} catch-up:`, e));
      // NOTE: flag is NOT set on error — next load will retry the catch-up.
    };

    const unsub = onSnapshot(colRef, snap => {
      if (isFirst) {
        isFirst = false;
        if (snap.empty) {
          const localItems = stateRef.current;
          const seedIds = new Set((seedData||[]).map(p => p.id));
          const localReal = localItems.filter(p => !seedIds.has(p.id));
          // Migrate local real items first, then catch up from old Firestore doc
          const localIds = new Set(localReal.map(p => p.id));
          const migrateLocal = localReal.length > 0
            ? Promise.all(localReal.map(item => setDoc(doc(db, collectionName, item.id), item)))
                .catch(e => console.error(`ASD: ${collectionName} migration:`, e))
            : Promise.resolve();
          migrateLocal
            .then(() => catchUpFromLegacy(localIds))
            .finally(() => setFsReady(true));
        } else {
          const snapIds = new Set(snap.docs.map(d => d.id));
          _setItems(snap.docs.map(d => ({ ...d.data(), id: d.id })));
          setFsReady(true); // App is ready immediately; catch-up runs in background
          catchUpFromLegacy(snapIds); // Recovers any items missed by the initial migration
        }
        return;
      }
      _setItems(prev => {
        let next = prev;
        for (const change of snap.docChanges()) {
          const id = change.doc.id;
          if (pendingWrites.current.has(id)) continue;
          const item = { ...change.doc.data(), id };
          if (change.type === "added" || change.type === "modified") {
            const idx = next.findIndex(p => p.id === id);
            if (idx === -1) next = [...next, item];
            else if (JSON.stringify(next[idx]) !== JSON.stringify(item)) {
              next = [...next.slice(0, idx), item, ...next.slice(idx + 1)];
            }
          } else if (change.type === "removed") {
            next = next.filter(p => p.id !== id);
          }
        }
        return next;
      });
      setFsReady(true);
    }, err => {
      console.error(`ASD: ${collectionName} collection error:`, err);
      setFsReady(true);
    });

    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      pendingWrites.current.forEach(({ timer }) => clearTimeout(timer));
      pendingWrites.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setItems = useCallback((updater) => {
    _setItems(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next === prev) return prev;
      if (firebaseConfigured) {
        const prevMap = new Map(prev.map(p => [p.id, p]));
        const nextMap = new Map(next.map(p => [p.id, p]));
        for (const [id, item] of nextMap) {
          if (prevMap.get(id) !== item) {
            const existing = pendingWrites.current.get(id);
            if (existing) clearTimeout(existing.timer);
            const data = { ...item };
            // If there is already a pending write for this doc, use ITS prevItem (the last state
            // Firestore knows about). This ensures a rapid second write (e.g. onMoveEvent then
            // onUpdateEvent for the same event) includes ALL accumulated changes in the final
            // diff, not just the delta from the second call alone.
            const prevItem = existing?.prevItem ?? prevMap.get(id);
            let _retries = 0;
            const flush = () => {
              if (_retries === 0) { _sync.pending++; _notifySync(); }
              let writeOp;
              if (prevItem) {
                const diff = fieldDiff(prevItem, data);
                writeOp = Object.keys(diff).length > 0
                  ? updateDoc(doc(db, collectionName, id), diff)
                  : Promise.resolve();
              } else {
                writeOp = setDoc(doc(db, collectionName, id), data);
              }
              writeOp
                .then(() => {
                  // Only remove protection if we are still the current write for this doc.
                  // A rapid second write replaces pendingWrites[id] before our .then() fires;
                  // deleting it unconditionally would expose the doc to a stale snapshot overwrite.
                  if (pendingWrites.current.get(id)?.flush === flush) pendingWrites.current.delete(id);
                  _retries = 0;
                  _sync.pending = Math.max(0, _sync.pending - 1);
                  _sync.hasError = false;
                  _sync.lastSave = Date.now();
                  _notifySync();
                })
                .catch(() => {
                  const stillCurrent = pendingWrites.current.get(id)?.flush === flush;
                  if (!stillCurrent) {
                    // Superseded by a newer write — stop retrying, release our pending count
                    _sync.pending = Math.max(0, _sync.pending - 1);
                    _notifySync();
                    return;
                  }
                  if (_retries < 3) {
                    _retries++;
                    setTimeout(flush, _retries * 2000); // 2s, 4s, 6s
                  } else {
                    pendingWrites.current.delete(id);
                    _retries = 0;
                    _sync.pending = Math.max(0, _sync.pending - 1);
                    _sync.hasError = true;
                    _notifySync();
                  }
                });
            };
            const timer = setTimeout(flush, 0);
            pendingWrites.current.set(id, { timer, flush, prevItem });
          }
        }
        for (const [id] of prevMap) {
          if (!nextMap.has(id)) {
            const existing = pendingWrites.current.get(id);
            if (existing) { clearTimeout(existing.timer); pendingWrites.current.delete(id); }
            deleteDoc(doc(db, collectionName, id)).catch(e => console.error(`ASD: deleteDoc ${collectionName}:`, e));
          }
        }
      }
      return next;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return [items, setItems, fsReady];
}

function MainApp({ currentUser, onLogout, presence, onToggleDnd }) {
  const { teamNames: TEAM, memberColor: MEMBER_COLOR, memberRole, isAdmin, clients } = useTeam();
  const vw = useWindowWidth();
  const isMobile = vw < 768;
  const isTablet = vw < 1024;
  const [projects, setProjects, projectsFsReady] = useProjectsCollection();
  const [tasks, setTasks] = useCollectionState("tasks", SEED_TASKS);
  const [calendarEvents, setCalendarEvents] = useCollectionState("calendar_events", SEED_CALENDAR);
  const [feedback, setFeedback] = useCollectionState("feedback", []);
  const [notices, setNotices] = useCollectionState("notices", []);
  const [draggingNoticeItem, setDraggingNoticeItem] = useState(null); // { id, text, author }
  const [draggingMyInboxItem, setDraggingMyInboxItem] = useState(null); // inbox item being dragged to calendar
  const [tab, setTab] = useState(() => {
    try {
      const saved = localStorage.getItem(`asd_tab_order_${currentUser}`);
      if (saved) { const order = JSON.parse(saved); if (Array.isArray(order) && order.length) return order[0]; }
    } catch {}
    return "projects";
  });
  const [tabHistory, setTabHistory] = useState([]);
  const goToTab = (next) => { setTabHistory(h => [...h, tab]); setTab(next); if (next !== "calendar") setCalendarViewMember(currentUser); };
  const goBack = () => { if (!tabHistory.length) return; setTab(tabHistory[tabHistory.length-1]); setTabHistory(h => h.slice(0,-1)); };
  const [checklistJumpId, setChecklistJumpId] = useState(null);
  const [modal, setModal] = useState(null);
  const [pendingDeleteEventId, setPendingDeleteEventId] = useState(null);
  const [calendarViewMember, setCalendarViewMember] = useState(currentUser);
  const [editing, setEditing] = useState(null);
  const [copyData, setCopyData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailTab, setDetailTab] = useState("details"); // "details" | "notes" | "checklist"
  const [confirmState, setConfirmState] = useState(null);
  const [showTeamModal, setShowTeamModal] = useState(false);
  const [showClientsModal, setShowClientsModal] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoverySnapshots, setRecoverySnapshots] = useState([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [masterTemplate, setMasterTemplate, masterFsReady] = usePersistentState("asd_master_template", MASTER_DEFAULT);
  const [deletedProjects, setDeletedProjects] = usePersistentState("asd_deleted_projects", []);
  const [deletedMasterItems, setDeletedMasterItems] = usePersistentState("asd_deleted_master_items", []);
  const [invoices, setInvoices] = usePersistentState("asd_invoices", []);
  const [portfolio, setPortfolio] = usePersistentState("asd_portfolio", DEFAULT_PORTFOLIO);
  const [siteServices, setSiteServices] = usePersistentState("asd_site_services", DEFAULT_SITE_SERVICES);
  const [siteStats, setSiteStats] = usePersistentState("asd_site_stats", DEFAULT_SITE_STATS);
  const [siteTestimonials, setSiteTestimonials] = usePersistentState("asd_site_testimonials", DEFAULT_SITE_TESTIMONIALS);

  // One-time migration: prepend Job Study section if not yet present in stored template
  useEffect(() => {
    setMasterTemplate(prev => {
      if (!prev || prev.some(item => item.section === "Job Study")) return prev;
      const jobStudyItems = MASTER_DEFAULT.filter(item => item.section === "Job Study");
      return [...jobStudyItems, ...prev];
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // One-time migration: prepend Take-Off item if not yet present in stored template
  useEffect(() => {
    setMasterTemplate(prev => {
      if (!prev || prev.some(item => item.section === "Take-Off")) return prev;
      const takeOffItems = MASTER_DEFAULT.filter(item => item.section === "Take-Off");
      return [...takeOffItems, ...prev];
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // One-time migration + cleanup: move old status:"TAKE-OFF" projects to type:"Take-Off",
  // and remove takeOffOnly checklist items from non-Take-Off projects.
  // Returns the same array ref when nothing needs migrating so usePersistentState
  // doesn't see a state change and doesn't push an unnecessary write to Firestore.
  useEffect(() => {
    setProjects(ps => {
      let changed = false;
      const next = ps.map(p => {
        let updated = p;
        if (p.status === "TAKE-OFF") {
          updated = { ...updated, status: "PENDING", type: "Take-Off" };
          changed = true;
        }
        if (updated.type !== "Take-Off") {
          const cl = updated.checklist || [];
          if (cl.some(c => c.takeOffOnly)) {
            updated = { ...updated, checklist: cl.filter(c => !c.takeOffOnly) };
            changed = true;
          }
        }
        return updated;
      });
      return changed ? next : ps;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // One-time migration: trim accumulated checklist history to the last entry only.
  // History entries were appended on every check/uncheck/flag, making the asd_projects
  // document grow unboundedly. Only the last entry is ever displayed in the UI, so
  // keeping the full array is pure bloat that can push the document over Firestore's 1 MB limit.
  useEffect(() => {
    if (!projectsFsReady) return;
    setProjects(ps => {
      let anyChanged = false;
      const next = ps.map(p => {
        const cl = p.checklist || [];
        let projChanged = false;
        const trimmedCl = cl.map(c => {
          if (!c.history || c.history.length <= 1) return c;
          projChanged = true;
          return { ...c, history: c.history.slice(-1) };
        });
        if (!projChanged) return p;
        anyChanged = true;
        return { ...p, checklist: trimmedCl };
      });
      return anyChanged ? next : ps;
    });
  }, [projectsFsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-apply subItem changes from master template to existing project checklist items.
  // Only fires when masterTemplate changes. Preserves done state for subItems whose text
  // matches an existing entry. New main checklist items (not yet in a project) still require
  // a manual push via SyncModal — this only handles subtask additions/changes on existing items.
  // Guard: only run after both Firestore documents have loaded. Without this guard the effect
  // fires on mount with stale localStorage data, writes it back to Firestore, and overwrites
  // any projects that were added on another device since this device last synced.
  useEffect(() => {
    if (!projectsFsReady || !masterFsReady) return;
    setProjects(ps => {
      let anyChanged = false;
      const next = ps.map(p => {
        const cl = p.checklist || [];
        let projChanged = false;
        const updatedCl = cl.map(c => {
          if (!c.templateId) return c;
          const master = masterTemplate.find(m => m.id === c.templateId);
          if (!master) return c;
          const mSubs = (master.subItems||[]).map(s => s.text).join("\x00");
          const eSubs = (c.subItems||[]).map(s => s.text).join("\x00");
          if (mSubs === eSubs) return c;
          const prevDone = Object.fromEntries((c.subItems||[]).map(s => [s.text, s.done]));
          projChanged = true;
          return {
            ...c,
            subItems: (master.subItems||[]).map(si => ({
              id: mkId(),
              text: si.text,
              done: prevDone[si.text] ?? false,
            })),
          };
        });
        if (!projChanged) return p;
        anyChanged = true;
        return { ...p, checklist: updatedCl };
      });
      return anyChanged ? next : ps;
    });
  }, [masterTemplate, projectsFsReady, masterFsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const [filterStatuses, setFilterStatuses] = useState(new Set());
  const toggleStatusFilter = s => setFilterStatuses(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });
  const [filterMember, setFilterMember] = useState("All");
  const [filterClient, setFilterClient] = useState("All");
  const [filterDue, setFilterDue] = useState("All");
  const [filterCompletedMonth, setFilterCompletedMonth] = useState("All");
  const [completedSortDir, setCompletedSortDir] = useState("desc"); // "desc" = newest first
  const [analyticsMonth, setAnalyticsMonth] = useState(() => new Date().toISOString().slice(0,7));
  const [sortBy, setSortBy] = useState("jobCode"); // "jobCode" | "priority"
  const [hideOnHold, setHideOnHold] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`asd_hide_onhold_${currentUser}`)) ?? false; }
    catch { return false; }
  });
  const toggleHideOnHold = () => setHideOnHold(v => {
    const next = !v;
    localStorage.setItem(`asd_hide_onhold_${currentUser}`, JSON.stringify(next));
    return next;
  });
  const [statusOrder, setStatusOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`asd_status_order_${currentUser}`));
      if (Array.isArray(saved) && saved.length === SELECTABLE_PROJECT_STATUS.length &&
          saved.every(s => SELECTABLE_PROJECT_STATUS.includes(s))) return saved;
    } catch {}
    return [...SELECTABLE_PROJECT_STATUS];
  });
  const handleReorderStatus = next => {
    setStatusOrder(next);
    localStorage.setItem(`asd_status_order_${currentUser}`, JSON.stringify(next));
  };
  const [search, setSearch] = useState("");
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [showMoreTabs, setShowMoreTabs] = useState(false);
  const [projectView, setProjectView] = useState(() => localStorage.getItem(`asd_view_pref_${currentUser}`) || "list");
  const [listPicker, setListPicker] = useState(null); // {id, field} — which list-row cell has its dropdown open
  const [listInlineEdit, setListInlineEdit] = useState(null); // {id, field, value} — inline text edit
  const [copiedAddrId, setCopiedAddrId] = useState(null);
  const [listNotesEditId, setListNotesEditId] = useState(null); // project id whose notes panel is open in list view
  const [viewCtxMenu, setViewCtxMenu] = useState(null); // {view, x, y}

  useEffect(() => {
    if (!viewCtxMenu) return;
    const close = () => setViewCtxMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [viewCtxMenu]);

  const saveDefaultView = (view) => {
    localStorage.setItem(`asd_view_pref_${currentUser}`, view);
    setProjectView(view);
    setViewCtxMenu(null);
  };

  const askConfirm = (title, message, onConfirm) => setConfirmState({ title, message, onConfirm });
  const goToChecklist = (projectId) => { setChecklistJumpId(projectId); goToTab("checklist"); };

  // ── Import from JSON backup ────────────────────────────────────────────────
  const importFileRef = useRef(null);
  const handleImport = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // allow re-selecting same file
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { return; }
    if (!parsed?.data || typeof parsed.data !== "object") return;
    const keys = Object.keys(parsed.data).filter(k => k.startsWith("asd_"));
    askConfirm(
      "Restore from backup?",
      `Replace ALL current data with the backup from ${(parsed.exportedAt||"").slice(0,10)||"unknown date"}? ` +
      `This overwrites ${keys.length} data sets. Export first if you want to keep current data.`,
      async () => {
        for (const key of keys) {
          try { localStorage.setItem(key, JSON.stringify(parsed.data[key])); } catch {}
        }
        if (firebaseConfigured) {
          const nonProjectKeys = keys.filter(k => k !== "asd_projects");
          try {
            await Promise.all(nonProjectKeys.map(key => setDoc(doc(db, "appState", key), { value: parsed.data[key] })));
          } catch (err) {
            console.error("Import to Firestore failed:", err);
          }
          // Projects live in their own collection — write each as its own document
          const projectsData = parsed.data["asd_projects"];
          if (Array.isArray(projectsData) && projectsData.length > 0) {
            try {
              await Promise.all(projectsData.map(p => setDoc(doc(db, "projects", p.id), p)));
            } catch (err) {
              console.error("Import projects to Firestore failed:", err);
            }
          }
        }
        window.location.reload();
      }
    );
  };

  // ── Recovery snapshots ────────────────────────────────────────────────────
  const fetchRecoverySnapshots = async () => {
    if (!firebaseConfigured) return;
    setRecoveryLoading(true);
    try {
      const snap = await getDocs(collection(db, "appState"));
      const recs = [];
      snap.forEach(d => {
        if (d.id.startsWith("asd_projects_REC_")) {
          const data = d.data();
          recs.push({ id: d.id, savedAt: data.savedAt, device: data.device || "", projects: data.value || [] });
        }
      });
      recs.sort((a, b) => b.savedAt - a.savedAt);
      setRecoverySnapshots(recs);
    } catch (e) { console.error("Recovery fetch failed:", e); }
    setRecoveryLoading(false);
  };

  const restoreRecoverySnapshot = rec => {
    askConfirm(
      "Restore this snapshot?",
      `Replace ALL current project data with the ${new Date(rec.savedAt).toLocaleString("en-AU")} snapshot (${rec.projects.length} projects)? Export first if you want to keep current data.`,
      async () => {
        try {
          await Promise.all(rec.projects.map(p => setDoc(doc(db, "projects", p.id), p)));
          window.location.reload();
        } catch (e) { console.error("Snapshot restore failed:", e); }
      }
    );
  };

  useEffect(() => {
    if (!listPicker) return;
    const close = () => setListPicker(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [listPicker]);

  const openDetail = (p, tab="details") => { setDetail(p); setDetailTab(tab); };

  // Always derive the open detail from live project state so inline edits reflect instantly
  const liveDetail = detail ? projects.find(p => p.id === detail.id) || null : null;

  const saveProject = f => {
    const isTakeOff = f.type === "Take-Off";
    const checklist = editing
      ? (f.checklist || makeChecklist(masterTemplate))
      : makeChecklist(masterTemplate).filter(c => isTakeOff ? !!c.takeOffOnly : !c.takeOffOnly);
    const proj = { ...f, completedDate:f.completedDate||"", checklist };
    const assignedChanged = JSON.stringify(f.assigned) !== JSON.stringify(editing?.assigned);
    if (editing) setProjects(ps=>ps.map(p=>{
      if (p.id !== editing.id) return p;
      // Merge notes: apply only the form's note delta on top of current live notes so
      // notes added outside the form (card panel, another user) are never silently lost.
      const editingNoteIds = new Set(noteList(editing.notes || []).map(n => n.id));
      const formNotes = noteList(f.notes || []);
      const formNoteIds = new Set(formNotes.map(n => n.id));
      const addedInForm = formNotes.filter(n => !editingNoteIds.has(n.id));
      const removedInForm = new Set(noteList(editing.notes || []).filter(n => !formNoteIds.has(n.id)).map(n => n.id));
      const editedInForm = new Map(formNotes.filter(n => editingNoteIds.has(n.id)).map(n => [n.id, n]));
      const mergedNotes = [
        ...addedInForm,
        ...noteList(p.notes || []).filter(n => !removedInForm.has(n.id)).map(n => editedInForm.has(n.id) ? editedInForm.get(n.id) : n),
      ];
      return { ...p, ...proj, notes: mergedNotes, ...(assignedChanged ? { assignedBy: currentUser } : {}) };
    }));
    else {
      setProjects(ps=>[...ps,{...proj,id:mkId(),assignedBy:currentUser,incomingDate:todayYmd()}]);
      addNotice(`📋 New project added — ${proj.jobCode||"?"}: ${proj.name}${proj.client?`\nClient: ${proj.client}`:""}${proj.due?`\nDue: ${fmtDate(proj.due)}`:""}${proj.assigned?.length?`\nIn charge: ${proj.assigned.join(", ")}`:""}`, proj.assigned||[]);
    }
    setModal(null); setEditing(null); setCopyData(null);
  };
  const copyProject = p => {
    setCopyData({ ...p, jobCode: "", notes: [], completedDate: "", status: "IN PROGRESS" });
    setEditing(null);
    setModal("addProject");
  };
  const delProject = id => {
    const proj = projects.find(p => p.id === id);
    if (proj) {
      const archivedTasks = tasks.filter(t => t.projectId === id);
      const archivedEvents = calendarEvents.filter(e => e.projectId === id);
      const archivedFeedback = feedback.filter(f => f.projectId === id);
      setDeletedProjects(d => [...d, {
        ...proj,
        _deletedAt: nowTs(),
        _archivedTasks: archivedTasks,
        _archivedEvents: archivedEvents,
        _archivedFeedback: archivedFeedback,
      }]);
    }
    setProjects(ps=>ps.filter(p=>p.id!==id));
    setTasks(ts=>ts.filter(t=>t.projectId!==id));
    setCalendarEvents(es=>es.filter(e=>e.projectId!==id));
    setFeedback(fb=>fb.filter(f=>f.projectId!==id));
    setDetail(null); setEditing(null); setModal(null);
  };
  const restoreProject = id => {
    const proj = deletedProjects.find(p => p.id === id);
    if (!proj) return;
    const { _deletedAt, _archivedTasks = [], _archivedEvents = [], _archivedFeedback = [], ...restored } = proj;
    setProjects(ps => [restored, ...ps]);
    if (_archivedTasks.length) setTasks(ts => [...ts, ..._archivedTasks]);
    if (_archivedEvents.length) setCalendarEvents(es => [...es, ..._archivedEvents]);
    if (_archivedFeedback.length) setFeedback(fb => [...fb, ..._archivedFeedback]);
    setDeletedProjects(d => d.filter(x => x.id !== id));
  };
  const permanentDeleteProject = id => setDeletedProjects(d => d.filter(x => x.id !== id));
  const reopenProject = id => {
    setProjects(ps=>ps.map(p=>p.id===id?{...p,status:"MODELLING",completedDate:""}:p));
    setDetail(null);
  };
  const completeProject = id => {
    setProjects(ps=>ps.map(p=>p.id===id?{...p,status:"Completed",completedDate:todayYmd(),pct:100,phase:"READY TO ISSUE"}:p));
    setDetail(null);
  };
  const updateProjectStatus = (projectId, status) => {
    setProjects(ps => ps.map(p => {
      if (p.id !== projectId) return p;
      const updated = { ...p, status,
        ...(status === "Completed" ? { completedDate: todayYmd(), phase: "READY TO ISSUE" } : {}),
        ...(status !== "Completed" && p.status === "Completed" ? { completedDate: "" } : {}),
        ...(status === "ON HOLD" ? { priority: "Low" } : {}),
      };
      updated.pct = phasePct(updated.phase, updated.status);
      return updated;
    }));
  };
  const updateFieldChange = (projectId, field, value) => {
    setProjects(ps => ps.map(p => {
      if (p.id !== projectId) return p;
      const updated = { ...p, [field]: value };
      if (field === "phase") updated.pct = phasePct(value, updated.status);
      return updated;
    }));
  };
  const updateChecklist = (projectId, cl) => setProjects(ps=>ps.map(p=>p.id===projectId?{...p,checklist:cl}:p));
  // Note mutations use Firestore transactions so the note change is applied on top of
  // whatever the server has AT THAT MOMENT — surviving concurrent writes from other users.
  // setProjects is still called first for an immediate optimistic UI response.
  const _notesTx = async (projectId, applyFn) => {
    if (!firebaseConfigured) return;
    const ref = doc(db, "projects", projectId);
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      tx.set(ref, applyFn(snap.data()));
    }).catch(err => console.error("Note transaction failed:", err));
  };

  const addProjectNote = (projectId, text, tagged) => {
    if (!text.trim()) return;
    const note = { id: mkId(), text: text.trim(), author: currentUser, ts: nowTs(), tagged: tagged||[], readBy: [] };
    // Optimistic update for immediate feedback
    setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, notes: [note, ...noteList(p.notes)] }));
    // Atomic server write — reads latest server state and adds the note on top,
    // so a concurrent write from another user cannot discard this note.
    _notesTx(projectId, p => {
      const existing = noteList(p.notes || []);
      if (existing.some(n => n.id === note.id)) return p; // already present (our optimistic write echoed)
      return { ...p, notes: [note, ...existing] };
    });
  };
  const removeProjectNote = (projectId, noteId) => {
    setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, notes: noteList(p.notes).filter(n => n.id !== noteId) }));
    _notesTx(projectId, p => ({ ...p, notes: noteList(p.notes || []).filter(n => n.id !== noteId) }));
  };
  const markProjectNoteRead = (projectId, noteId, member) => {
    setProjects(ps => ps.map(p => p.id !== projectId ? p : {
      ...p, notes: noteList(p.notes).map(n => n.id===noteId && !n.readBy.includes(member) ? { ...n, readBy:[...n.readBy, member] } : n),
    }));
    _notesTx(projectId, p => ({
      ...p, notes: noteList(p.notes || []).map(n =>
        n.id===noteId && !(n.readBy||[]).includes(member) ? { ...n, readBy:[...(n.readBy||[]), member] } : n
      ),
    }));
  };
  const markChecklistNoteRead = (projectId, noteId, member) => {
    setProjects(ps => ps.map(p => p.id !== projectId ? p : {
      ...p, checklistNotes: (p.checklistNotes||[]).map(n =>
        n.id===noteId && !(n.readBy||[]).includes(member) ? {...n, readBy:[...(n.readBy||[]), member]} : n
      ),
    }));
    _notesTx(projectId, p => ({
      ...p, checklistNotes: (p.checklistNotes||[]).map(n =>
        n.id===noteId && !(n.readBy||[]).includes(member) ? {...n, readBy:[...(n.readBy||[]), member]} : n
      ),
    }));
  };
  const markProjectNoteScheduled = (projectId, noteId, member) => {
    const upd = n => n.id!==noteId ? n : {
      ...n,
      readBy: (n.readBy||[]).includes(member) ? (n.readBy||[]) : [...(n.readBy||[]), member],
      scheduledBy: (n.scheduledBy||[]).includes(member) ? (n.scheduledBy||[]) : [...(n.scheduledBy||[]), member],
    };
    setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, notes: noteList(p.notes).map(upd) }));
    _notesTx(projectId, p => ({ ...p, notes: noteList(p.notes||[]).map(upd) }));
  };
  const markChecklistNoteScheduled = (projectId, noteId, member) => {
    const upd = n => n.id!==noteId ? n : {
      ...n,
      readBy: (n.readBy||[]).includes(member) ? (n.readBy||[]) : [...(n.readBy||[]), member],
      scheduledBy: (n.scheduledBy||[]).includes(member) ? (n.scheduledBy||[]) : [...(n.scheduledBy||[]), member],
    };
    setProjects(ps => ps.map(p => p.id !== projectId ? p : {
      ...p, checklistNotes: (p.checklistNotes||[]).map(upd),
    }));
    _notesTx(projectId, p => ({ ...p, checklistNotes: (p.checklistNotes||[]).map(upd) }));
  };
  const markProjectNoteScheduleCompleted = (projectId, noteId, member, completed) => {
    const upd = n => n.id!==noteId ? n : {
      ...n,
      scheduleCompletedBy: completed
        ? [...new Set([...(n.scheduleCompletedBy||[]), member])]
        : (n.scheduleCompletedBy||[]).filter(m => m !== member),
    };
    setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, notes: noteList(p.notes).map(upd) }));
    _notesTx(projectId, p => ({ ...p, notes: noteList(p.notes||[]).map(upd) }));
  };
  const markChecklistNoteScheduleCompleted = (projectId, noteId, member, completed) => {
    const upd = n => n.id!==noteId ? n : {
      ...n,
      scheduleCompletedBy: completed
        ? [...new Set([...(n.scheduleCompletedBy||[]), member])]
        : (n.scheduleCompletedBy||[]).filter(m => m !== member),
    };
    setProjects(ps => ps.map(p => p.id !== projectId ? p : {
      ...p, checklistNotes: (p.checklistNotes||[]).map(upd),
    }));
    _notesTx(projectId, p => ({ ...p, checklistNotes: (p.checklistNotes||[]).map(upd) }));
  };
  const markFeedbackRead = (feedbackId, member) => {
    setFeedback(fb => fb.map(f => f.id !== feedbackId ? f :
      { ...f, readBy: [...new Set([...(f.readBy||[]), member])] }
    ));
  };
  const toggleNoteDone = (projectId, noteId, source) => {
    if (source === "Tracker") {
      const curProj = projects.find(p => p.id === projectId);
      const curNote = (curProj?.checklistNotes || []).find(n => n.id === noteId);
      const targetDone = !(curNote?.done ?? false);
      const upd = n => n.id !== noteId ? n : { ...n, done: !n.done };
      const txUpd = n => n.id !== noteId ? n : { ...n, done: targetDone };
      setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, checklistNotes: (p.checklistNotes||[]).map(upd) }));
      _notesTx(projectId, p => ({ ...p, checklistNotes: (p.checklistNotes||[]).map(txUpd) }));
    } else {
      const curProj = projects.find(p => p.id === projectId);
      const curNote = noteList(curProj?.notes || []).find(n => n.id === noteId);
      const targetDone = !(curNote?.done ?? false);
      const upd = n => n.id !== noteId ? n : { ...n, done: !n.done };
      const txUpd = n => n.id !== noteId ? n : { ...n, done: targetDone };
      setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, notes: noteList(p.notes).map(upd) }));
      _notesTx(projectId, p => ({ ...p, notes: noteList(p.notes||[]).map(txUpd) }));
    }
  };
  const selfTagProjectNote = (projectId, noteId, member) => {
    const upd = n => n.id !== noteId ? n : {
      ...n,
      tagged: [...new Set([...(n.tagged||[]), member])],
      readBy:  [...new Set([...(n.readBy||[]),  member])],
    };
    setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, notes: noteList(p.notes).map(upd) }));
    _notesTx(projectId, p => ({ ...p, notes: noteList(p.notes||[]).map(upd) }));
  };
  const selfTagChecklistNote = (projectId, noteId, member) => {
    const upd = n => n.id !== noteId ? n : {
      ...n,
      tagged: [...new Set([...(n.tagged||[]), member])],
      readBy:  [...new Set([...(n.readBy||[]),  member])],
    };
    setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, checklistNotes: (p.checklistNotes||[]).map(upd) }));
    _notesTx(projectId, p => ({ ...p, checklistNotes: (p.checklistNotes||[]).map(upd) }));
  };
  const updateChecklistNoteTags = (projectId, noteId, newTagged) => {
    const upd = n => n.id !== noteId ? n : { ...n, tagged: newTagged };
    setProjects(ps => ps.map(p => p.id !== projectId ? p : { ...p, checklistNotes: (p.checklistNotes||[]).map(upd) }));
    _notesTx(projectId, p => ({ ...p, checklistNotes: (p.checklistNotes||[]).map(upd) }));
  };

  const editProjectNote = (projectId, noteId, newText) => {
    setProjects(ps => ps.map(p => p.id !== projectId ? p : {
      ...p, notes: noteList(p.notes).map(n => n.id===noteId ? { ...n, text: newText } : n),
    }));
    _notesTx(projectId, p => ({
      ...p, notes: noteList(p.notes || []).map(n => n.id===noteId ? { ...n, text: newText } : n),
    }));
  };
  const autoReorderProjects = newMaster => {
    const masterOrder = newMaster.map(m => m.id);
    setProjects(ps => ps.map(p => {
      const cl = p.checklist || [];
      if (!cl.length) return p;
      const withTemplate = cl.filter(c => c.templateId);
      const withoutTemplate = cl.filter(c => !c.templateId);
      const sorted = [...withTemplate].sort((a, b) => {
        const ai = masterOrder.indexOf(a.templateId);
        const bi = masterOrder.indexOf(b.templateId);
        return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      });
      return { ...p, checklist: [...sorted, ...withoutTemplate] };
    }));
  };

  const syncProjectWithMaster = (projectId, newItemIds, changedItemIds) => {
    setProjects(ps => ps.map(p => {
      if (p.id !== projectId) return p;
      const cl = p.checklist || [];
      const projectTplIds = new Set(cl.map(c => c.templateId).filter(Boolean));
      const newItemsToAdd = masterTemplate
        .filter(m => newItemIds.includes(m.id) && !projectTplIds.has(m.id) && (m.takeOffOnly ? p.type === "Take-Off" : true))
        .map(m => ({
          id: mkId(), templateId: m.id, section: m.section, label: m.label,
          subItems: (m.subItems||[]).map(si=>({id:mkId(), text:si.text, done:false})),
          done: false, note: "", flag: null,
          ...(m.takeOffOnly ? { takeOffOnly: true } : {}),
          history: [{ ts: nowTs(), member: currentUser, action: "synced from master" }]
        }));
      const relabeled = cl.map(c => {
        const m = c.templateId && changedItemIds.includes(c.templateId) && masterTemplate.find(mm => mm.id === c.templateId);
        if (!m) return c;
        const labelChanged = m.label !== c.label;
        const mSubs = (m.subItems||[]).map(s=>s.text).join("\x00");
        const eSubs = (c.subItems||[]).map(s=>s.text).join("\x00");
        if (!labelChanged && mSubs === eSubs) return c;
        const prevDone = Object.fromEntries((c.subItems||[]).map(s=>[s.text, s.done]));
        return {
          ...c, label: m.label,
          subItems: (m.subItems||[]).map(si=>({id:mkId(), text:si.text, done: prevDone[si.text]??false})),
          history: [{ ts: nowTs(), member: currentUser, action: "synced from master" }]
        };
      });
      return { ...p, checklist: [...relabeled, ...newItemsToAdd] };
    }));
  };

  const saveTask = f => {
    if (editing) setTasks(ts=>ts.map(t=>t.id===editing.id?{...editing,...f,...(f.assigned!==editing.assigned?{assignedBy:currentUser}:{})}:t));
    else setTasks(ts=>[...ts,{...f,id:mkId(),assignedBy:currentUser}]);
    setModal(null); setEditing(null);
  };
  const completeTask = id => setTasks(ts=>ts.map(t=>t.id===id?{...t,status:"Completed"}:t));

  // tz is stamped from the creating device's own clock — covers every creation path (quick-add, full modal, etc.) at once
  const addCalendarEvent = ev => setCalendarEvents(es => [...es, { tz: DEVICE_TZ, ...ev }]);
  const removeCalendarEvent = id => setCalendarEvents(es => es.filter(e => e.id !== id));
  const smartRemoveCalendarEvent = id => {
    const ev = calendarEvents.find(e => e.id === id);
    if (ev?.inboxItemType) {
      if (ev.createdBy !== currentUser && !isAdmin(currentUser)) return;
      setPendingDeleteEventId(id);
      return;
    }
    removeCalendarEvent(id);
  };
  const updateCalendarEvent = (id, patch) => setCalendarEvents(es => es.map(e => e.id === id ? { ...e, ...patch } : e));
  const smartUpdateCalendarEvent = (id, patch, forMember) => {
    const member = forMember || currentUser;
    if ('done' in patch) {
      const ev = calendarEvents.find(e => e.id === id);
      if (ev?.noteId && ev?.projectId) {
        if (ev.inboxItemType === "note") {
          markProjectNoteScheduleCompleted(ev.projectId, ev.noteId, member, patch.done);
          // Mirror done state onto the source note so it clears from the tracker
          setProjects(ps => ps.map(p => p.id !== ev.projectId ? p : {
            ...p, notes: noteList(p.notes).map(n => n.id === ev.noteId ? { ...n, done: patch.done } : n),
          }));
          _notesTx(ev.projectId, p => ({ ...p, notes: noteList(p.notes||[]).map(n => n.id === ev.noteId ? { ...n, done: patch.done } : n) }));
        } else if (ev.inboxItemType === "checklist") {
          markChecklistNoteScheduleCompleted(ev.projectId, ev.noteId, member, patch.done);
          // Mirror done state onto the source checklist note so it clears from the tracker
          setProjects(ps => ps.map(p => p.id !== ev.projectId ? p : {
            ...p, checklistNotes: (p.checklistNotes||[]).map(n => n.id === ev.noteId ? { ...n, done: patch.done } : n),
          }));
          _notesTx(ev.projectId, p => ({ ...p, checklistNotes: (p.checklistNotes||[]).map(n => n.id === ev.noteId ? { ...n, done: patch.done } : n) }));
        }
      }
    }
    updateCalendarEvent(id, patch);
  };
  const copyCalendarEvent = (id, overrides) => {
    const ev = calendarEvents.find(e => e.id === id);
    if (!ev) return;
    addCalendarEvent({ ...ev, ...overrides, id: mkId(), ts: nowTs(), done: false, createdBy: currentUser });
  };
  const toggleSubtaskInEvent = (eventId, subtaskId) => setCalendarEvents(es => es.map(e =>
    e.id === eventId ? { ...e, subtasks: (e.subtasks||[]).map(st => st.id===subtaskId ? {...st, done:!st.done} : st) } : e
  ));
  const moveCalendarEvent = (id, newDate, newTime) => setCalendarEvents(es => {
    if (newDate < todayYmd()) return es;
    const moving = es.find(e => e.id === id);
    if (!moving || (moving.date === newDate && (newTime === undefined || moving.startTime === newTime))) return es;
    const destCount = es.filter(e => e.date === newDate && e.member === moving.member).length;
    const patch = { date: newDate, order: destCount };
    if (newTime !== undefined) patch.startTime = newTime;
    return es.map(e => e.id === id ? { ...e, ...patch } : e);
  });
  const reorderCalendarDay = (date, member, orderedIds) => setCalendarEvents(es => {
    const orderMap = new Map(orderedIds.map((id,idx) => [id, idx]));
    return es.map(e => (e.date === date && e.member === member && orderMap.has(e.id)) ? { ...e, order: orderMap.get(e.id) } : e);
  });

  // F-04: Auto-archive old calendar events once after each login.
  // Removes done events older than 6 months so the collection doesn't grow unbounded.
  // Only runs when a user is logged in (Firestore write rules require isTeamMember).
  useEffect(() => {
    if (!currentUser || !firebaseConfigured) return;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 6);
    const cutoffYmd = cutoff.toISOString().slice(0, 10);
    const stale = calendarEvents.filter(e => e.done && e.date < cutoffYmd && !e.inboxItemType);
    if (!stale.length) return;
    console.log(`ASD: auto-removing ${stale.length} calendar event(s) older than 6 months`);
    setCalendarEvents(es => es.filter(e => !stale.some(s => s.id === e.id)));
  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const addFeedback = ({ projectId, text, receivedDate, attachments, tagged }) => setFeedback(fb => [
    ...fb, { id:mkId(), projectId, text, receivedDate, attachments:attachments||[], tagged:tagged||[], status:"Open", createdBy:currentUser, ts:nowTs() },
  ]);
  const updateFeedback = (id, fields) => setFeedback(fb => fb.map(f => f.id===id ? { ...f, ...fields } : f));
  const removeFeedback = id => setFeedback(fb => fb.filter(f => f.id !== id));
  const toggleFeedbackStatus = id => setFeedback(fb => fb.map(f => f.id===id ? { ...f, status: f.status==="Open"?"Resolved":"Open" } : f));

  const addInvoice = (inv) => setInvoices(v => [...v, { ...inv, id:mkId(), createdAt:nowTs() }]);
  const updateInvoice = (id, fields) => setInvoices(v => v.map(inv => inv.id===id ? { ...inv, ...fields } : inv));
  const removeInvoice = id => setInvoices(v => v.filter(inv => inv.id !== id));

  const addNotice = (text, tagged) => setNotices(n => [
    ...n, { id:mkId(), text, author:currentUser, ts:nowTs(), tagged:tagged||[], readBy:[], archivedAt:null },
  ]);
  // Mark a notice as read for the given member. Does NOT auto-archive — notices stay
  // in Active until someone manually archives them so all team members see every notice
  // regardless of whether they are tagged.
  const markNoticeRead = (id, member) => setNotices(n => n.map(x => {
    if (x.id !== id || x.readBy.includes(member)) return x;
    return { ...x, readBy: [...x.readBy, member] };
  }));
  const archiveNotice = id => setNotices(n => n.map(x => x.id===id ? { ...x, archivedAt: nowTs() } : x));
  const unarchiveNotice = id => setNotices(n => n.map(x => x.id===id ? { ...x, archivedAt: null } : x));
  const deleteNoticeForever = id => setNotices(n => n.filter(x => x.id !== id));

  // Merge curated clients list with any client codes already on projects so newly added
  // fabricators appear in the filter immediately, even before they're assigned to a project.
  const fabricators = [...new Set([...clients, ...projects.map(p => p.client).filter(Boolean)])].sort();

  const filteredProjects = useMemo(() => projects.filter(p => {
    if (p.status === "Completed") return false;
    if (hideOnHold && p.status === "ON HOLD") return false;
    if (filterStatuses.size > 0 && !filterStatuses.has(p.status)) return false;
    if (filterMember !== "All" && !p.assigned.includes(filterMember)) return false;
    if (filterClient !== "All" && p.client !== filterClient) return false;
    if (filterDue !== "All") {
      const today = todayYmd();
      const d = p.due || "";
      if (filterDue === "Overdue" && (d === "" || d >= today)) return false;
      if (filterDue === "This Week") {
        const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
        const weekEndStr = ymd(weekEnd);
        if (d === "" || d < today || d > weekEndStr) return false;
      }
      if (filterDue === "This Month" && d.slice(0,7) !== today.slice(0,7)) return false;
      if (filterDue === "No Date" && d !== "") return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !p.client.toLowerCase().includes(q) && !(p.jobCode||"").toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (sortBy === "priority") {
      const ra = PRIORITY_RANK[a.priority] ?? 9, rb = PRIORITY_RANK[b.priority] ?? 9;
      if (ra !== rb) return ra - rb;
      return (a.jobCode||"").localeCompare(b.jobCode||"", undefined, { numeric:true, sensitivity:"base" });
    }
    if (sortBy === "newest") {
      const da = a.incomingDate || "", db = b.incomingDate || "";
      if (da !== db) return db.localeCompare(da);
      return (a.jobCode||"").localeCompare(b.jobCode||"", undefined, { numeric:true, sensitivity:"base" });
    }
    if (sortBy === "due") {
      const da = a.due || "9999-99-99", db = b.due || "9999-99-99";
      if (da !== db) return da.localeCompare(db); // soonest first; no date → bottom
      return (a.jobCode||"").localeCompare(b.jobCode||"", undefined, { numeric:true, sensitivity:"base" });
    }
    return (a.jobCode||"").localeCompare(b.jobCode||"", undefined, { numeric:true, sensitivity:"base" });
  }), [projects, filterStatuses, filterMember, filterClient, filterDue, search, sortBy, hideOnHold]);

  const completedMonths = useMemo(() => {
    const months = new Set(
      projects.filter(p => p.status === "Completed" && p.completedDate).map(p => p.completedDate.slice(0, 7))
    );
    return [...months].sort().reverse();
  }, [projects]);

  const filteredCompleted = useMemo(() => projects.filter(p => {
    if (p.status !== "Completed") return false;
    if (filterMember !== "All" && !p.assigned.includes(filterMember)) return false;
    if (filterClient !== "All" && p.client !== filterClient) return false;
    if (filterCompletedMonth !== "All" && (!p.completedDate || p.completedDate.slice(0, 7) !== filterCompletedMonth)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !p.client.toLowerCase().includes(q) && !(p.jobCode||"").toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => completedSortDir === "desc"
    ? (b.completedDate||"").localeCompare(a.completedDate||"")
    : (a.completedDate||"").localeCompare(b.completedDate||"")),
  [projects, filterMember, filterClient, filterCompletedMonth, completedSortDir, search]);

  const projectsWithUpdates = useMemo(() => projects.filter(p => {
    const u = getProjectUpdates(p, masterTemplate);
    return u.newItems.length > 0;
  }).length, [projects, masterTemplate]);

  const mc = MEMBER_COLOR[currentUser];

  const [theme, setTheme] = useState(() => localStorage.getItem(`asd_theme_${currentUser}`) || localStorage.getItem("asd_theme") || "light");
  const [themeMenu, setThemeMenu] = useState(null); // {x,y} for right-click context menu
  useEffect(() => {
    const t = localStorage.getItem(`asd_theme_${currentUser}`) || "light";
    setTheme(t);
    document.documentElement.dataset.theme = t;
    document.body.style.background = t === "dark" ? "#0F172A" : "#F1F5F9";
  }, [currentUser]);
  const applyTheme = (t) => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    document.body.style.background = t === "dark" ? "#0F172A" : "#F1F5F9";
    localStorage.setItem(`asd_theme_${currentUser}`, t);
    localStorage.setItem("asd_theme", t); // keep global in sync for pre-login flash prevention
  };
  const toggleTheme = () => applyTheme(theme === "light" ? "dark" : "light");
  const isDark = theme === "dark";

  const CAN_MANAGE_WEBSITE = ["RAJ","LESLIE"].includes(currentUser);
  const TAB_LABELS = useMemo(() => {
    const myProjectTags   = projects.reduce((n,p) => n + noteList(p.notes||[]).filter(note => (note.tagged||[]).includes(currentUser) && !(note.readBy||[]).includes(currentUser) && !note.done).length, 0);
    const myTrackerTags   = projects.reduce((n,p) => n + (p.checklistNotes||[]).filter(note => (note.tagged||[]).includes(currentUser) && !(note.readBy||[]).includes(currentUser) && !note.done).length, 0);
    const myFeedbackTags  = feedback.filter(f => (f.tagged||[]).includes(currentUser) && !(f.readBy||[]).includes(currentUser)).length;
    return [
      {key:"projects",  label:"Projects",  icon:"🏗️", count:projects.filter(p=>p.status!=="Completed").length, tagCount:myProjectTags},
      {key:"completed", label:"Completed", icon:"✅",  count:projects.filter(p=>p.status==="Completed").length},
      {key:"checklist", label:"Tracker",   icon:"📋",  tagCount:myTrackerTags},
      {key:"calendar",  label:"Calendar",  icon:"📅"},
      {key:"feedback",  label:"Feedback",  icon:"💬",  count:feedback.filter(f=>f.status==="Open").length, tagCount:myFeedbackTags},
      ...(CAN_MANAGE_WEBSITE ? [{key:"portfolio", label:"Website", icon:"🌐"}] : []),
      ...(isAdmin(currentUser) ? [{key:"invoices", label:"Invoices", icon:"💰", count: invoices.filter(i=>i.status==="Sent"||i.status==="Overdue").length}] : []),
    ];
  }, [projects, feedback, invoices, CAN_MANAGE_WEBSITE, currentUser, isAdmin]);

  // ── Persisted tab order per user ──────────────────────────────────────────
  const [tabOrder, setTabOrder] = useState(() => {
    try {
      const saved = localStorage.getItem(`asd_tab_order_${currentUser}`);
      if (saved) { const p = JSON.parse(saved); if (Array.isArray(p) && p.length) return p; }
    } catch {}
    return null;
  });
  const orderedTabLabels = useMemo(() => {
    if (!tabOrder) return TAB_LABELS;
    const byKey = Object.fromEntries(TAB_LABELS.map(t => [t.key, t]));
    const result = tabOrder.filter(k => byKey[k]).map(k => byKey[k]);
    TAB_LABELS.forEach(t => { if (!result.find(r => r.key === t.key)) result.push(t); });
    return result;
  }, [tabOrder, TAB_LABELS]);

  const [draggingTabKey, setDraggingTabKey] = useState(null);
  const [dragOverTabKey, setDragOverTabKey] = useState(null);
  const reorderTab = overKey => {
    if (!draggingTabKey || draggingTabKey === overKey) return;
    const keys = orderedTabLabels.map(t => t.key);
    const from = keys.indexOf(draggingTabKey), to = keys.indexOf(overKey);
    if (from < 0 || to < 0) return;
    const next = [...keys]; next.splice(from, 1); next.splice(to, 0, draggingTabKey);
    setTabOrder(next);
    try { localStorage.setItem(`asd_tab_order_${currentUser}`, JSON.stringify(next)); } catch {}
  };

  return (
    <div style={{minHeight:"100vh",background:"var(--c-page)",fontFamily:"system-ui,sans-serif",color:"var(--c-t1)"}}>
      <div style={{background:"var(--c-page)",borderBottom:"1px solid var(--c-border2)",padding:"0 16px",position:"sticky",top:0,zIndex:200}}>
        <div style={{display:"flex",alignItems:"center",gap:4,height:46}}>
          <a href="https://www.advancedsteeldrafting.com.au"
            style={{display:"flex",alignItems:"center",gap:8,marginRight:6,textDecoration:"none",cursor:"pointer"}}>
            <img src="/logo.jpg" alt="ASD" style={{width:28,height:28,borderRadius:5,objectFit:"cover",display:"block",flexShrink:0}}/>
            <div>
              <div style={{fontWeight:900,fontSize:12,color:"var(--c-t1)",lineHeight:1.1}}>ADVANCED STEEL</div>
              <div style={{fontWeight:600,fontSize:8,color:"var(--c-t4)",letterSpacing:"0.1em",textTransform:"uppercase"}}>DRAFTING</div>
            </div>
          </a>
          {!isTablet && <WorldClocks/>}
          <div style={{flex:1}}/>
          {tabHistory.length>0 && (
            <button onClick={goBack} title="Go back" style={{background:"none",border:"none",color:"#F97316",cursor:"pointer",fontSize:18,padding:"4px 6px",lineHeight:1,marginRight:2,fontWeight:900}}>←</button>
          )}
          {!isMobile && orderedTabLabels.map(({key,label,count,tagCount})=>{
            const isDragging = draggingTabKey===key;
            const isOver = dragOverTabKey===key && !isDragging;
            return (
              <button key={key}
                draggable
                onDragStart={e=>{e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",key);setDraggingTabKey(key);}}
                onDragOver={e=>{if(!draggingTabKey)return;e.preventDefault();e.dataTransfer.dropEffect="move";if(dragOverTabKey!==key)setDragOverTabKey(key);}}
                onDragLeave={()=>setDragOverTabKey(k=>k===key?null:k)}
                onDrop={e=>{if(!draggingTabKey)return;e.preventDefault();reorderTab(key);setDraggingTabKey(null);setDragOverTabKey(null);}}
                onDragEnd={()=>{setDraggingTabKey(null);setDragOverTabKey(null);}}
                onClick={()=>goToTab(key)}
                title="Drag to reorder tabs"
                style={{
                  background: isOver?"#3B82F610":"none",
                  border:"none",
                  color:tab===key?"#F97316":isDragging?"#94A3B8":"#64748B",
                  cursor:draggingTabKey?"grabbing":"grab",
                  fontSize:12,fontWeight:tab===key?800:500,
                  padding:"4px 8px",
                  borderBottom:isOver?"2px solid #3B82F6":tab===key?"2px solid #F97316":"2px solid transparent",
                  borderRadius:isOver?"4px 4px 0 0":undefined,
                  display:"flex",alignItems:"center",gap:4,
                  opacity:isDragging?0.35:1,
                  transition:"opacity 0.1s,background 0.1s",
                }}>
                {tagCount>0&&<span style={{background:"#EF4444",color:"#fff",fontSize:8,fontWeight:900,borderRadius:7,minWidth:13,height:13,lineHeight:"13px",textAlign:"center",padding:"0 3px",flexShrink:0}}>{tagCount}</span>}
                {label}
                {count!=null&&<span style={{background:tab===key?"#F9731630":"var(--c-panel)",color:tab===key?"#F97316":"var(--c-t5)",fontSize:9,fontWeight:800,borderRadius:8,padding:"1px 5px"}}>{count}</span>}
              </button>
            );
          })}
          {isMobile && <span style={{fontSize:13,fontWeight:800,color:"#F97316"}}>{TAB_LABELS.find(t=>t.key===tab)?.label}</span>}
          {isAdmin(currentUser) && !isMobile && (
            <>
              <button onClick={()=>setShowTeamModal(true)} title="Manage team members" style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:11,fontWeight:700,padding:"5px 10px",marginLeft:6,display:"flex",alignItems:"center",gap:5}}>
                👥 Team
              </button>
              <button onClick={()=>setShowClientsModal(true)} title="Manage clients" style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:11,fontWeight:700,padding:"5px 10px",marginLeft:6,display:"flex",alignItems:"center",gap:5}}>
                🏢 Clients
              </button>
              <button onClick={() => exportAllData(projects)} title="Download a full JSON backup of all app data" style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:11,fontWeight:700,padding:"5px 10px",marginLeft:6,display:"flex",alignItems:"center",gap:5}}>
                💾 Export
              </button>
              <button onClick={()=>importFileRef.current?.click()} title="Restore all data from a previously exported JSON backup" style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:11,fontWeight:700,padding:"5px 10px",marginLeft:6,display:"flex",alignItems:"center",gap:5}}>
                📂 Import
              </button>
              <input ref={importFileRef} type="file" accept=".json" style={{display:"none"}} onChange={handleImport}/>
              <button onClick={()=>{ setShowRecoveryModal(true); fetchRecoverySnapshots(); }} title="Restore projects from an automatic device snapshot" style={{background:"var(--c-panel)",border:"1px solid #F9731644",borderRadius:6,color:"#F97316",cursor:"pointer",fontSize:11,fontWeight:700,padding:"5px 10px",marginLeft:6,display:"flex",alignItems:"center",gap:5}}>
                🔄 Recover
              </button>
            </>
          )}
          {isAdmin(currentUser) && isMobile && (
            <>
              <button onClick={()=>setShowTeamModal(true)} title="Team" style={{background:"none",border:"none",color:"var(--c-t3)",cursor:"pointer",fontSize:18,padding:"4px"}}>👥</button>
              <button onClick={()=>setShowClientsModal(true)} title="Clients" style={{background:"none",border:"none",color:"var(--c-t3)",cursor:"pointer",fontSize:18,padding:"4px"}}>🏢</button>
            </>
          )}
          {/* Sync status — shows save/offline/error state for Firestore writes */}
          {firebaseConfigured && !isMobile && <SyncBadge/>}
          {/* Theme toggle — left-click to switch, right-click to set as default */}
          <button
            onClick={toggleTheme}
            onContextMenu={e=>{ e.preventDefault(); setThemeMenu({x:e.clientX,y:e.clientY}); }}
            title={`Switch to ${isDark?"light":"dark"} mode · right-click to set default`}
            style={{background:"none",border:"1px solid var(--c-border)",borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:15,color:"var(--c-t3)",marginLeft:4,lineHeight:1}}>
            {isDark ? "☀️" : "🌙"}
          </button>
          <div style={{display:"flex",alignItems:"center",gap:5,marginLeft:6,padding:"3px 8px",background:`${mc}18`,border:`1px solid ${mc}44`,borderRadius:20}}>
            <div style={{width:20,height:20,borderRadius:"50%",background:mc,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:900,color:"#0F172A"}}>{currentUser.slice(0,2)}</div>
            {!isMobile && <span style={{fontSize:11,fontWeight:700,color:mc}}>{currentUser}</span>}
            <button onClick={onLogout} style={{background:"none",border:"none",color:"var(--c-t5)",cursor:"pointer",fontSize:11}}>⏏</button>
          </div>
        </div>
      </div>
      {showTeamModal && isAdmin(currentUser) && <TeamModal presence={presence||{sessions:[],online:{}}} currentUser={currentUser} memberColor={MEMBER_COLOR} teamNames={TEAM} onClose={()=>setShowTeamModal(false)}/>}
      {showClientsModal && <ClientsModal projects={projects} invoices={invoices} onAddInvoice={addInvoice} onUpdateInvoice={updateInvoice} onRemoveInvoice={removeInvoice} onClose={()=>setShowClientsModal(false)}/>}
      {showRecoveryModal && isAdmin(currentUser) && (
        <div style={{position:"fixed",inset:0,zIndex:9500,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:12,width:"100%",maxWidth:640,maxHeight:"80vh",display:"flex",flexDirection:"column",boxShadow:"0 24px 64px rgba(0,0,0,0.4)"}}>
            <div style={{padding:"16px 20px 12px",borderBottom:"1px solid var(--c-border)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:15,fontWeight:800,color:"var(--c-t1)"}}>🔄 Data Recovery</div>
                <div style={{fontSize:11,color:"var(--c-t4)",marginTop:2}}>Automatic snapshots saved each time a device opens the app with real data</div>
              </div>
              <button onClick={()=>setShowRecoveryModal(false)} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"var(--c-t3)",padding:4}}>✕</button>
            </div>
            <div style={{overflowY:"auto",flex:1,padding:16}}>
              {recoveryLoading ? (
                <div style={{textAlign:"center",padding:40,color:"var(--c-t4)",fontSize:13}}>Loading snapshots…</div>
              ) : recoverySnapshots.length === 0 ? (
                <div style={{textAlign:"center",padding:40,color:"var(--c-t4)",fontSize:13}}>No recovery snapshots found.</div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {recoverySnapshots.map((rec,i) => {
                    const dt = new Date(rec.savedAt);
                    const isRecent = Date.now() - rec.savedAt < 7 * 86400000;
                    return (
                      <div key={rec.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:i===0?"#F9731608":"var(--c-page)",border:`1px solid ${i===0?"#F9731633":"var(--c-border)"}`,borderRadius:8}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:700,color:"var(--c-t1)"}}>
                            {dt.toLocaleString("en-AU",{weekday:"short",day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}
                            {i===0&&<span style={{marginLeft:6,fontSize:9,fontWeight:800,color:"#F97316",background:"#F9731620",padding:"1px 5px",borderRadius:4}}>LATEST</span>}
                          </div>
                          <div style={{fontSize:10,color:"var(--c-t4)",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {rec.projects.length} project{rec.projects.length!==1?"s":""} &nbsp;·&nbsp; {rec.device.split(" ").slice(0,4).join(" ")||"Unknown device"}
                          </div>
                        </div>
                        <button onClick={()=>restoreRecoverySnapshot(rec)} style={{flexShrink:0,background:"#F9731618",border:"1px solid #F9731644",borderRadius:7,padding:"6px 14px",color:"#F97316",cursor:"pointer",fontSize:11,fontWeight:800}}>
                          Restore
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{padding:"10px 16px",borderTop:"1px solid var(--c-border)",fontSize:10,color:"var(--c-t4)"}}>
              Restoring replaces all current project data. Export a backup first if needed.
            </div>
          </div>
        </div>
      )}
      {/* Theme right-click context menu */}
      {themeMenu && <>
        <div style={{position:"fixed",inset:0,zIndex:8999}} onClick={()=>setThemeMenu(null)} onContextMenu={e=>{e.preventDefault();setThemeMenu(null);}}/>
        <div style={{position:"fixed",left:themeMenu.x,top:themeMenu.y,zIndex:9000,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:4,boxShadow:"0 8px 24px rgba(0,0,0,0.3)",minWidth:170}}>
          <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",padding:"4px 10px 6px",letterSpacing:"0.06em"}}>Set default theme</div>
          {[["light","☀️","Light Mode"],["dark","🌙","Dark Mode"]].map(([t,icon,label])=>(
            <button key={t} onClick={()=>{applyTheme(t);setThemeMenu(null);}}
              style={{display:"flex",alignItems:"center",gap:8,width:"100%",background:theme===t?"#F9731618":"transparent",border:"none",borderRadius:5,padding:"7px 12px",cursor:"pointer",fontSize:12,fontWeight:theme===t?800:500,color:theme===t?"#F97316":"var(--c-t2)",textAlign:"left"}}>
              <span style={{fontSize:15}}>{icon}</span>
              {label}
              {theme===t && <span style={{marginLeft:"auto",fontSize:10,color:"#F97316",fontWeight:900}}>✓ current</span>}
            </button>
          ))}
        </div>
      </>}

      {/* Mobile bottom tab bar — primary 4 tabs + "More" overflow */}
      {isMobile && (
        <>
          {showMoreTabs && (
            <>
              <div style={{position:"fixed",inset:0,zIndex:298}} onClick={()=>setShowMoreTabs(false)}/>
              <div style={{position:"fixed",bottom:"calc(60px + env(safe-area-inset-bottom) + 6px)",right:8,zIndex:299,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:12,padding:6,boxShadow:"0 8px 32px rgba(0,0,0,0.35)",minWidth:160}}>
                {TAB_LABELS.slice(4).map(({key,label,icon,count,tagCount})=>(
                  <button key={key} onClick={()=>{goToTab(key);setShowMoreTabs(false);}}
                    style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"10px 14px",background:tab===key?"#F9731618":"transparent",border:"none",borderRadius:8,color:tab===key?"#F97316":"var(--c-t2)",cursor:"pointer",fontSize:13,fontWeight:tab===key?800:500,position:"relative"}}>
                    <span style={{fontSize:18}}>{icon}</span>
                    <span style={{flex:1,textAlign:"left"}}>{label}</span>
                    {(count>0||tagCount>0)&&<span style={{background:tagCount>0?"#EF4444":"#F97316",color:"#fff",fontSize:10,fontWeight:800,borderRadius:8,padding:"1px 6px",minWidth:16,textAlign:"center"}}>{tagCount>0?tagCount:count}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
          <div style={{position:"fixed",bottom:0,left:0,right:0,zIndex:300,background:"var(--c-panel)",borderTop:"1px solid var(--c-border)",display:"flex",height:"calc(60px + env(safe-area-inset-bottom))",paddingBottom:"env(safe-area-inset-bottom)"}}>
            {TAB_LABELS.slice(0,4).map(({key,label,icon,count,tagCount})=>(
              <button key={key} onClick={()=>{goToTab(key);setShowMoreTabs(false);}} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,background:"none",border:"none",color:tab===key?"#F97316":"var(--c-t4)",cursor:"pointer",fontSize:10,fontWeight:tab===key?800:500,padding:"4px 0",position:"relative"}}>
                <span style={{fontSize:20,lineHeight:1.2}}>{icon}</span>
                <span>{label}</span>
                {(count>0||tagCount>0)&&<span style={{position:"absolute",top:4,left:"calc(50% - 30px)",background:tagCount>0?"#EF4444":"#F97316",color:"#fff",fontSize:9,fontWeight:800,borderRadius:8,padding:"1px 4px",minWidth:14,textAlign:"center"}}>{tagCount>0?tagCount:count}</span>}
              </button>
            ))}
            {TAB_LABELS.length > 4 && (
              <button onClick={()=>setShowMoreTabs(m=>!m)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,background:"none",border:"none",color:showMoreTabs||TAB_LABELS.slice(4).some(t=>t.key===tab)?"#F97316":"var(--c-t4)",cursor:"pointer",fontSize:10,fontWeight:500,padding:"4px 0",position:"relative"}}>
                <span style={{fontSize:20,lineHeight:1.2}}>⋯</span>
                <span>More</span>
                {TAB_LABELS.slice(4).reduce((n,t)=>(n+(t.tagCount||0)+(t.count||0)),0)>0&&<span style={{position:"absolute",top:4,left:"calc(50% - 30px)",background:"#EF4444",color:"#fff",fontSize:9,fontWeight:800,borderRadius:8,padding:"1px 4px",minWidth:14,textAlign:"center"}}>{TAB_LABELS.slice(4).reduce((n,t)=>n+(t.tagCount||0)+(t.count||0),0)}</span>}
              </button>
            )}
          </div>
        </>
      )}

      <ProjectNoteAlerts projects={projects} currentUser={currentUser} onOpenProject={p=>openDetail(p,"notes")}/>
      <div style={{padding:isMobile?"8px 8px":"14px 16px",display:"flex",gap:16,alignItems:"flex-start",paddingBottom:isMobile?"calc(76px + env(safe-area-inset-bottom))":undefined}}>
        {!isTablet && <NoticeBoard notices={notices} currentUser={currentUser} presence={presence} onAdd={addNotice} onMarkRead={markNoticeRead} onArchive={archiveNotice} onUnarchive={unarchiveNotice} onDeleteForever={deleteNoticeForever} onNoticeDragStart={item=>{ setDraggingMyInboxItem(null); setDraggingNoticeItem(item); }} onNoticeDragEnd={()=>setDraggingNoticeItem(null)} onToggleDnd={onToggleDnd}/>}
        <ErrorBoundary label="Projects">
        <div style={{flex:1,minWidth:0}}>
        <div style={(tab==="projects"&&!(projectView==="card"||isMobile)&&filteredProjects.length>0)||(tab==="completed"&&!isMobile&&filteredCompleted.length>0)?{position:"sticky",top:47,zIndex:15,background:"var(--c-page)"}:{}}>
        {tab==="projects"&&<Stats projects={projects} activeStatuses={filterStatuses} onToggle={toggleStatusFilter} statusOrder={statusOrder} onReorder={handleReorderStatus}/>}

        {tab!=="checklist"&&tab!=="calendar"&&tab!=="feedback"&&(
          <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…" style={{...IS,width:isMobile?undefined:240,flex:isMobile?"1":"0 0 auto"}}/>
            {isMobile && <button onClick={()=>setShowMobileFilters(f=>!f)} style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:12,fontWeight:700,padding:"6px 12px",whiteSpace:"nowrap"}}>{showMobileFilters?"▲ Hide":"▼ Filter"}</button>}
            {(!isMobile||showMobileFilters)&&<>
            {tab==="completed"
              ? <>
                  <select value={filterCompletedMonth} onChange={e=>setFilterCompletedMonth(e.target.value)} style={{...IS,width:isMobile?"100%":155}}>
                    <option value="All">All months</option>
                    {completedMonths.map(ym => {
                      const [y, m] = ym.split("-");
                      const label = new Date(+y, +m-1, 1).toLocaleString("default", { month:"long", year:"numeric" });
                      return <option key={ym} value={ym}>{label}</option>;
                    })}
                  </select>
                  <div style={{display:"flex",alignItems:"center",gap:0,background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:6,padding:2}}>
                    <button onClick={()=>setCompletedSortDir("desc")} title="Newest first" style={{padding:"5px 10px",borderRadius:4,border:"none",background:completedSortDir==="desc"?"var(--c-panel)":"transparent",color:completedSortDir==="desc"?"var(--c-t1)":"var(--c-t4)",fontWeight:completedSortDir==="desc"?700:400,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>↓ Newest</button>
                    <button onClick={()=>setCompletedSortDir("asc")} title="Oldest first" style={{padding:"5px 10px",borderRadius:4,border:"none",background:completedSortDir==="asc"?"var(--c-panel)":"transparent",color:completedSortDir==="asc"?"var(--c-t1)":"var(--c-t4)",fontWeight:completedSortDir==="asc"?700:400,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>↑ Oldest</button>
                  </div>
                </>
              : null
            }
            <select value={filterClient} onChange={e=>setFilterClient(e.target.value)} style={{...IS,width:isMobile?"100%":150}}><option value="All">All fabricators</option>{fabricators.map(c=><option key={c}>{c}</option>)}</select>
            <select value={filterMember} onChange={e=>setFilterMember(e.target.value)} style={{...IS,width:isMobile?"100%":130}}><option value="All">All members</option>{TEAM.map(m=><option key={m}>{m}</option>)}</select>
            {tab!=="completed"&&<select value={filterDue} onChange={e=>setFilterDue(e.target.value)} style={{...IS,width:isMobile?"100%":140}}><option value="All">All due dates</option><option value="Overdue">Overdue</option><option value="This Week">Due this week</option><option value="This Month">Due this month</option><option value="No Date">No due date</option></select>}
            {tab!=="completed"&&(
              <label title="Hide all ON HOLD projects from the list" style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",userSelect:"none",fontSize:12,color:hideOnHold?"#8B5CF6":"var(--c-t4)",fontWeight:hideOnHold?700:500,background:"var(--c-page)",border:`1px solid ${hideOnHold?"#8B5CF6":"var(--c-border)"}`,borderRadius:6,padding:"5px 10px",whiteSpace:"nowrap",transition:"border-color 0.15s,color 0.15s"}}>
                <input type="checkbox" checked={hideOnHold} onChange={toggleHideOnHold} style={{cursor:"pointer",accentColor:"#8B5CF6",margin:0}}/>
                Hide On Hold
              </label>
            )}
            {tab!=="completed"&&<div style={{display:"flex",alignItems:"center",gap:4,background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:6,padding:2}}>
              <button onClick={()=>setSortBy("jobCode")} style={{padding:"5px 10px",borderRadius:4,border:"none",background:sortBy==="jobCode"?"var(--c-panel)":"transparent",color:sortBy==="jobCode"?"var(--c-t1)":"var(--c-t4)",fontWeight:sortBy==="jobCode"?700:400,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>↕ Job Code</button>
              <button onClick={()=>setSortBy("priority")} style={{padding:"5px 10px",borderRadius:4,border:"none",background:sortBy==="priority"?"#7C3AED":"transparent",color:sortBy==="priority"?"#fff":"var(--c-t4)",fontWeight:sortBy==="priority"?700:400,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>▲ Priority</button>
              <button onClick={()=>setSortBy("newest")} style={{padding:"5px 10px",borderRadius:4,border:"none",background:sortBy==="newest"?"#0EA5E9":"transparent",color:sortBy==="newest"?"#fff":"var(--c-t4)",fontWeight:sortBy==="newest"?700:400,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>📅 Newest</button>
              <button onClick={()=>setSortBy("due")} style={{padding:"5px 10px",borderRadius:4,border:"none",background:sortBy==="due"?"#10B981":"transparent",color:sortBy==="due"?"#fff":"var(--c-t4)",fontWeight:sortBy==="due"?700:400,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>⏰ Due</button>
            </div>}</>}
            <div style={{flex:1}}/>
            {tab==="projects"&&(projectView==="card"||isMobile)&&(
              <span style={{fontSize:11,color:"var(--c-t4)",whiteSpace:"nowrap",alignSelf:"center"}}>({filteredProjects.length})</span>
            )}
            {tab==="projects"&&(
              <div style={{display:"flex",background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:6,padding:2,gap:2}}>
                {[{v:"card",label:"▦ Card"},{v:"list",label:"☰ List"}].map(({v,label})=>{
                  const saved = localStorage.getItem(`asd_view_pref_${currentUser}`)||"list";
                  return (
                    <button key={v} onClick={()=>setProjectView(v)}
                      onContextMenu={e=>{e.preventDefault();setViewCtxMenu({view:v,x:e.clientX,y:e.clientY});}}
                      title={`${label} view — right-click to set as default`}
                      style={{background:projectView===v?"var(--c-panel)":"transparent",border:"none",borderRadius:4,padding:"5px 10px",color:projectView===v?"#F97316":"var(--c-t4)",cursor:"pointer",fontSize:12,fontWeight:700,position:"relative"}}>
                      {label}
                      {saved===v&&<span title="Your default view" style={{position:"absolute",top:2,right:2,width:5,height:5,borderRadius:"50%",background:"#10B981"}}/>}
                    </button>
                  );
                })}
                {viewCtxMenu&&(
                  <div style={{position:"fixed",top:viewCtxMenu.y,left:viewCtxMenu.x,zIndex:1000,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:4,boxShadow:"0 4px 20px #000a",minWidth:160}}
                    onClick={e=>e.stopPropagation()}>
                    <div style={{padding:"4px 10px 6px",fontSize:10,fontWeight:700,color:"var(--c-t5)",textTransform:"uppercase",borderBottom:"1px solid var(--c-border)",marginBottom:4}}>
                      {viewCtxMenu.view==="card"?"▦ Card":"☰ List"} view
                    </div>
                    <button onMouseDown={()=>saveDefaultView(viewCtxMenu.view)}
                      style={{display:"flex",alignItems:"center",gap:8,width:"100%",textAlign:"left",padding:"7px 10px",borderRadius:5,border:"none",background:"transparent",color:"var(--c-t1)",fontSize:12,cursor:"pointer",fontWeight:600}}>
                      <span style={{fontSize:14}}>★</span> Set as my default
                    </button>
                  </div>
                )}
              </div>
            )}
            {tab==="projects"&&<button onClick={()=>{setEditing(null);setModal("addProject");}} style={{background:"#F97316",border:"none",borderRadius:6,padding:"7px 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>+ New Project</button>}
          </div>
        )}
        {tab==="projects"&&!(projectView==="card"||isMobile)&&filteredProjects.length>0&&(
          <div style={{display:"grid",gridTemplateColumns:"80px 1fr 78px 100px 150px 80px 92px 100px 60px",gap:8,padding:"10px 16px",background:"var(--c-panel)",border:"1px solid var(--c-border)",borderBottom:"1px solid var(--c-border)",borderRadius:"10px 10px 0 0"}}>
            {["Job Code","Project","Received","Client","Status","Priority","Due","Team",""].map(h=>{
              const sortable = h==="Priority"||h==="Job Code"||h==="Received";
              const isActive = (h==="Priority"&&sortBy==="priority")||(h==="Job Code"&&sortBy==="jobCode")||(h==="Received"&&sortBy==="newest");
              return <div key={h} onClick={sortable?(()=>setSortBy(h==="Priority"?"priority":h==="Received"?"newest":"jobCode")):undefined}
                style={{color:isActive?"#0EA5E9":"var(--c-t5)",fontSize:11,fontWeight:700,textTransform:"uppercase",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:sortable?"pointer":"default",userSelect:"none"}}>
                {h}{h==="Job Code"&&<span style={{fontSize:10,fontWeight:600,color:"var(--c-t4)",textTransform:"none",marginLeft:3}}>({filteredProjects.length})</span>}{isActive?" ▼":sortable?" ↕":""}
              </div>;
            })}
          </div>
        )}
        {tab==="completed"&&!isMobile&&filteredCompleted.length>0&&(
          <div style={{display:"grid",gridTemplateColumns:isAdmin(currentUser)?"90px 1fr 80px 90px 90px 110px 72px 72px 90px 100px":"90px 1fr 80px 90px 90px 110px 100px",gap:10,padding:"10px 16px",background:"var(--c-panel)",border:"1px solid var(--c-border)",borderBottom:"1px solid var(--c-border)",borderRadius:"10px 10px 0 0"}}>
            {["Job Code","Address","Client","Due","Completed","Checklist",...(isAdmin(currentUser)?["Inv Sent","Inv Paid","Amount"]:[]),""].map(h=><div key={h} style={{color:"var(--c-t5)",fontSize:11,fontWeight:700,textTransform:"uppercase"}}>{h}</div>)}
          </div>
        )}
        </div>

        {tab==="projects"&&(
          filteredProjects.length===0
            ?<div style={{textAlign:"center",color:"#334155",padding:"60px 0"}}>No projects.</div>
            :(projectView==="card"||isMobile)
            ?<div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":`repeat(auto-fill,minmax(270px,1fr))`,gap:isMobile?8:10}}>
              {filteredProjects.flatMap((p,_ci,_ca)=>{
                const _pc = PRIORITY_CLR[p.priority]||"#6B7280";
                const _cr = [];
                if (sortBy==="priority" && (_ci===0 || _ca[_ci-1].priority!==p.priority)) {
                  const _gc = _ca.filter(pp=>pp.priority===p.priority).length;
                  _cr.push(<div key={`chdr-${p.priority}`} style={{gridColumn:"1 / -1",display:"flex",alignItems:"center",gap:8,padding:"6px 4px",borderBottom:`2px solid ${_pc}44`,marginBottom:2}}>
                    <span style={{color:_pc,fontWeight:800,fontSize:12}}>▲ {(p.priority||"—").toUpperCase()}</span>
                    <span style={{color:"var(--c-t4)",fontSize:10}}>{_gc} project{_gc!==1?"s":""}</span>
                  </div>);
                }
                _cr.push(
                  <ProjectCard key={p.id} project={p} tasks={tasks} currentUser={currentUser}
                    onClick={()=>openDetail(p)}
                    onEdit={()=>{setEditing(p);setModal("editProject");}}
                    onDelete={()=>askConfirm("Move to Trash?",`Move "${p.jobCode||p.name}" to trash? You can restore it from the Trash tab.`,()=>delProject(p.id))}
                    onComplete={()=>askConfirm("Mark Completed?",`Move "${p.jobCode||p.name}" to completed?`,()=>completeProject(p.id))}
                    onCopy={()=>copyProject(p)}
                    onChecklist={()=>{setDetail(null);goToChecklist(p.id);}}
                    onStatusChange={updateProjectStatus}
                    onFieldChange={updateFieldChange}
                    onAddNote={addProjectNote}
                    onRemoveNote={removeProjectNote}
                    onMarkNoteRead={markProjectNoteRead}
                    onEditNote={editProjectNote}
                    onSelfTagNote={id=>selfTagProjectNote(p.id,id,currentUser)}
                    onToggleNoteDone={id=>toggleNoteDone(p.id,id,"note")}/>
                );
                return _cr;
              })}
            </div>
            :<div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderTop:"none",borderRadius:"0 0 10px 10px",overflow:"hidden"}}>
              {filteredProjects.flatMap((p,_pidx,_parr)=>{
                const cfg = PROJECT_STATUS[p.status]||{color:"#6B7280"};
                const priClr = PRIORITY_CLR[p.priority]||"#6B7280";
                const dl = daysLeft(p.due);
                const cl = p.checklist||[];
                const pn = noteList(p.notes);
                const myUnreadTagged = pn.filter(n=>n.tagged.includes(currentUser) && !n.readBy.includes(currentUser));
                const _rows = [];
                if (sortBy==="priority" && (_pidx===0 || _parr[_pidx-1].priority !== p.priority)) {
                  const _gc = _parr.filter(pp=>pp.priority===p.priority).length;
                  _rows.push(<div key={`phdr-${p.priority}`} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 16px",background:`${priClr}10`,borderBottom:`1px solid ${priClr}33`,borderTop:_pidx>0?`1px solid ${priClr}22`:"none"}}>
                    <span style={{color:priClr,fontWeight:800,fontSize:11}}>▲ {(p.priority||"—").toUpperCase()}</span>
                    <span style={{color:"var(--c-t4)",fontSize:10}}>{_gc} project{_gc!==1?"s":""}</span>
                  </div>);
                }
                _rows.push(
                  <div key={p.id} style={{borderBottom:"1px solid var(--c-border2)",padding:"9px 16px",background:myUnreadTagged.length>0?"#F9731610":"transparent"}}>
                    <div style={{display:"grid",gridTemplateColumns:"80px 1fr 78px 100px 150px 80px 92px 100px 60px",gap:8,alignItems:"center"}}>
                      {/* Job Code */}
                      {listInlineEdit?.id===p.id&&listInlineEdit?.field==="jobCode" ? (
                        <input autoFocus value={listInlineEdit.value}
                          onChange={e=>setListInlineEdit(s=>({...s,value:e.target.value}))}
                          onKeyDown={e=>{if(e.key==="Enter"){updateFieldChange(p.id,"jobCode",listInlineEdit.value.trim());setListInlineEdit(null);}if(e.key==="Escape")setListInlineEdit(null);}}
                          onBlur={()=>{updateFieldChange(p.id,"jobCode",listInlineEdit.value.trim());setListInlineEdit(null);}}
                          style={{...IS,width:"100%",fontSize:11,padding:"2px 6px",fontFamily:"monospace",fontWeight:900,color:"#F97316"}}/>
                      ) : (
                        <span onClick={()=>setListInlineEdit({id:p.id,field:"jobCode",value:p.jobCode||""})}
                          style={{fontSize:11,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731644",borderRadius:4,padding:"2px 6px",textAlign:"center",cursor:"text",display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                          title="Click to edit job code">{p.jobCode||"—"}</span>
                      )}
                      {/* Project name */}
                      <div style={{minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:6}}>
                          {listInlineEdit?.id===p.id&&listInlineEdit?.field==="name" ? (
                            <input autoFocus value={listInlineEdit.value}
                              onChange={e=>setListInlineEdit(s=>({...s,value:e.target.value}))}
                              onKeyDown={e=>{if(e.key==="Enter"){updateFieldChange(p.id,"name",listInlineEdit.value.trim());setListInlineEdit(null);}if(e.key==="Escape")setListInlineEdit(null);}}
                              onBlur={()=>{updateFieldChange(p.id,"name",listInlineEdit.value.trim());setListInlineEdit(null);}}
                              style={{...IS,flex:1,fontSize:12,padding:"2px 6px",fontWeight:600}}/>
                          ) : (
                            <span onDoubleClick={()=>setListInlineEdit({id:p.id,field:"name",value:p.name||""})}
                              onClick={()=>openDetail(p)}
                              style={{fontSize:12,color:"var(--c-t1)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:"pointer",textDecoration:"underline",textDecorationColor:"#334155",textUnderlineOffset:2}}
                              title="Click to open · Double-click to rename">{p.name}</span>
                          )}
                          {p.name && !listInlineEdit && (
                            <button onClick={e=>{e.stopPropagation();navigator.clipboard.writeText(p.name);setCopiedAddrId(p.id);setTimeout(()=>setCopiedAddrId(i=>i===p.id?null:i),1800);}}
                              title="Copy address"
                              style={{background:"none",border:"none",cursor:"pointer",fontSize:10,fontWeight:700,color:copiedAddrId===p.id?"#10B981":"#475569",padding:"0 2px",flexShrink:0,transition:"color 0.2s"}}>
                              {copiedAddrId===p.id?"✓":"⎘"}
                            </button>
                          )}
                          {p.siteMeasureRequired==="Yes" && <span title="Site measure required" style={{fontSize:12,flexShrink:0,color:"#10B981",background:"#10B98120",border:"1px solid #10B98144",borderRadius:3,padding:"1px 4px"}}>📐</span>}
                          {p.siteMeasureRequired==="TBC" && <span title="Site measure in question — TBC" style={{fontSize:12,flexShrink:0,color:"#EF4444",background:"#EF444420",border:"1px solid #EF444444",borderRadius:3,padding:"1px 4px"}}>📐?</span>}
                        </div>
                        <div style={{fontSize:10,color:"var(--c-t5)"}}>{p.type}</div>
                      </div>
                      {/* Incoming date */}
                      <div title={p.incomingDate ? `Received ${fmtDate(p.incomingDate)}` : "No incoming date recorded"}
                        style={{fontSize:11,color:p.incomingDate?"var(--c-t3)":"var(--c-t5)",fontWeight:p.incomingDate?600:400,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                        {p.incomingDate ? fmtDate(p.incomingDate) : "—"}
                      </div>
                      {/* Client */}
                      {listInlineEdit?.id===p.id&&listInlineEdit?.field==="client" ? (
                        <select autoFocus value={listInlineEdit.value}
                          onChange={e=>{updateFieldChange(p.id,"client",e.target.value);setListInlineEdit(null);}}
                          onBlur={()=>setListInlineEdit(null)}
                          style={{...IS,width:"100%",fontSize:11,padding:"2px 4px"}}>
                          <option value="">— None —</option>
                          {fabricators.map(c=><option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <div onClick={()=>setListInlineEdit({id:p.id,field:"client",value:p.client||""})}
                          style={{fontSize:11,color:p.client?"var(--c-t4)":"var(--c-t5)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:"pointer"}}
                          title={p.client||"Click to set client"}>{p.client||"+ Client"}</div>
                      )}
                      {/* Status picker */}
                      <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
                        <span onClick={()=>setListPicker(lp=>lp?.id===p.id&&lp?.field==="status"?null:{id:p.id,field:"status"})} title={p.status} style={{fontSize:10,fontWeight:700,color:cfg.color,background:`${cfg.color}1A`,border:`1px solid ${cfg.color}44`,borderRadius:4,padding:"2px 7px",whiteSpace:"nowrap",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:3,maxWidth:"100%",overflow:"hidden"}}><span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{p.status}</span><span style={{fontSize:7,opacity:0.6,flexShrink:0}}>{listPicker?.id===p.id&&listPicker?.field==="status"?"▲":"▼"}</span></span>
                        {listPicker?.id===p.id&&listPicker?.field==="status"&&(
                          <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:300,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:4,minWidth:130,boxShadow:"0 4px 20px #000a"}}>
                            {SELECTABLE_PROJECT_STATUS.map(s=>{const sc=PROJECT_STATUS[s]||{color:"#6B7280"};return(
                              <button key={s} onMouseDown={e=>{e.preventDefault();updateProjectStatus(p.id,s);setListPicker(null);}} style={{display:"block",width:"100%",textAlign:"left",padding:"6px 10px",borderRadius:5,border:"none",background:s===p.status?`${sc.color}20`:"transparent",color:s===p.status?sc.color:"var(--c-t2)",fontWeight:s===p.status?700:400,fontSize:11,cursor:"pointer"}}>{s}</button>
                            );})}
                          </div>
                        )}
                      </div>
                      {/* Priority picker */}
                      <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
                        <span onClick={()=>setListPicker(lp=>lp?.id===p.id&&lp?.field==="priority"?null:{id:p.id,field:"priority"})} style={{fontSize:10,fontWeight:700,color:priClr,whiteSpace:"nowrap",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:3,maxWidth:"100%"}}>▲ {p.priority}<span style={{fontSize:7,opacity:0.6,flexShrink:0}}>{listPicker?.id===p.id&&listPicker?.field==="priority"?"▲":"▼"}</span></span>
                        {listPicker?.id===p.id&&listPicker?.field==="priority"&&(
                          <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:300,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:4,minWidth:110,boxShadow:"0 4px 20px #000a"}}>
                            {PRIORITY.map(pri=>{const pc=PRIORITY_CLR[pri];return(
                              <button key={pri} onMouseDown={e=>{e.preventDefault();updateFieldChange(p.id,"priority",pri);setListPicker(null);}} style={{display:"block",width:"100%",textAlign:"left",padding:"6px 10px",borderRadius:5,border:"none",background:pri===p.priority?`${pc}20`:"transparent",color:pri===p.priority?pc:"#CBD5E1",fontWeight:pri===p.priority?700:400,fontSize:11,cursor:"pointer"}}>▲ {pri}</button>
                            );})}
                          </div>
                        )}
                      </div>
                      <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
                        <span onClick={()=>setListPicker(lp=>lp?.id===p.id&&lp?.field==="due"?null:{id:p.id,field:"due"})} style={{fontSize:10,fontWeight:600,color:dl!==null&&dl<0?"#EF4444":dl!==null&&dl<=7?"#F59E0B":p.due?"#64748B":"#334155",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:2,maxWidth:"100%",whiteSpace:"nowrap"}}>
                          {p.due?fmtDate(p.due):"+ Due"}<span style={{fontSize:7,opacity:0.6,flexShrink:0}}>{listPicker?.id===p.id&&listPicker?.field==="due"?"▲":"▼"}</span>
                        </span>
                        {listPicker?.id===p.id&&listPicker?.field==="due"&&(
                          <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:300,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:10,boxShadow:"0 4px 20px #000a",minWidth:160}}>
                            <input type="date" value={p.due||""} autoFocus
                              onChange={e=>{updateFieldChange(p.id,"due",e.target.value);setListPicker(null);}}
                              style={{...IS,fontSize:12,width:"100%",marginBottom:6}}/>
                            {p.due&&<button onMouseDown={()=>{updateFieldChange(p.id,"due","");setListPicker(null);}} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:11,width:"100%",textAlign:"left",padding:"2px 0"}}>✕ Clear date</button>}
                          </div>
                        )}
                      </div>
                      {/* Team assignment picker */}
                      <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
                        <div onClick={()=>setListPicker(lp=>lp?.id===p.id&&lp?.field==="assign"?null:{id:p.id,field:"assign"})} style={{display:"flex",cursor:"pointer",alignItems:"center",gap:2}}>
                          {p.assigned.length===0
                            ? <span style={{color:"var(--c-t5)",fontSize:10,fontWeight:600}}>+ Assign</span>
                            : p.assigned.map(m=><Avatar key={m} name={m} size={20}/>)}
                          <span style={{fontSize:7,color:"var(--c-t5)",opacity:0.6}}>{listPicker?.id===p.id&&listPicker?.field==="assign"?"▲":"▼"}</span>
                        </div>
                        {listPicker?.id===p.id&&listPicker?.field==="assign"&&(
                          <div style={{position:"absolute",top:"calc(100% + 4px)",right:0,zIndex:300,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:4,minWidth:140,boxShadow:"0 4px 20px #000a"}}>
                            {TEAM.map(m=>{const isOn=p.assigned.includes(m);const mc=MEMBER_COLOR[m]||"#64748B";return(
                              <button key={m} onMouseDown={e=>{e.preventDefault();updateFieldChange(p.id,"assigned",isOn?p.assigned.filter(x=>x!==m):[...p.assigned,m]);}}
                                style={{display:"flex",alignItems:"center",gap:8,width:"100%",textAlign:"left",padding:"6px 10px",borderRadius:5,border:"none",background:isOn?`${mc}22`:"transparent",color:isOn?mc:"#CBD5E1",fontSize:12,fontWeight:isOn?800:500,cursor:"pointer",marginBottom:1}}>
                                <div style={{width:16,height:16,borderRadius:"50%",background:isOn?mc:"transparent",border:`2px solid ${isOn?mc:"#475569"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:900,color:"#0F172A",flexShrink:0}}>{isOn?"✓":""}</div>
                                {m}
                              </button>
                            );})}
                          </div>
                        )}
                      </div>
                      <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                        <button onClick={()=>askConfirm("Mark Completed?",`Move "${p.jobCode||p.name}" to completed?`,()=>completeProject(p.id))} title="Mark complete" style={{background:"none",border:"none",color:"#10B981",cursor:"pointer",fontSize:13,padding:2}}>✓</button>
                        <button onClick={()=>{setEditing(p);setModal("editProject");}} title="Edit" style={{background:"none",border:"none",color:"#F97316",cursor:"pointer",fontSize:12,padding:2}}>✎</button>
                        <button onClick={()=>copyProject(p)} title="Copy project" style={{background:"none",border:"none",color:"#3B82F6",cursor:"pointer",fontSize:12,padding:2}}>⎘</button>
                        <button onClick={()=>askConfirm("Move to Trash?",`Move "${p.jobCode||p.name}" to trash? You can restore it from the Trash tab.`,()=>delProject(p.id))} title="Delete" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13,padding:2}}>🗑</button>
                      </div>
                    </div>
                    <div style={{marginTop:8,paddingLeft:85,display:"flex",gap:10,alignItems:"flex-start"}}>
                      {cl.length>0 && (
                        <div style={{width:260,flexShrink:0}}>
                          <ChecklistMini checklist={cl} type={p.type} onClick={()=>{setDetail(null);goToChecklist(p.id);}}/>
                        </div>
                      )}
                      <div style={{flex:1,minWidth:0}} onClick={e=>e.stopPropagation()}>
                        <div style={{fontSize:9,fontWeight:800,color:myUnreadTagged.length>0?"#F97316":"#475569",textTransform:"uppercase",marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
                          Notes{pn.length>0?` (${pn.length})`:""}
                          {myUnreadTagged.length>0&&<span style={{background:"#F97316",color:"#0F172A",fontSize:8,fontWeight:800,borderRadius:8,padding:"1px 6px"}}>🔔 tagged</span>}
                        </div>
                        <ProjectNotesPanel notes={pn} currentUser={currentUser}
                          onAdd={(text,tagged)=>addProjectNote(p.id,text,tagged)}
                          onRemove={id=>removeProjectNote(p.id,id)}
                          onMarkRead={id=>markProjectNoteRead(p.id,id,currentUser)}
                          onEdit={(id,text)=>editProjectNote(p.id,id,text)}
                          onSelfTag={id=>selfTagProjectNote(p.id,id,currentUser)}
                          onToggleDone={id=>toggleNoteDone(p.id,id,"note")}/>
                      </div>
                    </div>
                  </div>
                ); // end _rows.push
                return _rows;
              })}
              </div>
        )}

        {tab==="projects"&&filterStatuses.size===0&&(search||filterClient!=="All"||filterMember!=="All")&&filteredCompleted.length>0&&(
          <div style={{marginTop:18,background:"var(--c-panel)",border:"1px solid #10B98133",borderRadius:10,overflow:"hidden"}}>
            <div style={{padding:"10px 16px",borderBottom:"1px solid var(--c-border)",display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:13,fontWeight:800,color:"#10B981"}}>✓ Completed</span>
              <span style={{fontSize:11,color:"var(--c-t4)"}}>{filteredCompleted.length} matching project{filteredCompleted.length!==1?"s":""}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"90px 1fr 80px 90px 90px 100px",gap:10,padding:"8px 16px",borderBottom:"1px solid var(--c-border2)"}}>
              {["Job Code","Address","Client","Due","Completed",""].map(h=><div key={h} style={{color:"var(--c-t5)",fontSize:11,fontWeight:700,textTransform:"uppercase"}}>{h}</div>)}
            </div>
            {filteredCompleted.map(p=>{
              const onTime = p.completedDate && p.due && p.completedDate <= p.due;
              return (
                <div key={p.id} style={{display:"grid",gridTemplateColumns:"90px 1fr 80px 90px 90px 100px",gap:10,alignItems:"center",padding:"9px 16px",borderBottom:"1px solid var(--c-border2)"}}>
                  <span style={{fontSize:11,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731644",borderRadius:4,padding:"2px 6px",textAlign:"center"}}>{p.jobCode||"—"}</span>
                  <div onClick={()=>openDetail(p)} style={{fontSize:12,color:"var(--c-t1)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:"pointer",textDecoration:"underline",textDecorationColor:"#334155",textUnderlineOffset:2}}>{p.name}</div>
                  <div style={{fontSize:11,color:"var(--c-t4)"}}>{p.client}</div>
                  <div style={{fontSize:11,color:"var(--c-t4)"}}>{fmtDate(p.due)}</div>
                  <div style={{fontSize:11,color:onTime?"#10B981":"#EF4444",fontWeight:600}}>{fmtDate(p.completedDate)}</div>
                  <button onClick={()=>{ goToTab("completed"); }} style={{background:"#10B98120",border:"1px solid #10B98144",color:"#10B981",borderRadius:4,padding:"3px 8px",cursor:"pointer",fontSize:11,fontWeight:700}}>View →</button>
                </div>
              );
            })}
          </div>
        )}

        {tab==="completed"&&(
          <div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderTop:"none",borderRadius:"0 0 10px 10px",overflow:"hidden"}}>
            {(() => {
              let lastMonth = null;
              return filteredCompleted.map(p=>{
                const monthKey = p.completedDate ? p.completedDate.slice(0,7) : null;
                const showHeader = monthKey && monthKey !== lastMonth;
                if (showHeader) lastMonth = monthKey;
                const [my, mm] = monthKey ? monthKey.split("-") : [];
                const monthLabel = monthKey ? new Date(+my, +mm-1, 1).toLocaleString("default",{month:"long",year:"numeric"}) : null;
                const cl = p.checklist||[];
                const clDone = cl.filter(c=>c.done).length;
                const clPctVal = cl.length===0 ? 0 : Math.round((clDone/cl.length)*100);
                const clColor = clPctVal===100?"#10B981":clPctVal>=60?"#3B82F6":"#F59E0B";
                const onTime = p.completedDate && p.due && p.completedDate <= p.due;
                return (
                  <Fragment key={p.id}>
                    {showHeader && monthLabel && (
                      <div style={{gridColumn:"1/-1",padding:"8px 16px 4px",background:"var(--c-page)",borderBottom:"1px solid var(--c-border)",display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:11,fontWeight:800,color:"#10B981",textTransform:"uppercase",letterSpacing:1}}>{monthLabel}</span>
                        <span style={{fontSize:10,color:"var(--c-t5)"}}>{filteredCompleted.filter(x=>x.completedDate?.slice(0,7)===monthKey).length} job{filteredCompleted.filter(x=>x.completedDate?.slice(0,7)===monthKey).length!==1?"s":""}</span>
                      </div>
                    )}
                    <div style={{display:"grid",gridTemplateColumns:isAdmin(currentUser)?"90px 1fr 80px 90px 90px 110px 72px 72px 90px 100px":"90px 1fr 80px 90px 90px 110px 100px",gap:10,alignItems:"center",padding:"10px 16px",borderBottom:"1px solid var(--c-border2)"}}>
                      <span style={{fontSize:11,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731644",borderRadius:4,padding:"2px 6px",textAlign:"center"}}>{p.jobCode||"—"}</span>
                      <div onClick={()=>openDetail(p)} style={{fontSize:12,color:"var(--c-t1)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:"pointer",textDecoration:"underline",textDecorationColor:"#334155",textUnderlineOffset:2}}>{p.name}</div>
                      <div style={{fontSize:11,color:"var(--c-t4)"}}>{p.client}</div>
                      <div style={{fontSize:11,color:"var(--c-t4)"}}>{fmtDate(p.due)}</div>
                      <div style={{fontSize:11,color:onTime?"#10B981":"#EF4444",fontWeight:600}}>{fmtDate(p.completedDate)}</div>
                      <button onClick={e=>{e.stopPropagation();goToChecklist(p.id);}} style={{background:`${clColor}15`,border:`1px solid ${clColor}44`,borderRadius:5,padding:"4px 8px",cursor:"pointer"}}>
                        <span style={{fontSize:10,fontWeight:800,color:clColor}}>{clPctVal}%</span>
                      </button>
                      {isAdmin(currentUser)&&(()=>{
                        const InvToggle = ({field,label,color}) => {
                          const active = !!p[field];
                          return (
                            <div onClick={e=>{e.stopPropagation();updateFieldChange(p.id,field,!active);}} title={`${label}: ${active?"Yes — click to unmark":"No — click to mark"}`}
                              style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",userSelect:"none"}}>
                              <div style={{width:16,height:16,borderRadius:4,border:`2px solid ${active?color:"#475569"}`,background:active?color:"transparent",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.15s"}}>
                                {active&&<span style={{color:"#fff",fontSize:10,lineHeight:1,fontWeight:900}}>✓</span>}
                              </div>
                              <span style={{fontSize:10,fontWeight:700,color:active?color:"var(--c-t5)"}}>{active?"Yes":"No"}</span>
                            </div>
                          );
                        };
                        return <>
                          <InvToggle field="invoiceSent" label="Invoice Sent" color="#3B82F6"/>
                          <InvToggle field="invoicePaid" label="Invoice Paid" color="#10B981"/>
                          <div onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center"}}>
                            <input
                              type="text"
                              defaultValue={p.invoiceAmount||""}
                              onBlur={e=>{const v=e.target.value.trim();if(v!==(p.invoiceAmount||""))updateFieldChange(p.id,"invoiceAmount",v);}}
                              onKeyDown={e=>{if(e.key==="Enter")e.target.blur();}}
                              placeholder="$0"
                              style={{width:"100%",background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:4,padding:"3px 6px",fontSize:11,color:"var(--c-t1)",fontWeight:600,outline:"none",boxSizing:"border-box"}}/>
                          </div>
                        </>;
                      })()}
                      <div style={{display:"flex",gap:3,justifyContent:"flex-end"}}>
                        <button onClick={e=>{e.stopPropagation();askConfirm("Reopen?",`Reopen "${p.jobCode||p.name}"?`,()=>reopenProject(p.id));}} title="Reopen" style={{background:"#3B82F620",border:"1px solid #3B82F644",color:"#3B82F6",borderRadius:4,padding:"3px 7px",cursor:"pointer",fontSize:11,fontWeight:700}}>↺</button>
                        <button onClick={e=>{e.stopPropagation();setEditing(p);setModal("editProject");}} title="Edit" style={{background:"#F9731620",border:"1px solid #F9731644",color:"#F97316",borderRadius:4,padding:"3px 7px",cursor:"pointer",fontSize:11,fontWeight:700}}>✎</button>
                        <button onClick={e=>{e.stopPropagation();askConfirm("Remove?",`Remove "${p.jobCode||p.name}"?`,()=>delProject(p.id));}} title="Delete" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13}}>🗑</button>
                      </div>
                    </div>
                  </Fragment>
                );
              });
            })()}
          </div>
        )}
        {tab==="completed"&&filteredCompleted.length>0&&(()=>{
          const curMonthKey = new Date().toISOString().slice(0,7);
          // Clamp analyticsMonth to months that actually exist in filteredCompleted
          const allMonthKeys = [...new Set(filteredCompleted.filter(p=>p.completedDate).map(p=>p.completedDate.slice(0,7)))].sort().reverse();
          const activeMonth = allMonthKeys.includes(analyticsMonth) ? analyticsMonth : (allMonthKeys[0]||curMonthKey);

          // Monthly stats — all months for the bar chart
          const byMonth={};
          filteredCompleted.forEach(p=>{ const mk=p.completedDate?.slice(0,7); if(mk) byMonth[mk]=(byMonth[mk]||0)+1; });
          const chartMonths=[...Object.keys(byMonth)].sort();

          // Per-month breakdown for selected month
          const monthProjects = filteredCompleted.filter(p=>p.completedDate?.slice(0,7)===activeMonth);
          const byFab={};
          let onTime=0, delayed=0;
          monthProjects.forEach(p=>{
            byFab[p.client||"Unknown"]=(byFab[p.client||"Unknown"]||0)+1;
            if(p.completedDate&&p.due){ if(p.completedDate<=p.due) onTime++; else delayed++; }
          });
          const fabs=Object.entries(byFab).sort((a,b)=>b[1]-a[1]);
          const maxM=Math.max(...Object.values(byMonth),1);
          const maxF=Math.max(...Object.values(byFab),1);
          const mTotal=monthProjects.length;
          const tracked=onTime+delayed;
          const onTimePct=tracked>0?Math.round((onTime/tracked)*100):null;
          const FAB_COLORS=["#F97316","#3B82F6","#EC4899","#8B5CF6","#10B981","#06B6D4","#F59E0B","#EF4444","#14B8A6","#A855F7"];
          const R=46,CX=60,CY=60,SW=14,circ=2*Math.PI*R;
          const onArc=tracked>0?(onTime/tracked)*circ:0;
          const dlArc=tracked>0?(delayed/tracked)*circ:0;

          const fmtMonthKey = mk => { const [y,m]=mk.split("-"); return new Date(+y,+m-1,1).toLocaleString("default",{month:"long",year:"numeric"}); };
          const isCurrentMonth = activeMonth===curMonthKey;
          const monthLabel = fmtMonthKey(activeMonth);

          return (
            <div style={{marginTop:20,marginBottom:32,background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:12,overflow:"hidden"}}>
              {/* Header */}
              <div style={{padding:"12px 20px",borderBottom:"1px solid var(--c-border)",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontSize:13,fontWeight:800,color:"var(--c-t1)"}}>Performance Overview</span>
                <div style={{display:"flex",alignItems:"center",gap:6,background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:6,padding:"3px 8px 3px 10px"}}>
                  <span style={{fontSize:12,fontWeight:700,color:"#10B981"}}>
                    {isCurrentMonth?"This month — ":""}{monthLabel}
                  </span>
                  {allMonthKeys.length>1&&(
                    <select value={activeMonth} onChange={e=>setAnalyticsMonth(e.target.value)}
                      style={{border:"none",background:"transparent",color:"var(--c-t4)",fontSize:11,cursor:"pointer",outline:"none",padding:"0 2px"}}>
                      {allMonthKeys.map(mk=>(
                        <option key={mk} value={mk}>{mk===curMonthKey?"▶ Current — ":""}{fmtMonthKey(mk)}</option>
                      ))}
                    </select>
                  )}
                </div>
                <span style={{fontSize:11,color:"var(--c-t4)",background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:4,padding:"1px 8px"}}>{mTotal} job{mTotal!==1?"s":""} this month</span>
                <span style={{fontSize:11,color:"var(--c-t5)"}}>{filteredCompleted.length} total</span>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 220px",minHeight:200}}>

                {/* ── Jobs by Month (trend) ── */}
                <div style={{padding:"16px 20px",borderRight:"1px solid var(--c-border)"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",letterSpacing:1,marginBottom:12}}>Monthly Trend</div>
                  <div style={{display:"flex",alignItems:"flex-end",gap:6,height:120,paddingBottom:2}}>
                    {chartMonths.map(mk=>{
                      const [my,mm]=mk.split("-");
                      const lbl=new Date(+my,+mm-1,1).toLocaleString("default",{month:"short"});
                      const count=byMonth[mk];
                      const pct=Math.round((count/maxM)*100);
                      const isActive=mk===activeMonth;
                      return (
                        <div key={mk} onClick={()=>setAnalyticsMonth(mk)}
                          style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3,minWidth:0,cursor:"pointer",opacity:isActive?1:0.5,transition:"opacity 0.15s"}}>
                          <span style={{fontSize:10,fontWeight:700,color:isActive?"#10B981":"var(--c-t4)"}}>{count}</span>
                          <div style={{width:"100%",background:isActive?"#10B98120":"var(--c-border2)",borderRadius:"4px 4px 0 0",height:`${Math.max(pct,4)}%`,minHeight:4,position:"relative",overflow:"hidden",outline:isActive?"2px solid #10B981":"none",outlineOffset:1}}>
                            <div style={{position:"absolute",bottom:0,left:0,right:0,height:"100%",background:isActive?"#10B981":"#64748B",borderRadius:"4px 4px 0 0"}}/>
                          </div>
                          <span style={{fontSize:9,color:isActive?"#10B981":"var(--c-t5)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:"100%",textAlign:"center",fontWeight:isActive?700:400}}>{lbl}</span>
                          <span style={{fontSize:9,color:"var(--c-t5)",whiteSpace:"nowrap"}}>{my}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{fontSize:10,color:"var(--c-t5)",marginTop:6,textAlign:"center"}}>Click a bar to drill into that month</div>
                </div>

                {/* ── Jobs by Fabricator (selected month) ── */}
                <div style={{padding:"16px 20px",borderRight:"1px solid var(--c-border)"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",letterSpacing:1,marginBottom:12}}>By Fabricator</div>
                  {fabs.length>0?(
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {fabs.map(([fab,count],i)=>{
                        const pct=Math.round((count/maxF)*100);
                        const clr=FAB_COLORS[i%FAB_COLORS.length];
                        return (
                          <div key={fab}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                              <span style={{fontSize:11,fontWeight:600,color:"var(--c-t2)"}}>{fab}</span>
                              <span style={{fontSize:11,fontWeight:700,color:clr}}>{count} job{count!==1?"s":""}</span>
                            </div>
                            <div style={{height:7,background:"var(--c-page)",borderRadius:4,overflow:"hidden"}}>
                              <div style={{height:"100%",width:`${pct}%`,background:clr,borderRadius:4,transition:"width 0.3s"}}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ):<span style={{fontSize:12,color:"var(--c-t5)"}}>No jobs this month</span>}
                </div>

                {/* ── On Time vs Delayed (selected month) ── */}
                <div style={{padding:"16px 20px",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:"var(--c-t4)",textTransform:"uppercase",letterSpacing:1,alignSelf:"flex-start"}}>On Time</div>
                  {tracked>0?(
                    <>
                      <svg width={120} height={120} viewBox="0 0 120 120">
                        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--c-border2)" strokeWidth={SW}/>
                        {delayed>0&&<circle cx={CX} cy={CY} r={R} fill="none" stroke="#EF4444" strokeWidth={SW}
                          strokeDasharray={`${dlArc} ${circ}`} strokeDashoffset={-(onArc)} strokeLinecap="round"
                          style={{transform:"rotate(-90deg)",transformOrigin:`${CX}px ${CY}px`}}/>}
                        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#10B981" strokeWidth={SW}
                          strokeDasharray={`${onArc} ${circ}`} strokeDashoffset={0} strokeLinecap="round"
                          style={{transform:"rotate(-90deg)",transformOrigin:`${CX}px ${CY}px`}}/>
                        <text x={CX} y={CY-6} textAnchor="middle" fontSize={18} fontWeight={800} fill="#10B981">{onTimePct}%</text>
                        <text x={CX} y={CY+10} textAnchor="middle" fontSize={9} fill="var(--c-t4)">on time</text>
                      </svg>
                      <div style={{display:"flex",gap:14}}>
                        <div style={{display:"flex",alignItems:"center",gap:5}}>
                          <div style={{width:9,height:9,borderRadius:"50%",background:"#10B981"}}/>
                          <span style={{fontSize:11,color:"var(--c-t3)"}}>{onTime} on time</span>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:5}}>
                          <div style={{width:9,height:9,borderRadius:"50%",background:"#EF4444"}}/>
                          <span style={{fontSize:11,color:"var(--c-t3)"}}>{delayed} delayed</span>
                        </div>
                      </div>
                    </>
                  ):(
                    <span style={{fontSize:12,color:"var(--c-t5)"}}>{mTotal>0?"No due dates set":"No jobs this month"}</span>
                  )}
                </div>

              </div>
            </div>
          );
        })()}

        {tab==="completed"&&deletedProjects.length>0&&(
          <div style={{marginTop:16,background:"var(--c-panel)",border:"1px solid #EF444433",borderRadius:10,overflow:"hidden"}}>
            <div style={{padding:"12px 16px",borderBottom:"1px solid var(--c-border)",display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:13,fontWeight:800,color:"#EF4444"}}>🗑 Trash</span>
              <span style={{fontSize:11,color:"var(--c-t4)"}}>{deletedProjects.length} deleted project{deletedProjects.length!==1?"s":""} — restore to recover</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"90px 1fr 80px 150px 130px",gap:10,padding:"8px 16px",borderBottom:"1px solid var(--c-border2)"}}>
              {["Job Code","Address","Client","Deleted",""].map(h=><div key={h} style={{color:"var(--c-t5)",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>{h}</div>)}
            </div>
            {deletedProjects.map(p=>(
              <div key={p.id} style={{display:"grid",gridTemplateColumns:"90px 1fr 80px 150px 130px",gap:10,alignItems:"center",padding:"10px 16px",borderBottom:"1px solid var(--c-border2)",opacity:0.8}}>
                <span style={{fontSize:11,fontFamily:"monospace",fontWeight:900,color:"#EF4444",background:"#EF444420",border:"1px solid #EF444444",borderRadius:4,padding:"2px 6px",textAlign:"center"}}>{p.jobCode||"—"}</span>
                <div style={{fontSize:12,color:"var(--c-t3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                <div style={{fontSize:11,color:"var(--c-t4)"}}>{p.client}</div>
                <div style={{fontSize:11,color:"var(--c-t5)"}}>{fmtTs(p._deletedAt)}</div>
                <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                  <button onClick={()=>restoreProject(p.id)} style={{background:"#10B98120",border:"1px solid #10B98144",color:"#10B981",borderRadius:4,padding:"3px 8px",cursor:"pointer",fontSize:11,fontWeight:700}}>↩ Restore</button>
                  <button onClick={()=>askConfirm("Delete forever?",`Permanently erase "${p.jobCode||p.name}"? Cannot be undone.`,()=>permanentDeleteProject(p.id))} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:12,fontWeight:700}}>✕ Erase</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{display:tab==="checklist"?undefined:"none"}}><ErrorBoundary label="Checklist"><ChecklistTab key={checklistJumpId||"cl"} projects={projects} currentUser={currentUser} onUpdateChecklist={updateChecklist} onFieldChange={updateFieldChange} initialId={checklistJumpId} masterTemplate={masterTemplate} setMasterTemplate={setMasterTemplate} onSyncProject={syncProjectWithMaster} onReorderMaster={autoReorderProjects} projectsWithUpdates={projectsWithUpdates} deletedMasterItems={deletedMasterItems} setDeletedMasterItems={setDeletedMasterItems} onToggleNoteDone={toggleNoteDone} onSelfTagClNote={(projectId,noteId)=>selfTagChecklistNote(projectId,noteId,currentUser)} onUpdateClNoteTags={(projectId,noteId,tags)=>updateChecklistNoteTags(projectId,noteId,tags)}/></ErrorBoundary></div>

        <div style={{display:tab==="calendar"?undefined:"none"}}><ErrorBoundary label="Calendar"><CalendarTab projects={projects} tasks={tasks} feedback={feedback} calendarEvents={calendarEvents} currentUser={currentUser} onAddEvent={addCalendarEvent} onRemoveEvent={smartRemoveCalendarEvent} onUpdateEvent={smartUpdateCalendarEvent} onMoveEvent={moveCalendarEvent} onReorderDay={reorderCalendarDay} onToggleSubtask={toggleSubtaskInEvent} onCompleteProject={completeProject} onCompleteTask={completeTask} onToggleNoteDone={toggleNoteDone} draggingNoticeItem={draggingNoticeItem} onCopyEvent={copyCalendarEvent} draggingMyInboxItem={draggingMyInboxItem} onMarkMyInboxItemRead={(type,id,projectId)=>{ const m=calendarViewMember; if(type==="note") markProjectNoteScheduled(projectId,id,m); else if(type==="checklist") markChecklistNoteScheduled(projectId,id,m); else if(type==="feedback") markFeedbackRead(id,m); }} onSelMemberChange={m=>setCalendarViewMember(m)}/></ErrorBoundary></div>

        <div style={{display:tab==="feedback"?undefined:"none"}}><ErrorBoundary label="Feedback"><FeedbackTab projects={projects} feedback={feedback} currentUser={currentUser} onAdd={addFeedback} onUpdate={updateFeedback} onRemove={removeFeedback} onToggleStatus={toggleFeedbackStatus}/></ErrorBoundary></div>
        {CAN_MANAGE_WEBSITE&&<div style={{display:tab==="portfolio"?undefined:"none"}}><ErrorBoundary label="Portfolio"><PortfolioTab portfolio={portfolio} setPortfolio={setPortfolio} services={siteServices} setServices={setSiteServices} stats={siteStats} setStats={setSiteStats} testimonials={siteTestimonials} setTestimonials={setSiteTestimonials} currentUser={currentUser}/></ErrorBoundary></div>}
        {isAdmin(currentUser)&&<div style={{display:tab==="invoices"?undefined:"none"}}><ErrorBoundary label="Invoices"><InvoicesTab projects={projects} invoices={invoices} onAddInvoice={addInvoice} onUpdateInvoice={updateInvoice} onRemoveInvoice={removeInvoice}/></ErrorBoundary></div>}
        </div>
        </ErrorBoundary>
        {!isTablet && <MyInbox projects={projects} tasks={tasks} feedback={feedback} currentUser={currentUser} inboxUser={tab==="calendar" ? calendarViewMember : currentUser}
          calendarEvents={calendarEvents}
          onToggleCalendarTask={id => smartUpdateCalendarEvent(id, {done: !calendarEvents.find(e=>e.id===id)?.done}, calendarViewMember)}
          onCompleteTask={id => { const t=tasks.find(x=>x.id===id); if(t) saveTask({...t,status:"Done"}); }}
          onOpenProject={(proj,t)=>openDetail(proj,t)}
          onGoToChecklist={goToChecklist}
          onGoToFeedback={()=>goToTab("feedback")}
          onMarkUnscheduled={item => {
            const m = calendarViewMember;
            if (item.type==="note")      markProjectNoteRead(item.project.id, item.id, m);
            else if (item.type==="checklist") markChecklistNoteRead(item.project.id, item.id, m);
            else if (item.type==="feedback")  markFeedbackRead(item.id, m);
          }}
          onDragStart={item => { setDraggingNoticeItem(null); setDraggingMyInboxItem(item); }}
          onDragEnd={() => setDraggingMyInboxItem(null)}
        />}
      </div>

      {pendingDeleteEventId && (() => {
        const ev = calendarEvents.find(e => e.id === pendingDeleteEventId);
        const proj = projects.find(p => p.id === ev?.projectId);
        return (
          <ConfirmModal
            title="Delete scheduled item?"
            message={`This task was scheduled from an inbox item${proj ? ` on ${proj.jobCode || proj.name}` : ""}.\n\nDeleting it will remove it from the calendar but the note will remain at its original location. Are you sure?`}
            confirmLabel="Delete"
            onConfirm={() => { removeCalendarEvent(pendingDeleteEventId); setPendingDeleteEventId(null); }}
            onClose={() => setPendingDeleteEventId(null)}
          />
        );
      })()}
      {(modal==="addProject"||modal==="editProject")&&<Modal title={modal==="editProject"?(editing?.jobCode?`Edit ${editing.jobCode}`:"Edit Project"):copyData?"Copy Project":"New Project"} onClose={()=>{setModal(null);setEditing(null);setCopyData(null);}}><ProjectForm initial={editing||copyData} currentUser={currentUser} onSave={saveProject} onClose={()=>{setModal(null);setEditing(null);setCopyData(null);}} masterTemplate={masterTemplate} existingProjects={projects}/></Modal>}
      {(modal==="addTask"||modal==="editTask")&&<Modal title={modal==="editTask"?"Edit Task":"New Task"} onClose={()=>{setModal(null);setEditing(null);}}><TaskForm initial={editing} projects={projects} onSave={saveTask} onClose={()=>{setModal(null);setEditing(null);}}/></Modal>}

      {liveDetail&&(
        <Modal title={liveDetail.jobCode?`${liveDetail.jobCode} — ${liveDetail.name}`:liveDetail.name} onClose={()=>setDetail(null)} wide>
          {/* Project header */}
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,padding:"10px 14px",background:"#F9731610",border:"1px solid #F9731644",borderRadius:8}}>
            <span style={{fontSize:14,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731666",borderRadius:5,padding:"4px 12px"}}>{liveDetail.jobCode||"NO CODE"}</span>
            <div style={{flex:1}}>
              <div style={{fontSize:13,color:"var(--c-t1)",fontWeight:600}}>{liveDetail.name}</div>
              <div style={{fontSize:11,color:"var(--c-t4)"}}>{liveDetail.client} · {liveDetail.type}</div>
            </div>
          </div>
          {/* Tab bar */}
          <div style={{display:"flex",gap:2,marginBottom:14,borderBottom:"1px solid var(--c-border)"}}>
            {[
              {key:"details", label:"Details"},
              {key:"notes", label:`Notes${noteList(liveDetail.notes).length>0?` (${noteList(liveDetail.notes).length})`:""}`, highlight: noteList(liveDetail.notes).some(n=>n.tagged.includes(currentUser)&&!n.readBy.includes(currentUser))},
              {key:"checklist", label:"Checklist"},
            ].map(({key,label,highlight})=>(
              <button key={key} onClick={()=>setDetailTab(key)} style={{background:"none",border:"none",borderBottom:`2px solid ${detailTab===key?"#F97316":"transparent"}`,color:detailTab===key?"#F97316":highlight?"#F59E0B":"#64748B",cursor:"pointer",fontSize:12,fontWeight:detailTab===key?800:500,padding:"6px 12px",marginBottom:-1}}>
                {label}{highlight&&detailTab!==key&&<span style={{marginLeft:4,width:6,height:6,background:"#F97316",borderRadius:"50%",display:"inline-block",verticalAlign:"middle"}}/>}
              </button>
            ))}
          </div>
          {/* Tab content */}
          {detailTab==="details"&&(
            <>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                {[["Due",fmtDate(liveDetail.due)],["Status",liveDetail.status]].map(([k,v])=>(
                  <div key={k}><div style={{color:"var(--c-t5)",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>{k}</div><div style={{color:"var(--c-t2)",fontSize:13}}>{v}</div></div>
                ))}
              </div>
              <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}><Badge label={liveDetail.status}/><PriBadge label={liveDetail.priority}/>{liveDetail.assigned.map(m=><Avatar key={m} name={m}/>)}</div>
            </>
          )}
          {detailTab==="notes"&&(
            <ProjectNotesPanel notes={noteList(liveDetail.notes)} currentUser={currentUser}
              onAdd={(text,tagged)=>addProjectNote(liveDetail.id,text,tagged)}
              onRemove={id=>removeProjectNote(liveDetail.id,id)}
              onMarkRead={id=>markProjectNoteRead(liveDetail.id,id,currentUser)}
              onEdit={(id,text)=>editProjectNote(liveDetail.id,id,text)}
              onSelfTag={id=>selfTagProjectNote(liveDetail.id,id,currentUser)}
              onToggleDone={id=>toggleNoteDone(liveDetail.id,id,"note")}/>
          )}
          {detailTab==="checklist"&&(
            <button onClick={()=>{setDetail(null);goToChecklist(liveDetail.id);}} style={{width:"100%",background:"#F9731620",border:"1px solid #F97316",color:"#F97316",borderRadius:6,padding:"8px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>Open Checklist →</button>
          )}
          <div style={{marginTop:20,paddingTop:16,borderTop:"1px solid var(--c-border)",display:"flex",gap:8,flexWrap:"wrap"}}>
            {liveDetail.status==="Completed" ? (
              <button onClick={()=>askConfirm("Reopen?",`Reopen "${liveDetail.jobCode||liveDetail.name}"?`,()=>reopenProject(liveDetail.id))} style={{flex:1,background:"#3B82F620",border:"1px solid #3B82F6",color:"#3B82F6",borderRadius:6,padding:"9px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>↺ Reopen</button>
            ) : (
              <button onClick={()=>askConfirm("Mark Completed?",`Move "${liveDetail.jobCode||liveDetail.name}" to completed?`,()=>completeProject(liveDetail.id))} style={{flex:1,background:"#10B98120",border:"1px solid #10B981",color:"#10B981",borderRadius:6,padding:"9px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>✓ Mark Completed</button>
            )}
            <button onClick={()=>{setEditing(liveDetail);setDetail(null);setModal("editProject");}} style={{flex:1,background:"#F97316",border:"none",color:"#fff",borderRadius:6,padding:"9px 0",cursor:"pointer",fontWeight:800,fontSize:13}}>✎ Edit Project</button>
            <button onClick={()=>askConfirm("Move to Trash?",`Move "${liveDetail.jobCode||liveDetail.name}" to trash? You can restore it from the Trash tab.`,()=>delProject(liveDetail.id))} style={{flex:1,background:"#EF444420",border:"1px solid #EF4444",color:"#EF4444",borderRadius:6,padding:"9px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>🗑 Delete</button>
          </div>
        </Modal>
      )}

      {confirmState && <ConfirmModal title={confirmState.title} message={confirmState.message} onConfirm={confirmState.onConfirm} onClose={()=>setConfirmState(null)}/>}
    </div>
  );
}

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("ASD Hub crashed:", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    const { label } = this.props;
    // Tab-level boundary: show inline recovery without reloading the whole page
    if (label) {
      return (
        <div style={{padding:"48px 24px",textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>⚠️</div>
          <div style={{fontWeight:800,fontSize:16,color:"var(--c-t1)",marginBottom:6}}>{label} crashed</div>
          <div style={{fontSize:13,color:"var(--c-t3)",marginBottom:20,maxWidth:340,margin:"0 auto 20px"}}>
            {this.state.error?.message || "An unexpected error occurred."}
          </div>
          <div style={{display:"flex",gap:10,justifyContent:"center"}}>
            <button onClick={()=>this.setState({error:null})} style={{background:"#F97316",color:"#fff",border:"none",borderRadius:6,padding:"9px 20px",fontWeight:700,cursor:"pointer",fontSize:13}}>
              Retry
            </button>
            <button onClick={()=>window.location.reload()} style={{background:"transparent",border:"1px solid var(--c-border)",color:"var(--c-t2)",borderRadius:6,padding:"9px 20px",fontWeight:600,cursor:"pointer",fontSize:13}}>
              Reload App
            </button>
          </div>
        </div>
      );
    }
    // Root-level boundary: full page takeover
    return (
      <div style={{minHeight:"100vh",background:"var(--c-page)",color:"var(--c-t1)",display:"flex",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"monospace"}}>
        <div style={{maxWidth:640,background:"var(--c-panel)",border:"1px solid #EF4444",borderRadius:10,padding:24}}>
          <div style={{fontSize:16,fontWeight:800,color:"#EF4444",marginBottom:10}}>⚠ ASD Hub hit an error</div>
          <div style={{fontSize:13,color:"var(--c-t2)",marginBottom:14,whiteSpace:"pre-wrap"}}>{String(this.state.error?.message || this.state.error)}</div>
          <div style={{fontSize:11,color:"var(--c-t4)",marginBottom:18,whiteSpace:"pre-wrap",maxHeight:200,overflowY:"auto"}}>{this.state.error?.stack}</div>
          <button onClick={()=>window.location.reload()} style={{width:"100%",background:"#334155",border:"none",color:"var(--c-t1)",borderRadius:6,padding:"10px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>Reload</button>
        </div>
      </div>
    );
  }
}

// ─── Team Tab (online status + attendance) ────────────────────────────────
function TeamTab({ presence, currentUser, teamNames, memberColor }) {
  const [selMember, setSelMember] = useState(teamNames[0]);
  const [selMonth, setSelMonth] = useState(() => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  });
  const sessions = (presence.sessions || []).filter(s => s.member === selMember && s.date.startsWith(selMonth));
  const byDate = {};
  sessions.forEach(s => { (byDate[s.date] = byDate[s.date]||[]).push(s); });
  const sortedDates = Object.keys(byDate).sort().reverse();
  const workingDays = sortedDates.length;
  const fmtTime = iso => { if (!iso) return "—"; const d = new Date(iso); return d.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",hour12:true}); };
  const fmtDateShort = ymd => { const [y,m,d] = ymd.split("-"); return new Date(y,m-1,d).toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"}); };
  const calcDuration = ss => {
    let total = 0;
    ss.forEach(s => { if (s.loginAt && s.logoutAt) total += new Date(s.logoutAt)-new Date(s.loginAt); });
    if (!total) return "—";
    const h = Math.floor(total/3600000), mn = Math.floor((total%3600000)/60000);
    return `${h}h ${mn}m`;
  };
  const months = [];
  for (let i = 0; i < 12; i++) { const d = new Date(); d.setMonth(d.getMonth()-i); months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`); }

  return (
    <div style={{padding:"24px 20px",maxWidth:780,margin:"0 auto"}}>
      {/* Online status cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,marginBottom:28}}>
        {teamNames.map(m => {
          const isOnline = isOnlineFresh(presence?.online?.[m]);
          const isMe = m === currentUser;
          const color = memberColor[m] || "#64748B";
          return (
            <div key={m} style={{background:"var(--c-panel)",border:`1.5px solid ${isMe?"#F97316":isOnline?"#22C55E44":"var(--c-border)"}`,borderRadius:12,padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
              <div style={{width:38,height:38,borderRadius:"50%",background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:900,color:"#fff",opacity:isOnline?1:0.5,flexShrink:0}}>
                {m.slice(0,2)}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--c-t1)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m}{isMe&&<span style={{fontSize:10,color:"#F97316",marginLeft:4}}>(you)</span>}</div>
                <div style={{display:"flex",alignItems:"center",gap:5,marginTop:2}}>
                  <div style={{width:7,height:7,borderRadius:"50%",background:isOnline?"#22C55E":"#64748B",boxShadow:isOnline?"0 0 5px #22C55E":"none"}}/>
                  <span style={{fontSize:11,color:isOnline?"#22C55E":"var(--c-t4)",fontWeight:600}}>{isOnline?"Online":"Offline"}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Attendance section */}
      <div style={{fontSize:13,fontWeight:800,color:"var(--c-t1)",marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>📊 Attendance</div>
      <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        {teamNames.map(m => (
          <button key={m} onClick={()=>setSelMember(m)} style={{padding:"5px 16px",borderRadius:20,border:"none",background:selMember===m?"#F97316":"var(--c-deep)",color:selMember===m?"#fff":"var(--c-t3)",fontWeight:700,fontSize:12,cursor:"pointer"}}>{m}</button>
        ))}
        <select value={selMonth} onChange={e=>setSelMonth(e.target.value)} style={{marginLeft:"auto",padding:"5px 10px",borderRadius:8,border:"1px solid var(--c-border)",background:"var(--c-deep)",color:"var(--c-t1)",fontSize:12}}>
          {months.map(m => { const [y,mo]=m.split("-"); return <option key={m} value={m}>{new Date(y,mo-1).toLocaleDateString("en-AU",{month:"long",year:"numeric"})}</option>; })}
        </select>
      </div>
      <div style={{background:"#F9731618",border:"1px solid #F9731633",borderRadius:10,padding:"10px 16px",marginBottom:14,display:"flex",gap:24,flexWrap:"wrap"}}>
        <div><div style={{fontSize:10,color:"var(--c-t4)",fontWeight:700,textTransform:"uppercase"}}>Working Days</div><div style={{fontSize:24,fontWeight:900,color:"#F97316"}}>{workingDays}</div></div>
        <div><div style={{fontSize:10,color:"var(--c-t4)",fontWeight:700,textTransform:"uppercase"}}>Sessions</div><div style={{fontSize:24,fontWeight:900,color:"var(--c-t1)"}}>{sessions.length}</div></div>
      </div>
      {sortedDates.length === 0
        ? <div style={{color:"var(--c-t4)",textAlign:"center",padding:"24px 0"}}>No sessions recorded for this period.</div>
        : sortedDates.map(date => (
          <div key={date} style={{marginBottom:10,background:"var(--c-deep)",borderRadius:10,overflow:"hidden"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px",borderBottom:"1px solid var(--c-border2)"}}>
              <span style={{fontWeight:700,fontSize:13,color:"var(--c-t1)"}}>{fmtDateShort(date)}</span>
              <span style={{marginLeft:"auto",fontSize:11,color:"var(--c-t4)"}}>Total: {calcDuration(byDate[date])}</span>
            </div>
            {byDate[date].map((s,i) => (
              <div key={s.id||i} style={{display:"flex",alignItems:"center",gap:16,padding:"7px 14px",borderBottom:i<byDate[date].length-1?"1px solid var(--c-border2)":"none"}}>
                <span style={{fontSize:12,color:"#10B981",fontWeight:600}}>▶ {fmtTime(s.loginAt)}</span>
                <span style={{fontSize:12,color:s.logoutAt?"#EF4444":"#F59E0B",fontWeight:600}}>{s.logoutAt?"⏹ "+fmtTime(s.logoutAt):"● Active"}</span>
                {s.loginAt && s.logoutAt && <span style={{marginLeft:"auto",fontSize:11,color:"var(--c-t4)"}}>{calcDuration([s])}</span>}
              </div>
            ))}
          </div>
        ))
      }
    </div>
  );
}

function DeviceNamePrompt({ onSave }) {
  const [name, setName] = useState("");
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    localStorage.setItem("asd_device_name", trimmed);
    onSave();
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:99999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#fff",borderRadius:12,padding:"28px 32px",width:340,boxShadow:"0 8px 32px rgba(0,0,0,0.3)"}}>
        <div style={{fontSize:18,fontWeight:800,color:"#0F172A",marginBottom:6}}>💻 Name this device</div>
        <div style={{fontSize:13,color:"#64748B",marginBottom:18}}>Give this device a name. Only asked once.</div>
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && save()}
          placeholder='e.g. RAJs Desktop or Office PC'
          style={{width:"100%",boxSizing:"border-box",border:"1.5px solid #CBD5E1",borderRadius:7,padding:"9px 12px",fontSize:14,color:"#0F172A",outline:"none",marginBottom:14}}
        />
        <button onClick={save} disabled={!name.trim()} style={{width:"100%",padding:"10px 0",background:name.trim()?"#F97316":"#CBD5E1",border:"none",borderRadius:7,color:"#fff",fontWeight:800,fontSize:14,cursor:name.trim()?"pointer":"not-allowed"}}>
          Save device name
        </button>
      </div>
    </div>
  );
}

function LandingPage({ onLoginSuccess }) {
  const vw = useWindowWidth();
  const isMobile = vw < 768;
  const isTablet = vw < 1024;
  const [showLogin, setShowLogin] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [form, setForm] = useState({ name:"", company:"", email:"", phone:"", description:"", projectType:"" });
  const [files, setFiles] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [livePortfolio, setLivePortfolio] = useState(DEFAULT_PORTFOLIO);
  const quoteRef = useRef(null);
  const fileInputRef = useRef(null);

  // Live portfolio from Firestore (falls back to DEFAULT_PORTFOLIO if not configured)
  useEffect(() => {
    if (!db) return;
    const unsub = onSnapshot(doc(db, "appState", "asd_portfolio"), snap => {
      if (snap.exists()) {
        const items = snap.data().value;
        if (Array.isArray(items) && items.length > 0) setLivePortfolio(items);
      }
    }, () => {});
    return unsub;
  }, []);

  const scrollTo = id => { document.getElementById(id)?.scrollIntoView({behavior:"smooth"}); setMobileMenuOpen(false); };
  const scrollToQuote = e => { e?.preventDefault(); quoteRef.current?.scrollIntoView({behavior:"smooth"}); setMobileMenuOpen(false); };
  const fmtFileSize = b => b < 1024*1024 ? `${(b/1024).toFixed(0)} KB` : `${(b/(1024*1024)).toFixed(1)} MB`;
  const MAX_FILE = 100 * 1024 * 1024;

  const processFiles = rawFiles => {
    const valid = rawFiles.filter(f => {
      if (f.size > MAX_FILE) { setSubmitError(`"${f.name}" exceeds 100 MB — please compress or split it.`); return false; }
      return true;
    });
    setFiles(prev => { const names = new Set(prev.map(x=>x.name)); return [...prev, ...valid.filter(f=>!names.has(f.name))]; });
    setSubmitError("");
  };
  const handleFilePick = e => { processFiles(Array.from(e.target.files)); e.target.value = ""; };
  const removeFile = i => setFiles(p => p.filter((_,j)=>j!==i));
  const handleDrop = e => { e.preventDefault(); setDragging(false); processFiles(Array.from(e.dataTransfer.files)); };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.description.trim()) return;
    setBusy(true); setSubmitError("");
    try {
      const qid = `q_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const fileUrls = [];
      if (files.length > 0 && storage) {
        for (const file of files) {
          const r = storageFileRef(storage, `quotes/${qid}/${file.name}`);
          await new Promise((res, rej) => {
            const task = uploadBytesResumable(r, file);
            task.on("state_changed",
              snap => setUploadProgress(p => ({ ...p, [file.name]: Math.round(snap.bytesTransferred/snap.totalBytes*100) })),
              rej,
              async () => { fileUrls.push({ name:file.name, url: await getDownloadURL(task.snapshot.ref), size: fmtFileSize(file.size) }); res(); }
            );
          });
        }
      }
      if (db) {
        await addDoc(collection(db, "quotes"), { ...form, files:fileUrls, submittedAt:new Date().toISOString(), status:"New", qid });
      }
      // Email notification via Web3Forms (free, no account needed — see WEB3FORMS_KEY constant)
      if (WEB3FORMS_KEY && WEB3FORMS_KEY !== "YOUR_WEB3FORMS_KEY_HERE") {
        try {
          await fetch("https://api.web3forms.com/submit", {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({
              access_key: WEB3FORMS_KEY,
              subject:`🔔 New Quote Request — ${form.name}${form.company?` (${form.company})`:""}`,
              from_name: form.name,
              email: form.email,
              phone: form.phone || "Not provided",
              company: form.company || "Not provided",
              project_type: form.projectType || "Not specified",
              message: form.description,
              attachments_uploaded: files.length,
              botcheck:"",
            })
          });
        } catch {} // email failure is non-fatal — quote still saved to Firestore
      }
      setSubmitted(true);
    } catch(err) {
      console.error("Quote submit error:", err);
      setSubmitError("Submission failed. Please email admin@advancedsteeldrafting.com directly.");
    } finally { setBusy(false); }
  };

  const NAV_LINKS = [["Services","services"],["Portfolio","portfolio-section"],["About","about"],["Process","process"],["Get a Quote","quote"]];

  const SERVICES = [
    { icon:"🏗️", title:"Structural Steel Modelling", desc:"Precision 3D modelling using Tekla Structures for residential, commercial and industrial projects across Australia." },
    { icon:"📐", title:"GA Drawings", desc:"Comprehensive General Arrangement drawings — fully coordinated and suitable for engineering approval and construction." },
    { icon:"⚙️", title:"Fabrication Drawings", desc:"Detailed shop drawings for fabricators including all member profiles, connections, baseplates and specifications." },
    { icon:"📋", title:"RFI Management", desc:"Systematic tracking and resolution of Requests for Information to keep your project on schedule and documented." },
    { icon:"📊", title:"Steel Take-Offs", desc:"Accurate quantity take-offs from drawings for estimating, procurement and project cost control." },
    { icon:"🤝", title:"Project Coordination", desc:"End-to-end coordination from initial brief through to issued-for-construction documentation packages." },
  ];

  const PROCESS_STEPS = [
    ["01","Submit Your Brief","Fill in our quote form with your project details and attach any drawings, plans or specifications."],
    ["02","We Review & Quote","Our team reviews your brief and responds within 24 hours with a detailed, tailored quote."],
    ["03","We Detail","Our experienced detailers begin modelling and drafting to your exact specifications and Australian standards."],
    ["04","Deliver","Completed drawings and packages delivered to your preferred format and schedule — on time, every time."],
  ];

  const TESTIMONIALS = [
    { quote:"ASD turned around our GA drawings within 3 business days. Accurate, clean drawings with no back-and-forth required.", name:"Mark T.", role:"Project Manager, Melbourne Steel Fabrication" },
    { quote:"The level of detail in their shop drawings saved us at least two weeks on site. They really understand what fabricators need.", name:"Jason W.", role:"Site Manager, Premier Structural" },
    { quote:"Consistent, accurate and always responsive when we need revisions. ASD is our go-to detailing team for every project.", name:"Sarah L.", role:"Director, Optima Steel" },
  ];

  const LIS = { width:"100%", background:"#0F172A", border:"1px solid #334155", borderRadius:6, padding:"10px 12px", color:"#E2E8F0", fontSize:14, boxSizing:"border-box", outline:"none", fontFamily:"system-ui,sans-serif" };

  return (
    <div style={{fontFamily:"system-ui,sans-serif",color:"#E2E8F0",background:"#0F172A",overflowX:"hidden"}}>

      {/* ── HEADER ──────────────────────────────────── */}
      <header style={{position:"sticky",top:0,zIndex:500,background:"rgba(15,23,42,0.97)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderBottom:"1px solid #1E293B",padding:`0 ${isMobile?"16px":"32px"}`,height:64,display:"flex",alignItems:"center",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flex:1}}>
          <img src="/logo.jpg" alt="ASD" style={{width:34,height:34,borderRadius:6,objectFit:"cover",flexShrink:0}}/>
          <div>
            <div style={{fontWeight:900,fontSize:isMobile?10:12,color:"#F1F5F9",lineHeight:1.1,letterSpacing:"0.04em"}}>ADVANCED STEEL DRAFTING</div>
            {!isMobile && <div style={{fontSize:8,color:"#475569",letterSpacing:"0.2em"}}>STRUCTURAL DETAILING · AUSTRALIA</div>}
          </div>
        </div>
        {!isTablet && (
          <nav style={{display:"flex",gap:24,alignItems:"center"}}>
            {NAV_LINKS.map(([label,id])=>(
              <a key={id} href={`#${id}`}
                onClick={e=>{e.preventDefault();id==="quote"?scrollToQuote(e):scrollTo(id);}}
                style={{color:label==="Get a Quote"?"#F97316":"#94A3B8",textDecoration:"none",fontSize:13,fontWeight:label==="Get a Quote"?700:500}}>
                {label}
              </a>
            ))}
          </nav>
        )}
        <div style={{display:"flex",gap:8,marginLeft:isTablet?0:16}}>
          {!isMobile && <button onClick={scrollToQuote} style={{background:"#F97316",border:"none",borderRadius:6,padding:"8px 18px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:13}}>Get a Quote</button>}
          <button onClick={()=>setShowLogin(true)} style={{background:"transparent",border:"1px solid #334155",borderRadius:6,padding:"8px 14px",color:"#64748B",fontWeight:600,cursor:"pointer",fontSize:12}}>Team Portal →</button>
          {isMobile && (
            <button onClick={()=>setMobileMenuOpen(o=>!o)} style={{background:"none",border:"1px solid #334155",borderRadius:6,padding:"7px 10px",color:"#94A3B8",cursor:"pointer",fontSize:15,lineHeight:1}}>
              {mobileMenuOpen?"✕":"☰"}
            </button>
          )}
        </div>
        {isMobile && mobileMenuOpen && (
          <div style={{position:"absolute",top:64,left:0,right:0,background:"rgba(15,23,42,0.99)",borderBottom:"1px solid #1E293B",padding:"8px 16px 12px",display:"flex",flexDirection:"column",gap:0,zIndex:501}}>
            {NAV_LINKS.map(([label,id])=>(
              <button key={id} onClick={()=>{id==="quote"?scrollToQuote():scrollTo(id);}}
                style={{background:"none",border:"none",borderBottom:"1px solid #1E293B20",color:label==="Get a Quote"?"#F97316":"#CBD5E1",textAlign:"left",padding:"11px 8px",fontSize:14,fontWeight:label==="Get a Quote"?700:500,cursor:"pointer"}}>
                {label}
              </button>
            ))}
            <button onClick={()=>{setMobileMenuOpen(false);setShowLogin(true);}}
              style={{background:"none",border:"none",color:"#64748B",textAlign:"left",padding:"11px 8px",fontSize:14,cursor:"pointer"}}>
              Team Portal →
            </button>
          </div>
        )}
      </header>

      {/* ── HERO ────────────────────────────────────── */}
      <section style={{minHeight:"95vh",background:"linear-gradient(135deg,#0F172A 0%,#1E293B 55%,#0F172A 100%)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",padding:`100px ${isMobile?"20px":"40px"} 80px`,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",inset:0,opacity:0.03,backgroundImage:"repeating-linear-gradient(90deg,#F97316 0 1px,transparent 1px 80px),repeating-linear-gradient(180deg,#F97316 0 1px,transparent 1px 80px)",pointerEvents:"none"}}/>
        <div style={{position:"absolute",top:"20%",left:"50%",transform:"translateX(-50%)",width:700,height:700,background:"radial-gradient(circle,rgba(249,115,22,0.07) 0%,transparent 70%)",pointerEvents:"none"}}/>
        <div style={{position:"relative",zIndex:1,maxWidth:900}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:8,background:"rgba(249,115,22,0.1)",border:"1px solid rgba(249,115,22,0.25)",borderRadius:20,padding:"5px 18px",fontSize:11,color:"#F97316",fontWeight:700,letterSpacing:"0.12em",marginBottom:28}}>
            ★ STRUCTURAL STEEL DETAILING — AUSTRALIA-WIDE
          </div>
          <h1 style={{fontSize:`clamp(2rem,${isMobile?"7vw":"5vw"},3.8rem)`,fontWeight:900,color:"#F1F5F9",lineHeight:1.12,margin:"0 0 22px",letterSpacing:"-0.025em"}}>
            Structural Steel Documentation<br/><span style={{color:"#F97316"}}>Done Right.</span>
          </h1>
          <p style={{fontSize:"clamp(1rem,2.5vw,1.2rem)",color:"#94A3B8",maxWidth:640,margin:"0 auto 48px",lineHeight:1.8}}>
            Precision 3D modelling, GA drawings, fabrication packages and RFI management — delivered accurately and on time, every project.
          </p>
          <div style={{display:"flex",gap:14,justifyContent:"center",flexWrap:"wrap"}}>
            <button onClick={scrollToQuote} style={{background:"#F97316",border:"none",borderRadius:8,padding:"15px 36px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:16,letterSpacing:"0.02em",boxShadow:"0 4px 24px rgba(249,115,22,0.35)"}}>
              Get a Free Quote →
            </button>
            <button onClick={()=>scrollTo("portfolio-section")} style={{background:"transparent",border:"2px solid #334155",borderRadius:8,padding:"15px 28px",color:"#94A3B8",fontWeight:700,cursor:"pointer",fontSize:15}}>
              View Our Work
            </button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:isMobile?12:32,marginTop:64,maxWidth:620,margin:"64px auto 0"}}>
            {[["200+","Projects Completed"],["10+","Years Experience"],["100%","Australian Team"],["24hr","Quote Turnaround"]].map(([n,l])=>(
              <div key={l} style={{textAlign:"center"}}>
                <div style={{fontSize:"clamp(1.5rem,4vw,2.2rem)",fontWeight:900,color:"#F97316",lineHeight:1}}>{n}</div>
                <div style={{fontSize:9,color:"#475569",marginTop:6,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase"}}>{l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SERVICES ────────────────────────────────── */}
      <section id="services" style={{background:"#F8FAFC",padding:`80px ${isMobile?"20px":"40px"}`,color:"#0F172A"}}>
        <div style={{maxWidth:1140,margin:"0 auto"}}>
          <div style={{textAlign:"center",marginBottom:56}}>
            <div style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.15em",marginBottom:10}}>WHAT WE DO</div>
            <h2 style={{fontSize:"clamp(1.8rem,3vw,2.6rem)",fontWeight:900,margin:"0 0 14px",color:"#0F172A"}}>End-to-End Steel Drafting Services</h2>
            <p style={{fontSize:15,color:"#64748B",maxWidth:560,margin:"0 auto",lineHeight:1.75}}>From initial modelling to issued-for-construction packages — we handle every stage of the structural steel drafting process.</p>
          </div>
          <div style={{display:"grid",gridTemplateColumns:`repeat(auto-fit,minmax(${isMobile?"280px":"300px"},1fr))`,gap:20}}>
            {SERVICES.map((s,i)=>(
              <div key={i}
                style={{background:"#fff",border:"1px solid #E2E8F0",borderRadius:14,padding:28,borderLeft:"4px solid #F97316",transition:"transform 0.2s,box-shadow 0.2s",cursor:"default"}}
                onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow="0 12px 32px rgba(0,0,0,0.1)";}}
                onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";}}>
                <div style={{fontSize:32,marginBottom:14}}>{s.icon}</div>
                <div style={{fontWeight:800,fontSize:16,color:"#0F172A",marginBottom:8}}>{s.title}</div>
                <div style={{fontSize:13,color:"#64748B",lineHeight:1.7}}>{s.desc}</div>
              </div>
            ))}
          </div>
          <div style={{textAlign:"center",marginTop:36}}>
            <button onClick={scrollToQuote} style={{background:"#F97316",border:"none",borderRadius:8,padding:"12px 32px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14}}>Get a Quote for Your Project →</button>
          </div>
        </div>
      </section>

      {/* ── PORTFOLIO ───────────────────────────────── */}
      <section id="portfolio-section" style={{background:"#0F172A",padding:`80px ${isMobile?"20px":"40px"}`,borderTop:"1px solid #1E293B",borderBottom:"1px solid #1E293B"}}>
        <div style={{maxWidth:1140,margin:"0 auto"}}>
          <div style={{textAlign:"center",marginBottom:56}}>
            <div style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.15em",marginBottom:10}}>OUR WORK</div>
            <h2 style={{fontSize:"clamp(1.8rem,3vw,2.6rem)",fontWeight:900,margin:"0 0 14px",color:"#F1F5F9"}}>Recent Projects</h2>
            <p style={{fontSize:15,color:"#64748B",maxWidth:520,margin:"0 auto",lineHeight:1.75}}>A selection of recent structural steel documentation projects across Australia.</p>
          </div>
          <div style={{display:"grid",gridTemplateColumns:`repeat(auto-fit,minmax(${isMobile?"280px":"320px"},1fr))`,gap:20}}>
            {livePortfolio.map((p,i)=>(
              <div key={p.id||i}
                style={{background:"#1E293B",border:"1px solid #334155",borderRadius:14,overflow:"hidden",transition:"transform 0.2s,box-shadow 0.2s"}}
                onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-4px)";e.currentTarget.style.boxShadow="0 16px 40px rgba(0,0,0,0.4)";}}
                onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";}}>
                <div style={{height:200,background:"linear-gradient(135deg,#1E293B,#0F172A)",position:"relative",overflow:"hidden"}}>
                  {p.imageUrl
                    ? <img src={p.imageUrl} alt={p.title} style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.style.display="none";}}/>
                    : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:8}}>
                        <div style={{fontSize:48,opacity:0.2}}>🏗️</div>
                      </div>
                  }
                  <div style={{position:"absolute",top:12,left:12,display:"flex",gap:6,flexWrap:"wrap"}}>
                    <span style={{background:p.status==="Issued"?"#10B981":"#F59E0B",color:"#fff",fontSize:10,fontWeight:800,padding:"3px 10px",borderRadius:20}}>✓ {p.status||"Issued"}</span>
                    <span style={{background:"rgba(15,23,42,0.85)",color:"#94A3B8",fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:20,border:"1px solid #334155"}}>{p.type} · {p.year}</span>
                  </div>
                </div>
                <div style={{padding:"20px 22px"}}>
                  <div style={{fontWeight:800,fontSize:15,color:"#F1F5F9",marginBottom:8,lineHeight:1.3}}>{p.title}</div>
                  <div style={{fontSize:13,color:"#64748B",lineHeight:1.65,marginBottom:12}}>{p.desc}</div>
                  {p.tags&&p.tags.length>0&&(
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {p.tags.map(tag=>(
                        <span key={tag} style={{background:"rgba(249,115,22,0.1)",border:"1px solid rgba(249,115,22,0.2)",color:"#F97316",fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10}}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div style={{textAlign:"center",marginTop:36}}>
            <button onClick={scrollToQuote} style={{background:"transparent",border:"2px solid #F97316",borderRadius:8,padding:"12px 32px",color:"#F97316",fontWeight:700,cursor:"pointer",fontSize:14}}>Start Your Project →</button>
          </div>
        </div>
      </section>

      {/* ── ABOUT ───────────────────────────────────── */}
      <section id="about" style={{background:"#F8FAFC",padding:`80px ${isMobile?"20px":"40px"}`,color:"#0F172A"}}>
        <div style={{maxWidth:1140,margin:"0 auto",display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?40:80,alignItems:"center"}}>
          <div>
            <div style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.15em",marginBottom:10}}>WHO WE ARE</div>
            <h2 style={{fontSize:"clamp(1.8rem,3vw,2.4rem)",fontWeight:900,margin:"0 0 20px",color:"#0F172A",lineHeight:1.15}}>A Dedicated Structural Steel Detailing Team</h2>
            <p style={{fontSize:15,color:"#475569",lineHeight:1.8,marginBottom:16}}>Advanced Steel Drafting is an Australian structural steel detailing company specialising in Tekla Structures modelling, GA drawings, fabrication packages and full project documentation.</p>
            <p style={{fontSize:15,color:"#475569",lineHeight:1.8,marginBottom:28}}>With over 10 years of experience across residential, commercial and industrial projects, we work directly with fabricators, engineers and builders to deliver accurate, construction-ready documentation on schedule.</p>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {[["📍","Based in Australia","Serving clients across VIC, NSW, QLD and WA"],["🖥️","Tekla Structures","Industry-standard 3D structural steel modelling"],["🏆","Australian Standards","All documentation compliant with AS 4100 & NCC"],["⚡","Fast Turnaround","Quote within 24 hours, drawings delivered on time"]].map(([icon,title,desc])=>(
                <div key={title} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                  <span style={{fontSize:20,flexShrink:0}}>{icon}</span>
                  <div><div style={{fontWeight:800,fontSize:14,color:"#0F172A"}}>{title}</div><div style={{fontSize:13,color:"#64748B",marginTop:2}}>{desc}</div></div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div style={{background:"#fff",border:"1px solid #E2E8F0",borderRadius:14,padding:28,marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.15em",marginBottom:18}}>SOFTWARE & TOOLS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[["🏗️","Tekla Structures","3D Modelling"],["📐","AutoCAD","Drafting"],["☁️","Trimble Connect","Collaboration"],["🔄","IFC / BIM","Open BIM"],["📋","Tekla Tedds","Calculations"],["📊","MS Office","Documentation"]].map(([icon,name,cat])=>(
                  <div key={name} style={{background:"#F8FAFC",borderRadius:8,padding:"12px 14px",border:"1px solid #E2E8F0"}}>
                    <div style={{fontSize:20,marginBottom:4}}>{icon}</div>
                    <div style={{fontSize:13,fontWeight:800,color:"#0F172A"}}>{name}</div>
                    <div style={{fontSize:11,color:"#94A3B8"}}>{cat}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
              {["Residential","Commercial","Industrial","Civil"].map(t=>(
                <div key={t} style={{background:"#0F172A",borderRadius:8,padding:"10px 6px",textAlign:"center"}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#F97316",letterSpacing:"0.04em"}}>{t}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── WHY CHOOSE ASD ──────────────────────────── */}
      <section style={{background:"#0F172A",padding:`80px ${isMobile?"20px":"40px"}`,borderTop:"1px solid #1E293B"}}>
        <div style={{maxWidth:1140,margin:"0 auto"}}>
          <div style={{textAlign:"center",marginBottom:52}}>
            <div style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.15em",marginBottom:10}}>WHY ASD</div>
            <h2 style={{fontSize:"clamp(1.8rem,3vw,2.6rem)",fontWeight:900,margin:0,color:"#F1F5F9"}}>Why Clients Choose Us</h2>
          </div>
          <div style={{display:"grid",gridTemplateColumns:`repeat(auto-fit,minmax(${isMobile?"240px":"260px"},1fr))`,gap:20}}>
            {[["⚡","Fast Delivery","We quote within 24 hours and commit to realistic timelines we actually meet. No surprises."],["🎯","Accuracy First","Our detailers check every drawing against engineering and site conditions before issue."],["🇦🇺","Australian Team","Work directly with our in-house Australian team — no offshoring, no communication delays."],["🔄","Revision-Ready","We take revisions seriously and turn them around fast — because site delays cost money."]].map(([icon,title,desc])=>(
              <div key={title} style={{background:"#1E293B",border:"1px solid #334155",borderRadius:14,padding:28,textAlign:"center"}}>
                <div style={{fontSize:36,marginBottom:14}}>{icon}</div>
                <div style={{fontWeight:800,fontSize:15,color:"#F97316",marginBottom:8}}>{title}</div>
                <div style={{fontSize:13,color:"#64748B",lineHeight:1.7}}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PROCESS ─────────────────────────────────── */}
      <section id="process" style={{background:"#F8FAFC",padding:`80px ${isMobile?"20px":"40px"}`,color:"#0F172A"}}>
        <div style={{maxWidth:1040,margin:"0 auto"}}>
          <div style={{textAlign:"center",marginBottom:52}}>
            <div style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.15em",marginBottom:10}}>HOW IT WORKS</div>
            <h2 style={{fontSize:"clamp(1.8rem,3vw,2.6rem)",fontWeight:900,margin:"0 0 12px",color:"#0F172A"}}>Simple. Fast. Accurate.</h2>
            <p style={{fontSize:15,color:"#64748B",maxWidth:480,margin:"0 auto",lineHeight:1.75}}>Getting your steel documentation right shouldn't be complicated. Here's how we work.</p>
          </div>
          <div style={{display:"grid",gridTemplateColumns:`repeat(auto-fit,minmax(${isMobile?"240px":"220px"},1fr))`,gap:16}}>
            {PROCESS_STEPS.map(([n,title,desc],i)=>(
              <div key={n} style={{textAlign:"center",padding:"32px 20px",background:"#fff",borderRadius:14,border:"1px solid #E2E8F0",position:"relative"}}>
                <div style={{fontWeight:900,fontSize:52,color:"rgba(249,115,22,0.1)",lineHeight:1,marginBottom:14}}>{n}</div>
                <div style={{fontWeight:800,fontSize:15,color:"#0F172A",marginBottom:10}}>{title}</div>
                <div style={{fontSize:13,color:"#64748B",lineHeight:1.7}}>{desc}</div>
              </div>
            ))}
          </div>
          <div style={{textAlign:"center",marginTop:36}}>
            <button onClick={scrollToQuote} style={{background:"#F97316",border:"none",borderRadius:8,padding:"12px 32px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14}}>Get Started Today →</button>
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ────────────────────────────── */}
      <section style={{background:"#0F172A",padding:`80px ${isMobile?"20px":"40px"}`,borderTop:"1px solid #1E293B"}}>
        <div style={{maxWidth:1140,margin:"0 auto"}}>
          <div style={{textAlign:"center",marginBottom:52}}>
            <div style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.15em",marginBottom:10}}>WHAT CLIENTS SAY</div>
            <h2 style={{fontSize:"clamp(1.8rem,3vw,2.6rem)",fontWeight:900,margin:0,color:"#F1F5F9"}}>Trusted by Australian Fabricators & Builders</h2>
          </div>
          <div style={{display:"grid",gridTemplateColumns:`repeat(auto-fit,minmax(${isMobile?"280px":"300px"},1fr))`,gap:20}}>
            {TESTIMONIALS.map((t,i)=>(
              <div key={i} style={{background:"#1E293B",border:"1px solid #334155",borderRadius:14,padding:28,display:"flex",flexDirection:"column",gap:12}}>
                <div style={{fontSize:36,color:"#F97316",fontFamily:"Georgia,serif",lineHeight:1}}>"</div>
                <div style={{fontSize:14,color:"#CBD5E1",lineHeight:1.75,flex:1,marginTop:-8}}>{t.quote}</div>
                <div>
                  <div style={{fontWeight:800,fontSize:13,color:"#F1F5F9"}}>{t.name}</div>
                  <div style={{fontSize:12,color:"#64748B",marginTop:2}}>{t.role}</div>
                </div>
                <div style={{display:"flex",gap:2}}>{[...Array(5)].map((_,j)=><span key={j} style={{color:"#F97316",fontSize:13}}>★</span>)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA BANNER ──────────────────────────────── */}
      <section style={{background:"linear-gradient(135deg,#F97316,#EA6A0A)",padding:`64px ${isMobile?"20px":"40px"}`,textAlign:"center",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",inset:0,opacity:0.06,backgroundImage:"repeating-linear-gradient(45deg,#fff 0 1px,transparent 1px 30px)",pointerEvents:"none"}}/>
        <div style={{position:"relative",zIndex:1,maxWidth:640,margin:"0 auto"}}>
          <h2 style={{fontSize:"clamp(1.6rem,3vw,2.4rem)",fontWeight:900,color:"#fff",margin:"0 0 14px",lineHeight:1.2}}>Ready to Get Your Drawings Done Right?</h2>
          <p style={{fontSize:15,color:"rgba(255,255,255,0.85)",margin:"0 0 32px",lineHeight:1.7}}>Get a free, tailored quote within 24 hours. No lock-ins, no surprises — just accurate documentation delivered on time.</p>
          <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
            <button onClick={scrollToQuote} style={{background:"#fff",border:"none",borderRadius:8,padding:"14px 32px",color:"#F97316",fontWeight:800,cursor:"pointer",fontSize:15,boxShadow:"0 4px 16px rgba(0,0,0,0.2)"}}>Get a Free Quote →</button>
            <a href="mailto:admin@advancedsteeldrafting.com" style={{display:"inline-block",background:"transparent",border:"2px solid rgba(255,255,255,0.5)",borderRadius:8,padding:"14px 28px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:15,textDecoration:"none"}}>📧 Email Us Directly</a>
          </div>
        </div>
      </section>

      {/* ── REQUEST A QUOTE ──────────────────────────── */}
      <section id="quote" ref={quoteRef} style={{background:"#0A0F1E",padding:`80px ${isMobile?"20px":"40px"}`,borderTop:"1px solid #1E293B"}}>
        <div style={{maxWidth:1100,margin:"0 auto",display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1.4fr",gap:isMobile?40:64,alignItems:"start"}}>
          <div>
            <div style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.15em",marginBottom:10}}>GET STARTED</div>
            <h2 style={{fontSize:"clamp(1.8rem,3vw,2.4rem)",fontWeight:900,margin:"0 0 16px",color:"#F1F5F9",lineHeight:1.2}}>Request a Free Quote</h2>
            <p style={{fontSize:14,color:"#64748B",lineHeight:1.8,marginBottom:32}}>Tell us about your project and attach any drawings or documentation. We'll review and respond within 24 hours with a tailored quote.</p>
            <div style={{display:"flex",flexDirection:"column",gap:20,marginBottom:32}}>
              {[["📧","Email","admin@advancedsteeldrafting.com","mailto:admin@advancedsteeldrafting.com"],["📍","Location","Australia-wide — VIC · NSW · QLD · WA",null],["⏱️","Response Time","Within 24 hours",null],["📁","File Types","DWG · DXF · PDF · IFC · ZIP — up to 100MB",null]].map(([icon,label,val,href])=>(
                <div key={label} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                  <span style={{fontSize:22,flexShrink:0}}>{icon}</span>
                  <div>
                    <div style={{fontSize:10,color:"#475569",fontWeight:800,letterSpacing:"0.12em",marginBottom:3}}>{label.toUpperCase()}</div>
                    {href?<a href={href} style={{fontSize:14,color:"#F97316",textDecoration:"none"}}>{val}</a>:<div style={{fontSize:14,color:"#E2E8F0"}}>{val}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {["✅ No lock-in contracts","✅ 100% confidential","✅ Australian in-house team","✅ Reply within 24 hours"].map(t=>(
                <div key={t} style={{fontSize:13,color:"#64748B"}}>{t}</div>
              ))}
            </div>
          </div>
          <div style={{background:"#1E293B",borderRadius:16,padding:isMobile?24:36,border:"1px solid #334155"}}>
            {submitted ? (
              <div style={{textAlign:"center",padding:"56px 20px"}}>
                <div style={{fontSize:64,marginBottom:20}}>✅</div>
                <div style={{fontSize:20,fontWeight:900,color:"#F1F5F9",marginBottom:12}}>Quote Request Sent!</div>
                <div style={{fontSize:14,color:"#64748B",lineHeight:1.75}}>Thanks {form.name}! We've received your request and will reply to <strong style={{color:"#F97316"}}>{form.email}</strong> within 24 hours.</div>
                <button onClick={()=>{setSubmitted(false);setForm({name:"",company:"",email:"",phone:"",description:"",projectType:""});setFiles([]);setUploadProgress({});}} style={{marginTop:32,background:"#F97316",border:"none",borderRadius:8,padding:"12px 32px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:14}}>Submit Another Request</button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} style={{display:"flex",flexDirection:"column",gap:14}}>
                <h3 style={{margin:"0 0 4px",fontSize:17,fontWeight:900,color:"#F1F5F9"}}>Project Details</h3>
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:12}}>
                  <div>
                    <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.12em",marginBottom:5}}>FULL NAME *</label>
                    <input required value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="John Smith" style={LIS}/>
                  </div>
                  <div>
                    <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.12em",marginBottom:5}}>COMPANY</label>
                    <input value={form.company} onChange={e=>setForm(p=>({...p,company:e.target.value}))} placeholder="Smith Steel Pty Ltd" style={LIS}/>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:12}}>
                  <div>
                    <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.12em",marginBottom:5}}>EMAIL *</label>
                    <input required type="email" value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} placeholder="john@company.com.au" style={LIS}/>
                  </div>
                  <div>
                    <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.12em",marginBottom:5}}>PHONE</label>
                    <input value={form.phone} onChange={e=>setForm(p=>({...p,phone:e.target.value}))} placeholder="04XX XXX XXX" style={LIS}/>
                  </div>
                </div>
                <div>
                  <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.12em",marginBottom:5}}>PROJECT TYPE</label>
                  <select value={form.projectType} onChange={e=>setForm(p=>({...p,projectType:e.target.value}))} style={LIS}>
                    <option value="">Select type…</option>
                    {["Residential","Commercial","Industrial","Civil / Infrastructure","Take-Off Only","Other"].map(t=><option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.12em",marginBottom:5}}>PROJECT DESCRIPTION *</label>
                  <textarea required spellCheck value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} placeholder="Describe your project — structure type, number of storeys, location, timeline, any special requirements…" rows={5} style={{...LIS,resize:"vertical"}}/>
                </div>
                <div>
                  <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.12em",marginBottom:5}}>
                    ATTACH DRAWINGS / PLANS <span style={{fontWeight:400,textTransform:"none",letterSpacing:0,fontSize:10,color:"#334155"}}>— up to 100 MB each</span>
                  </label>
                  <div onClick={()=>fileInputRef.current?.click()}
                    onDragOver={e=>{e.preventDefault();setDragging(true);}}
                    onDragLeave={()=>setDragging(false)}
                    onDrop={handleDrop}
                    style={{border:`2px dashed ${dragging?"#F97316":"#334155"}`,borderRadius:10,padding:"22px 16px",textAlign:"center",cursor:"pointer",background:dragging?"rgba(249,115,22,0.05)":"transparent",transition:"border-color 0.15s,background 0.15s"}}>
                    <div style={{fontSize:30,marginBottom:8}}>📎</div>
                    <div style={{fontSize:13,color:"#64748B",fontWeight:600}}>Click to attach or drag & drop</div>
                    <div style={{fontSize:11,color:"#475569",marginTop:4}}>DWG · DXF · PDF · IFC · JPG · PNG · ZIP — up to 100 MB each</div>
                    <input ref={fileInputRef} type="file" multiple onChange={handleFilePick} style={{display:"none"}} accept=".dwg,.dxf,.pdf,.ifc,.srtl,.jpg,.jpeg,.png,.zip,.rar,.7z"/>
                  </div>
                  {files.length>0 && (
                    <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:6}}>
                      {files.map((f,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:10,background:"#0F172A",borderRadius:6,padding:"8px 12px",border:"1px solid #334155"}}>
                          <span style={{fontSize:14}}>📄</span>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:12,color:"#E2E8F0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</div>
                            {uploadProgress[f.name]!==undefined && uploadProgress[f.name]<100 && (
                              <div style={{height:3,background:"#1E293B",borderRadius:2,marginTop:4}}>
                                <div style={{height:"100%",width:`${uploadProgress[f.name]}%`,background:"#F97316",borderRadius:2,transition:"width 0.3s"}}/>
                              </div>
                            )}
                            {uploadProgress[f.name]===100 && <div style={{fontSize:10,color:"#10B981",marginTop:2}}>✓ Uploaded</div>}
                          </div>
                          <span style={{fontSize:11,color:"#475569",flexShrink:0}}>{fmtFileSize(f.size)}</span>
                          {!busy && <button type="button" onClick={()=>removeFile(i)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:18,padding:0,lineHeight:1,flexShrink:0}}>×</button>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {submitError && <div style={{fontSize:13,color:"#EF4444",background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:6,padding:"10px 14px"}}>{submitError}</div>}
                <button type="submit" disabled={busy} style={{background:busy?"#334155":"#F97316",border:"none",borderRadius:8,padding:"15px",color:"#fff",fontWeight:900,cursor:busy?"default":"pointer",fontSize:16,marginTop:4,letterSpacing:"0.02em",boxShadow:busy?"none":"0 4px 16px rgba(249,115,22,0.35)"}}>
                  {busy
                    ? (()=>{ const vals=Object.values(uploadProgress); return vals.length?`Uploading… ${Math.round(vals.reduce((a,b)=>a+b,0)/vals.length)}%`:"Submitting…"; })()
                    : "Submit Quote Request →"
                  }
                </button>
                <div style={{fontSize:11,color:"#334155",textAlign:"center"}}>We respond within 24 hours · All information is kept confidential</div>
              </form>
            )}
          </div>
        </div>
      </section>

      {/* ── FOOTER ──────────────────────────────────── */}
      <footer style={{background:"#020617",padding:`48px ${isMobile?"20px":"40px"} 32px`,borderTop:"1px solid #0F172A"}}>
        <div style={{maxWidth:1140,margin:"0 auto"}}>
          <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"2fr 1fr 1fr 1fr",gap:isMobile?24:32,marginBottom:36}}>
            <div style={{gridColumn:isMobile?"1/-1":"auto"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                <img src="/logo.jpg" alt="ASD" style={{width:30,height:30,borderRadius:5,objectFit:"cover"}}/>
                <div>
                  <div style={{fontWeight:900,fontSize:11,color:"#475569",letterSpacing:"0.04em"}}>ADVANCED STEEL DRAFTING</div>
                  <div style={{fontSize:9,color:"#1E293B",letterSpacing:"0.12em"}}>STRUCTURAL DETAILING</div>
                </div>
              </div>
              <p style={{fontSize:13,color:"#334155",lineHeight:1.7,maxWidth:240,margin:"0 0 12px"}}>Precision structural steel documentation for Australia's fabricators, engineers and builders.</p>
              <a href="mailto:admin@advancedsteeldrafting.com" style={{fontSize:13,color:"#F97316",textDecoration:"none"}}>admin@advancedsteeldrafting.com</a>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:"#334155",letterSpacing:"0.12em",marginBottom:14}}>SERVICES</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {["Steel Modelling","GA Drawings","Fabrication Drawings","RFI Management","Take-Offs","Project Coordination"].map(s=>(
                  <button key={s} onClick={()=>scrollTo("services")} style={{background:"none",border:"none",color:"#334155",fontSize:12,cursor:"pointer",textAlign:"left",padding:0}}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:"#334155",letterSpacing:"0.12em",marginBottom:14}}>COMPANY</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {[["About","about"],["Portfolio","portfolio-section"],["Our Process","process"],["Get a Quote","quote"]].map(([label,id])=>(
                  <button key={id} onClick={()=>id==="quote"?scrollToQuote():scrollTo(id)} style={{background:"none",border:"none",color:"#334155",fontSize:12,cursor:"pointer",textAlign:"left",padding:0}}>{label}</button>
                ))}
                <button onClick={()=>setShowLogin(true)} style={{background:"none",border:"none",color:"#334155",fontSize:12,cursor:"pointer",textAlign:"left",padding:0}}>Team Portal</button>
              </div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:"#334155",letterSpacing:"0.12em",marginBottom:14}}>CONTACT</div>
              <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
                <a href="mailto:admin@advancedsteeldrafting.com" style={{fontSize:12,color:"#475569",textDecoration:"none",display:"flex",gap:8,alignItems:"flex-start"}}><span>📧</span><span>admin@advancedsteeldrafting.com</span></a>
                <div style={{fontSize:12,color:"#334155",display:"flex",gap:8}}><span>📍</span><span>Australia-wide (VIC · NSW · QLD · WA)</span></div>
                <div style={{fontSize:12,color:"#334155",display:"flex",gap:8}}><span>⏱️</span><span>Quote turnaround: 24 hours</span></div>
              </div>
              <button onClick={scrollToQuote} style={{background:"#F97316",border:"none",borderRadius:6,padding:"8px 16px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:12}}>Get a Quote →</button>
            </div>
          </div>
          <div style={{borderTop:"1px solid #0F172A",paddingTop:20,display:"flex",flexDirection:isMobile?"column":"row",justifyContent:"space-between",alignItems:"center",gap:8}}>
            <div style={{fontSize:11,color:"#1E293B"}}>© {new Date().getFullYear()} Advanced Steel Drafting. All rights reserved.</div>
            <div style={{fontSize:11,color:"#1E293B"}}>Structural detailing services across Australia</div>
          </div>
        </div>
      </footer>

      {/* ── LOGIN MODAL ──────────────────────────────── */}
      {showLogin && createPortal(
        <div onClick={e=>{if(e.target===e.currentTarget)setShowLogin(false);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{position:"relative",width:"100%",maxWidth:340}}>
            <button onClick={()=>setShowLogin(false)} style={{position:"absolute",top:-44,right:0,background:"transparent",border:"1px solid #334155",borderRadius:6,padding:"6px 14px",color:"#94A3B8",cursor:"pointer",fontSize:13,fontWeight:700}}>✕ Close</button>
            <div style={{borderRadius:16,overflow:"hidden"}}>
              <LoginScreen compact onLogin={name=>{setShowLogin(false);onLoginSuccess(name);}}/>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function InvoicesTab({ projects, invoices, onAddInvoice, onUpdateInvoice, onRemoveInvoice }) {
  const { clients } = useTeam();
  const theme = useThemeMode();
  const isDark = theme === "dark";
  const isMob = useWindowWidth() < 768;

  const [innerTab, setInnerTab] = useState("overview");
  const [gstMode, setGstMode] = useState("ex"); // "ex" | "inc"

  const fmtAud = n => "$" + Number(n || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dispAmt = (amt, isCash) => {
    const n = parseFloat(amt) || 0;
    return isCash ? n : (gstMode === "inc" ? n * 1.1 : n);
  };
  const fmt = (amt, isCash) => fmtAud(dispAmt(amt, isCash));

  const NOW = new Date();
  const TODAY = NOW.toISOString().slice(0, 10);
  const THIS_YEAR = NOW.getFullYear();
  const [analyticsYear, setAnalyticsYear] = useState(THIS_YEAR);
  const yearOptions = Array.from({ length: 5 }, (_, i) => THIS_YEAR - i);

  const [filter, setFilter] = useState("All");
  const [clientFilter, setClientFilter] = useState("All");
  const [yearFilter, setYearFilter] = useState("All");
  const [monthFilter, setMonthFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [prefillProj, setPrefillProj] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [expandedInv, setExpandedInv] = useState(null);
  const [expandedJob, setExpandedJob] = useState(null);
  const [paymentForm, setPaymentForm] = useState(null);
  const [sendDocInv, setSendDocInv] = useState(null);
  const [jobsFilter, setJobsFilter] = useState("all");
  const [jobsClientFilter, setJobsClientFilter] = useState("All");

  // ── AUS BAS quarter state ────────────────────────────────────────────
  // Australian FY: 1 Jul – 30 Jun. Q1=Jul-Sep, Q2=Oct-Dec, Q3=Jan-Mar, Q4=Apr-Jun
  const curBasQ = useMemo(() => {
    const m = NOW.getMonth(), y = NOW.getFullYear();
    if (m >= 6 && m <= 8) return { fy: y, q: 1 };
    if (m >= 9) return { fy: y, q: 2 };
    if (m <= 2) return { fy: y - 1, q: 3 };
    return { fy: y - 1, q: 4 };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [selBasQ, setSelBasQ] = useState(`${curBasQ.fy}-Q${curBasQ.q}`);

  const quarterRange = (fy, q) => {
    switch (q) {
      case 1: return { start:`${fy}-07-01`, end:`${fy}-09-30`, due:`${fy}-10-28`, label:`Q1 ${fy}–${String(fy+1).slice(2)} (Jul–Sep)` };
      case 2: return { start:`${fy}-10-01`, end:`${fy}-12-31`, due:`${fy+1}-02-28`, label:`Q2 ${fy}–${String(fy+1).slice(2)} (Oct–Dec)` };
      case 3: return { start:`${fy+1}-01-01`, end:`${fy+1}-03-31`, due:`${fy+1}-04-28`, label:`Q3 ${fy}–${String(fy+1).slice(2)} (Jan–Mar)` };
      case 4: return { start:`${fy+1}-04-01`, end:`${fy+1}-06-30`, due:`${fy+1}-07-28`, label:`Q4 ${fy}–${String(fy+1).slice(2)} (Apr–Jun)` };
      default: return { start:"", end:"", due:"", label:"" };
    }
  };
  const ALL_QUARTERS = useMemo(() => {
    const qs = [];
    let { fy, q } = curBasQ;
    for (let i = 0; i < 8; i++) {
      qs.push({ key:`${fy}-Q${q}`, fy, q, ...quarterRange(fy, q) });
      q--; if (q < 1) { q = 4; fy--; }
    }
    return qs;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Next BAS due date (first quarter whose due date >= today)
  const nextBasDue = useMemo(() => {
    const ordered = [...ALL_QUARTERS].sort((a,b) => a.due.localeCompare(b.due));
    return ordered.find(q => q.due >= TODAY) || ordered[ordered.length - 1];
  }, [ALL_QUARTERS, TODAY]);

  const chartContainerRef = useRef(null);
  const chartCanvasRef = useRef(null);

  const allClients = useMemo(() =>
    [...new Set([...clients, ...projects.map(p => p.client).filter(Boolean)])].sort(),
  [clients, projects]);
  const completedProjects = useMemo(() =>
    projects.filter(p => {
      if (p.status === "Completed") return true;
      if (p.type === "Commercial") return p.status === "RFI & FAB DRAWINGS" || p.status === "APPROVED-READY TO ISSUE";
      return false;
    })
      .sort((a, b) => {
        if (a.status === "Completed" && b.status !== "Completed") return 1;
        if (b.status === "Completed" && a.status !== "Completed") return -1;
        return (b.due || "").localeCompare(a.due || "");
      }),
  [projects]);

  const getPayments = inv => Array.isArray(inv.payments) ? inv.payments : [];
  const totalReceived = inv => getPayments(inv).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const totalReceivedDisp = inv => getPayments(inv).reduce((s, p) => s + dispAmt(p.amount, p.isCash), 0);
  const balanceAmt = inv => Math.max((parseFloat(inv.amount) || 0) - totalReceived(inv), 0);
  const projInvs = pid => invoices.filter(i => i.projectId === pid);
  const daysOverdue = inv => {
    if (!inv.dueDate || inv.status === "Paid") return 0;
    return Math.max(0, Math.floor((NOW - new Date(inv.dueDate)) / 86400000));
  };

  // Auto-mark overdue: any Sent/Partial invoice past its due date becomes Overdue
  useEffect(() => {
    invoices.forEach(inv => {
      if ((inv.status === "Sent" || inv.status === "Partial") && inv.dueDate && inv.dueDate < TODAY && balanceAmt(inv) > 0) {
        onUpdateInvoice(inv.id, { status: "Overdue" });
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const outstanding = invoices.reduce((s, i) => {
    if (i.status === "Sent" || i.status === "Overdue" || i.status === "Partial") return s + balanceAmt(i);
    return s;
  }, 0);
  const overdueCount = invoices.filter(i => i.status === "Overdue" || (i.dueDate && i.dueDate < TODAY && i.status !== "Paid")).length;
  // Cash-basis: revenue counted by payment date, not issue date
  const paidYTD = invoices.reduce((s, inv) =>
    s + getPayments(inv).filter(p => (p.date||"").startsWith(String(analyticsYear))).reduce((ps,p)=>ps+(parseFloat(p.amount)||0),0), 0);
  const paidPrevYTD = invoices.reduce((s, inv) =>
    s + getPayments(inv).filter(p => (p.date||"").startsWith(String(analyticsYear-1))).reduce((ps,p)=>ps+(parseFloat(p.amount)||0),0), 0);
  const uninvoicedCount = completedProjects.filter(p => projInvs(p.id).length === 0).length;

  // ── Aged receivables ─────────────────────────────────────────────────
  const agedReceivables = useMemo(() => {
    const buckets = { current:0, d30:0, d60:0, d90:0, d90plus:0 };
    const counts  = { current:0, d30:0, d60:0, d90:0, d90plus:0 };
    invoices.forEach(inv => {
      const bal = balanceAmt(inv);
      if (bal <= 0 || inv.status === "Paid") return;
      if (!inv.dueDate || inv.dueDate >= TODAY) { buckets.current += bal; counts.current++; return; }
      const d = Math.floor((NOW - new Date(inv.dueDate)) / 86400000);
      const k = d <= 30 ? "d30" : d <= 60 ? "d60" : d <= 90 ? "d90" : "d90plus";
      buckets[k] += bal; counts[k]++;
    });
    const total = Object.values(buckets).reduce((s,v) => s + v, 0);
    return { buckets, counts, total };
  }, [invoices, TODAY]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cash flow forecast ───────────────────────────────────────────────
  const cashFlow = useMemo(() => {
    const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x.toISOString().slice(0,10); };
    const d30=add(TODAY,30), d60=add(TODAY,60), d90=add(TODAY,90);
    let n30=0, n60=0, n90=0, overdue=0;
    invoices.forEach(inv => {
      const bal = balanceAmt(inv);
      if (bal <= 0) return;
      const due = inv.dueDate || "";
      if (!due || due < TODAY) overdue += bal;
      else if (due <= d30) n30 += bal;
      else if (due <= d60) n60 += bal;
      else if (due <= d90) n90 += bal;
    });
    return { overdue, n30, n60, n90 };
  }, [invoices, TODAY]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Average days to pay (per client) ────────────────────────────────
  const avgDaysToPay = useMemo(() => {
    const stats = {};
    invoices.forEach(inv => {
      if (!inv.client || !inv.issuedDate) return;
      const pmts = getPayments(inv).filter(p => p.date && p.date >= inv.issuedDate).sort((a,b)=>a.date.localeCompare(b.date));
      if (!pmts.length) return;
      const d = Math.floor((new Date(pmts[0].date) - new Date(inv.issuedDate)) / 86400000);
      if (d < 0 || d > 365) return;
      if (!stats[inv.client]) stats[inv.client] = { total:0, n:0 };
      stats[inv.client].total += d; stats[inv.client].n++;
    });
    const out = {};
    Object.entries(stats).forEach(([cl,s]) => { out[cl] = Math.round(s.total/s.n); });
    return out;
  }, [invoices]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BAS data per quarter — CASH BASIS (payment date) ────────────────
  // Revenue recognised when payment received, not when invoice issued.
  const basData = useMemo(() => ALL_QUARTERS.map(({ key, fy, q, start, end, due, label }) => {
    let invoicedExGst = 0, cashPmts = 0, cardPmts = 0, invCount = 0;
    const seen = new Set();
    invoices.forEach(inv => {
      getPayments(inv).forEach(p => {
        const pd = p.date||"";
        if (pd < start || pd > end) return;
        const amt = parseFloat(p.amount)||0;
        if (p.isCash) {
          cashPmts += amt;
        } else {
          cardPmts += amt;
          invoicedExGst += amt; // card payments include GST — ex-GST portion
        }
        if (!seen.has(inv.id)) { seen.add(inv.id); invCount++; }
      });
    });
    // For cash-basis: ex-GST = card payments / 1.1 (they were inc-GST amounts)
    // Actually inv.amount is already ex-GST stored, payments are also ex-GST amounts
    // So GST = cardPmts * 0.1
    const gstCharged = cardPmts * 0.1;
    const gstPmts = gstCharged;
    const daysUntilDue = Math.ceil((new Date(due) - NOW) / 86400000);
    return { key, fy, q, start, end, due, label, invoicedExGst: cardPmts + cashPmts, gstCharged, cashPmts, gstPmts, daysUntilDue, invCount };
  }), [invoices, ALL_QUARTERS]); // eslint-disable-line react-hooks/exhaustive-deps

  // One-click pay full balance
  const payFull = inv => {
    const bal = balanceAmt(inv);
    if (bal <= 0) return;
    const p = { id: Math.random().toString(36).slice(2,9), amount: bal, date: TODAY, isCash: false };
    onUpdateInvoice(inv.id, { payments: [...getPayments(inv), p], status: "Paid" });
  };

  // Duplicate invoice — create a copy without invoiceNo/dates/payments/status
  const mkDup = inv => ({
    projectId: inv.projectId||"", projectLabel: inv.projectLabel||"",
    client: inv.client||"", amount: inv.amount, lineItems: inv.lineItems||[],
    claimNo: "", claimPct: inv.claimPct||"", paymentTerms: inv.paymentTerms||"14",
    notes: inv.notes||"", status:"Draft",
    invoiceNo:"", issuedDate:"", dueDate:"", payments:[],
    createdAt: Date.now(),
  });

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  // Cash-basis: chart uses payment date, not issue date
  const getMonthTotal = (year, mo) => {
    const prefix = `${year}-${String(mo + 1).padStart(2, "0")}`;
    let total = 0;
    invoices.forEach(inv => {
      getPayments(inv).forEach(p => {
        if ((p.date || "").startsWith(prefix)) total += dispAmt(p.amount, p.isCash);
      });
    });
    return total;
  };
  const thisYearData = useMemo(() => MONTHS.map((_, i) => getMonthTotal(analyticsYear, i)), [invoices, analyticsYear, gstMode]);
  const lastYearData = useMemo(() => MONTHS.map((_, i) => getMonthTotal(analyticsYear - 1, i)), [invoices, analyticsYear, gstMode]);

  const clientAnalytics = useMemo(() => {
    // Cash-basis: "received" counted by payment date; "invoiced" by issue date (obligation created)
    const map = {};
    invoices.forEach(inv => {
      const cl = inv.client || "Unassigned";
      // Count invoiced by issue year
      if ((inv.issuedDate || "").startsWith(String(analyticsYear))) {
        if (!map[cl]) map[cl] = { invoiced: 0, received: 0, balance: 0, count: 0 };
        map[cl].invoiced += dispAmt(inv.amount, false);
        map[cl].balance += dispAmt(balanceAmt(inv), false);
        map[cl].count++;
      }
      // Count received by payment date (cash basis)
      getPayments(inv).forEach(p => {
        if ((p.date||"").startsWith(String(analyticsYear))) {
          if (!map[cl]) map[cl] = { invoiced: 0, received: 0, balance: 0, count: 0 };
          map[cl].received += dispAmt(p.amount, p.isCash);
        }
      });
    });
    return Object.entries(map).sort((a, b) => b[1].invoiced - a[1].invoiced);
  }, [invoices, analyticsYear, gstMode]);

  const drawChart = useCallback(() => {
    const container = chartContainerRef.current;
    const canvas = chartCanvasRef.current;
    if (!container || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = container.clientWidth;
    const H = 160;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const maxV = Math.max(...thisYearData, ...lastYearData, 1000);
    const pL = 58, pR = 10, pT = 10, pB = 28;
    const cW = W - pL - pR, cH = H - pT - pB;
    const bGrp = cW / 12;
    const bW = Math.max(Math.min((bGrp - 8) / 2, 22), 4);
    const bg = isDark ? "#1E293B" : "#F8FAFC";
    const grid = isDark ? "#334155" : "#E2E8F0";
    const txt = isDark ? "#64748B" : "#94A3B8";
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i <= 4; i++) {
      const y = pT + cH - (i / 4) * cH;
      ctx.strokeStyle = grid; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
      const v = maxV * i / 4;
      ctx.fillStyle = txt; ctx.font = "9px system-ui,sans-serif"; ctx.textAlign = "right";
      ctx.fillText("$" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v.toFixed(0)), pL - 4, y + 3);
    }
    MONTHS.forEach((mo, i) => {
      const cx = pL + i * bGrp + bGrp / 2;
      const tH = (thisYearData[i] / maxV) * cH;
      const lH = (lastYearData[i] / maxV) * cH;
      ctx.fillStyle = isDark ? "#334155" : "#CBD5E1";
      if (lH > 0.5) { ctx.beginPath(); ctx.roundRect(cx - bW - 2, pT + cH - lH, bW, lH, [2,2,0,0]); ctx.fill(); }
      ctx.fillStyle = tH > 0.5 ? "#F97316" : (isDark ? "#1E293B" : "#F8FAFC");
      if (tH > 0.5) { ctx.beginPath(); ctx.roundRect(cx + 2, pT + cH - tH, bW, tH, [2,2,0,0]); ctx.fill(); }
      ctx.fillStyle = txt; ctx.font = "9px system-ui,sans-serif"; ctx.textAlign = "center";
      ctx.fillText(mo, cx, H - 8);
    });
  }, [thisYearData, lastYearData, isDark]);
  useEffect(() => { drawChart(); }, [drawChart]);
  useEffect(() => {
    const obs = new ResizeObserver(drawChart);
    if (chartContainerRef.current) obs.observe(chartContainerRef.current);
    return () => obs.disconnect();
  }, [drawChart]);

  const filtered = useMemo(() => invoices.filter(inv => {
    if (filter !== "All" && inv.status !== filter) return false;
    if (clientFilter !== "All" && inv.client !== clientFilter) return false;
    if (yearFilter !== "All" && !(inv.issuedDate || "").startsWith(yearFilter)) return false;
    if (monthFilter !== "All") {
      const ym = inv.issuedDate ? inv.issuedDate.slice(0, 7) : "";
      if (ym !== monthFilter) return false;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      const proj = projects.find(p => p.id === inv.projectId);
      const mp = proj && (proj.jobCode + " " + proj.name).toLowerCase().includes(q);
      if (!(inv.invoiceNo || "").toLowerCase().includes(q) && !(inv.client || "").toLowerCase().includes(q) &&
          !(inv.projectLabel || "").toLowerCase().includes(q) && !mp) return false;
    }
    return true;
  }).sort((a, b) => {
    const da = a.issuedDate || a.createdAt || "";
    const db = b.issuedDate || b.createdAt || "";
    return da > db ? -1 : da < db ? 1 : 0;
  }), [invoices, filter, clientFilter, yearFilter, monthFilter, search, projects]);

  // Month options derived from invoices that have dates
  const monthOptions = useMemo(() => {
    const seen = new Set();
    invoices.forEach(inv => { if (inv.issuedDate) seen.add(inv.issuedDate.slice(0, 7)); });
    return [...seen].sort().reverse();
  }, [invoices]);

  const recordPayment = () => {
    if (!paymentForm) return;
    const { invoiceId, amount, date, isCash } = paymentForm;
    const inv = invoices.find(i => i.id === invoiceId);
    if (!inv || !amount || isNaN(parseFloat(amount))) return;
    const newPmt = { id: Math.random().toString(36).slice(2, 9), amount: parseFloat(amount), date, isCash: !!isCash };
    const updPmts = [...getPayments(inv), newPmt];
    const newTotal = updPmts.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const newStatus = newTotal >= (parseFloat(inv.amount) || 0) ? "Paid" : newTotal > 0 ? "Partial" : inv.status;
    onUpdateInvoice(invoiceId, { payments: updPmts, status: newStatus });
    setPaymentForm(null);
  };

  const removePayment = (inv, pmtId) => {
    const updPmts = getPayments(inv).filter(p => p.id !== pmtId);
    const newTotal = updPmts.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    const newStatus = newTotal >= (parseFloat(inv.amount) || 0) ? "Paid"
      : newTotal > 0 ? "Partial"
      : (inv.dueDate && inv.dueDate < today ? "Overdue" : "Sent");
    onUpdateInvoice(inv.id, { payments: updPmts, status: newStatus });
  };

  const exportCsv = () => {
    const hdr = ["Invoice No","Type","Claim #","Claim %","Client","Project","Amount (Ex-GST)","GST","Amount (Inc-GST)","Received (Ex-GST)","Balance","Status","Issued","Due","Payment Terms","Notes"];
    const rows = filtered.map(inv => {
      const proj = projects.find(p => p.id === inv.projectId);
      const exAmt = parseFloat(inv.amount) || 0;
      const recEx = totalReceived(inv);
      const invType = inv.claimNo ? "Progress Claim" : inv.claimPct ? "Variation" : "Invoice";
      return [
        inv.invoiceNo || "", invType, inv.claimNo||"", inv.claimPct||"",
        inv.client || "",
        proj ? `${proj.jobCode||""} ${proj.name||""}`.trim() : (inv.projectLabel || ""),
        exAmt.toFixed(2), (exAmt*0.1).toFixed(2), (exAmt*1.1).toFixed(2),
        recEx.toFixed(2), balanceAmt(inv).toFixed(2),
        inv.status || "", inv.issuedDate || "", inv.dueDate || "",
        inv.paymentTerms ? `${inv.paymentTerms} days` : "",
        (inv.notes || "").replace(/[\r\n]+/g, " "),
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
    });
    const blob = new Blob([[hdr.join(","), ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "ASD_Invoices.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const exportBasCsv = (qData) => {
    const hdr = ["Quarter","Period Start","Period End","BAS Due","Invoices Issued","Income Ex-GST","GST Charged (1A)","GST Received on Payments","Payments Received (Cash)"];
    const row = [
      qData.label, qData.start, qData.end, qData.due,
      qData.invCount, qData.invoicedExGst.toFixed(2), qData.gstCharged.toFixed(2),
      qData.gstPmts.toFixed(2), qData.cashPmts.toFixed(2),
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(",");
    const blob = new Blob([[hdr.join(","), row].join("\n")], { type:"text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `ASD_BAS_${qData.key}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const ITAB = (k, label) => (
    <button key={k} onClick={() => setInnerTab(k)}
      style={{ background:"none", border:"none", borderBottom:`2px solid ${innerTab===k?"#F97316":"transparent"}`,
        color:innerTab===k?"#F97316":"var(--c-t4)", fontWeight:innerTab===k?800:500,
        fontSize:12, padding:"6px 14px", cursor:"pointer", marginBottom:-1, whiteSpace:"nowrap" }}>
      {label}
    </button>
  );
  const GBTN = (mode, label) => (
    <button onClick={() => setGstMode(mode)}
      style={{ background:gstMode===mode?"#F97316":"none", border:`1px solid ${gstMode===mode?"#F97316":"var(--c-border)"}`,
        borderRadius:5, padding:"3px 10px", color:gstMode===mode?"#fff":"var(--c-t4)", fontSize:11, fontWeight:700, cursor:"pointer" }}>
      {label}
    </button>
  );
  const yoyArrow = (curr, prev) => {
    if (!prev && !curr) return <span style={{color:"var(--c-t5)"}}>—</span>;
    if (!prev) return null;
    const pct = (curr - prev) / prev * 100;
    return <span style={{color:pct>=0?"#10B981":"#EF4444",fontWeight:700}}>{pct>=0?"▲":"▼"}{Math.abs(pct).toFixed(0)}%</span>;
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", minHeight:0 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:"1px solid var(--c-border)", marginBottom:14, flexShrink:0, flexWrap:"wrap", gap:6 }}>
        <div style={{ display:"flex", flexWrap:"wrap" }}>
          {ITAB("overview","📊 Overview")}
          {ITAB("invoices",`🧾 Invoices (${invoices.length})`)}
          {ITAB("jobs",`✅ Completed Jobs (${completedProjects.length})`)}
          {ITAB("bas","🏛 BAS & Tax")}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, paddingBottom:6, flexWrap:"wrap" }}>
          {nextBasDue&&(()=>{
            const d = Math.ceil((new Date(nextBasDue.due)-NOW)/86400000);
            const clr = d<=14?"#EF4444":d<=30?"#F59E0B":"#10B981";
            return <span onClick={()=>setInnerTab("bas")} title={`Next BAS due ${nextBasDue.due}`}
              style={{fontSize:10,fontWeight:700,color:clr,background:`${clr}18`,borderRadius:10,padding:"2px 8px",border:`1px solid ${clr}44`,cursor:"pointer"}}>
              BAS due in {d}d
            </span>;
          })()}
          <span style={{ fontSize:10, color:"var(--c-t5)", fontWeight:700 }}>GST:</span>
          {GBTN("ex","Ex-GST")} {GBTN("inc","Inc-GST")}
        </div>
      </div>

      {/* OVERVIEW */}
      {innerTab==="overview"&&(
        <div style={{ flex:1, overflowY:"auto", minHeight:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
            <span style={{ fontSize:11, fontWeight:700, color:"var(--c-t4)" }}>Year:</span>
            <select value={analyticsYear} onChange={e=>setAnalyticsYear(Number(e.target.value))} style={{ ...IS, padding:"3px 8px", fontSize:11 }}>
              {yearOptions.map(y=><option key={y} value={y}>{y}</option>)}
            </select>
            <span style={{ fontSize:11, color:"var(--c-t5)" }}>compared to {analyticsYear-1}</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:10, marginBottom:18 }}>
            {[
              { clr:"#EF4444", label:"Outstanding", val:fmt(outstanding,false), sub:"Balance remaining" },
              { clr:"#EF4444", label:"Overdue", val:String(overdueCount), sub:`Invoice${overdueCount!==1?"s":""}` },
              { clr:"#10B981", label:`Paid ${analyticsYear}`, val:fmtAud(gstMode==="inc"?paidYTD*1.1:paidYTD), sub:"Payments received" },
              { clr:"#3B82F6", label:`Paid ${analyticsYear-1}`, val:fmtAud(gstMode==="inc"?paidPrevYTD*1.1:paidPrevYTD), sub:"Prior year" },
              { clr:"#F59E0B", label:"Uninvoiced Jobs", val:String(uninvoicedCount), sub:"Completed, not billed" },
            ].map(({clr,label,val,sub})=>(
              <div key={label} style={{ background:`${clr}15`, border:`1px solid ${clr}40`, borderRadius:8, padding:"12px 14px" }}>
                <div style={{ fontSize:10, fontWeight:800, color:clr, textTransform:"uppercase", marginBottom:4 }}>{label}</div>
                <div style={{ fontSize:18, fontWeight:900, color:clr, fontVariantNumeric:"tabular-nums" }}>{val}</div>
                <div style={{ fontSize:10, color:clr, opacity:0.7, marginTop:2 }}>{sub}</div>
              </div>
            ))}
          </div>
          <div style={{ background:"var(--c-panel)", border:"1px solid var(--c-border2)", borderRadius:10, padding:"14px 16px", marginBottom:18 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
              <div style={{ fontSize:12, fontWeight:800, color:"var(--c-t2)" }}>Monthly Revenue — {analyticsYear} vs {analyticsYear-1}</div>
              <div style={{ display:"flex", gap:12 }}>
                <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:10, color:"var(--c-t4)" }}><div style={{ width:10,height:10,borderRadius:2,background:"#F97316" }}/>{analyticsYear}</div>
                <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:10, color:"var(--c-t4)" }}><div style={{ width:10,height:10,borderRadius:2,background:isDark?"#334155":"#CBD5E1" }}/>{analyticsYear-1}</div>
              </div>
            </div>
            <div ref={chartContainerRef} style={{ width:"100%" }}><canvas ref={chartCanvasRef} style={{ display:"block" }}/></div>
          </div>
          <div style={{ background:"var(--c-panel)", border:"1px solid var(--c-border2)", borderRadius:10, padding:"14px 16px", marginBottom:18 }}>
            <div style={{ fontSize:12, fontWeight:800, color:"var(--c-t2)", marginBottom:10 }}>Month-by-Month — {analyticsYear} vs {analyticsYear-1}</div>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                <thead><tr>{["Month",analyticsYear,analyticsYear-1,"vs Prior","Diff"].map(h=>(
                  <th key={h} style={{ textAlign:h==="Month"?"left":"right", padding:"4px 10px", borderBottom:"1px solid var(--c-border)", color:"var(--c-t4)", fontWeight:700, fontSize:10, textTransform:"uppercase", whiteSpace:"nowrap" }}>{h}</th>
                ))}</tr></thead>
                <tbody>
                  {MONTHS.map((mo,i)=>{
                    const curr=thisYearData[i], prev=lastYearData[i], diff=curr-prev;
                    return (
                      <tr key={mo} style={{ borderBottom:"1px solid var(--c-border2)" }}>
                        <td style={{ padding:"5px 10px", color:"var(--c-t2)", fontWeight:600 }}>{mo}</td>
                        <td style={{ padding:"5px 10px", textAlign:"right", color:curr>0?"var(--c-t1)":"var(--c-t5)", fontVariantNumeric:"tabular-nums" }}>{curr>0?fmtAud(curr):"—"}</td>
                        <td style={{ padding:"5px 10px", textAlign:"right", color:prev>0?"var(--c-t3)":"var(--c-t5)", fontVariantNumeric:"tabular-nums" }}>{prev>0?fmtAud(prev):"—"}</td>
                        <td style={{ padding:"5px 10px", textAlign:"right" }}>{curr>0||prev>0?yoyArrow(curr,prev):"—"}</td>
                        <td style={{ padding:"5px 10px", textAlign:"right", color:diff>=0?"#10B981":"#EF4444", fontVariantNumeric:"tabular-nums" }}>{curr>0||prev>0?`${diff>=0?"+":""}${fmtAud(diff)}`:"—"}</td>
                      </tr>
                    );
                  })}
                  <tr style={{ borderTop:"2px solid var(--c-border)", background:"var(--c-deep)" }}>
                    <td style={{ padding:"6px 10px", fontWeight:800, color:"var(--c-t2)" }}>Total</td>
                    {[thisYearData,lastYearData].map((d,di)=>(
                      <td key={di} style={{ padding:"6px 10px", textAlign:"right", fontWeight:800, color:di===0?"#F97316":"var(--c-t3)", fontVariantNumeric:"tabular-nums" }}>{fmtAud(d.reduce((s,v)=>s+v,0))}</td>
                    ))}
                    <td style={{ padding:"6px 10px", textAlign:"right" }}>{yoyArrow(thisYearData.reduce((s,v)=>s+v,0),lastYearData.reduce((s,v)=>s+v,0))}</td>
                    <td style={{ padding:"6px 10px", textAlign:"right", fontWeight:800, fontVariantNumeric:"tabular-nums" }}>
                      {(()=>{const d=thisYearData.reduce((s,v)=>s+v,0)-lastYearData.reduce((s,v)=>s+v,0);return<span style={{color:d>=0?"#10B981":"#EF4444"}}>{d>=0?"+":""}{fmtAud(d)}</span>;})()}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          {clientAnalytics.length>0&&(
            <div style={{ background:"var(--c-panel)", border:"1px solid var(--c-border2)", borderRadius:10, padding:"14px 16px", marginBottom:18 }}>
              <div style={{ fontSize:12, fontWeight:800, color:"var(--c-t2)", marginBottom:10 }}>By Client / Fabricator — {analyticsYear}</div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                  <thead><tr>{["Client","Invoices","Total Invoiced","Received","Balance","Avg Days to Pay"].map(h=>(
                    <th key={h} style={{ textAlign:h==="Client"?"left":"right", padding:"4px 10px", borderBottom:"1px solid var(--c-border)", color:"var(--c-t4)", fontWeight:700, fontSize:10, textTransform:"uppercase" }}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {clientAnalytics.map(([cl,d])=>{
                      const avgD = avgDaysToPay[cl];
                      const dClr = !avgD ? "var(--c-t5)" : avgD <= 14 ? "#10B981" : avgD <= 30 ? "#F59E0B" : "#EF4444";
                      return (
                        <tr key={cl} style={{ borderBottom:"1px solid var(--c-border2)" }}>
                          <td style={{ padding:"6px 10px", color:"#F97316", fontWeight:800, fontFamily:"monospace" }}>{cl}</td>
                          <td style={{ padding:"6px 10px", textAlign:"right", color:"var(--c-t3)" }}>{d.count}</td>
                          <td style={{ padding:"6px 10px", textAlign:"right", fontWeight:700, color:"var(--c-t1)", fontVariantNumeric:"tabular-nums" }}>{fmtAud(d.invoiced)}</td>
                          <td style={{ padding:"6px 10px", textAlign:"right", fontWeight:700, color:"#10B981", fontVariantNumeric:"tabular-nums" }}>{fmtAud(d.received)}</td>
                          <td style={{ padding:"6px 10px", textAlign:"right", fontWeight:700, color:d.balance>0?"#EF4444":"var(--c-t5)", fontVariantNumeric:"tabular-nums" }}>{d.balance>0?fmtAud(d.balance):"—"}</td>
                          <td style={{ padding:"6px 10px", textAlign:"right", color:dClr, fontWeight:avgD?700:400 }}>{avgD?`${avgD}d`:"—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Aged Receivables */}
          {agedReceivables.total>0&&(
            <div style={{ background:"var(--c-panel)", border:"1px solid var(--c-border2)", borderRadius:10, padding:"14px 16px", marginBottom:18 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <div style={{ fontSize:12, fontWeight:800, color:"var(--c-t2)" }}>Aged Receivables</div>
                <div style={{ fontSize:12, fontWeight:900, color:"#EF4444", fontVariantNumeric:"tabular-nums" }}>{fmtAud(agedReceivables.total)} total outstanding</div>
              </div>
              {[
                { key:"current", label:"Not Yet Due", clr:"#10B981" },
                { key:"d30",    label:"1–30 Days Overdue", clr:"#F59E0B" },
                { key:"d60",    label:"31–60 Days Overdue", clr:"#F97316" },
                { key:"d90",    label:"61–90 Days Overdue", clr:"#EF4444" },
                { key:"d90plus",label:"90+ Days — Action Required", clr:"#991B1B" },
              ].map(({ key, label, clr }) => {
                const v = agedReceivables.buckets[key], c = agedReceivables.counts[key];
                if (!v) return null;
                const pct = (v / agedReceivables.total * 100).toFixed(0);
                return (
                  <div key={key} style={{ marginBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:3 }}>
                      <span style={{ color:"var(--c-t3)", fontWeight:600 }}>{label} <span style={{ color:"var(--c-t5)" }}>({c} inv.)</span></span>
                      <span style={{ color:clr, fontWeight:800, fontVariantNumeric:"tabular-nums" }}>{fmtAud(v)}</span>
                    </div>
                    <div style={{ height:5, background:"var(--c-deep)", borderRadius:3 }}>
                      <div style={{ height:"100%", width:`${pct}%`, background:clr, borderRadius:3, transition:"width .3s" }}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Cash Flow Forecast */}
          <div style={{ background:"var(--c-panel)", border:"1px solid var(--c-border2)", borderRadius:10, padding:"14px 16px" }}>
            <div style={{ fontSize:12, fontWeight:800, color:"var(--c-t2)", marginBottom:12 }}>Cash Flow Forecast — Expected Collections</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
              {[
                { label:"Overdue", val:cashFlow.overdue, clr:"#EF4444", sub:"Collect now" },
                { label:"Next 30 Days", val:cashFlow.n30, clr:"#F97316", sub:`Due by ${new Date(Date.now()+30*86400000).toLocaleDateString("en-AU",{day:"numeric",month:"short"})}` },
                { label:"31–60 Days", val:cashFlow.n60, clr:"#F59E0B", sub:"Upcoming" },
                { label:"61–90 Days", val:cashFlow.n90, clr:"#3B82F6", sub:"Planned" },
              ].map(({ label, val, clr, sub }) => (
                <div key={label} style={{ background:`${clr}12`, border:`1px solid ${clr}30`, borderRadius:8, padding:"10px 12px" }}>
                  <div style={{ fontSize:9, fontWeight:800, color:clr, textTransform:"uppercase", marginBottom:4 }}>{label}</div>
                  <div style={{ fontSize:15, fontWeight:900, color:val>0?clr:"var(--c-t5)", fontVariantNumeric:"tabular-nums" }}>{val>0?fmtAud(val):"—"}</div>
                  <div style={{ fontSize:9, color:"var(--c-t5)", marginTop:2 }}>{sub}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* INVOICES LIST */}
      {innerTab==="invoices"&&(
        <div style={{ display:"flex", flexDirection:"column", flex:1, minHeight:0 }}>
          <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap", alignItems:"center", flexShrink:0 }}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search invoice, client, project…" style={{ ...IS, flex:"1 1 140px", minWidth:0 }}/>
            <select value={clientFilter} onChange={e=>{ setClientFilter(e.target.value); setMonthFilter("All"); }} style={{ ...IS, minWidth:110 }}>
              <option value="All">All fabricators</option>{allClients.map(c=><option key={c}>{c}</option>)}
            </select>
            <select value={filter} onChange={e=>setFilter(e.target.value)} style={{ ...IS, minWidth:100 }}>
              <option value="All">All statuses</option>{INVOICE_STATUSES.map(s=><option key={s}>{s}</option>)}
            </select>
            <select value={monthFilter} onChange={e=>{ setMonthFilter(e.target.value); if(e.target.value!=="All") setYearFilter("All"); }} style={{ ...IS, minWidth:110 }}>
              <option value="All">All months</option>
              {monthOptions.map(ym=>{
                const [y,m] = ym.split("-");
                const label = new Date(parseInt(y), parseInt(m)-1, 1).toLocaleDateString("en-AU",{month:"long",year:"numeric"});
                return <option key={ym} value={ym}>{label}</option>;
              })}
            </select>
            <select value={yearFilter} onChange={e=>{ setYearFilter(e.target.value); if(e.target.value!=="All") setMonthFilter("All"); }} style={{ ...IS, minWidth:75 }}>
              <option value="All">All years</option>{yearOptions.map(y=><option key={y} value={String(y)}>{y}</option>)}
            </select>
            <button onClick={exportCsv} style={{ background:"none", border:"1px solid var(--c-border)", borderRadius:6, padding:"5px 10px", color:"var(--c-t4)", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" }}>↓ CSV</button>
            <button onClick={()=>setShowForm(true)} style={{ background:"#F97316", border:"none", borderRadius:6, padding:"6px 14px", color:"#fff", fontWeight:800, fontSize:12, cursor:"pointer", whiteSpace:"nowrap" }}>+ New Invoice</button>
          </div>
          <div style={{ flex:1, overflowY:"auto", minHeight:0 }}>
            {filtered.length===0?(
              <div style={{ textAlign:"center", color:"var(--c-t5)", padding:"48px 0", fontSize:13 }}>
                {invoices.length===0?"No invoices yet — create your first above.":"No invoices match the filters."}
              </div>
            ):(()=>{
              // Group by month
              const groups = [];
              let lastYM = null;
              filtered.forEach(inv => {
                const ym = inv.issuedDate ? inv.issuedDate.slice(0,7) : "Unknown";
                if (ym !== lastYM) { groups.push({ ym, invs:[] }); lastYM = ym; }
                groups[groups.length-1].invs.push(inv);
              });
              const fmtYM = ym => {
                if (ym === "Unknown") return "Date Unknown";
                const [y,m] = ym.split("-");
                return new Date(parseInt(y),parseInt(m)-1,1).toLocaleDateString("en-AU",{month:"long",year:"numeric"});
              };
              return (
              <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
                {groups.map(({ ym, invs }) => {
                  const grpTotal = invs.reduce((s,i)=>s+(parseFloat(i.amount)||0),0);
                  return (
                    <div key={ym}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 4px 6px", borderBottom:"1px solid var(--c-border2)", marginBottom:6 }}>
                        <span style={{ fontSize:11, fontWeight:800, color:"var(--c-t3)", textTransform:"uppercase", letterSpacing:".5px" }}>{fmtYM(ym)}</span>
                        <span style={{ fontSize:11, color:"var(--c-t5)", fontVariantNumeric:"tabular-nums" }}>{invs.length} invoice{invs.length>1?"s":""} · {fmtAud(grpTotal)} ex-GST</span>
                      </div>
                      <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:14 }}>
                {invs.map(inv=>{
                  const proj = projects.find(p=>p.id===inv.projectId);
                  const sc = INVOICE_STATUS_CLR[inv.status]||"#64748B";
                  const pmts = getPayments(inv);
                  const recvd = totalReceived(inv);
                  const bal = balanceAmt(inv);
                  const isExp = expandedInv===inv.id;
                  const isRec = paymentForm?.invoiceId===inv.id;
                  // Age badge
                  const dueMs = inv.dueDate ? new Date(inv.dueDate).getTime() : null;
                  const daysOverdue = dueMs ? Math.floor((NOW - dueMs) / 86400000) : null;
                  const ageBadge = inv.status!=="Paid" && daysOverdue!==null && daysOverdue>0 ? daysOverdue : null;
                  const ageClr = ageBadge ? (ageBadge>90?"#991B1B":ageBadge>60?"#EF4444":ageBadge>30?"#F97316":"#F59E0B") : null;
                  return (
                    <div key={inv.id} style={{ background:"var(--c-panel)", border:"1px solid var(--c-border2)", borderRadius:8, overflow:"hidden" }}>
                      <div style={{ padding:"11px 14px", display:"flex", alignItems:isMob?"flex-start":"center", gap:12, flexWrap:isMob?"wrap":"nowrap" }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3, flexWrap:"wrap" }}>
                            <span style={{ fontSize:13, fontWeight:800, color:"#F97316", fontFamily:"monospace" }}>{inv.invoiceNo||"—"}</span>
                            <span style={{ fontSize:10, fontWeight:700, color:sc, background:`${sc}18`, borderRadius:10, padding:"1px 8px", border:`1px solid ${sc}44` }}>{inv.status}</span>
                            {inv.client&&<span style={{ fontSize:11, color:"var(--c-t3)", fontWeight:700 }}>{inv.client}</span>}
                            {pmts.some(p=>p.isCash)&&<span title="Contains coin payment" style={{ fontSize:12 }}>🪙</span>}
                            {inv.claimNo&&<span style={{ fontSize:10, fontWeight:700, color:"#3B82F6", background:"#3B82F618", borderRadius:10, padding:"1px 8px", border:"1px solid #3B82F640" }}>Claim {inv.claimNo}{inv.claimPct?` (${inv.claimPct}%)`:""}</span>}
                            {ageBadge&&<span style={{ fontSize:10, fontWeight:800, color:ageClr, background:`${ageClr}18`, borderRadius:10, padding:"1px 8px", border:`1px solid ${ageClr}40` }}>{ageBadge}d overdue</span>}
                          </div>
                          <div style={{ fontSize:11, color:"var(--c-t4)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:2 }}>
                            {proj?`${proj.jobCode?proj.jobCode+" — ":""}${proj.name}`:(inv.projectLabel||"No project linked")}
                          </div>
                          <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
                            {inv.issuedDate&&<span style={{ fontSize:10, color:"var(--c-t5)" }}>Issued: {inv.issuedDate}</span>}
                            {inv.dueDate&&<span style={{ fontSize:10, color:inv.status==="Overdue"?"#EF4444":"var(--c-t5)" }}>Due: {inv.dueDate}</span>}
                            {recvd>0&&<span style={{ fontSize:10, color:bal<=0?"#10B981":"#F59E0B", fontWeight:700, fontVariantNumeric:"tabular-nums" }}>
                              {fmtAud(dispAmt(recvd,false))} received{bal>0?` · ${fmtAud(dispAmt(bal,false))} due`:""}
                            </span>}
                          </div>
                        </div>
                        <div style={{ textAlign:"right", flexShrink:0, marginRight:isMob?0:4 }}>
                          <div style={{ fontWeight:900, fontSize:15, color:"var(--c-t1)", fontVariantNumeric:"tabular-nums" }}>{fmt(inv.amount,false)}</div>
                          <div style={{ fontSize:9, color:"var(--c-t5)" }}>{gstMode==="inc"?"inc-GST":"ex-GST"}</div>
                        </div>
                        {/* Action buttons — full row on desktop, own line on mobile */}
                        <div style={{ display:"flex", gap:5, alignItems:"center", flexShrink:0, ...(isMob?{width:"100%",borderTop:"1px solid var(--c-border2)",paddingTop:8,marginTop:2}:{}) }}>
                          <button onClick={()=>setExpandedInv(isExp?null:inv.id)}
                            style={{ background:isExp?"#F9731620":"none", border:`1px solid ${isExp?"#F97316":"var(--c-border)"}`, borderRadius:5, padding:"5px 9px", color:isExp?"#F97316":"var(--c-t4)", cursor:"pointer", fontSize:11, fontWeight:700 }}>
                            💰{pmts.length>0?` ${pmts.length}`:""}
                          </button>
                          {inv.status!=="Paid"&&bal>0&&(
                            <button onClick={()=>payFull(inv)}
                              title={`Record full balance: ${fmtAud(dispAmt(bal,false))}`}
                              style={{ background:"#10B98120", border:"1px solid #10B98150", borderRadius:5, padding:"5px 9px", color:"#10B981", fontSize:11, fontWeight:800, cursor:"pointer" }}>✓ Full</button>
                          )}
                          {inv.status!=="Paid"&&(
                            <button onClick={()=>setPaymentForm({invoiceId:inv.id,amount:"",date:new Date().toISOString().slice(0,10),isCash:false})}
                              style={{ background:"#3B82F620", border:"1px solid #3B82F650", borderRadius:5, padding:"5px 9px", color:"#3B82F6", fontSize:11, fontWeight:800, cursor:"pointer" }}>+ Pay</button>
                          )}
                          <button onClick={()=>setSendDocInv(inv)}
                            title="Send / Print document"
                            style={{ background:"#8B5CF620", border:"1px solid #8B5CF650", borderRadius:5, padding:"5px 9px", color:"#8B5CF6", fontSize:11, fontWeight:800, cursor:"pointer" }}>✉ Send</button>
                          {!isMob&&<button onClick={()=>{ onAddInvoice(mkDup(inv)); }}
                            title="Duplicate invoice"
                            style={{ background:"none", border:"1px solid var(--c-border)", borderRadius:5, padding:"5px 9px", color:"var(--c-t4)", cursor:"pointer", fontSize:11, fontWeight:700 }}>⧉</button>}
                          <button onClick={()=>setEditing(inv)} style={{ background:"none", border:"1px solid var(--c-border)", borderRadius:5, padding:"5px 9px", color:"var(--c-t4)", cursor:"pointer", fontSize:12 }}>✎</button>
                          <button onClick={()=>setConfirmRemove(inv.id)} style={{ background:"none", border:"none", color:"#EF4444", cursor:"pointer", fontSize:16, padding:"2px 4px", lineHeight:1, marginLeft:"auto" }}>×</button>
                        </div>
                      </div>
                      {(isExp||isRec)&&(
                        <div style={{ borderTop:"1px solid var(--c-border2)", background:"var(--c-page)", padding:"10px 14px" }}>
                          {pmts.length>0&&(
                            <div style={{ marginBottom:8 }}>
                              {pmts.map(p=>(
                                <div key={p.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 0", borderBottom:"1px solid var(--c-border2)" }}>
                                  {p.isCash?<span title="Coin payment – no GST" style={{ fontSize:13 }}>🪙</span>:<span style={{ fontSize:13, opacity:0.3 }}>💳</span>}
                                  <span style={{ fontSize:11, color:"var(--c-t2)", fontWeight:700, fontVariantNumeric:"tabular-nums" }}>
                                    {fmtAud(dispAmt(p.amount,p.isCash))}
                                    {p.isCash&&gstMode==="inc"&&<span style={{ fontSize:9, color:"var(--c-t5)", marginLeft:5 }}>no GST</span>}
                                  </span>
                                  <span style={{ fontSize:10, color:"var(--c-t5)", flex:1 }}>{p.date}</span>
                                  <button onClick={()=>removePayment(inv,p.id)} style={{ background:"none",border:"none",color:"#EF444480",cursor:"pointer",fontSize:13,padding:"0 2px" }}>×</button>
                                </div>
                              ))}
                              <div style={{ display:"flex", justifyContent:"space-between", padding:"6px 0 2px", fontSize:11 }}>
                                <span style={{ color:"var(--c-t4)", fontWeight:700 }}>Total received</span>
                                <span style={{ fontWeight:800, color:"#10B981", fontVariantNumeric:"tabular-nums" }}>{fmtAud(totalReceivedDisp(inv))}</span>
                              </div>
                              {bal>0&&<div style={{ display:"flex", justifyContent:"space-between", fontSize:11 }}>
                                <span style={{ color:"var(--c-t4)", fontWeight:700 }}>Balance remaining</span>
                                <span style={{ fontWeight:800, color:"#EF4444", fontVariantNumeric:"tabular-nums" }}>{fmtAud(dispAmt(bal,false))}</span>
                              </div>}
                            </div>
                          )}
                          {pmts.length===0&&!isRec&&<div style={{ fontSize:11, color:"var(--c-t5)", textAlign:"center", padding:"8px 0" }}>No payments recorded yet.</div>}
                          {isRec&&(
                            <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginTop:pmts.length>0?8:0, paddingTop:pmts.length>0?8:0, borderTop:pmts.length>0?"1px solid var(--c-border2)":undefined }}>
                              <input type="number" min="0" step="0.01" placeholder="Amount" value={paymentForm.amount}
                                onChange={e=>setPaymentForm(f=>({...f,amount:e.target.value}))} style={{ ...IS, width:110, flexShrink:0 }}/>
                              <input type="date" value={paymentForm.date}
                                onChange={e=>setPaymentForm(f=>({...f,date:e.target.value}))} style={{ ...IS, flexShrink:0 }}/>
                              <button onClick={()=>setPaymentForm(f=>({...f,isCash:!f.isCash}))}
                                title={paymentForm.isCash?"🪙 Coin payment (GST-free) – click to switch":"💳 Toggle to coin payment"}
                                style={{ background:paymentForm.isCash?"#F59E0B20":"none", border:`1px solid ${paymentForm.isCash?"#F59E0B":"var(--c-border)"}`, borderRadius:5, padding:"4px 10px", cursor:"pointer", fontSize:15 }}>
                                {paymentForm.isCash?"🪙":"💳"}
                              </button>
                              <button onClick={recordPayment} style={{ background:"#10B981", border:"none", borderRadius:5, padding:"5px 14px", color:"#fff", fontWeight:800, fontSize:11, cursor:"pointer" }}>Record</button>
                              <button onClick={()=>setPaymentForm(null)} style={{ background:"none", border:"1px solid var(--c-border)", borderRadius:5, padding:"5px 10px", color:"var(--c-t4)", fontSize:11, cursor:"pointer" }}>Cancel</button>
                            </div>
                          )}
                          {!isRec&&inv.status!=="Paid"&&(
                            <button onClick={()=>setPaymentForm({invoiceId:inv.id,amount:"",date:new Date().toISOString().slice(0,10),isCash:false})}
                              style={{ marginTop:6, background:"#10B98115", border:"1px solid #10B98140", borderRadius:5, padding:"4px 12px", color:"#10B981", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                              + Record Payment
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                      </div>
                    </div>
                  );
                })}
              </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* COMPLETED JOBS */}
      {innerTab==="jobs"&&(()=>{
        // Filter + sort
        const sortedJobs = [...completedProjects].sort((a,b)=>{
          const da = a.completedDate || a.due || "";
          const db = b.completedDate || b.due || "";
          return da > db ? -1 : da < db ? 1 : 0;
        });
        const jobsList = sortedJobs.filter(p=>{
          if (jobsClientFilter !== "All" && p.client !== jobsClientFilter) return false;
          if (jobsFilter === "uninvoiced" && projInvs(p.id).length > 0) return false;
          return true;
        });

        // Group by completion month
        const jobGroups = [];
        let lastJobYM = null;
        jobsList.forEach(proj => {
          const d = proj.completedDate || proj.due || "";
          const ym = d ? d.slice(0,7) : "Unknown";
          if (ym !== lastJobYM) { jobGroups.push({ ym, projects:[] }); lastJobYM = ym; }
          jobGroups[jobGroups.length-1].projects.push(proj);
        });
        const fmtJobYM = ym => {
          if (ym === "Unknown") return "Date Unknown";
          const [y,m] = ym.split("-");
          return new Date(parseInt(y),parseInt(m)-1,1).toLocaleDateString("en-AU",{month:"long",year:"numeric"});
        };

        return (
        <div style={{ display:"flex", flexDirection:"column", flex:1, minHeight:0 }}>
          {/* Filters */}
          <div style={{ display:"flex", gap:8, marginBottom:12, alignItems:"center", flexShrink:0, flexWrap:"wrap" }}>
            <select value={jobsClientFilter} onChange={e=>setJobsClientFilter(e.target.value)} style={{ ...IS, minWidth:120 }}>
              <option value="All">All fabricators</option>
              {allClients.map(c=><option key={c}>{c}</option>)}
            </select>
            {[["all","All Jobs"],["uninvoiced",`Pending Invoice (${uninvoicedCount})`]].map(([k,l])=>(
              <button key={k} onClick={()=>setJobsFilter(k)}
                style={{ background:jobsFilter===k?"#F97316":"none", border:`1px solid ${jobsFilter===k?"#F97316":"var(--c-border)"}`,
                  borderRadius:5, padding:"4px 12px", color:jobsFilter===k?"#fff":"var(--c-t4)", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                {l}
              </button>
            ))}
            <span style={{ marginLeft:"auto", fontSize:11, color:"var(--c-t5)" }}>{jobsList.length} job{jobsList.length!==1?"s":""}</span>
          </div>
          <div style={{ flex:1, overflowY:"auto", minHeight:0 }}>
            {jobsList.length===0?(
              <div style={{ textAlign:"center", color:"var(--c-t5)", padding:"48px 0", fontSize:13 }}>
                {completedProjects.length===0?"No completed projects yet.":"No jobs match the filters."}
              </div>
            ):(
              <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
                {jobGroups.map(({ ym, projects:grpProjs }) => (
                  <div key={ym}>
                    {/* Month header */}
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 4px 6px", borderBottom:"1px solid var(--c-border2)", marginBottom:6 }}>
                      <span style={{ fontSize:11, fontWeight:800, color:"var(--c-t3)", textTransform:"uppercase", letterSpacing:".5px" }}>{fmtJobYM(ym)}</span>
                      <span style={{ fontSize:11, color:"var(--c-t5)" }}>{grpProjs.length} job{grpProjs.length!==1?"s":""}</span>
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:14 }}>
                      {grpProjs.map(proj=>{
                        const pinvs = projInvs(proj.id);
                        const totInv = pinvs.reduce((s,i)=>s+(parseFloat(i.amount)||0),0);
                        const totRecv = pinvs.reduce((s,i)=>s+totalReceived(i),0);
                        const isUnbilled = pinvs.length===0;
                        const isExpanded = expandedJob===proj.id;
                        const fullyPaid = totInv>0 && totRecv>=totInv;
                        const partial = totRecv>0 && totRecv<totInv;
                        return (
                          <div key={proj.id} style={{ background:"var(--c-panel)", border:`1px solid ${isUnbilled?"#F59E0B44":fullyPaid?"#10B98130":"var(--c-border2)"}`, borderRadius:8, overflow:"hidden" }}>
                            {/* Job header row */}
                            <div style={{ padding:"10px 14px", display:"flex", alignItems:"center", gap:10 }}>
                              {/* Expand toggle */}
                              <button onClick={()=>setExpandedJob(isExpanded?null:proj.id)}
                                style={{ background:"none", border:"none", color:"var(--c-t5)", cursor:"pointer", fontSize:13, padding:"0 2px", flexShrink:0, lineHeight:1 }}>
                                {isExpanded?"▾":"▸"}
                              </button>
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3, flexWrap:"wrap" }}>
                                  {proj.jobCode&&<span style={{ fontSize:12, fontWeight:800, color:"#F97316", fontFamily:"monospace" }}>{proj.jobCode}</span>}
                                  <span style={{ fontSize:12, fontWeight:700, color:"var(--c-t1)" }}>{proj.name}</span>
                                  {proj.client&&<span style={{ fontSize:10, color:"var(--c-t4)", fontWeight:700, background:"var(--c-deep)", borderRadius:4, padding:"1px 6px" }}>{proj.client}</span>}
                                  {proj.status==="APPROVED-READY TO ISSUE"&&<span style={{ fontSize:9, fontWeight:700, color:"#3B82F6", background:"#3B82F615", borderRadius:4, padding:"1px 6px", border:"1px solid #3B82F630" }}>Ready to Issue</span>}
                                </div>
                                <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                                  {proj.completedDate&&<span style={{ fontSize:10, color:"var(--c-t5)" }}>Completed: <b style={{color:"var(--c-t4)"}}>{proj.completedDate}</b></span>}
                                  {proj.due&&<span style={{ fontSize:10, color:"var(--c-t5)" }}>Due: {proj.due}</span>}
                                  {isUnbilled
                                    ? <span style={{ fontSize:10, color:"#F59E0B", fontWeight:700 }}>⚠ Pending invoice</span>
                                    : fullyPaid
                                      ? <span style={{ fontSize:10, color:"#10B981", fontWeight:700 }}>✓ Fully paid</span>
                                      : partial
                                        ? <span style={{ fontSize:10, color:"#F59E0B", fontWeight:700 }}>{pinvs.length} invoice{pinvs.length>1?"s":""} · {fmt(totRecv,false)} of {fmt(totInv,false)} received</span>
                                        : <span style={{ fontSize:10, color:"#3B82F6", fontWeight:700 }}>{pinvs.length} invoice{pinvs.length>1?"s":""} · {fmt(totInv,false)} invoiced</span>
                                  }
                                </div>
                              </div>
                              <div style={{ display:"flex", gap:8, flexShrink:0, alignItems:"center" }}>
                                {totInv>0&&<div style={{ fontSize:13, fontWeight:900, color:fullyPaid?"#10B981":"var(--c-t1)", fontVariantNumeric:"tabular-nums" }}>{fmt(totInv,false)}</div>}
                                <button onClick={()=>{ setPrefillProj(proj); setShowForm(true); }}
                                  style={{ background:isUnbilled?"#F97316":"var(--c-deep)", border:`1px solid ${isUnbilled?"#F97316":"var(--c-border)"}`, borderRadius:6, padding:"5px 12px", color:isUnbilled?"#fff":"var(--c-t3)", fontWeight:800, fontSize:11, cursor:"pointer", whiteSpace:"nowrap" }}>
                                  {isUnbilled?"+ Invoice":"+ Progress Claim"}
                                </button>
                              </div>
                            </div>
                            {/* Expanded: show invoices under this job */}
                            {isExpanded&&pinvs.length>0&&(
                              <div style={{ borderTop:"1px solid var(--c-border2)", background:"var(--c-page)", padding:"8px 14px 10px" }}>
                                <div style={{ fontSize:10, fontWeight:800, color:"var(--c-t5)", marginBottom:6, textTransform:"uppercase", letterSpacing:".4px" }}>Invoices for this job</div>
                                <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                                  {pinvs.map(inv=>{
                                    const sc = INVOICE_STATUS_CLR[inv.status]||"#64748B";
                                    const invBal = balanceAmt(inv);
                                    return (
                                      <div key={inv.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 10px", background:"var(--c-panel)", borderRadius:6, border:"1px solid var(--c-border2)" }}>
                                        <span style={{ fontSize:12, fontWeight:800, color:"#F97316", fontFamily:"monospace", minWidth:60 }}>{inv.invoiceNo||"—"}</span>
                                        <span style={{ fontSize:10, fontWeight:700, color:sc, background:`${sc}18`, borderRadius:8, padding:"1px 7px", border:`1px solid ${sc}33` }}>{inv.status}</span>
                                        {inv.claimNo&&<span style={{ fontSize:10, color:"#3B82F6", fontWeight:700 }}>Claim {inv.claimNo}{inv.claimPct?` · ${inv.claimPct}%`:""}</span>}
                                        <span style={{ fontSize:10, color:"var(--c-t5)", flex:1 }}>{inv.issuedDate||""}</span>
                                        <span style={{ fontSize:12, fontWeight:800, color:"var(--c-t2)", fontVariantNumeric:"tabular-nums" }}>{fmt(inv.amount,false)}</span>
                                        {invBal>0&&<span style={{ fontSize:10, color:"#EF4444", fontWeight:700, fontVariantNumeric:"tabular-nums" }}>bal {fmt(invBal,false)}</span>}
                                        <button onClick={()=>setSendDocInv(inv)} style={{ background:"none", border:"1px solid var(--c-border)", borderRadius:4, padding:"3px 7px", color:"#8B5CF6", fontSize:10, fontWeight:700, cursor:"pointer" }}>✉</button>
                                        <button onClick={()=>setEditing(inv)} style={{ background:"none", border:"1px solid var(--c-border)", borderRadius:4, padding:"3px 7px", color:"var(--c-t4)", fontSize:10, cursor:"pointer" }}>✎</button>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {isExpanded&&pinvs.length===0&&(
                              <div style={{ borderTop:"1px solid var(--c-border2)", padding:"10px 14px", fontSize:11, color:"var(--c-t5)" }}>No invoices yet — click + Invoice above.</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* BAS & TAX TAB */}
      {innerTab==="bas"&&(()=>{
        const bd = basData.find(b=>b.key===selBasQ);
        return (
        <div style={{ display:"flex", flexDirection:"column", flex:1, minHeight:0, overflowY:"auto" }}>
          {/* Quarter selector */}
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16, flexWrap:"wrap" }}>
            <div style={{ fontSize:13, fontWeight:800, color:"var(--c-t2)" }}>Quarter:</div>
            <select value={selBasQ} onChange={e=>setSelBasQ(e.target.value)}
              style={{ ...IS, width:"auto" }}>
              {ALL_QUARTERS.map(q=><option key={q.key} value={q.key}>{q.label}</option>)}
            </select>
            {nextBasDue&&(()=>{
              const d=Math.ceil((new Date(nextBasDue.due)-NOW)/86400000);
              const clr=d<=14?"#EF4444":d<=30?"#F59E0B":"#10B981";
              return <span style={{ fontSize:11, fontWeight:700, color:clr, padding:"4px 10px", background:`${clr}15`, border:`1px solid ${clr}40`, borderRadius:8 }}>
                BAS due in {d}d — {nextBasDue.label} by {nextBasDue.due}
              </span>;
            })()}
            <button onClick={()=>bd&&exportBasCsv(bd)} style={{ background:"none", border:"1px solid var(--c-border)", borderRadius:6, padding:"5px 10px", color:"var(--c-t4)", fontSize:11, fontWeight:700, cursor:"pointer", marginLeft:"auto" }}>↓ BAS CSV</button>
          </div>

          {/* Selected quarter BAS summary */}
          {bd ? (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12, marginBottom:18 }}>
              {[
                { label:"Total Invoiced (Ex-GST)", val:fmtAud(bd.invoicedExGst), clr:"#F97316", icon:"🧾" },
                { label:"GST Charged (10%)", val:fmtAud(bd.gstCharged), clr:"#EF4444", icon:"🏛" },
                { label:"Total Inc-GST", val:fmtAud(bd.invoicedExGst+bd.gstCharged), clr:"#3B82F6", icon:"💰" },
                { label:"Cash / Coin Pmts", val:fmtAud(bd.cashPmts), clr:"#F59E0B", icon:"🪙", sub:"GST-free" },
                { label:"GST on Card Pmts", val:fmtAud(bd.gstPmts), clr:"#8B5CF6", icon:"💳" },
              ].map(({ label, val, clr, icon, sub })=>(
                <div key={label} style={{ background:`${clr}12`, border:`1px solid ${clr}30`, borderRadius:10, padding:"12px 14px" }}>
                  <div style={{ fontSize:11, color:clr, fontWeight:800, marginBottom:6 }}>{icon} {label}</div>
                  <div style={{ fontSize:18, fontWeight:900, color:clr, fontVariantNumeric:"tabular-nums" }}>{val}</div>
                  {sub&&<div style={{ fontSize:9, color:"var(--c-t5)", marginTop:3 }}>{sub}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color:"var(--c-t5)", fontSize:12, padding:"24px 0", textAlign:"center" }}>No invoice data for selected quarter.</div>
          )}

          {/* BAS guidance box */}
          <div style={{ background:"var(--c-panel)", border:"1px solid var(--c-border2)", borderRadius:10, padding:"14px 16px", marginBottom:18 }}>
            <div style={{ fontSize:12, fontWeight:800, color:"var(--c-t2)", marginBottom:10 }}>Australian BAS — Reporting Deadlines</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:8 }}>
              {[
                { suffix:"Jul-Sep", qNum:1, dueText:"28 Oct" },
                { suffix:"Oct-Dec", qNum:2, dueText:"28 Feb" },
                { suffix:"Jan-Mar", qNum:3, dueText:"28 Apr" },
                { suffix:"Apr-Jun", qNum:4, dueText:"28 Jul" },
              ].map(({ suffix, qNum, dueText })=>{
                const bd2 = basData.find(b=>b.q===qNum);
                const isActive = nextBasDue?.q===qNum;
                return (
                  <div key={suffix} style={{ padding:"8px 10px", background:isActive?"#F9731612":"var(--c-deep)", border:`1px solid ${isActive?"#F9731640":"var(--c-border2)"}`, borderRadius:8 }}>
                    <div style={{ fontSize:10, fontWeight:800, color:isActive?"#F97316":"var(--c-t3)" }}>Q{qNum} {suffix}</div>
                    <div style={{ fontSize:10, color:"var(--c-t5)" }}>Due: {dueText}</div>
                    {bd2&&bd2.invoicedExGst>0&&<div style={{ fontSize:10, fontWeight:700, color:"#10B981", marginTop:2, fontVariantNumeric:"tabular-nums" }}>{fmtAud(bd2.invoicedExGst)} invoiced</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 8-quarter rolling table */}
          <div style={{ background:"var(--c-panel)", border:"1px solid var(--c-border2)", borderRadius:10, padding:"14px 16px" }}>
            <div style={{ fontSize:12, fontWeight:800, color:"var(--c-t2)", marginBottom:10 }}>Rolling 8-Quarter BAS History</div>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                <thead>
                  <tr>{["Quarter","Invoiced (Ex-GST)","GST Charged","Cash Pmts","GST on Pmts","Due Date"].map(h=>(
                    <th key={h} style={{ textAlign:h==="Quarter"?"left":"right", padding:"4px 10px", borderBottom:"1px solid var(--c-border)", color:"var(--c-t4)", fontWeight:700, fontSize:10, textTransform:"uppercase" }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {basData.map(row=>(
                    <tr key={row.key} onClick={()=>setSelBasQ(row.key)} style={{ borderBottom:"1px solid var(--c-border2)", background:row.key===selBasQ?"#F9731608":undefined, cursor:"pointer" }}>
                      <td style={{ padding:"6px 10px", color:row.key===selBasQ?"#F97316":"var(--c-t2)", fontWeight:row.key===selBasQ?800:600 }}>{row.label}</td>
                      <td style={{ padding:"6px 10px", textAlign:"right", fontVariantNumeric:"tabular-nums", color:"var(--c-t1)", fontWeight:700 }}>{row.invoicedExGst>0?fmtAud(row.invoicedExGst):"—"}</td>
                      <td style={{ padding:"6px 10px", textAlign:"right", fontVariantNumeric:"tabular-nums", color:"#EF4444", fontWeight:700 }}>{row.gstCharged>0?fmtAud(row.gstCharged):"—"}</td>
                      <td style={{ padding:"6px 10px", textAlign:"right", fontVariantNumeric:"tabular-nums", color:"#F59E0B" }}>{row.cashPmts>0?fmtAud(row.cashPmts):"—"}</td>
                      <td style={{ padding:"6px 10px", textAlign:"right", fontVariantNumeric:"tabular-nums", color:"#8B5CF6" }}>{row.gstPmts>0?fmtAud(row.gstPmts):"—"}</td>
                      <td style={{ padding:"6px 10px", textAlign:"right", color:row.daysUntilDue<=14?"#EF4444":row.daysUntilDue<=30?"#F59E0B":"var(--c-t4)", fontSize:10 }}>
                        {row.due}{row.daysUntilDue>=0&&row.daysUntilDue<=60?<span style={{ marginLeft:4, fontWeight:700 }}>({row.daysUntilDue}d)</span>:null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Tax tips */}
          <div style={{ background:"#3B82F612", border:"1px solid #3B82F630", borderRadius:10, padding:"14px 16px", marginTop:18 }}>
            <div style={{ fontSize:12, fontWeight:800, color:"#3B82F6", marginBottom:8 }}>Tax & BAS Tips for Steel Drafting</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))", gap:8, fontSize:11, color:"var(--c-t3)", lineHeight:1.5 }}>
              <div>• <b>Coin / cash payments are GST-free</b> — the 🪙 flag ensures these are excluded from GST payable.</div>
              <div>• <b>Progress claims</b> — each claim creates a BAS obligation when issued, not when paid.</div>
              <div>• <b>Overdue accounts</b> — unpaid invoices still count as income in the BAS quarter they were issued.</div>
              <div>• <b>ATO portal deadline</b> — always lodge by due date even if you can't pay — penalties apply for late lodgement.</div>
            </div>
          </div>
        </div>
        );
      })()}

      {sendDocInv&&<SendDocModal inv={sendDocInv} onClose={()=>setSendDocInv(null)}/>}
      {(showForm||editing)&&(
        <InvoiceFormModal
          invoice={editing}
          prefillProject={prefillProj}
          projects={projects}
          clients={allClients}
          onSave={saved=>{ if(editing){ onUpdateInvoice(editing.id,saved); } else { onAddInvoice(saved); } setShowForm(false); setEditing(null); setPrefillProj(null); }}
          onSaveAndSend={!editing?saved=>{ onAddInvoice(saved); setSendDocInv(saved); setShowForm(false); setEditing(null); setPrefillProj(null); }:undefined}
          onClose={()=>{ setShowForm(false); setEditing(null); setPrefillProj(null); }}
        />
      )}
      {confirmRemove&&(
        <ConfirmModal title="Delete invoice?" message="This invoice will be permanently removed." confirmLabel="Delete"
          onConfirm={()=>{ onRemoveInvoice(confirmRemove); setConfirmRemove(null); }}
          onClose={()=>setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

function PortfolioTab({ portfolio, setPortfolio, services, setServices, stats, setStats, testimonials, setTestimonials, currentUser }) {
  const [section, setSection] = useState("portfolio");

  // ── Portfolio state ──
  const [showAdd, setShowAdd] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const emptyForm = { title:"", type:"Residential", status:"Issued", year:String(new Date().getFullYear()), desc:"", images:[], tags:"" };
  const [form, setForm] = useState(emptyForm);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  const fileRef = useRef(null);

  // ── Services state ──
  const [editSvcId, setEditSvcId] = useState(null);
  const [svcForm, setSvcForm] = useState({});
  const [addSvc, setAddSvc] = useState(false);
  const [newSvc, setNewSvc] = useState({ icon:"⭐", title:"", desc:"", color:"#F97316", visible:true });

  // ── Stats state ──
  const [editStatId, setEditStatId] = useState(null);
  const [statForm, setStatForm] = useState({});

  // ── Testimonials state ──
  const [editTestId, setEditTestId] = useState(null);
  const [testForm, setTestForm] = useState({});
  const [addTest, setAddTest] = useState(false);
  const [newTest, setNewTest] = useState({ quote:"", name:"", role:"", visible:true });

  // ── AI brief generator ──
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiKw, setAiKw] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");

  const aiWriteDesc = async () => {
    if (!aiKw.trim()) { setAiError("Enter some keywords first."); return; }
    setAiLoading(true); setAiError("");
    try {
      const res = await fetch("/api/ai-brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.title || "",
          type: form.type,
          year: form.year,
          keywords: aiKw,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
      const text = (data.text || "").trim();
      if (!text) throw new Error("Empty response");
      setForm(p => ({ ...p, desc: text }));
      setShowAiPanel(false);
      setAiKw("");
    } catch(err) { setAiError(err.message || "Generation failed"); }
    finally { setAiLoading(false); }
  };

  const INP = { width:"100%", background:"#0F172A", border:"1px solid #334155", borderRadius:6, padding:"8px 10px", color:"#F1F5F9", fontSize:13, boxSizing:"border-box", outline:"none" };

  // ── Portfolio functions ──
  const normalise = item => ({ ...item, images: item.images || (item.imageUrl ? [item.imageUrl] : []) });
  const openAdd  = () => { setForm(emptyForm); setEditingItem(null); setShowAdd(true); };
  const openEdit = item => { const n=normalise(item); setForm({...n,tags:(n.tags||[]).join(", ")}); setEditingItem(item); setShowAdd(true); };
  const uploadImages = async files => {
    if (!storage) return;
    const newUrls = [];
    setUploading(true); setUploadErr("");
    try {
      for (const file of files) {
        if (file.size > 20*1024*1024) { setUploadErr(`"${file.name}" must be under 20 MB`); continue; }
        const r = storageFileRef(storage, `portfolio/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`);
        const task = uploadBytesResumable(r, file);
        await new Promise((res, rej) => task.on("state_changed", null, rej, res));
        newUrls.push(await getDownloadURL(task.snapshot.ref));
      }
      setForm(p => ({ ...p, images:[...p.images, ...newUrls] }));
    } catch(err) { setUploadErr("Upload failed: " + err.message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const removeImage   = idx => setForm(p => ({ ...p, images: p.images.filter((_,i) => i!==idx) }));
  const moveImage     = (idx, dir) => setForm(p => { const imgs=[...p.images]; const sw=idx+dir; if(sw<0||sw>=imgs.length) return p; [imgs[idx],imgs[sw]]=[imgs[sw],imgs[idx]]; return {...p,images:imgs}; });
  const save          = () => { const tags=form.tags?form.tags.split(",").map(t=>t.trim()).filter(Boolean):[]; const item={...form,tags,imageUrl:form.images[0]||""}; if(editingItem){setPortfolio(p=>p.map(x=>x.id===editingItem.id?{...editingItem,...item}:x));}else{setPortfolio(p=>[{id:`pf_${Date.now()}`,...item,addedBy:currentUser,addedAt:new Date().toISOString()},...p]);} setShowAdd(false); };
  const remove        = id => { if(window.confirm("Delete this project permanently?")) setPortfolio(p=>p.filter(x=>x.id!==id)); };
  const toggleVisible = id => setPortfolio(p => p.map(x => x.id===id ? {...x, visible: x.visible===false ? true : false} : x));
  const moveUp        = id => setPortfolio(p => { const i=p.findIndex(x=>x.id===id); if(i<=0) return p; const a=[...p]; [a[i-1],a[i]]=[a[i],a[i-1]]; return a; });
  const moveDown      = id => setPortfolio(p => { const i=p.findIndex(x=>x.id===id); if(i<0||i>=p.length-1) return p; const a=[...p]; [a[i],a[i+1]]=[a[i+1],a[i]]; return a; });

  // ── Services functions ──
  const svcToggle   = id => setServices(s => s.map(x => x.id===id ? {...x, visible: x.visible===false ? true : false} : x));
  const svcMoveUp   = id => setServices(s => { const i=s.findIndex(x=>x.id===id); if(i<=0) return s; const a=[...s]; [a[i-1],a[i]]=[a[i],a[i-1]]; return a; });
  const svcMoveDown = id => setServices(s => { const i=s.findIndex(x=>x.id===id); if(i<0||i>=s.length-1) return s; const a=[...s]; [a[i],a[i+1]]=[a[i+1],a[i]]; return a; });
  const svcRemove   = id => { if(window.confirm("Remove this service from the website?")) setServices(s=>s.filter(x=>x.id!==id)); };
  const svcStartEdit= svc => { setSvcForm({...svc}); setEditSvcId(svc.id); };
  const svcSave     = () => { setServices(s=>s.map(x=>x.id===editSvcId?{...x,...svcForm}:x)); setEditSvcId(null); };
  const svcAdd      = () => { if(!newSvc.title.trim()) return; setServices(s=>[...s,{...newSvc,id:`sv_${Date.now()}`}]); setNewSvc({icon:"⭐",title:"",desc:"",color:"#F97316",visible:true}); setAddSvc(false); };

  // ── Stats functions ──
  const statStartEdit = stat => { setStatForm({...stat}); setEditStatId(stat.id); };
  const statSave      = () => { setStats(s=>s.map(x=>x.id===editStatId?{...x,...statForm}:x)); setEditStatId(null); };
  const statRemove    = id => { if(window.confirm("Remove this stat?")) setStats(s=>s.filter(x=>x.id!==id)); };
  const statAdd       = () => setStats(s=>[...s,{id:`st_${Date.now()}`,num:"0",label:"New Stat"}]);

  // ── Testimonials functions ──
  const testToggle   = id => setTestimonials(t => t.map(x => x.id===id ? {...x, visible: x.visible===false ? true : false} : x));
  const testMoveUp   = id => setTestimonials(t => { const i=t.findIndex(x=>x.id===id); if(i<=0) return t; const a=[...t]; [a[i-1],a[i]]=[a[i],a[i-1]]; return a; });
  const testMoveDown = id => setTestimonials(t => { const i=t.findIndex(x=>x.id===id); if(i<0||i>=t.length-1) return t; const a=[...t]; [a[i],a[i+1]]=[a[i+1],a[i]]; return a; });
  const testRemove   = id => { if(window.confirm("Delete this testimonial?")) setTestimonials(t=>t.filter(x=>x.id!==id)); };
  const testStartEdit= tm => { setTestForm({...tm}); setEditTestId(tm.id); };
  const testSave     = () => { setTestimonials(t=>t.map(x=>x.id===editTestId?{...x,...testForm}:x)); setEditTestId(null); };
  const testAdd      = () => { if(!newTest.quote.trim()) return; setTestimonials(t=>[...t,{...newTest,id:`tm_${Date.now()}`}]); setNewTest({quote:"",name:"",role:"",visible:true}); setAddTest(false); };

  const BTN_ACTIVE = { padding:"7px 16px", borderRadius:8, border:"2px solid #F97316", cursor:"pointer", fontWeight:700, fontSize:12, background:"#F9731618", color:"#F97316", transition:"all 0.15s" };
  const BTN_IDLE   = { padding:"7px 16px", borderRadius:8, border:"1px solid var(--c-border)", cursor:"pointer", fontWeight:700, fontSize:12, background:"var(--c-panel)", color:"var(--c-t3)", transition:"all 0.15s" };

  return (
    <div style={{padding:16}}>
      {/* Header */}
      <div style={{marginBottom:14}}>
        <div style={{fontWeight:800,fontSize:15,color:"var(--c-t1)"}}>🌐 Website Manager</div>
        <div style={{fontSize:12,color:"var(--c-t4)",marginTop:2}}>All changes appear live on the public website instantly — no rebuild needed.</div>
      </div>

      {/* Sub-nav */}
      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {[
          ["portfolio", "🖼️ Portfolio", `${portfolio.filter(p=>p.visible!==false).length} visible`],
          ["services",  "🛠️ Services",  `${(services||[]).filter(s=>s.visible!==false).length} visible`],
          ["stats",     "📊 Stats",     `${(stats||[]).length} stats`],
          ["testimonials","💬 Testimonials",`${(testimonials||[]).filter(t=>t.visible!==false).length} visible`],
        ].map(([k,l,count])=>(
          <button key={k} onClick={()=>setSection(k)} style={section===k ? BTN_ACTIVE : BTN_IDLE}>
            {l} <span style={{fontWeight:400,fontSize:10,marginLeft:4,opacity:0.7}}>{count}</span>
          </button>
        ))}
      </div>

      {/* ═══════════════════ PORTFOLIO ═══════════════════ */}
      {section==="portfolio" && (
        <div>
          <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
            <button onClick={openAdd} style={{background:"#F97316",border:"none",borderRadius:6,padding:"8px 18px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>+ Add Project</button>
          </div>
          {portfolio.length===0 ? (
            <div style={{textAlign:"center",padding:"60px 20px",color:"var(--c-t4)"}}>
              <div style={{fontSize:48,marginBottom:16}}>🌐</div>
              <div style={{fontSize:15,fontWeight:700,marginBottom:8}}>No projects yet</div>
              <button onClick={openAdd} style={{background:"#F97316",border:"none",borderRadius:8,padding:"10px 24px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:13}}>+ Add First Project</button>
            </div>
          ) : (
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:16}}>
              {portfolio.map((p,idx)=>{
                const n=normalise(p); const thumb=n.images[0]; const isHidden=p.visible===false;
                return (
                  <div key={p.id} style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:12,overflow:"hidden",opacity:isHidden?0.55:1,transition:"opacity 0.2s"}}>
                    <div style={{height:150,background:"var(--c-deep)",position:"relative",overflow:"hidden"}}>
                      {thumb
                        ? <img src={thumb} alt={p.title} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                        : <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8,opacity:0.35}}><div style={{fontSize:36}}>🏗️</div><div style={{fontSize:11,color:"var(--c-t4)"}}>No photos yet</div></div>
                      }
                      {isHidden && <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{background:"rgba(0,0,0,0.8)",color:"#94A3B8",fontSize:11,fontWeight:700,padding:"4px 12px",borderRadius:20}}>👁 Hidden from website</div></div>}
                      {n.images.length>1 && !isHidden && <div style={{position:"absolute",bottom:8,right:8,background:"rgba(0,0,0,0.75)",color:"#fff",fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:10}}>📷 {n.images.length} photos</div>}
                      <div style={{position:"absolute",top:8,left:8,display:"flex",gap:4}}>
                        <span style={{background:p.status==="Issued"?"#10B981":"#F59E0B",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:10}}>✓ {p.status}</span>
                        <span style={{background:"rgba(0,0,0,0.65)",color:"#E2E8F0",fontSize:10,padding:"2px 8px",borderRadius:10}}>{p.type} · {p.year}</span>
                      </div>
                    </div>
                    {n.images.length>1 && (
                      <div style={{display:"flex",gap:4,padding:"6px 8px",background:"var(--c-deep)",overflowX:"auto"}}>
                        {n.images.map((url,i)=><img key={i} src={url} alt="" style={{width:40,height:32,objectFit:"cover",borderRadius:4,flexShrink:0,border:i===0?"2px solid #F97316":"2px solid transparent"}}/>)}
                      </div>
                    )}
                    <div style={{padding:"12px 14px"}}>
                      <div style={{fontWeight:800,fontSize:13,color:"var(--c-t1)",marginBottom:3}}>{p.title}</div>
                      <div style={{fontSize:11,color:"var(--c-t4)",lineHeight:1.5,marginBottom:10}}>{(p.desc||"").substring(0,90)}{(p.desc||"").length>90?"…":""}</div>
                      {p.tags&&p.tags.length>0&&<div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>{p.tags.map(tag=><span key={tag} style={{background:"rgba(249,115,22,0.1)",color:"#F97316",fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:8,border:"1px solid rgba(249,115,22,0.2)"}}>{tag}</span>)}</div>}
                      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                        <button onClick={()=>toggleVisible(p.id)} title={isHidden?"Show on website":"Hide from website"}
                          style={{flex:"none",background:isHidden?"rgba(100,116,139,0.15)":"rgba(16,185,129,0.1)",border:isHidden?"1px solid #475569":"1px solid #10B981",borderRadius:6,padding:"5px 10px",color:isHidden?"#64748B":"#10B981",fontWeight:700,cursor:"pointer",fontSize:11}}>
                          {isHidden?"👁 Show":"✓ Visible"}
                        </button>
                        <button onClick={()=>moveUp(p.id)} disabled={idx===0} title="Move up" style={{background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:6,padding:"5px 8px",color:"var(--c-t3)",cursor:"pointer",fontSize:12,opacity:idx===0?0.3:1}}>▲</button>
                        <button onClick={()=>moveDown(p.id)} disabled={idx===portfolio.length-1} title="Move down" style={{background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:6,padding:"5px 8px",color:"var(--c-t3)",cursor:"pointer",fontSize:12,opacity:idx===portfolio.length-1?0.3:1}}>▼</button>
                        <button onClick={()=>openEdit(p)} style={{flex:1,background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:6,padding:"5px 0",color:"var(--c-t3)",fontWeight:700,cursor:"pointer",fontSize:12}}>✏ Edit</button>
                        <button onClick={()=>remove(p.id)} style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:6,padding:"5px 9px",color:"#EF4444",fontWeight:700,cursor:"pointer",fontSize:12}}>✕</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {showAdd && (
            <Modal title={editingItem?"✏ Edit Project":"🌐 Add Project to Website"} onClose={()=>setShowAdd(false)} wide>
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div>
                  <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.1em",marginBottom:5}}>PROJECT TITLE *</label>
                  <input required value={form.title} onChange={e=>setForm(p=>({...p,title:e.target.value}))} placeholder="e.g. 3-Storey Residential Frame, Malvern VIC" style={INP}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                  <div>
                    <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.1em",marginBottom:5}}>TYPE</label>
                    <select value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))} style={INP}>{["Residential","Commercial","Industrial","Civil"].map(t=><option key={t}>{t}</option>)}</select>
                  </div>
                  <div>
                    <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.1em",marginBottom:5}}>STATUS</label>
                    <select value={form.status} onChange={e=>setForm(p=>({...p,status:e.target.value}))} style={INP}>{["Issued","In Progress","Completed"].map(s=><option key={s}>{s}</option>)}</select>
                  </div>
                  <div>
                    <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.1em",marginBottom:5}}>YEAR</label>
                    <input value={form.year} onChange={e=>setForm(p=>({...p,year:e.target.value}))} placeholder="2024" style={INP}/>
                  </div>
                </div>
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <label style={{fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.1em"}}>SHORT DESCRIPTION</label>
                    <button type="button" onClick={()=>{setShowAiPanel(s=>!s);setAiError("");}}
                      style={{background:"linear-gradient(135deg,#7C3AED,#3B82F6)",border:"none",borderRadius:5,padding:"3px 11px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",gap:5,letterSpacing:"0.02em"}}>
                      ✨ AI Write
                    </button>
                  </div>
                  {showAiPanel && (
                    <div style={{marginBottom:10,background:"#0A0F1E",border:"1px solid #7C3AED55",borderRadius:10,padding:"14px 16px"}}>
                      <div style={{fontSize:10,fontWeight:800,color:"#A78BFA",letterSpacing:"0.12em",marginBottom:10}}>✨ AI BRIEF GENERATOR</div>
                      <div style={{display:"flex",gap:8}}>
                        <input value={aiKw} onChange={e=>setAiKw(e.target.value)}
                          onKeyDown={e=>e.key==="Enter"&&!aiLoading&&aiWriteDesc()}
                          placeholder="e.g. 6-storey frame, crane beams, RFI, Tekla, mezzanine…"
                          style={{...INP,flex:1,fontSize:13,padding:"10px 12px",borderColor:"#7C3AED44"}} autoFocus/>
                        <button type="button" onClick={aiWriteDesc} disabled={aiLoading||!aiKw.trim()}
                          style={{background:aiLoading||!aiKw.trim()?"#1E293B":"#7C3AED",border:"none",borderRadius:7,padding:"0 20px",color:"#fff",fontWeight:700,cursor:aiLoading||!aiKw.trim()?"not-allowed":"pointer",fontSize:13,whiteSpace:"nowrap",flexShrink:0}}>
                          {aiLoading?"⏳ Writing…":"Generate →"}
                        </button>
                      </div>
                      {aiError && <div style={{fontSize:12,color:"#EF4444",marginTop:7}}>{aiError}</div>}
                      <div style={{fontSize:11,color:"#475569",marginTop:8}}>Type a few keywords — AI writes a professional brief and fills it in below. Press Enter or click Generate.</div>
                    </div>
                  )}
                  <SpellCheckArea value={form.desc} onChange={e=>setForm(p=>({...p,desc:e.target.value}))} placeholder="Brief description of the project scope and what was delivered…" rows={6} style={{...INP,resize:"vertical",width:"100%",boxSizing:"border-box"}}/>
                </div>
                <div>
                  <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.1em",marginBottom:5}}>TAGS <span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}>— comma separated</span></label>
                  <input value={form.tags} onChange={e=>setForm(p=>({...p,tags:e.target.value}))} placeholder="Tekla, GA Drawings, Fab Package, Commercial" style={INP}/>
                </div>
                <div>
                  <label style={{display:"block",fontSize:10,fontWeight:800,color:"#475569",letterSpacing:"0.1em",marginBottom:8}}>PROJECT PHOTOS <span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}>— first photo is the cover · up to 20 MB each</span></label>
                  {form.images.length>0 && (
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))",gap:8,marginBottom:10}}>
                      {form.images.map((url,i)=>(
                        <div key={i} style={{position:"relative",borderRadius:8,overflow:"hidden",border:i===0?"2px solid #F97316":"2px solid #334155"}}>
                          <img src={url} alt="" style={{width:"100%",height:80,objectFit:"cover",display:"block"}}/>
                          {i===0 && <div style={{position:"absolute",top:3,left:3,background:"#F97316",color:"#fff",fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:4}}>COVER</div>}
                          <div style={{position:"absolute",bottom:0,left:0,right:0,display:"flex",justifyContent:"space-between",background:"rgba(0,0,0,0.7)",padding:"3px 4px"}}>
                            <div style={{display:"flex",gap:2}}>
                              <button type="button" onClick={()=>moveImage(i,-1)} disabled={i===0} style={{background:"none",border:"none",color:"#fff",cursor:"pointer",fontSize:12,padding:0,opacity:i===0?0.3:1}}>◀</button>
                              <button type="button" onClick={()=>moveImage(i,1)} disabled={i===form.images.length-1} style={{background:"none",border:"none",color:"#fff",cursor:"pointer",fontSize:12,padding:0,opacity:i===form.images.length-1?0.3:1}}>▶</button>
                            </div>
                            <button type="button" onClick={()=>removeImage(i)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14,padding:0,lineHeight:1}}>✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {storage && (
                    <div>
                      <input ref={fileRef} type="file" accept="image/*" multiple onChange={e=>uploadImages(Array.from(e.target.files))} style={{display:"none"}}/>
                      <button type="button" onClick={()=>fileRef.current?.click()} disabled={uploading}
                        style={{background:"#F97316",border:"none",borderRadius:6,padding:"9px 18px",color:"#fff",fontWeight:700,cursor:uploading?"wait":"pointer",fontSize:13}}>
                        {uploading?"⏳ Uploading…":"📸 Upload Photos"}
                      </button>
                      <span style={{fontSize:11,color:"#475569",marginLeft:10}}>Select multiple at once</span>
                      {uploadErr && <div style={{fontSize:11,color:"#EF4444",marginTop:4}}>{uploadErr}</div>}
                    </div>
                  )}
                </div>
                <div style={{display:"flex",gap:10,marginTop:4}}>
                  <button onClick={save} disabled={!form.title.trim()} style={{flex:1,background:form.title.trim()?"#F97316":"#334155",border:"none",borderRadius:7,padding:"11px 0",color:"#fff",fontWeight:800,cursor:form.title.trim()?"pointer":"not-allowed",fontSize:13}}>
                    {editingItem?"Save Changes":"Add to Website"}
                  </button>
                  <button onClick={()=>setShowAdd(false)} style={{padding:"11px 20px",background:"transparent",border:"1px solid #334155",borderRadius:7,color:"#94A3B8",cursor:"pointer",fontSize:13}}>Cancel</button>
                </div>
              </div>
            </Modal>
          )}
        </div>
      )}

      {/* ═══════════════════ SERVICES ═══════════════════ */}
      {section==="services" && (
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <div style={{fontSize:12,color:"var(--c-t4)"}}>Control which services appear on the website and in what order. Click ✏ to edit any service.</div>
            <button onClick={()=>setAddSvc(true)} style={{background:"#F97316",border:"none",borderRadius:6,padding:"8px 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:12,flexShrink:0}}>+ Add Service</button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {(services||[]).map((svc,idx)=>{
              const isHidden=svc.visible===false; const isEditing=editSvcId===svc.id;
              return (
                <div key={svc.id} style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,padding:"12px 14px",opacity:isHidden?0.55:1,transition:"opacity 0.2s"}}>
                  {isEditing ? (
                    <div style={{display:"flex",flexDirection:"column",gap:10}}>
                      <div style={{display:"grid",gridTemplateColumns:"64px 1fr",gap:8}}>
                        <div>
                          <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>ICON</div>
                          <input value={svcForm.icon||""} onChange={e=>setSvcForm(f=>({...f,icon:e.target.value}))} style={{...INP,textAlign:"center",fontSize:20}} maxLength={4}/>
                        </div>
                        <div>
                          <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>TITLE</div>
                          <input value={svcForm.title||""} onChange={e=>setSvcForm(f=>({...f,title:e.target.value}))} style={INP} placeholder="Service name"/>
                        </div>
                      </div>
                      <div>
                        <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>DESCRIPTION</div>
                        <SpellCheckArea value={svcForm.desc||""} onChange={e=>setSvcForm(f=>({...f,desc:e.target.value}))} rows={2} style={{...INP,resize:"vertical",width:"100%",boxSizing:"border-box"}} placeholder="Short description shown on the website"/>
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={svcSave} style={{background:"#F97316",border:"none",borderRadius:6,padding:"7px 18px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:12}}>Save</button>
                        <button onClick={()=>setEditSvcId(null)} style={{background:"none",border:"1px solid var(--c-border)",borderRadius:6,padding:"7px 14px",color:"var(--c-t4)",cursor:"pointer",fontSize:12}}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
                      <div style={{width:40,height:40,borderRadius:8,background:`${svc.color||"#F97316"}18`,border:`1px solid ${svc.color||"#F97316"}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{svc.icon}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:13,color:"var(--c-t1)",marginBottom:2}}>{svc.title}</div>
                        <div style={{fontSize:11,color:"var(--c-t4)",lineHeight:1.5}}>{(svc.desc||"").substring(0,110)}{(svc.desc||"").length>110?"…":""}</div>
                      </div>
                      <div style={{display:"flex",gap:4,flexShrink:0,alignItems:"center"}}>
                        <button onClick={()=>svcToggle(svc.id)} style={{background:isHidden?"rgba(100,116,139,0.15)":"rgba(16,185,129,0.1)",border:isHidden?"1px solid #475569":"1px solid #10B981",borderRadius:6,padding:"4px 8px",color:isHidden?"#64748B":"#10B981",cursor:"pointer",fontSize:11,fontWeight:700}}>
                          {isHidden?"👁 Show":"✓ On"}
                        </button>
                        <button onClick={()=>svcMoveUp(svc.id)} disabled={idx===0} style={{background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 7px",color:"var(--c-t3)",cursor:"pointer",fontSize:11,opacity:idx===0?0.3:1}}>▲</button>
                        <button onClick={()=>svcMoveDown(svc.id)} disabled={idx===(services||[]).length-1} style={{background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 7px",color:"var(--c-t3)",cursor:"pointer",fontSize:11,opacity:idx===(services||[]).length-1?0.3:1}}>▼</button>
                        <button onClick={()=>svcStartEdit(svc)} style={{background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 9px",color:"var(--c-t3)",cursor:"pointer",fontSize:11,fontWeight:700}}>✏</button>
                        <button onClick={()=>svcRemove(svc.id)} style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:5,padding:"4px 7px",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700}}>✕</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {addSvc && (
            <div style={{marginTop:12,background:"var(--c-panel)",border:"1px solid #F9731640",borderRadius:10,padding:"14px"}}>
              <div style={{fontWeight:700,fontSize:12,color:"var(--c-t1)",marginBottom:12}}>New Service</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <div style={{display:"grid",gridTemplateColumns:"64px 1fr",gap:8}}>
                  <div>
                    <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>ICON</div>
                    <input value={newSvc.icon} onChange={e=>setNewSvc(f=>({...f,icon:e.target.value}))} style={{...INP,textAlign:"center",fontSize:20}} maxLength={4}/>
                  </div>
                  <div>
                    <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>TITLE *</div>
                    <input value={newSvc.title} onChange={e=>setNewSvc(f=>({...f,title:e.target.value}))} style={INP} placeholder="Service name"/>
                  </div>
                </div>
                <div>
                  <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>DESCRIPTION</div>
                  <SpellCheckArea value={newSvc.desc} onChange={e=>setNewSvc(f=>({...f,desc:e.target.value}))} rows={2} style={{...INP,resize:"vertical",width:"100%",boxSizing:"border-box"}} placeholder="Short description…"/>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={svcAdd} disabled={!newSvc.title.trim()} style={{background:newSvc.title.trim()?"#F97316":"#334155",border:"none",borderRadius:6,padding:"7px 18px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:12}}>Add Service</button>
                  <button onClick={()=>setAddSvc(false)} style={{background:"none",border:"1px solid var(--c-border)",borderRadius:6,padding:"7px 14px",color:"var(--c-t4)",cursor:"pointer",fontSize:12}}>Cancel</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════ STATS ═══════════════════ */}
      {section==="stats" && (
        <div>
          <div style={{fontSize:12,color:"var(--c-t4)",marginBottom:16}}>These numbers appear in the hero section and stats strip on the website. Click any card to edit.</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
            {(stats||[]).map(stat=>{
              const isEditing=editStatId===stat.id;
              return (
                <div key={stat.id} style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:12,padding:"16px",position:"relative",cursor:isEditing?"default":"pointer"}}
                  onClick={()=>{ if(!isEditing) statStartEdit(stat); }}>
                  {isEditing ? (
                    <div style={{display:"flex",flexDirection:"column",gap:8}} onClick={e=>e.stopPropagation()}>
                      <div>
                        <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>NUMBER</div>
                        <input value={statForm.num||""} onChange={e=>setStatForm(f=>({...f,num:e.target.value}))} style={{...INP,fontSize:22,fontWeight:900,color:"#F97316"}} placeholder="200+"/>
                      </div>
                      <div>
                        <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>LABEL</div>
                        <input value={statForm.label||""} onChange={e=>setStatForm(f=>({...f,label:e.target.value}))} style={INP} placeholder="Projects Completed"/>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={statSave} style={{flex:1,background:"#F97316",border:"none",borderRadius:6,padding:"6px 0",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:12}}>Save</button>
                        <button onClick={()=>setEditStatId(null)} style={{background:"none",border:"1px solid var(--c-border)",borderRadius:6,padding:"6px 10px",color:"var(--c-t4)",cursor:"pointer",fontSize:12}}>✕</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{textAlign:"center"}}>
                        <div style={{fontSize:36,fontWeight:900,fontFamily:"monospace",color:"#F97316",lineHeight:1}}>{stat.num}</div>
                        <div style={{fontSize:11,color:"#64748B",marginTop:6,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em"}}>{stat.label}</div>
                      </div>
                      <div style={{position:"absolute",top:7,right:8,fontSize:9,color:"var(--c-t4)",opacity:0.6}}>✏ edit</div>
                      {(stats||[]).length>1 && <button onClick={e=>{e.stopPropagation();statRemove(stat.id);}} style={{position:"absolute",top:7,left:8,background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:12,padding:2,opacity:0.5}}>✕</button>}
                    </>
                  )}
                </div>
              );
            })}
            <div onClick={statAdd}
              style={{background:"transparent",border:"1px dashed var(--c-border)",borderRadius:12,padding:"16px",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"var(--c-t4)",fontSize:13,minHeight:100}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor="#F97316";e.currentTarget.style.color="#F97316";}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor="";e.currentTarget.style.color="";}}>
              + Add Stat
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════ TESTIMONIALS ═══════════════════ */}
      {section==="testimonials" && (
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <div style={{fontSize:12,color:"var(--c-t4)"}}>Client testimonials shown on the website. Add real quotes to build trust.</div>
            <button onClick={()=>setAddTest(true)} style={{background:"#F97316",border:"none",borderRadius:6,padding:"8px 16px",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:12,flexShrink:0}}>+ Add Testimonial</button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {(testimonials||[]).map((tm,idx)=>{
              const isHidden=tm.visible===false; const isEditing=editTestId===tm.id;
              return (
                <div key={tm.id} style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,padding:"14px",opacity:isHidden?0.55:1,transition:"opacity 0.2s"}}>
                  {isEditing ? (
                    <div style={{display:"flex",flexDirection:"column",gap:10}}>
                      <div>
                        <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>QUOTE *</div>
                        <SpellCheckArea value={testForm.quote||""} onChange={e=>setTestForm(f=>({...f,quote:e.target.value}))} rows={3} style={{...INP,resize:"vertical",width:"100%",boxSizing:"border-box"}} placeholder="What the client said…"/>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        <div>
                          <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>CLIENT NAME</div>
                          <input value={testForm.name||""} onChange={e=>setTestForm(f=>({...f,name:e.target.value}))} style={INP} placeholder="Mark T."/>
                        </div>
                        <div>
                          <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>ROLE / COMPANY</div>
                          <input value={testForm.role||""} onChange={e=>setTestForm(f=>({...f,role:e.target.value}))} style={INP} placeholder="Project Manager, XYZ Steel"/>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={testSave} style={{background:"#F97316",border:"none",borderRadius:6,padding:"7px 18px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:12}}>Save</button>
                        <button onClick={()=>setEditTestId(null)} style={{background:"none",border:"1px solid var(--c-border)",borderRadius:6,padding:"7px 14px",color:"var(--c-t4)",cursor:"pointer",fontSize:12}}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                      <div style={{fontSize:30,color:"#F97316",fontFamily:"Georgia,serif",lineHeight:1,flexShrink:0,marginTop:2}}>"</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,color:"var(--c-t2)",lineHeight:1.6,marginBottom:6}}>{tm.quote}</div>
                        <div style={{fontSize:11,fontWeight:700,color:"#F97316"}}>{tm.name}</div>
                        {tm.role && <div style={{fontSize:10,color:"var(--c-t4)"}}>{tm.role}</div>}
                      </div>
                      <div style={{display:"flex",gap:4,flexShrink:0}}>
                        <button onClick={()=>testToggle(tm.id)} style={{background:isHidden?"rgba(100,116,139,0.15)":"rgba(16,185,129,0.1)",border:isHidden?"1px solid #475569":"1px solid #10B981",borderRadius:6,padding:"4px 8px",color:isHidden?"#64748B":"#10B981",cursor:"pointer",fontSize:10,fontWeight:700}}>
                          {isHidden?"👁 Show":"✓ On"}
                        </button>
                        <button onClick={()=>testMoveUp(tm.id)} disabled={idx===0} style={{background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 7px",color:"var(--c-t3)",cursor:"pointer",fontSize:11,opacity:idx===0?0.3:1}}>▲</button>
                        <button onClick={()=>testMoveDown(tm.id)} disabled={idx===(testimonials||[]).length-1} style={{background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 7px",color:"var(--c-t3)",cursor:"pointer",fontSize:11,opacity:idx===(testimonials||[]).length-1?0.3:1}}>▼</button>
                        <button onClick={()=>testStartEdit(tm)} style={{background:"var(--c-deep)",border:"1px solid var(--c-border)",borderRadius:5,padding:"4px 9px",color:"var(--c-t3)",cursor:"pointer",fontSize:11,fontWeight:700}}>✏</button>
                        <button onClick={()=>testRemove(tm.id)} style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:5,padding:"4px 7px",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700}}>✕</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {addTest && (
            <div style={{marginTop:12,background:"var(--c-panel)",border:"1px solid #F9731640",borderRadius:10,padding:"14px"}}>
              <div style={{fontWeight:700,fontSize:12,color:"var(--c-t1)",marginBottom:12}}>New Testimonial</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <div>
                  <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>QUOTE *</div>
                  <SpellCheckArea value={newTest.quote} onChange={e=>setNewTest(f=>({...f,quote:e.target.value}))} rows={3} style={{...INP,resize:"vertical",width:"100%",boxSizing:"border-box"}} placeholder="What the client said…"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div>
                    <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>CLIENT NAME</div>
                    <input value={newTest.name} onChange={e=>setNewTest(f=>({...f,name:e.target.value}))} style={INP} placeholder="Mark T."/>
                  </div>
                  <div>
                    <div style={{fontSize:9,fontWeight:800,color:"#475569",marginBottom:4,letterSpacing:"0.1em"}}>ROLE / COMPANY</div>
                    <input value={newTest.role} onChange={e=>setNewTest(f=>({...f,role:e.target.value}))} style={INP} placeholder="Project Manager, XYZ Steel"/>
                  </div>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={testAdd} disabled={!newTest.quote.trim()} style={{background:newTest.quote.trim()?"#F97316":"#334155",border:"none",borderRadius:6,padding:"7px 18px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:12}}>Add Testimonial</button>
                  <button onClick={()=>setAddTest(false)} style={{background:"none",border:"1px solid var(--c-border)",borderRadius:6,padding:"7px 14px",color:"var(--c-t4)",cursor:"pointer",fontSize:12}}>Cancel</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [loginPinToken, setLoginPinToken] = useState(null); // pinChangedAt captured at login time
  const [showDevicePrompt, setShowDevicePrompt] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Stale-tab guard: show a banner when a newer build is deployed so the user
  // can choose when to reload (avoids discarding mid-edit work).
  useEffect(() => {
    if (!firebaseConfigured) return;
    const ref = doc(db, "appState", "asd_app_version");
    const unsub = onSnapshot(ref, snap => {
      const v = snap.exists() ? Number(snap.data().value) || 0 : 0;
      if (v > APP_VERSION) setUpdateAvailable(true);
      else if (v < APP_VERSION) setDoc(ref, { value: APP_VERSION }).catch(() => {});
    }, () => {});
    return () => unsub();
  }, []);

  // Always show login screen in light mode
  useEffect(() => {
    if (!currentUser) document.documentElement.dataset.theme = "light";
  }, [currentUser]);

  const [team, setTeam] = usePersistentState("asd_team_members", DEFAULT_TEAM);
  const teamReady = true;
  // Migrate any plain-text PINs to SHA-256 hashes (one-time, runs until all are hashed)
  useEffect(() => {
    if (!Array.isArray(team)) return;
    const plain = team.filter(m => !isHashed(m.pin));
    if (!plain.length) return;
    Promise.all(plain.map(m => hashPin(m.pin).then(h => ({ name: m.name, hash: h })))).then(results => {
      const lookup = Object.fromEntries(results.map(r => [r.name, r.hash]));
      setTeam(t => (Array.isArray(t) ? t : []).map(m => lookup[m.name] ? { ...m, pin: lookup[m.name] } : m));
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [clients, setClients] = usePersistentState("asd_clients", DEFAULT_CLIENTS);
  const [clientDetails, setClientDetails] = usePersistentState("asd_client_details", DEFAULT_CLIENT_DETAILS);
  const [presence, setPresence] = usePersistentState("asd_presence", { sessions: [], online: {} });
  const [teamsMeetingUrl, setTeamsMeetingUrl] = usePersistentState("asd_teams_meeting_url", "");
  const activeSessionId = useRef(null);

  // ── Fast online status — dedicated tiny document, no debounce ──────────────
  // Separate from asd_presence (which stores full session history and debounces
  // 500 ms before writing). This writes straight to Firestore on every
  // login/logout so other members' screens update in <1 s.
  const [onlineStatus, setOnlineStatus] = useState(() => {
    try {
      const raw = localStorage.getItem("asd_online");
      if (raw) return JSON.parse(raw);
      // First-run fallback: seed from presence.online already in localStorage
      const pRaw = localStorage.getItem("asd_presence");
      return JSON.parse(pRaw)?.online || {};
    } catch { return {}; }
  });
  const onlineStatusRef = useRef(onlineStatus);
  useEffect(() => { onlineStatusRef.current = onlineStatus; }, [onlineStatus]);

  // Per-user collection: asd_online/{MEMBERNAME} → { ts, sid, system }
  // Each user writes ONLY their own document — zero concurrent write conflicts.
  // Collection snapshot delivers all members' presence in one real-time listener.
  useEffect(() => {
    if (!firebaseConfigured) return;
    const colRef = collection(db, "asd_online");
    const unsub = onSnapshot(colRef, snap => {
      const val = {};
      snap.docs.forEach(d => { val[d.id] = d.data(); });
      setOnlineStatus(val);
      localStorage.setItem("asd_online", JSON.stringify(val));
    }, err => console.error("asd_online sync error:", err));
    return () => unsub();
  }, []);

  // Write THIS user's presence to their own document immediately — no debounce.
  // Retry up to 3× on failure (3s, 9s, 27s back-off).
  const pushOnlineStatus = (name, data, retryCount = 0) => {
    const next = { ...onlineStatusRef.current, [name]: data };
    onlineStatusRef.current = next;
    setOnlineStatus(next);
    localStorage.setItem("asd_online", JSON.stringify(next));
    if (firebaseConfigured) {
      setDoc(doc(db, "asd_online", name), data).catch(err => {
        console.error("asd_online write error:", err);
        if (retryCount < 3) {
          setTimeout(() => pushOnlineStatus(name, data, retryCount + 1), 3000 * Math.pow(3, retryCount));
        }
      });
    }
  };
  // ──────────────────────────────────────────────────────────────────────────

  // ── Do Not Disturb status — synced via Firestore appState/asd_dnd ─────────
  const [dndStatus, setDndStatus] = useState(() => {
    try { return JSON.parse(localStorage.getItem("asd_dnd") || "{}"); } catch { return {}; }
  });
  const dndStatusRef = useRef(dndStatus);
  useEffect(() => { dndStatusRef.current = dndStatus; }, [dndStatus]);
  useEffect(() => {
    if (!firebaseConfigured) return;
    const unsub = onSnapshot(doc(db, "appState", "asd_dnd"), snap => {
      if (snap.exists()) {
        const val = snap.data().value || {};
        setDndStatus(val);
        localStorage.setItem("asd_dnd", JSON.stringify(val));
      }
    }, err => console.error("asd_dnd sync error:", err));
    return () => unsub();
  }, []);
  const pushDndStatus = (member, isDnd) => {
    const next = { ...dndStatusRef.current, [member]: isDnd };
    dndStatusRef.current = next;
    setDndStatus(next);
    localStorage.setItem("asd_dnd", JSON.stringify(next));
    if (firebaseConfigured)
      setDoc(doc(db, "appState", "asd_dnd"), { value: next }).catch(console.error);
  };
  // ──────────────────────────────────────────────────────────────────────────

  // ── GCal meeting times — synced via Firestore so all team members see them ─
  const [gcalTimes, setGcalTimes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("asd_gcal_times_global") || "{}"); } catch { return {}; }
  });
  useEffect(() => {
    if (!firebaseConfigured) return;
    const unsub = onSnapshot(doc(db, "appState", "asd_gcal_times"), snap => {
      if (snap.exists()) {
        const val = snap.data().value || {};
        setGcalTimes(val);
        localStorage.setItem("asd_gcal_times_global", JSON.stringify(val));
      }
    }, err => console.error("asd_gcal_times sync error:", err));
    return () => unsub();
  }, []);
  // ──────────────────────────────────────────────────────────────────────────

  // ── Teams presence — server polls Graph API every 30s, stores here ─────────
  const [teamsPresence, setTeamsPresence] = useState({});
  useEffect(() => {
    if (!firebaseConfigured) return;
    const unsub = onSnapshot(doc(db, "appState", "teams_presence"), snap => {
      if (snap.exists()) setTeamsPresence(snap.data().value || {});
    }, () => {});
    return () => unsub();
  }, []);
  // ──────────────────────────────────────────────────────────────────────────

  const teamNames = team.map(m => m.name);
  const memberColor = Object.fromEntries(team.map(m => [m.name, m.color]));
  const memberRole = Object.fromEntries(team.map(m => [m.name, m.role]));
  const isAdmin = name => memberRole[name] === "admin";

  const verifyPin = async (name, enteredPin) => {
    const member = team.find(m => m.name === name);
    if (!member) return false;
    const h = await hashPin(enteredPin);
    return member.pin === h;
  };

  const addMember = async (name, pin) => {
    const hashed = await hashPin(pin);
    const usedColors = new Set(team.map(m => m.color));
    const color = TEAM_COLOR_PALETTE.find(c => !usedColors.has(c)) || "#6B7280";
    setTeam(t => [...t, { name, pin: hashed, color, role:"member", pinChangedAt: Date.now() }]);
  };
  const removeMember = name => setTeam(t => t.filter(m => m.name !== name));
  const updateMemberPin = async (name, pin) => {
    const hashed = await hashPin(pin);
    setTeam(t => t.map(m => m.name===name ? { ...m, pin: hashed, pinChangedAt: Date.now() } : m));
  };
  const updateMemberTeamsEmail = (name, email) => {
    setTeam(t => t.map(m => m.name===name ? { ...m, teamsEmail: email.trim() } : m));
  };

  const addClient = code => setClients(c => [...c, code]);
  const removeClient = code => setClients(c => c.filter(x => x !== code));
  const updateClientDetails = (code, details) => setClientDetails(d => ({ ...d, [code]: { ...(d[code]||{}), ...details } }));

  const teamCtx = { team, teamNames, memberColor, memberRole, isAdmin, verifyPin, addMember, removeMember, updateMemberPin, updateMemberTeamsEmail, clients, addClient, removeClient, clientDetails, updateClientDetails, teamReady, teamsMeetingUrl, setTeamsMeetingUrl };

  // Force-logout if the current user's PIN was changed (on any device) or if they were removed
  useEffect(() => {
    if (!currentUser) return;
    const member = team.find(m => m.name === currentUser);
    if (!member) { setCurrentUser(null); setLoginPinToken(null); return; }
    // Normalize both sides: Firestore round-trips drop undefined fields, so a missing
    // pinChangedAt must compare equal whether it arrives as undefined or null.
    if ((member.pinChangedAt ?? null) !== (loginPinToken ?? null)) { setCurrentUser(null); setLoginPinToken(null); }
  }, [team, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async name => {
    // Stamp the anonymous Firebase session with a role-specific sentinel so
    // Firestore rules can distinguish admin (asd-hub-admin) from regular team
    // members (asd-hub-member). Admins get broader write access (e.g. invoices).
    const member = team.find(m => m.name === name);
    try {
      if (auth?.currentUser) {
        const sentinel = member?.role === "admin" ? "asd-hub-admin" : "asd-hub-member";
        await updateProfile(auth.currentUser, { displayName: sentinel });
        await auth.currentUser.getIdToken(true); // force token refresh with new claim
      }
    } catch (e) {
      console.warn("handleLogin: token upgrade failed", e);
    }
    setLoginPinToken(member?.pinChangedAt);
    setCurrentUser(name);
    if (!localStorage.getItem("asd_device_name")) setShowDevicePrompt(true);
    const sid = mkId();
    const loginAt = nowTs();
    const date = ymd(new Date());
    const system = getSystemInfo();
    activeSessionId.current = sid;
    // Write this session's presence immediately — per-user document in asd_online collection
    pushOnlineStatus(name, { ts: Date.now(), sid, system });
    // Slow path: record session in attendance history (debounced, large doc)
    if (PRESENCE_TRACKED.includes(name)) {
      setPresence(p => ({
        ...p,
        sessions: [...(p.sessions||[]), { id:sid, member:name, date, loginAt, logoutAt:null }],
      }));
    }
  };

  // Heartbeat: refresh this session's ts every 60 s — stale entries auto-expire after 3.5 min
  // visibilitychange listener fires immediately on tab focus/wake so laptop-sleep/background-tab
  // throttling never causes the session to appear offline when the user returns.
  useEffect(() => {
    if (!currentUser) return;
    const system = getSystemInfo();
    const refresh = () => {
      const sid = activeSessionId.current;
      if (!sid) return;
      pushOnlineStatus(currentUser, { ts: Date.now(), sid, system });
    };
    const beat = setInterval(refresh, 30000); // 30s heartbeat — TTL is 3.5 min, 7x safety margin
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(beat); document.removeEventListener("visibilitychange", onVisible); };
  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = () => {
    if (currentUser && activeSessionId.current) {
      const sid = activeSessionId.current;
      const logoutAt = nowTs();
      // Mark offline immediately by writing ts:0 — isSessionFresh will return false
      pushOnlineStatus(currentUser, { ts: 0, sid, system: getSystemInfo() });
      // Slow path: stamp logoutAt on the session record
      if (PRESENCE_TRACKED.includes(currentUser)) {
        setPresence(p => ({
          ...p,
          sessions: (p.sessions||[]).map(s => s.id===sid ? { ...s, logoutAt } : s),
        }));
      }
      activeSessionId.current = null;
    }
    setCurrentUser(null);
    setLoginPinToken(null);
  };

  return (
    <TeamContext.Provider value={teamCtx}>
      {updateAvailable && (
        <div style={{position:"fixed",top:0,left:0,right:0,zIndex:99999,background:"#1D4ED8",color:"#fff",padding:"10px 20px",display:"flex",gap:12,alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:600,flexWrap:"wrap"}}>
          A new version of ASD Hub is available.
          <button onClick={()=>window.location.reload()} style={{background:"#fff",color:"#1D4ED8",border:"none",borderRadius:5,padding:"5px 14px",fontWeight:700,cursor:"pointer",fontSize:12,whiteSpace:"nowrap"}}>Reload now</button>
          <button onClick={()=>setUpdateAvailable(false)} style={{background:"transparent",border:"1px solid rgba(255,255,255,0.5)",color:"#fff",borderRadius:5,padding:"5px 10px",fontWeight:600,cursor:"pointer",fontSize:12,whiteSpace:"nowrap"}}>Later</button>
        </div>
      )}
      {!currentUser
        ? <LandingPage onLoginSuccess={handleLogin}/>
        : <MainApp currentUser={currentUser} onLogout={handleLogout} presence={{...presence, online: onlineStatus, dnd: dndStatus, gcalTimes, teamsPresence}} onToggleDnd={pushDndStatus}/>}
      {showDevicePrompt && <DeviceNamePrompt onSave={() => setShowDevicePrompt(false)}/>}
    </TeamContext.Provider>
  );
}

export default function RootApp() {
  return <ErrorBoundary><App/></ErrorBoundary>;
}
