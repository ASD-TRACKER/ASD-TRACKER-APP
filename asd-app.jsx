import { useState, useEffect, useRef, useContext, createContext, Component, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { doc, onSnapshot, setDoc, updateDoc, collection, addDoc, runTransaction } from "firebase/firestore";
import { ref as storageFileRef, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { firebaseConfigured, db, authReady, storage } from "./src/firebase.js";

// ═════════════════════════════════════════════════
// TEAM ROSTER — RAJ is the admin (only admin can add/remove members or reset
// PINs); everyone else is a regular member. Roster is persisted/synced via
// usePersistentState like everything else, and exposed through TeamContext so
// any component can read it without prop-drilling through the whole tree.
// ═════════════════════════════════════════════════
const DEFAULT_TEAM = [
  { name:"RAJ", pin:"1994", color:"#F97316", role:"admin" },
  { name:"LESLIE", pin:"2345", color:"#3B82F6", role:"member" },
  { name:"LALITHA", pin:"3456", color:"#EC4899", role:"member" },
  { name:"SRIKANTH", pin:"5678", color:"#8B5CF6", role:"member" },
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
const ONLINE_TTL_MS = 2 * 60 * 1000;
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
const APP_VERSION = 2;

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

// Fabricator/client codes — admin-curated list (same admin as the team roster)
// so the Client field on a project is picked from a controlled list instead
// of free text, avoiding typo'd duplicates like "USS" vs "uss".
const DEFAULT_CLIENTS = ["DF", "GS", "USS"];

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

const mkId = () => Math.random().toString(36).slice(2, 9);

const isHashed = v => typeof v === "string" && v.length === 64 && /^[0-9a-f]+$/.test(v);

// One-time startup migration: wipe old SHA-256 hashed PINs from localStorage so
// DEFAULT_TEAM (with correct plain-text PINs) takes over until Firestore syncs.
(function clearHashedPins() {
  try {
    const raw = localStorage.getItem("asd_team_members");
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data) && data.some(m => isHashed(m.pin))) {
      localStorage.removeItem("asd_team_members");
    }
  } catch {}
})();

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
  return arr.map(n => ({ tagged: [], readBy: [], ...n }));
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
  const { team, addMember, removeMember, updateMemberPin, isAdmin } = useTeam();
  const [view, setView] = useState("roster"); // "roster" | "attendance"
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPin, setResetPin] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);
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
const INVOICE_STATUSES = ["Draft","Sent","Paid","Overdue"];
const INVOICE_STATUS_CLR = { Draft:"#64748B", Sent:"#3B82F6", Paid:"#10B981", Overdue:"#EF4444" };

function ClientsModal({ projects, invoices, onAddInvoice, onUpdateInvoice, onRemoveInvoice, onClose }) {
  const { clients, addClient, removeClient } = useTeam();
  const [innerTab, setInnerTab] = useState("clients");

  // ── Clients tab state ──
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);

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
            ) : clients.map(c => (
              <div key={c} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:"var(--c-page)",borderRadius:8,marginBottom:6,border:"1px solid var(--c-border2)"}}>
                <span style={{flex:1,fontSize:13,fontFamily:"monospace",fontWeight:800,color:"#F97316"}}>{c}</span>
                <span style={{fontSize:11,color:"var(--c-t5)",marginRight:4}}>{projects.filter(p=>p.client===c).length} projects</span>
                <button onClick={()=>setConfirmRemove(c)} title="Remove client" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14}}>🗑</button>
              </div>
            ))}
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

function InvoiceFormModal({ invoice, projects, clients, onSave, onClose }) {
  const today = new Date().toISOString().slice(0,10);
  const [invoiceNo, setInvoiceNo] = useState(invoice?.invoiceNo||"");
  const [projectId, setProjectId] = useState(invoice?.projectId||"");
  const [client, setClient] = useState(invoice?.client||"");
  const [amount, setAmount] = useState(invoice?.amount||"");
  const [status, setStatus] = useState(invoice?.status||"Draft");
  const [issuedDate, setIssuedDate] = useState(invoice?.issuedDate||today);
  const [dueDate, setDueDate] = useState(invoice?.dueDate||"");
  const [notes, setNotes] = useState(invoice?.notes||"");
  const [error, setError] = useState("");

  // Auto-fill client when project selected
  const handleProjectChange = (pid) => {
    setProjectId(pid);
    if (pid) {
      const p = projects.find(p=>p.id===pid);
      if (p?.client) setClient(p.client);
    }
  };

  const save = () => {
    if (!invoiceNo.trim()) { setError("Invoice number is required."); return; }
    if (!amount || isNaN(parseFloat(amount))) { setError("Enter a valid amount."); return; }
    onSave({ invoiceNo:invoiceNo.trim(), projectId, client, amount:parseFloat(amount), status, issuedDate, dueDate, notes });
  };

  return (
    <Modal title={invoice?"✎ Edit Invoice":"+ New Invoice"} onClose={onClose}>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4}}>Invoice No *</div>
            <input value={invoiceNo} onChange={e=>setInvoiceNo(e.target.value)} placeholder="INV-001" style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4}}>Amount (AUD) *</div>
            <input value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00" type="number" min="0" step="0.01" style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
        </div>
        <div>
          <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4}}>Project</div>
          <select value={projectId} onChange={e=>handleProjectChange(e.target.value)} style={{...IS,width:"100%"}}>
            <option value="">— Not linked to a project —</option>
            {projects.map(p=><option key={p.id} value={p.id}>{p.jobCode||""}{p.jobCode?" — ":""}{p.name}</option>)}
          </select>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4}}>Client</div>
            <select value={client} onChange={e=>setClient(e.target.value)} style={{...IS,width:"100%"}}>
              <option value="">— None —</option>
              {clients.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4}}>Status</div>
            <select value={status} onChange={e=>setStatus(e.target.value)} style={{...IS,width:"100%"}}>
              {INVOICE_STATUSES.map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4}}>Date Issued</div>
            <input type="date" value={issuedDate} onChange={e=>setIssuedDate(e.target.value)} style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4}}>Due Date</div>
            <input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} style={{...IS,width:"100%",boxSizing:"border-box"}}/>
          </div>
        </div>
        <div>
          <div style={{fontSize:10,fontWeight:800,color:"var(--c-t4)",textTransform:"uppercase",marginBottom:4}}>Notes</div>
          <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Optional notes…" rows={2} spellCheck
            style={{...IS,width:"100%",resize:"vertical",boxSizing:"border-box"}}/>
        </div>
        {error && <div style={{color:"#EF4444",fontSize:11,fontWeight:600}}>⚠ {error}</div>}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",paddingTop:4}}>
          <button onClick={onClose} style={{background:"none",border:"1px solid var(--c-border)",borderRadius:6,padding:"6px 16px",color:"var(--c-t4)",fontSize:12,cursor:"pointer"}}>Cancel</button>
          <button onClick={save} style={{background:"#F97316",border:"none",borderRadius:6,padding:"6px 18px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer"}}>
            {invoice?"Save Changes":"Create Invoice"}
          </button>
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
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=au&format=json&addressdetails=1&limit=7&email=admin@advancedsteeldrafting.com`;
        const res = await fetch(url, { headers: { "Accept-Language": "en-AU" } });
        const data = await res.json();
        const formatted = data.map(d => ({ id: d.place_id, label: fmtAddr(d), raw: d }))
          .filter((d,i,arr) => d.label && arr.findIndex(x => x.label === d.label) === i);
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
      // Built via DOM APIs, not document.write(html) — att.name comes from a
      // user-supplied filename and must never be interpolated into markup.
      win.document.title = att.name;
      win.document.body.style.margin = "0";
      win.document.body.style.background = "#0F172A";
      const iframe = win.document.createElement("iframe");
      iframe.src = att.dataUrl;
      iframe.style.cssText = "border:none;width:100vw;height:100vh;display:block;";
      win.document.body.appendChild(iframe);
    } else {
      // popup blocked — fall back to download
      const link = document.createElement("a");
      link.href = att.dataUrl;
      link.download = att.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } else {
    // Word / Excel / ZIP etc — download
    const link = document.createElement("a");
    link.href = att.dataUrl;
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
        const dataUrl = await readFileAsDataUrl(file);
        newAtts.push({
          id: mkId(), name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size, dataUrl,
          member: currentUser, ts: nowTs(),
        });
      }
      if (rejected.length > 0)
        setErrMsg(`${rejected.length} file(s) exceeded 50MB limit: ${rejected.join(", ")}`);
      setAttachments([...attachments, ...newAtts]);
    } catch (err) {
      setErrMsg("Failed to read file: " + err.message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const delAttachment = (id) => setAttachments(attachments.filter(a => a.id !== id));

  const downloadAtt = (att) => {
    const link = document.createElement("a");
    link.href = att.dataUrl; link.download = att.name;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const handleSave = () => {
    const original = item.attachments || [];
    const newAtts = attachments.filter(a => !original.some(o => o.id === a.id));
    const removedAtts = original.filter(o => !attachments.some(a => a.id === o.id));
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
                      src={att.dataUrl} alt={att.name}
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
          <img src={preview.dataUrl} alt={preview.name} style={{maxWidth:"90%",maxHeight:"85%",borderRadius:8,boxShadow:"0 0 40px rgba(0,0,0,0.8)"}} onClick={e=>e.stopPropagation()}/>
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

  const confirm = () => {
    if (!capturedUrl) return;
    const ts   = nowTs();
    const ext  = capturedType.split("/")[1] || "png";
    const name = capturedName || `snip_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`;
    const approxSize = Math.round((capturedUrl.length - capturedUrl.indexOf(",") - 1) * 0.75);
    const att  = { id: mkId(), name, type: capturedType, size: approxSize, dataUrl: capturedUrl, member: currentUser, ts };
    onSave(item.id, [...(item.attachments || []), att], [{ ts, member: currentUser, action: "attached", note: name }]);
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
                <img src={a.dataUrl} alt={a.name} onClick={()=>setLightbox(a)}
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
          <img src={lightbox.dataUrl} alt={lightbox.name} style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8,boxShadow:"0 0 40px #000"}}/>
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
  const syncing = !teamReady;

  const handlePin = digit => {
    if (pin.length >= 4 || syncing) return;
    const next = pin + digit;
    setPin(next);
    setError("");
    if (next.length === 4) {
      const matched = TEAM.find(name => verifyPin(name, next));
      if (matched) {
        onLogin(matched);
      } else {
        setError("Incorrect code. Try again.");
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
        {error && <div style={{color:"#EF4444",fontSize:12,marginBottom:14,fontWeight:600}}>{error}</div>}

        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,maxWidth:260,margin:"0 auto",opacity:syncing?0.35:1,pointerEvents:syncing?"none":"auto"}}>
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
function ProjectNotesPanel({ notes, currentUser, onAdd, onRemove, onMarkRead, onEdit }) {
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

  const mentionMatches = mention ? teamNames.filter(n => n!==currentUser && n.toUpperCase().startsWith(mention.query.toUpperCase())) : [];
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
    onAdd(draft.trim(), tagged);
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
                <div style={{background:"var(--c-page)",border:`1px solid ${iAmTagged&&!iHaveRead?"#F9731666":isEditing?"#F9731633":"var(--c-border2)"}`,borderRadius:6,padding:"7px 10px",opacity:isEditing?0.5:1,minWidth:0,width:"100%",boxSizing:"border-box"}}>
                  <div style={{display:"flex",justifyContent:"space-between",gap:8}}>
                    <div onClick={()=>{if(onEdit&&!isEditing){setEditingNoteId(n.id);setEditText(n.text);}}} title={onEdit&&!isEditing?"Click to edit":""}
                      style={{flex:1,minWidth:0,fontSize:12,color:"var(--c-t2)",lineHeight:1.4,whiteSpace:"pre-wrap",wordBreak:"break-word",overflowWrap:"break-word",cursor:onEdit&&!isEditing?"text":"default",maxHeight:"calc(1.4em * 5)",overflowY:"auto"}}>{n.text}</div>
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
                  {iAmTagged && !iHaveRead && (
                    <button onClick={()=>onMarkRead(n.id)} style={{width:"100%",marginTop:6,background:"#F9731620",border:"1px solid #F97316",borderRadius:5,padding:"4px 0",color:"#F97316",fontWeight:700,cursor:"pointer",fontSize:11,animation:"asd-read-pulse 1.6s ease-in-out infinite"}}>✓ Mark as read</button>
                  )}
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

function ProjectForm({ initial, currentUser, onSave, onClose, masterTemplate }) {
  const { teamNames: TEAM, clients } = useTeam();
  // If an existing project's client isn't in the curated list anymore (e.g. removed
  // by the admin since), keep showing it so the form doesn't silently lose the value.
  const blank = {
    jobCode: "", name: "", client: "", type: "Residential", status: "IN PROGRESS",
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

  return (
    <div onKeyDown={e=>{ if (e.key==="Enter" && !["TEXTAREA","BUTTON","INPUT"].includes(e.target.tagName)) { e.preventDefault(); save(); } }}>
      <div style={{background:"linear-gradient(135deg,#F9731620 0%,#F9731610 100%)",border:"2px solid #F97316",borderRadius:10,padding:"16px 18px",marginBottom:18,boxShadow:"0 0 20px rgba(249,115,22,0.15)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <span style={{fontSize:16}}>🏷</span>
          <span style={{fontSize:11,fontWeight:800,color:"#F97316",letterSpacing:"0.1em",textTransform:"uppercase"}}>Job Code (Required — Primary Identifier)</span>
        </div>
        <input type="text" value={f.jobCode} onChange={e=>s("jobCode",e.target.value.toUpperCase())} placeholder="e.g. USS-009 / DF-006 / GS-003" autoFocus
          style={{width:"100%",background:"var(--c-page)",border:"1px solid #F9731644",borderRadius:7,padding:"10px 14px",color:"#F97316",fontSize:18,fontWeight:900,fontFamily:"monospace",letterSpacing:"0.1em",textTransform:"uppercase",outline:"none",boxSizing:"border-box"}}/>
        <div style={{marginTop:10}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
            <label style={{color:"var(--c-t3)",fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase"}}>Project Address</label>
            {f.name.trim() && <button onClick={copyAddress} style={{background:"none",border:"none",cursor:"pointer",fontSize:10,fontWeight:700,color:addrCopied?"#10B981":"#64748B",padding:"0 2px",transition:"color 0.2s"}}>{addrCopied?"✓ Copied":"⎘ Copy"}</button>}
          </div>
          <AddressAutocomplete value={f.name} onChange={e=>s("name",e.target.value)} placeholder="e.g. 55 Molesworth St, Kew" style={{...IS,width:"100%",boxSizing:"border-box"}}/>
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

function ProjectCard({ project, tasks, currentUser, onClick, onEdit, onDelete, onComplete, onChecklist, onStatusChange, onFieldChange, onAddNote, onRemoveNote, onMarkNoteRead, onEditNote }) {
  const { teamNames, memberColor } = useTeam();
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
            {project.siteMeasureRequired==="Yes" && <span title="Site measure required" style={{color:"#F59E0B",fontSize:9,fontWeight:700,background:"#F59E0B18",borderRadius:3,padding:"1px 5px"}}>📐 Site Measure</span>}
            {project.siteMeasureRequired==="TBC" && <span title="Site measure — to be confirmed" style={{color:"var(--c-t3)",fontSize:9,fontWeight:700,background:"#94A3B818",borderRadius:3,padding:"1px 5px"}}>📐 Site Measure: TBC</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:4,marginLeft:8}}>
          <button onClick={e=>{e.stopPropagation();e.preventDefault();onComplete();}} title="Mark complete" style={{background:"none",border:"none",color:"#10B981",cursor:"pointer",fontSize:14,padding:2}}>✓</button>
          <button onClick={e=>{e.stopPropagation();e.preventDefault();onEdit();}} title="Edit" style={{background:"#F9731620",border:"1px solid #F9731644",color:"#F97316",cursor:"pointer",fontSize:12,padding:"2px 6px",borderRadius:4,fontWeight:700}}>✎ Edit</button>
          <button onClick={e=>{e.stopPropagation();e.preventDefault();onDelete();}} title="Delete" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14,padding:2}}>🗑</button>
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
          onEdit={(id,text)=>onEditNote&&onEditNote(project.id,id,text)}/>
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

function ChecklistTab({ projects, currentUser, onUpdateChecklist, onFieldChange, initialId, masterTemplate, setMasterTemplate, onSyncProject, onReorderMaster, projectsWithUpdates, deletedMasterItems, setDeletedMasterItems, onToggleNoteDone }) {
  const { memberColor: MEMBER_COLOR, teamNames: TEAM_NAMES, isAdmin } = useTeam();
  const canDelete = isAdmin(currentUser) || currentUser === "LESLIE";
  const [editMode, setEditMode] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [clSortBy, setClSortBy] = useState("jobCode"); // "jobCode" | "priority" — must be before sortCLProjects
  const initialProject = initialId ? projects.find(p=>p.id===initialId) : null;
  const initialIsCompleted = initialProject?.status === "Completed";
  const activeProjects = projects.filter(p => p.status !== "Completed");
  const completedProjects = projects.filter(p => p.status === "Completed");
  const sortCLProjects = arr => clSortBy === "priority"
    ? [...arr].sort((a,b) => { const ra = (PRIORITY_RANK[a.priority]??9), rb = (PRIORITY_RANK[b.priority]??9); return ra!==rb?ra-rb:(a.jobCode||"").localeCompare(b.jobCode||"",undefined,{numeric:true,sensitivity:"base"}); })
    : [...arr].sort((a,b) => (a.jobCode||"").localeCompare(b.jobCode||"",undefined,{numeric:true,sensitivity:"base"}));
  const visibleProjects = sortCLProjects((showCompleted || initialIsCompleted) ? [...activeProjects, ...completedProjects] : activeProjects);

  const [selId, setSelId] = useState(initialId || activeProjects[0]?.id || null);
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
  const clNoteInputRef = useRef(null);
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
      history:[...(c.history||[]), { ts:nowTs(), member:currentUser, action:c.done?"unchecked":"checked" }]
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
      ...c, flag:null, history:[...(c.history||[]), { ts:nowTs(), member:currentUser, action:"unflagged" }]
    } : {
      ...c, flag:{ member:currentUser, ts:nowTs(), reason:"" }, history:[...(c.history||[]), { ts:nowTs(), member:currentUser, action:"flagged" }]
    }) : c);
    onUpdateChecklist(selId, next);
  };
  const saveAttachments = (id, attachments, histEntries) => {
    const next = cl.map(c => c.id===id ? {
      ...c, attachments,
      history:[...(c.history||[]), ...histEntries]
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
    const note = { id:mkId(), text:clNoteDraft.trim(), author:currentUser, ts:nowTs(), tagged:clNoteTagged, readBy:[] };
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
  const flaggedCount = relCL.filter(c=>c.flag).length;
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
        <div style={{display:"grid",gridTemplateColumns:"220px 1fr",gap:12,minHeight:"60vh"}}>
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
                const pFlags = pcl.filter(c=>c.flag).length;
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
                        {pFlags>0 && <span style={{fontSize:9,color:"#F59E0B",fontWeight:700,background:"#F59E0B18",borderRadius:3,padding:"1px 4px"}}>🚩{pFlags}</span>}
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
                    <div style={{fontSize:13,color:"var(--c-t2)",fontWeight:600}}>{selProject.name}</div>
                  </div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:24,fontWeight:900,color:pc,fontFamily:"monospace",lineHeight:1}}>{pct}%</div><div style={{fontSize:10,color:"var(--c-t5)"}}>{totalDone}/{cl.length}</div></div>
                </div>
                <div style={{background:"var(--c-page)",borderRadius:4,height:8,overflow:"hidden",marginBottom:10}}><div style={{width:`${pct}%`,height:"100%",background:pc,borderRadius:4}}/></div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <input value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} placeholder="Search…" style={{...IS,width:150,fontSize:12,padding:"5px 8px",flex:"0 0 auto"}}/>
                  <div style={{display:"flex",background:"var(--c-page)",borderRadius:5,padding:2,gap:2}}>
                    {["All","Pending","Done","Flagged"].map(f=><button key={f} onClick={()=>setClFilter(f)} style={{padding:"3px 10px",borderRadius:3,border:"none",background:clFilter===f?(f==="Flagged"?"#F59E0B30":"var(--c-panel)"):"transparent",color:clFilter===f?(f==="Flagged"?"#F59E0B":"var(--c-t1)"):"var(--c-t5)",cursor:"pointer",fontSize:11,fontWeight:clFilter===f?700:400}}>
                      {f==="Flagged"&&"🚩 "}{f}{f==="Flagged"&&flaggedCount>0&&<span style={{marginLeft:4,fontSize:9}}>{flaggedCount}</span>}
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
                        const hasTag = (n.tagged||[]).length > 0;
                        return (
                          <div key={n.id} style={{background:"var(--c-panel)",borderRadius:6,padding:"7px 10px",borderLeft:`3px solid ${mc}`,opacity:n.done?0.5:1}}>
                            {isEditing ? (
                              <textarea autoFocus spellCheck value={clNoteEditText} onChange={e=>setClNoteEditText(e.target.value)}
                                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();saveClNoteEdit(n.id);}if(e.key==="Escape"){setClNoteEditId(null);setClNoteEditText("");}}}
                                style={{...IS,width:"100%",fontSize:12,padding:"4px 6px",resize:"vertical",minHeight:54,marginBottom:4,boxSizing:"border-box"}}/>
                            ) : (
                              <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
                                {hasTag && (
                                  <div onClick={()=>onToggleNoteDone?.(selId,n.id,"Tracker")}
                                    title={n.done?"Mark as not done":"Mark as done"}
                                    style={{width:15,height:15,borderRadius:3,border:"1.5px solid #F97316",background:n.done?"#F97316":"transparent",cursor:"pointer",flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center"}}>
                                    {n.done && <span style={{color:"#fff",fontSize:10,lineHeight:1}}>✓</span>}
                                  </div>
                                )}
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
                              {n.author===currentUser&&(
                                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                                  {isEditing
                                    ? <><button onClick={()=>saveClNoteEdit(n.id)} style={{background:"#10B981",border:"none",borderRadius:4,padding:"2px 8px",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer"}}>Save</button>
                                        <button onClick={()=>{setClNoteEditId(null);setClNoteEditText("");}} style={{background:"none",border:"none",color:"var(--c-t4)",fontSize:10,cursor:"pointer"}}>Cancel</button></>
                                    : <><button onClick={()=>{setClNoteEditId(n.id);setClNoteEditText(n.text);}} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:11,padding:0}}>✎</button>
                                        <button onClick={()=>removeClNote(n.id)} style={{background:"none",border:"none",color:"#334155",cursor:"pointer",fontSize:11,padding:0}}>×</button></>
                                  }
                                </div>
                              )}
                            </div>
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
    <div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,overflow:"hidden",display:"flex",flexDirection:"column",minHeight:"60vh"}}>
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
        {(deletedMasterItems||[]).length > 0 && (
          <div style={{marginTop:20,borderTop:"1px solid var(--c-border)",paddingTop:16}}>
            <button onClick={()=>setShowDeletedItems(s=>!s)} style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6,marginBottom:showDeletedItems?10:0}}>
              🗑 Recently Deleted ({deletedMasterItems.length}) {showDeletedItems?"▲":"▼"}
            </button>
            {showDeletedItems && (deletedMasterItems||[]).map(item => {
              const sc = SECTION_CLR[item.section] || "#64748B";
              return (
                <div key={item.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 12px",background:"var(--c-page)",borderRadius:7,marginBottom:4,borderLeft:`2px solid #334155`,opacity:0.7}}>
                  <span style={{fontSize:9,fontFamily:"monospace",color:"#334155",background:"var(--c-panel)",borderRadius:3,padding:"1px 5px"}}>{item.section}</span>
                  <span style={{flex:1,color:"var(--c-t4)",fontSize:13,textDecoration:"line-through"}}>{item.label}</span>
                  <span style={{fontSize:9,color:"var(--c-t5)"}}>{fmtTs(item._deletedAt)}</span>
                  <button onClick={()=>restoreMasterItem(item.id)} style={{background:"#10B98120",border:"1px solid #10B98144",borderRadius:5,padding:"3px 8px",color:"#10B981",cursor:"pointer",fontSize:11,fontWeight:700}}>↩ Restore</button>
                  <button onClick={()=>permanentDeleteMasterItem(item.id)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:12}}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
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
  const activeProjects = projects.filter(p => p.status !== "Completed");
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
  const { memberColor: MEMBER_COLOR } = useTeam();
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
                <button onClick={()=>onRemove(ev.id)} title="Remove" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:14,flexShrink:0}}>✕</button>
              </div>
            );
          })}
        </div>
      )}
      <div style={{fontSize:11,color:TT.textFaint,textAlign:"center",marginBottom:10}}>⠿ Drag a task to reorder, or drag it onto another day on the calendar to move it</div>
      <button onClick={e=>onAdd(e.currentTarget.getBoundingClientRect())} style={{width:"100%",background:"#3B5BFF14",border:"1px solid #3B5BFF",color:"#3B5BFF",borderRadius:6,padding:"9px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>+ Add Project</button>
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
                <button onClick={e=>{ setAddingFor(member); setAddAnchorRect(e.currentTarget.getBoundingClientRect()); }} style={{background:"none",border:"none",color:"#3B5BFF",cursor:"pointer",fontSize:11,fontWeight:700}}>+ Add</button>
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
const HOUR_PX = 56; // pixel height per hour row

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
  const activeProjects = projects.filter(p => p.status !== "Completed");
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
      <button onClick={()=>{onDelete();onClose();}} style={{display:"flex",alignItems:"center",gap:8,width:"100%",textAlign:"left",padding:"7px 10px",borderRadius:5,border:"none",background:"transparent",color:"#EF4444",fontSize:12,fontWeight:600,cursor:"pointer"}}>🗑 Delete</button>
      <div style={{fontSize:9,color:TT.textFaint,padding:"4px 10px 2px",borderTop:`1px solid ${TT.border}`,marginTop:2}}>or press Delete</div>
    </div>
  );
}

function DayHourView({ date, events, projects, member, currentUser, hourRange, onAddAt, onEdit, onToggleDone, onRemove, onMoveTime, onResize, onToggleSubtask, draggingInboxItem, onDropInboxItem, onCopyEvent, onGcalClick }) {
  const { memberColor: MEMBER_COLOR } = useTeam();
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
    e.stopPropagation();
    const y = getOffsetY(e.clientY);
    setInteraction({ mode:"move", id:ev.id, grabOffset:y-top, startTop:top, currentTop:top, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };
  const beginResize = (e, ev, top, height) => {
    e.stopPropagation();
    setInteraction({ mode:"resize", id:ev.id, startTop:top, currentTop:top, startHeight:height, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };
  // Dragging the top edge moves the start time while keeping the end time fixed —
  // the bottom edge stays anchored at top+height as the user drags.
  const beginResizeTop = (e, ev, top, height) => {
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
    const height = Math.max(20, (ev.durationMin||60) / 60 * HOUR_PX - 2);
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
      <div ref={scrollRef} style={{position:"relative",height:"calc(100vh - 200px)",overflowY:"auto",border:`1px solid ${TT.border}`,borderRadius:10,background:TT.bg}}>
        <div style={{position:"relative",height:totalHeight,display:"flex"}}>
          {/* Hour labels column */}
          <div style={{width:54,flexShrink:0,borderRight:`1px solid ${TT.border}`}}>
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
                <div key={ev.id}
                  onPointerDown={e=>beginMove(e, ev, top, height)}
                  onClick={e=>{ e.stopPropagation(); if(!wasMovedRef.current) onEdit(ev, e.currentTarget.getBoundingClientRect()); }}
                  onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); setContextMenu({x:e.clientX,y:e.clientY,ev,rect:e.currentTarget.getBoundingClientRect()}); }}
                  title="Drag to reschedule · Ctrl+drag to copy · drag top/bottom edge to resize · click to edit · right-click to delete"
                  style={{
                    position:"absolute", top:displayTop, height:displayHeight, left:`calc(${lane*widthPct}% + 3px)`, width:`calc(${widthPct}% - 6px)`,
                    background:ev.done?"#F7F8FA":`${mc}26`, border:"none",
                    borderRadius:5, padding:"3px 7px", cursor:isActive&&interaction.mode==="resize"?"ns-resize":isActive&&ctrlHeld?"copy":"grab", overflow:"visible", zIndex:isActive?9:2,
                    boxShadow:isActive?TT.shadow:"none", touchAction:"none", boxSizing:"border-box",
                  }}>
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
              );
            })}
          </div>
        </div>
      </div>
      <div style={{fontSize:10,color:TT.textFaint,textAlign:"center",marginTop:8}}>Drag on empty space to create a task · Drag a task to move it · Drag its bottom edge to resize · Right-click to delete</div>
      {contextMenu && (
        <TaskContextMenu x={contextMenu.x} y={contextMenu.y}
          onEdit={()=>onEdit(contextMenu.ev, contextMenu.rect)}
          onDelete={()=>onRemove(contextMenu.ev.id)}
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

function WeekHourView({ weekDates, eventsByDay, projects, member, hourRange, onAddAt, onEdit, onToggleDone, onMoveTask, onResize, onToggleSubtask, onRemove, draggingInboxItem, onDropInboxItem, onCopyEvent, onGcalClick }) {
  const { memberColor: MEMBER_COLOR } = useTeam();
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

  // Per-day lane assignment so overlapping tasks split into side-by-side columns within that day
  const laneForDay = (dymd) => {
    const timed = (eventsByDay[dymd]||[]).filter(e=>e.startTime);
    const positioned = timed.map(ev => ({ ev, top: timeToOffset(ev.startTime), height: Math.max(18,(ev.durationMin||60)/60*HOUR_PX-2) })).sort((a,b)=>a.top-b.top);
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
    e.stopPropagation();
    const y = getOffsetYInCol(e.clientY, dymd);
    setInteraction({ mode:"move", id:ev.id, originDate:dymd, date:dymd, grabOffset:y-top, startTop:top, currentTop:top, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };
  const beginResize = (e, ev, top, height, dymd) => {
    e.stopPropagation();
    setInteraction({ mode:"resize", id:ev.id, date:dymd, startTop:top, currentTop:top, startHeight:height, currentHeight:height, moved:false });
    e.target.setPointerCapture?.(e.pointerId);
  };
  // Dragging the top edge moves the start time while keeping the end time fixed
  const beginResizeTop = (e, ev, top, height, dymd) => {
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
      <div ref={scrollRef} style={{position:"relative",height:"calc(100vh - 200px)",overflowY:"auto",border:`1px solid ${TT.border}`,borderRadius:10,background:TT.bg}}>
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
          <div style={{width:54,flexShrink:0,borderRight:`1px solid ${TT.border}`}}>
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
                style={{position:"relative",flex:1,borderLeft:`1px solid ${TT.border}`,background:isMoveTargetHere?"#3B5BFF0C":today?"#3B5BFF08":"transparent",touchAction:"none",cursor:interaction?.mode==="draw"?"ns-resize":"default"}}
                onPointerDown={e=>{ if(!quickAdd) handleAreaPointerDown(e,dymd); }}
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
                    <div key={ev.id}
                      onPointerDown={e=>beginMove(e, ev, top, height, dymd)}
                      onClick={e=>{ e.stopPropagation(); if(!wasMovedRef.current) onEdit(ev, e.currentTarget.getBoundingClientRect()); }}
                      onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); setContextMenu({x:e.clientX,y:e.clientY,ev,rect:e.currentTarget.getBoundingClientRect()}); }}
                      title="Drag to reschedule · Ctrl+drag to copy · drag top/bottom edge to resize · click to edit · right-click to delete"
                      style={{
                        position:"absolute", top:displayTop, height:displayHeight, left:`calc(${lane*widthPct}% + 2px)`, width:`calc(${widthPct}% - 4px)`,
                        background:ev.done?"#F7F8FA":`${mc}26`, border:"none",
                        borderRadius:4, padding:"2px 5px", cursor:isActive&&(interaction.mode==="resize"||interaction.mode==="resizeTop")?"ns-resize":isActive&&ctrlHeld?"copy":"grab", overflow:"visible",
                        zIndex:isActive?9:2, boxShadow:isActive?TT.shadow:"none", touchAction:"none", boxSizing:"border-box",
                      }}>
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
          onDelete={()=>onRemove?.(contextMenu.ev.id)}
          onClose={()=>setContextMenu(null)}
        />
      )}
    </div>
  );
}

function CalendarTab({ projects, tasks, feedback, calendarEvents, currentUser, onAddEvent, onRemoveEvent, onUpdateEvent, onMoveEvent, onReorderDay, onToggleSubtask, onCompleteProject, onCompleteTask, onToggleNoteDone, draggingNoticeItem, onCopyEvent, draggingMyInboxItem, onMarkMyInboxItemRead }) {
  const { teamNames: TEAM, memberColor: MEMBER_COLOR } = useTeam();
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const calKey = k => `asd_cal_${k}_${currentUser}`;
  const [viewMode, setViewMode] = useState(() => localStorage.getItem(calKey("viewMode")) || "single");
  const [singleSubView, setSingleSubView] = useState(() => localStorage.getItem(calKey("singleSubView")) || "week");
  const [selDate, setSelDate] = useState(TODAY);
  const [hourRange, setHourRange] = useState(() => { try { return JSON.parse(localStorage.getItem(calKey("hourRange"))) || { start: 6, end: 21 }; } catch { return { start: 6, end: 21 }; } });
  const [hourPreset, setHourPreset] = useState(() => localStorage.getItem(calKey("hourPreset")) || "work");
  const [showHourSettings, setShowHourSettings] = useState(false);
  const [allSubView, setAllSubView] = useState(() => localStorage.getItem(calKey("allSubView")) || "timeline");
  useEffect(() => { localStorage.setItem(calKey("viewMode"), viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem(calKey("singleSubView"), singleSubView); }, [singleSubView]);
  useEffect(() => { localStorage.setItem(calKey("allSubView"), allSubView); }, [allSubView]);
  useEffect(() => { localStorage.setItem(calKey("hourRange"), JSON.stringify(hourRange)); }, [hourRange]);
  useEffect(() => { localStorage.setItem(calKey("hourPreset"), hourPreset); }, [hourPreset]);
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

  // ── Google Calendar integration ────────────────────────────────────────────
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
      if (res.status === 401) { setGcalConnected(false); return; }
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const { items } = await res.json();
      setGcalEvents(items || []);
      setGcalConnected(true);
    } catch(e) { setGcalError(e.message); }
    finally { setGcalLoading(false); }
  }, [currentUser]);

  // Remove a meeting from local list only (server re-fetches will restore it on next sync)
  const deleteGcalEvent = useCallback(id => {
    setGcalEvents(prev => prev.filter(e => e.id !== id));
  }, []);

  // Opens a popup to Railway's OAuth flow — user signs in once, refresh token stored on server permanently
  const connectGcal = useCallback(() => {
    const popup = window.open(`/gcal/auth/url?user=${encodeURIComponent(currentUser)}`, "gcal-auth", "width=520,height=640,left=200,top=100");
    if (!popup) { setGcalError("Popup blocked — allow popups for this site."); return; }
    const onMsg = e => {
      if (!e.data?.gcalAuth) return;
      window.removeEventListener("message", onMsg);
      if (e.data.gcalAuth === "connected") { setGcalConnected(true); fetchGcalEvents(); }
      else { setGcalError(`Connection failed: ${e.data.reason || "unknown error"}`); }
    };
    window.addEventListener("message", onMsg);
    // Cleanup if popup closed without postMessage (user dismissed)
    const poll = setInterval(() => { if (popup.closed) { clearInterval(poll); window.removeEventListener("message", onMsg); } }, 500);
  }, [currentUser, fetchGcalEvents]);

  // On mount: check if this user already has Calendar connected, then fetch events
  useEffect(() => {
    fetch(`/gcal/status?user=${encodeURIComponent(currentUser)}`)
      .then(r => r.json())
      .then(d => { if (d.connected) { setGcalConnected(true); fetchGcalEvents(); } })
      .catch(() => {});
  }, [currentUser]);

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
  const effectiveDraggingItem = draggingInboxItem || myInboxDrag || (draggingNoticeItem ? { type:"notice", projectId:"", taskTitle: draggingNoticeItem.text?.slice(0,120)||"" } : null);

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
    const member = src ? currentUser : selMember; // MyInbox items always belong to currentUser
    onAddEvent({ id:mkId(), date, member, projectId:effectiveDraggingItem.projectId||"", task:effectiveDraggingItem.taskTitle||"", subtasks:[], startTime:timeHint||"", durationMin:effectiveDraggingItem.type==="project"?120:90, createdBy:currentUser, ts:nowTs(), order:dayCount, done:false, ...(noteId?{noteId}:{}), ...(fbId?{fbId}:{}), ...(inboxItemType?{inboxItemType}:{}) });
    if (src) onMarkMyInboxItemRead?.(src.type, src.id, src.project?.id);
    setDraggingInboxItem(null); setDragOverDay(null);
  };

  const grid = buildMonthGrid(viewYear, viewMonth);

  // Helper: returns false for any calendar event whose linked project is completed
  const isActiveEvent = e => {
    if (!e.projectId) return true;
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
      {/* ── Left panel: Work Inbox & Tagged Notes ── */}
      <div style={{width:330,flexShrink:0,position:"sticky",top:62,maxHeight:"calc(100vh - 80px)",overflowY:"auto",background:TT.panel,border:`1px solid ${inboxCount>0?"#F9731644":TT.border}`,boxShadow:inboxCount>0?"0 0 0 2px #F9731622":"none",borderRadius:10,display:"flex",flexDirection:"column"}}>
        <div style={{padding:"10px 14px",borderBottom:`1px solid ${TT.border}`,flexShrink:0}}>
          <div style={{fontSize:12,fontWeight:800,color:TT.text,display:"flex",alignItems:"center",gap:6}}>
            📥 Work Inbox
            {inboxCount>0&&<span style={{background:"#F97316",color:"#fff",borderRadius:10,padding:"1px 7px",fontSize:10,fontWeight:800}}>{inboxCount}</span>}
          </div>
        </div>

        <div style={{flex:1,overflowY:"auto",padding:"10px 14px",display:"flex",flexDirection:"column",gap:6}}>
          {inboxCount===0&&<div style={{textAlign:"center",color:TT.textFaint,fontSize:11,padding:"20px 0"}}>Nothing pending.</div>}
          {inboxTasks.length>0&&(
            <>
              <div style={{fontSize:10,fontWeight:700,color:TT.textSub,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2}}>Assigned Tasks</div>
              {inboxTasks.map(t=>{
                const proj=projects.find(p=>p.id===t.projectId);
                return(
                  <div key={t.id} draggable onDragStart={e=>{e.dataTransfer.effectAllowed="move";setDraggingInboxItem({type:"task",projectId:t.projectId||"",taskTitle:t.title});}} onDragEnd={()=>setDraggingInboxItem(null)}
                    style={{display:"flex",alignItems:"center",gap:6,padding:"7px 8px",background:TT.panel,borderRadius:7,border:`1px solid ${TT.border}`,cursor:"grab"}}>
                    <div onClick={()=>onCompleteTask?.(t.id)} title="Mark complete" style={{width:14,height:14,borderRadius:3,border:"1.5px solid #6B7280",background:"#fff",flexShrink:0,cursor:"pointer"}}/>
                    {proj&&<span style={{fontSize:10,fontFamily:"monospace",fontWeight:800,color:mc,flexShrink:0}}>{proj.jobCode}</span>}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:11,color:TT.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</div>
                      {t.assignedBy&&<div style={{fontSize:9,color:TT.textFaint}}>by {t.assignedBy}</div>}
                    </div>
                    <button onClick={e=>{e.stopPropagation();setAddModal(t.due>=TODAY?t.due:TODAY);setAddModalFromInbox(true);setPrefillProjectId(t.projectId||"");setPrefillTask(t.title);setPrefillTime("09:00");setPrefillDuration(90);}}
                      style={{background:"#F97316",color:"#fff",border:"none",borderRadius:4,padding:"3px 7px",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0}}>+</button>
                  </div>
                );
              })}
            </>
          )}
          {inboxNotes.length>0&&(
            <>
              <div style={{fontSize:10,fontWeight:700,color:"#F97316",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2,marginTop:inboxTasks.length>0?8:0}}>Tagged in Notes</div>
              {inboxNotes.map((n,i)=>(
                <div key={n.noteId+i} draggable onDragStart={e=>{e.dataTransfer.effectAllowed="move";setDraggingInboxItem({type:"note-tag",projectId:n.projectId,taskTitle:n.text.length>80?n.text.slice(0,77)+"…":n.text,noteId:n.noteId});}} onDragEnd={()=>setDraggingInboxItem(null)}
                  style={{display:"flex",alignItems:"flex-start",gap:6,padding:"7px 8px",background:TT.panel,borderRadius:7,border:"1.5px solid #F9731444",cursor:"grab"}}>
                  <div onClick={e=>{e.stopPropagation();onToggleNoteDone?.(n.projectId,n.noteId,n.source);}} title="Mark as done"
                    style={{width:14,height:14,borderRadius:3,border:"1.5px solid #F97316",background:"transparent",cursor:"pointer",flexShrink:0,marginTop:2}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                      <span style={{fontSize:10,fontFamily:"monospace",fontWeight:800,color:"#F97316",background:"#F9731618",borderRadius:3,padding:"1px 4px",flexShrink:0}}>{n.project.jobCode||"—"}</span>
                      <span style={{fontSize:9,color:"#F97316",fontWeight:700,background:"#F9731618",borderRadius:8,padding:"1px 5px",flexShrink:0}}>{n.source}</span>
                    </div>
                    <div style={{fontSize:11,color:TT.text,lineHeight:1.4}}>{n.text}</div>
                    {n.author&&<div style={{fontSize:9,color:TT.textFaint,marginTop:1}}>Tagged by {n.author}</div>}
                  </div>
                  <button onClick={e=>{e.stopPropagation();setAddModal(TODAY);setAddModalFromInbox(true);setPrefillProjectId(n.projectId);setPrefillTask(n.text.length>80?n.text.slice(0,77)+"…":n.text);setPrefillTime("09:00");setPrefillDuration(60);setPrefillNoteId(n.noteId);}}
                    style={{background:"#F97316",color:"#fff",border:"none",borderRadius:4,padding:"3px 7px",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0}}>+</button>
                </div>
              ))}
            </>
          )}
          {inboxFeedback.length>0&&(
            <>
              <div style={{fontSize:10,fontWeight:700,color:"#3B82F6",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2,marginTop:(inboxTasks.length>0||inboxNotes.length>0)?8:0}}>Tagged in Feedback</div>
              {inboxFeedback.map((f,i)=>(
                <div key={f.fbId+i} draggable onDragStart={e=>{e.dataTransfer.effectAllowed="move";setDraggingInboxItem({type:"feedback",projectId:f.projectId,taskTitle:f.text.length>80?f.text.slice(0,77)+"…":f.text});}} onDragEnd={()=>setDraggingInboxItem(null)}
                  style={{display:"flex",alignItems:"flex-start",gap:6,padding:"7px 8px",background:TT.panel,borderRadius:7,border:"1.5px solid #3B82F644",cursor:"grab"}}>
                  <span style={{fontSize:12,flexShrink:0,marginTop:1}}>💬</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                      <span style={{fontSize:10,fontFamily:"monospace",fontWeight:800,color:"#3B82F6",background:"#3B82F618",borderRadius:3,padding:"1px 4px",flexShrink:0}}>{f.project?.jobCode||"—"}</span>
                    </div>
                    <div style={{fontSize:11,color:TT.text,lineHeight:1.4}}>{f.text}</div>
                    {f.author&&<div style={{fontSize:9,color:TT.textFaint,marginTop:1}}>From {f.author}</div>}
                  </div>
                  <button onClick={e=>{e.stopPropagation();setAddModal(TODAY);setAddModalFromInbox(true);setPrefillProjectId(f.projectId);setPrefillTask(f.text.length>80?f.text.slice(0,77)+"…":f.text);setPrefillTime("09:00");setPrefillDuration(60);}}
                    style={{background:"#3B82F6",color:"#fff",border:"none",borderRadius:4,padding:"3px 7px",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0}}>+</button>
                </div>
              ))}
            </>
          )}
        </div>

      </div>
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
                  return <button key={m} onClick={()=>{ setSelMember(m); setShowMemberSwitch(false); }} style={{
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
          {/* ── Google Calendar compact control ── */}
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
            {!gcalConnected ? (
              <button onClick={connectGcal} title="Connect Google Calendar"
                style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:7,border:"1px solid #dadce0",background:"#fff",cursor:"pointer",fontSize:12,fontWeight:600,color:"#3c4043",boxShadow:"0 1px 2px rgba(0,0,0,0.08)"}}>
                <svg width="14" height="14" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                Connect Google Calendar
              </button>
            ) : (<>
              <button ref={gcalBtnRef}
                onClick={() => {
                  if (!gcalListOpen && gcalBtnRef.current) {
                    const r = gcalBtnRef.current.getBoundingClientRect();
                    setGcalListPos({ right: window.innerWidth - r.right, top: r.bottom + 6 });
                  }
                  setGcalListOpen(o => !o);
                }}
                disabled={gcalLoading}
                title="View / manage Google Calendar meetings"
                style={{display:"inline-flex",alignItems:"center",gap:5,padding:"5px 10px",borderRadius:7,border:`1px solid ${gcalListOpen?"#7C3AED66":"#4285F433"}`,background:gcalListOpen?"#7C3AED10":"#4285F408",cursor:"pointer",fontSize:12,fontWeight:600,color:gcalListOpen?"#7C3AED":"#4285F4",transition:"all 0.15s"}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 9h18" stroke="currentColor" strokeWidth="2"/><path d="M8 2v4M16 2v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                {gcalLoading ? "Syncing…" : gcalEvents.length > 0 ? `${gcalEvents.length} meetings ▾` : "Meetings ▾"}
              </button>
              <button
                onClick={() => fetchGcalEvents()}
                disabled={gcalLoading}
                title="Sync Google Calendar now"
                style={{display:"inline-flex",alignItems:"center",justifyContent:"center",padding:"5px 7px",borderRadius:7,border:"1px solid #4285F433",background:"#4285F408",cursor:gcalLoading?"not-allowed":"pointer",color:"#4285F4",transition:"all 0.15s",opacity:gcalLoading?0.5:1}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M23 4v6h-6" stroke="#4285F4" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M1 20v-6h6" stroke="#4285F4" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" stroke="#4285F4" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </>)}
            {gcalError && <span style={{fontSize:11,color:"#EF4444"}}>{gcalError}</span>}
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
              <button onClick={()=>setSelDate(TODAY)} style={{background:"#FFFFFF",border:`1px solid ${TT.border}`,borderRadius:6,color:TT.textSub,cursor:"pointer",padding:"6px 14px",fontSize:12,fontWeight:700}}>Today</button>

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
          onToggleDone={(id)=>onUpdateEvent(id,{done: !calendarEvents.find(e=>e.id===id)?.done})}
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
          hourRange={hourRange}
          onAddAt={(dymd,time,durationMin,extra)=>{
            if (extra?.quick && extra.projectId) {
              const dayCount = (calendarEvents.filter(e=>e.member===selMember && e.date===dymd)).length;
              onAddEvent({ id:mkId(), date:dymd, member:selMember, projectId:extra.projectId, task:extra.task||"", subtasks:[], startTime:time, durationMin, createdBy:currentUser, ts:nowTs(), order:dayCount, done:false });
            } else {
              setAddModal(dymd); setPrefillTime(time); setPrefillDuration(durationMin||60); setPrefillProjectId(extra?.projectId||""); setPrefillTask(extra?.task||""); setEventAnchorRect(extra?.anchorRect||null);
            }
          }}
          onEdit={(ev,rect)=>{ setEditingEvent(ev); setEventAnchorRect(rect||null); }}
          onToggleDone={(id)=>onUpdateEvent(id,{done: !calendarEvents.find(e=>e.id===id)?.done})}
          onMoveTask={(id,newDate,newTime)=>{
            const ev = calendarEvents.find(e=>e.id===id);
            if (!ev) return;
            if (ev.date === newDate) onUpdateEvent(id,{startTime:newTime});
            else if (newDate >= TODAY) { onMoveEvent(id,newDate); onUpdateEvent(id,{startTime:newTime}); }
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

          if (viewMode === "all") {
            const dayMap = allEventsByDay[dymd] || {};
            const membersWithEvents = TEAM.filter(m => (dayMap[m]||[]).length > 0);
            const totalCount = membersWithEvents.reduce((sum,m)=>sum+dayMap[m].length,0);
            return (
              <div key={dymd}
                onClick={()=>setDayModal(dymd)}
                style={{
                  minHeight:96, borderRadius:8, padding:"7px 8px", cursor:"pointer",
                  background: inMonth ? "#FFFFFF" : "#FAFBFC",
                  border:`1px solid ${TT.border}`,
                  opacity: inMonth ? 1 : 0.5,
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
              onClick={()=>setDayModal(dymd)}
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
                minHeight:92, borderRadius:8, padding:"7px 8px", cursor:"pointer",
                background: isDropTarget ? `${mc}14` : inMonth ? "#FFFFFF" : "#FAFBFC",
                border: isDropTarget ? `1.5px dashed ${mc}` : `1px solid ${TT.border}`,
                opacity: inMonth ? 1 : 0.5,
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
          onToggleDone={(id)=>onUpdateEvent(id,{done: !calendarEvents.find(e=>e.id===id)?.done})}
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
          minDate={addModalFromInbox ? TODAY : undefined}
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
                        onClick={()=>{if(a.type?.startsWith("image/"))setFbLightbox(a); else window.open(a.dataUrl);}}>
                        {a.type?.startsWith("image/")
                          ? <img src={a.dataUrl} alt={a.name} style={{width:72,height:72,objectFit:"cover",display:"block"}}/>
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
          <img src={fbLightbox.dataUrl} alt={fbLightbox.name} style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8,boxShadow:"0 0 40px #000"}}/>
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
                    ? <img src={a.dataUrl} alt={a.name} onClick={()=>setLightbox(a)} style={{width:80,height:80,objectFit:"cover",cursor:"pointer",display:"block"}}/>
                    : <div onClick={()=>window.open(a.dataUrl)} style={{width:80,height:80,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer",gap:4}}>
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
          <img src={lightbox.dataUrl} alt={lightbox.name} style={{maxWidth:"90vw",maxHeight:"90vh",borderRadius:8,boxShadow:"0 0 40px #000"}}/>
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
  const { teamNames, memberColor, isAdmin } = useTeam();
  const [text, setText] = useState("");
  const [tagged, setTagged] = useState([]);
  const [view, setView] = useState("active"); // "active" | "history"
  const [mention, setMention] = useState(null); // {start, query}
  const [popups, setPopups] = useState([]);
  const [tooltipInfo, setTooltipInfo] = useState(null); // { member, x, y }
  const [dndMenu, setDndMenu] = useState(null); // { member, x, y }
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
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
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
    onAdd(text.trim(), tagged);
    setText(""); setTagged([]); setMention(null);
  };

  const mentionMatches = mention ? teamNames.filter(n => n!==currentUser && n.toUpperCase().startsWith(mention.query.toUpperCase())) : [];
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
            const memberStatus = presence?.dnd?.[m]; // false | "dnd" | "leave" | "meeting" | true (legacy)
            const isDnd      = memberStatus === "dnd"     || memberStatus === true;
            const isLeave    = memberStatus === "leave";
            const inMtgManual = memberStatus === "meeting";
            const inMtg = inMtgAuto || inMtgManual;
            const isMe = m === currentUser;
            const color = memberColor[m] || "#64748B";
            // Priority: On Leave (black) > DND (red) > In Meeting (purple) > Online (green) > Offline (grey)
            const dotColor = isLeave ? "#0F172A" : isDnd ? "#EF4444" : inMtg ? "#7C3AED" : online ? "#22C55E" : "#475569";
            const dotGlow  = isLeave ? "0 0 5px #0F172A" : isDnd ? "0 0 5px #EF4444" : inMtg ? "0 0 5px #7C3AED" : online ? "0 0 4px #22C55E" : "none";
            return (
              <div key={m} style={{display:"flex",alignItems:"center"}}
                onMouseEnter={e => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTooltipInfo({ member: m, x: r.left + r.width / 2, y: r.top });
                }}
                onMouseLeave={() => setTooltipInfo(null)}
                onContextMenu={isMe ? e => {
                  e.preventDefault(); e.stopPropagation();
                  setTooltipInfo(null);
                  setDndMenu({ member: m, x: e.clientX, y: e.clientY });
                } : undefined}>
                <div style={{width:24,height:24,borderRadius:"50%",background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:900,color:"#fff",opacity:online||inMtg||isDnd||isLeave?1:0.4,border:isMe?"2px solid #F97316":"2px solid transparent",position:"relative",flexShrink:0,cursor:isMe?"context-menu":"default"}}>
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
            const inMtgManual = memberStatus === "meeting";
            const inMtg = inMtgAuto || inMtgManual;
            const isMe = m === currentUser;
            const systems = getActiveSystems(presence?.online?.[m]);
            const statusColor = isLeave ? "#94A3B8" : isDnd ? "#EF4444" : inMtg ? "#7C3AED" : online ? "#22C55E" : "#64748B";
            const statusLabel = isLeave ? "On Leave" : isDnd ? "Do Not Disturb" : inMtg ? "In a Meeting" : online ? "Online" : "Offline";
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
                const isMtgActive    = ms === "meeting";
                return [
                  { label:"Available",      icon:"🟢", color:"#22C55E", active: !ms,          onClick:()=>{ onToggleDnd?.(dndMenu.member, false);     setDndMenu(null); } },
                  { label:"In a Meeting",   icon:"🟣", color:"#7C3AED", active: isMtgActive,  onClick:()=>{ onToggleDnd?.(dndMenu.member, "meeting");  setDndMenu(null); } },
                  { label:"Do Not Disturb", icon:"🔴", color:"#EF4444", active: isDndActive,  onClick:()=>{ onToggleDnd?.(dndMenu.member, "dnd");      setDndMenu(null); } },
                  { label:"On Leave",       icon:"⚫", color:"#475569",  active: isLeaveActive, onClick:()=>{ onToggleDnd?.(dndMenu.member, "leave");  setDndMenu(null); } },
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
        </div>
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
          const canArchive = view==="active" && (n.author===currentUser || isAdmin(currentUser));
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
              <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:6}}>
                {canArchive && <button onClick={()=>onArchive(n.id)} title="Archive to history" style={{background:"none",border:"none",color:"var(--c-t4)",cursor:"pointer",fontSize:10,fontWeight:700}}>Archive →</button>}
                {view==="history" && isAdmin(currentUser) && <button onClick={()=>onUnarchive(n.id)} title="Push back to active" style={{background:"#3B82F620",border:"1px solid #3B82F644",color:"#3B82F6",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:10,fontWeight:700}}>← Push to Active</button>}
                {isAdmin(currentUser) && <button onClick={()=>onDeleteForever(n.id)} title="Delete permanently" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:11}}>🗑</button>}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{padding:"10px 14px",borderTop:"1px solid var(--c-border)",flexShrink:0}}>
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

function MyInbox({ projects, feedback, currentUser, calendarEvents, onToggleCalendarTask, onOpenProject, onGoToChecklist, onGoToFeedback, onMarkRead, onDragStart, onDragEnd }) {
  const [filter, setFilter] = useState("unread");

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

  const items = useMemo(() => {
    const arr = [];
    projects.forEach(p => {
      noteList(p.notes || []).forEach(n => {
        if (!(n.tagged||[]).includes(currentUser)) return;
        // done note = actioned = treat as read automatically
        arr.push({ id: n.id, type: "note", project: p, author: n.author, text: n.text, ts: n.ts, unread: !(n.readBy||[]).includes(currentUser) && !n.done });
      });
      (p.checklistNotes || []).forEach(n => {
        if (!(n.tagged||[]).includes(currentUser)) return;
        arr.push({ id: n.id, type: "checklist", project: p, author: n.author, text: n.text, ts: n.ts, unread: !(n.readBy||[]).includes(currentUser) && !n.done });
      });
    });
    (feedback || []).forEach(f => {
      if (!(f.tagged||[]).includes(currentUser)) return;
      arr.push({ id: f.id, type: "feedback", project: projects.find(p => p.id === f.projectId), author: f.createdBy, text: f.text, ts: f.ts, unread: !(f.readBy||[]).includes(currentUser) });
    });
    return arr.sort((a, b) => (b.ts||"").localeCompare(a.ts||""));
  }, [projects, feedback, currentUser]);

  const unreadCount = useMemo(() => items.filter(i => i.unread).length, [items]);
  const visible = filter === "unread" ? items.filter(i => i.unread) : items;

  const TYPE_META = {
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
      border: `1px solid ${unreadCount > 0 ? "#3B82F6" : "#334155"}`,
      boxShadow: unreadCount > 0 ? "0 0 0 3px #3B82F633" : "none",
      borderRadius: 10, height: "calc(100vh - 80px)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{padding:"10px 12px 0",borderBottom:"1px solid var(--c-border)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <span style={{fontSize:11,fontWeight:800,color:"var(--c-t2)",textTransform:"uppercase",letterSpacing:"0.06em"}}>
            📬 My Inbox
          </span>
          {unreadCount > 0 && (
            <span style={{background:"#3B82F6",color:"#fff",fontSize:9,fontWeight:800,borderRadius:8,padding:"1px 6px",minWidth:16,textAlign:"center"}}>
              {unreadCount}
            </span>
          )}
        </div>
        <div style={{display:"flex",gap:2,marginBottom:0}}>
          {[["unread", `Unread${unreadCount > 0 ? ` (${unreadCount})` : ""}`], ["all", "All"]].map(([v, label]) => (
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
            <div style={{fontSize:22,marginBottom:6}}>{filter==="unread"?"✓":"📭"}</div>
            <div style={{fontSize:11,color:"var(--c-t5)"}}>{filter==="unread"?"All caught up!":"No tags yet"}</div>
          </div>
        ) : visible.map(item => {
          const { label, icon, color } = TYPE_META[item.type] || TYPE_META.note;
          const proj = item.project;
          const linkedEvent = (calendarEvents||[]).find(e =>
            e.member === currentUser && e.inboxItemType &&
            (e.noteId === item.id || e.fbId === item.id)
          );
          return (
            <div key={`${item.type}-${item.id}`}
              draggable
              onDragStart={e => { e.dataTransfer.effectAllowed="move"; onDragStart?.(item); }}
              onDragEnd={() => onDragEnd?.()}
              onClick={() => handleClick(item)}
              style={{
                position:"relative",
                padding:"8px 10px 8px 12px",
                borderBottom:"1px solid var(--c-border2)",
                borderLeft: item.unread ? `3px solid ${color}` : "3px solid transparent",
                cursor:"grab",
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
                  <span style={{fontSize:9,color:"var(--c-t5)",opacity:0.5}} title="Drag to calendar">⠿</span>
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
                {item.author} tagged you
              </div>
              {/* Text excerpt */}
              <div style={{fontSize:11,color:"var(--c-t2)",lineHeight:1.35,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>
                {item.text}
              </div>
              {/* Calendar task checkbox — shown when scheduled */}
              {linkedEvent && (
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
              {/* Mark as read */}
              {item.unread && onMarkRead && (
                <button
                  onClick={e => { e.stopPropagation(); onMarkRead(item); }}
                  style={{marginTop:5,background:"none",border:"none",color:"#64748B",cursor:"pointer",fontSize:9,fontWeight:700,padding:0,textDecoration:"underline",textDecorationColor:"#334155",textUnderlineOffset:2,animation:"asd-tag-pulse 1.6s ease-in-out infinite"}}
                >
                  ✓ mark as read
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stats({ projects }) {
  return (
    <div style={{display:"grid",gridTemplateColumns:`repeat(${SELECTABLE_PROJECT_STATUS.length},1fr)`,gap:8,marginBottom:14}}>
      {SELECTABLE_PROJECT_STATUS.map(status => {
        const count = projects.filter(p=>p.status===status).length;
        const color = PROJECT_STATUS[status].color;
        return (
          <div key={status} style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:8,padding:"10px 14px"}}>
            <div style={{fontSize:22,fontWeight:900,color,fontFamily:"monospace",lineHeight:1}}>{count}</div>
            <div style={{color:"var(--c-t4)",fontSize:10,fontWeight:700,marginTop:3,textTransform:"uppercase"}}>{status}</div>
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
// PERSISTENCE — localStorage always; Firestore real-time sync layered on top
// once a project is configured (see .env.example). With no Firebase config,
// this behaves exactly like the original browser-local-only persistence.
// One Firestore doc per collection holds its whole array as a single field —
// simple and matches the localStorage model, but means every edit rewrites the
// full array, and any single project/event with large inline attachments could
// approach Firestore's 1MB-per-document cap (attachments aren't migrated to
// Firebase Storage yet — flagged as a known follow-up, not handled here).
// ═════════════════════════════════════════════════
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
  // whatever Firestore sends.
  const lastFsValue = useRef(state);
  // true while the local state has diverged from Firestore and a write hasn't landed yet.
  // Blocks incoming Firestore snapshots from overwriting in-flight local changes.
  const localDirty = useRef(false);
  const [fsReady, setFsReady] = useState(!firebaseConfigured);

  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (err) {
      console.warn(`ASD Hub: couldn't save "${key}" — storage may be full`, err);
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
        if (snap.exists()) {
          const val = snap.data().value;
          lastFsValue.current = val;
          // Only adopt Firestore's value if there is no pending local write.
          // If localDirty, we keep local state intact and let the write effect push it
          // to Firestore shortly — the subsequent echo will re-enter here with !localDirty.
          if (!localDirty.current) {
            setState(val);
          }
        } else {
          setDoc(ref, { value: stateRef.current })
            .catch(err => console.error(`Firestore seed failed for "${key}":`, err));
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

  // Debounced write — ~200ms so rapid edits don't spam Firestore on every keystroke.
  useEffect(() => {
    if (!firebaseConfigured) return;
    if (!fsReady) {
      // While Firestore isn't connected yet, track whether local state has diverged
      // from the last known Firestore value (or the initial local state on first load).
      // This ensures the first incoming snapshot doesn't overwrite offline edits.
      if (state !== lastFsValue.current) localDirty.current = true;
      return;
    }
    if (state === lastFsValue.current) { localDirty.current = false; return; }
    localDirty.current = true;
    const t = setTimeout(() => {
      localDirty.current = false;
      setDoc(doc(db, "appState", key), { value: stateRef.current })
        .catch(err => console.error(`Firestore write failed for "${key}":`, err));
    }, 200);
    return () => clearTimeout(t);
  }, [key, state, fsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  return [state, setState, fsReady];
}

function MainApp({ currentUser, onLogout, presence, onToggleDnd }) {
  const { teamNames: TEAM, memberColor: MEMBER_COLOR, memberRole, isAdmin, clients } = useTeam();
  const vw = useWindowWidth();
  const isMobile = vw < 768;
  const isTablet = vw < 1024;
  const [projects, setProjects] = usePersistentState("asd_projects", SEED_PROJECTS);
  const [tasks, setTasks] = usePersistentState("asd_tasks", SEED_TASKS);
  const [calendarEvents, setCalendarEvents] = usePersistentState("asd_calendar_events", SEED_CALENDAR);
  const [feedback, setFeedback] = usePersistentState("asd_feedback", []);
  const [notices, setNotices] = usePersistentState("asd_notices", []);
  const [draggingNoticeItem, setDraggingNoticeItem] = useState(null); // { id, text, author }
  const [draggingMyInboxItem, setDraggingMyInboxItem] = useState(null); // inbox item being dragged to calendar
  const [tab, setTab] = useState("projects");
  const [tabHistory, setTabHistory] = useState([]);
  const goToTab = (next) => { setTabHistory(h => [...h, tab]); setTab(next); };
  const goBack = () => { if (!tabHistory.length) return; setTab(tabHistory[tabHistory.length-1]); setTabHistory(h => h.slice(0,-1)); };
  const [checklistJumpId, setChecklistJumpId] = useState(null);
  const [modal, setModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailTab, setDetailTab] = useState("details"); // "details" | "notes" | "checklist"
  const [confirmState, setConfirmState] = useState(null);
  const [showTeamModal, setShowTeamModal] = useState(false);
  const [showClientsModal, setShowClientsModal] = useState(false);
  const [masterTemplate, setMasterTemplate] = usePersistentState("asd_master_template", MASTER_DEFAULT);
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
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterMember, setFilterMember] = useState("All");
  const [filterClient, setFilterClient] = useState("All");
  const [sortBy, setSortBy] = useState("jobCode"); // "jobCode" | "priority"
  const [search, setSearch] = useState("");
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [projectView, setProjectView] = useState(() => localStorage.getItem(`asd_view_pref_${currentUser}`) || "list");
  const [listPicker, setListPicker] = useState(null); // {id, field} — which list-row cell has its dropdown open
  const [listInlineEdit, setListInlineEdit] = useState(null); // {id, field, value} — inline text edit
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
      setProjects(ps=>[...ps,{...proj,id:mkId(),assignedBy:currentUser}]);
      addNotice(`📋 New project added — ${proj.jobCode||"?"}: ${proj.name}`, TEAM);
    }
    setModal(null); setEditing(null);
  };
  const delProject = id => {
    const proj = projects.find(p => p.id === id);
    if (proj) setDeletedProjects(d => [...d, { ...proj, _deletedAt: nowTs() }]);
    setProjects(ps=>ps.filter(p=>p.id!==id));
    setTasks(ts=>ts.filter(t=>t.projectId!==id));
    setCalendarEvents(es=>es.filter(e=>e.projectId!==id));
    setFeedback(fb=>fb.filter(f=>f.projectId!==id));
    setDetail(null); setEditing(null); setModal(null);
  };
  const restoreProject = id => {
    const proj = deletedProjects.find(p => p.id === id);
    if (!proj) return;
    const { _deletedAt, ...restored } = proj;
    setProjects(ps => [restored, ...ps]);
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
    const ref = doc(db, "appState", "asd_projects");
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const updated = (snap.data().value || []).map(p =>
        p.id === projectId ? applyFn(p) : p
      );
      tx.set(ref, { value: updated });
    }).catch(err => console.error("Note transaction failed:", err));
  };
  const _feedbackTx = async (feedbackId, applyFn) => {
    if (!firebaseConfigured) return;
    const ref = doc(db, "appState", "asd_feedback");
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const updated = (snap.data().value || []).map(f => f.id === feedbackId ? applyFn(f) : f);
      tx.set(ref, { value: updated });
    }).catch(err => console.error("Feedback transaction failed:", err));
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
  const markFeedbackRead = (feedbackId, member) => {
    setFeedback(fb => fb.map(f => f.id !== feedbackId ? f :
      { ...f, readBy: [...new Set([...(f.readBy||[]), member])] }
    ));
    _feedbackTx(feedbackId, f => ({ ...f, readBy: [...new Set([...(f.readBy||[]), member])] }));
  };
  const toggleNoteDone = (projectId, noteId, source) => {
    if (source === "Tracker") {
      setProjects(ps => ps.map(p => p.id !== projectId ? p : {
        ...p, checklistNotes: (p.checklistNotes||[]).map(n => n.id===noteId ? {...n, done:!n.done} : n),
      }));
    } else {
      setProjects(ps => ps.map(p => p.id !== projectId ? p : {
        ...p, notes: noteList(p.notes).map(n => n.id===noteId ? {...n, done:!n.done} : n),
      }));
    }
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
          history: [...(c.history||[]), { ts: nowTs(), member: currentUser, action: "synced from master" }]
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
  const updateCalendarEvent = (id, patch) => setCalendarEvents(es => es.map(e => e.id === id ? { ...e, ...patch } : e));
  const copyCalendarEvent = (id, overrides) => {
    const ev = calendarEvents.find(e => e.id === id);
    if (!ev) return;
    addCalendarEvent({ ...ev, ...overrides, id: mkId(), ts: nowTs(), done: false, createdBy: currentUser });
  };
  const toggleSubtaskInEvent = (eventId, subtaskId) => setCalendarEvents(es => es.map(e =>
    e.id === eventId ? { ...e, subtasks: (e.subtasks||[]).map(st => st.id===subtaskId ? {...st, done:!st.done} : st) } : e
  ));
  const moveCalendarEvent = (id, newDate) => setCalendarEvents(es => {
    if (newDate < TODAY) return es;
    const moving = es.find(e => e.id === id);
    if (!moving || moving.date === newDate) return es;
    const destCount = es.filter(e => e.date === newDate && e.member === moving.member).length;
    return es.map(e => e.id === id ? { ...e, date: newDate, order: destCount } : e);
  });
  const reorderCalendarDay = (date, member, orderedIds) => setCalendarEvents(es => {
    const orderMap = new Map(orderedIds.map((id,idx) => [id, idx]));
    return es.map(e => (e.date === date && e.member === member && orderMap.has(e.id)) ? { ...e, order: orderMap.get(e.id) } : e);
  });

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
  // A tagged notice auto-archives (moves to history) once every tagged member has ticked it read.
  const markNoticeRead = (id, member) => setNotices(n => n.map(x => {
    if (x.id !== id || x.readBy.includes(member)) return x;
    const readBy = [...x.readBy, member];
    const allRead = x.tagged.length>0 && x.tagged.every(t=>readBy.includes(t));
    return { ...x, readBy, archivedAt: allRead ? nowTs() : x.archivedAt };
  }));
  const archiveNotice = id => setNotices(n => n.map(x => x.id===id ? { ...x, archivedAt: nowTs() } : x));
  const unarchiveNotice = id => setNotices(n => n.map(x => x.id===id ? { ...x, archivedAt: null } : x));
  const deleteNoticeForever = id => setNotices(n => n.filter(x => x.id !== id));

  // Merge curated clients list with any client codes already on projects so newly added
  // fabricators appear in the filter immediately, even before they're assigned to a project.
  const fabricators = [...new Set([...clients, ...projects.map(p => p.client).filter(Boolean)])].sort();

  const filteredProjects = useMemo(() => projects.filter(p => {
    if (p.status === "Completed") return false;
    if (filterStatus !== "All" && p.status !== filterStatus) return false;
    if (filterMember !== "All" && !p.assigned.includes(filterMember)) return false;
    if (filterClient !== "All" && p.client !== filterClient) return false;
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
    return (a.jobCode||"").localeCompare(b.jobCode||"", undefined, { numeric:true, sensitivity:"base" });
  }), [projects, filterStatus, filterMember, filterClient, search, sortBy]);

  const filteredCompleted = useMemo(() => projects.filter(p => {
    if (p.status !== "Completed") return false;
    if (filterMember !== "All" && !p.assigned.includes(filterMember)) return false;
    if (filterClient !== "All" && p.client !== filterClient) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !p.client.toLowerCase().includes(q) && !(p.jobCode||"").toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (a.jobCode||"").localeCompare(b.jobCode||"", undefined, { numeric:true, sensitivity:"base" })),
  [projects, filterMember, filterClient, search]);

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
    ];
  }, [projects, feedback, CAN_MANAGE_WEBSITE, currentUser]);

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
            </>
          )}
          {isAdmin(currentUser) && isMobile && (
            <button onClick={()=>setShowTeamModal(true)} style={{background:"none",border:"none",color:"var(--c-t3)",cursor:"pointer",fontSize:18,padding:"4px"}}>👥</button>
          )}
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

      {/* Mobile bottom tab bar */}
      {isMobile && (
        <div style={{position:"fixed",bottom:0,left:0,right:0,zIndex:300,background:"var(--c-panel)",borderTop:"1px solid var(--c-border)",display:"flex",height:60,paddingBottom:"env(safe-area-inset-bottom)"}}>
          {TAB_LABELS.map(({key,label,icon,count,tagCount})=>(
            <button key={key} onClick={()=>goToTab(key)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,background:"none",border:"none",color:tab===key?"#F97316":"var(--c-t4)",cursor:"pointer",fontSize:10,fontWeight:tab===key?800:500,padding:"4px 0",position:"relative"}}>
              <span style={{fontSize:20,lineHeight:1.2}}>{icon}</span>
              <span>{label}</span>
              {(count>0||tagCount>0)&&<span style={{position:"absolute",top:4,left:"calc(50% - 30px)",background:tagCount>0?"#EF4444":"#F97316",color:"#fff",fontSize:9,fontWeight:800,borderRadius:8,padding:"1px 4px",minWidth:14,textAlign:"center"}}>{tagCount>0?tagCount:count}</span>}
            </button>
          ))}
        </div>
      )}

      <ProjectNoteAlerts projects={projects} currentUser={currentUser} onOpenProject={p=>openDetail(p,"notes")}/>
      <div style={{padding:isMobile?"8px 8px":"14px 16px",display:"flex",gap:16,alignItems:"flex-start",paddingBottom:isMobile?"76px":undefined}}>
        {!isTablet && <NoticeBoard notices={notices} currentUser={currentUser} presence={presence} onAdd={addNotice} onMarkRead={markNoticeRead} onArchive={archiveNotice} onUnarchive={unarchiveNotice} onDeleteForever={deleteNoticeForever} onNoticeDragStart={setDraggingNoticeItem} onNoticeDragEnd={()=>setDraggingNoticeItem(null)} onToggleDnd={onToggleDnd}/>}
        <div style={{flex:1,minWidth:0}}>
        {tab!=="checklist"&&tab!=="calendar"&&tab!=="feedback"&&<Stats projects={projects}/>}

        {tab!=="checklist"&&tab!=="calendar"&&tab!=="feedback"&&(
          <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…" style={{...IS,width:isMobile?undefined:240,flex:isMobile?"1":"0 0 auto"}}/>
            {isMobile && <button onClick={()=>setShowMobileFilters(f=>!f)} style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:6,color:"var(--c-t3)",cursor:"pointer",fontSize:12,fontWeight:700,padding:"6px 12px",whiteSpace:"nowrap"}}>{showMobileFilters?"▲ Hide":"▼ Filter"}</button>}
            {(!isMobile||showMobileFilters)&&<><select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={{...IS,width:isMobile?"100%":145}}><option value="All">All statuses</option>{SELECTABLE_PROJECT_STATUS.map(s=><option key={s}>{s}</option>)}</select>
            <select value={filterClient} onChange={e=>setFilterClient(e.target.value)} style={{...IS,width:isMobile?"100%":150}}><option value="All">All fabricators</option>{fabricators.map(c=><option key={c}>{c}</option>)}</select>
            <select value={filterMember} onChange={e=>setFilterMember(e.target.value)} style={{...IS,width:isMobile?"100%":130}}><option value="All">All members</option>{TEAM.map(m=><option key={m}>{m}</option>)}</select>
            <div style={{display:"flex",alignItems:"center",gap:4,background:"var(--c-page)",border:"1px solid var(--c-border)",borderRadius:6,padding:2}}>
              <button onClick={()=>setSortBy("jobCode")} style={{padding:"5px 10px",borderRadius:4,border:"none",background:sortBy==="jobCode"?"var(--c-panel)":"transparent",color:sortBy==="jobCode"?"var(--c-t1)":"var(--c-t4)",fontWeight:sortBy==="jobCode"?700:400,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>↕ Job Code</button>
              <button onClick={()=>setSortBy("priority")} style={{padding:"5px 10px",borderRadius:4,border:"none",background:sortBy==="priority"?"#7C3AED":"transparent",color:sortBy==="priority"?"#fff":"var(--c-t4)",fontWeight:sortBy==="priority"?700:400,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>▲ Priority</button>
            </div></>}
            <div style={{flex:1}}/>
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

        {tab==="projects"&&(
          filteredProjects.length===0
            ?<div style={{textAlign:"center",color:"#334155",padding:"60px 0"}}>No projects.</div>
            :(projectView==="card"||isMobile)
            ?<div style={{display:"grid",gridTemplateColumns:`repeat(auto-fill,minmax(${isMobile?160:270}px,1fr))`,gap:isMobile?8:10}}>
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
                    onDelete={()=>askConfirm("Delete Project?",`Permanently delete "${p.jobCode||p.name}"?`,()=>delProject(p.id))}
                    onComplete={()=>askConfirm("Mark Completed?",`Move "${p.jobCode||p.name}" to completed?`,()=>completeProject(p.id))}
                    onChecklist={()=>{setDetail(null);goToChecklist(p.id);}}
                    onStatusChange={updateProjectStatus}
                    onFieldChange={updateFieldChange}
                    onAddNote={addProjectNote}
                    onRemoveNote={removeProjectNote}
                    onMarkNoteRead={markProjectNoteRead}
                    onEditNote={editProjectNote}/>
                );
                return _cr;
              })}
            </div>
            :<div style={{background:"var(--c-panel)",border:"1px solid var(--c-border)",borderRadius:10,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"80px 1fr 110px 130px 80px 92px 100px 60px",gap:8,padding:"10px 16px",borderBottom:"1px solid var(--c-border)"}}>
                {["Job Code","Project","Client","Status","Priority","Due","Team",""].map(h=>{
                  const sortable = h==="Priority"||h==="Job Code";
                  const isActive = (h==="Priority"&&sortBy==="priority")||(h==="Job Code"&&sortBy==="jobCode");
                  return <div key={h} onClick={sortable?(()=>setSortBy(h==="Priority"?"priority":"jobCode")):undefined}
                    style={{color:isActive?"#7C3AED":"var(--c-t5)",fontSize:11,fontWeight:700,textTransform:"uppercase",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:sortable?"pointer":"default",userSelect:"none"}}>
                    {h}{isActive?" ▲":sortable?" ↕":""}
                  </div>;
                })}
              </div>
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
                    <div style={{display:"grid",gridTemplateColumns:"80px 1fr 110px 130px 80px 92px 100px 60px",gap:8,alignItems:"center"}}>
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
                          {p.siteMeasureRequired==="Yes" && <span title="Site measure required" style={{fontSize:9,flexShrink:0}}>📐</span>}
                          {p.siteMeasureRequired==="TBC" && <span title="Site measure — TBC" style={{fontSize:9,flexShrink:0,color:"var(--c-t3)"}}>📐?</span>}
                        </div>
                        <div style={{fontSize:10,color:"var(--c-t5)"}}>{p.type}</div>
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
                        <span onClick={()=>setListPicker(lp=>lp?.id===p.id&&lp?.field==="status"?null:{id:p.id,field:"status"})} style={{fontSize:10,fontWeight:700,color:cfg.color,background:`${cfg.color}1A`,border:`1px solid ${cfg.color}44`,borderRadius:4,padding:"2px 7px",whiteSpace:"nowrap",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:3,maxWidth:"100%"}}>{p.status}<span style={{fontSize:7,opacity:0.6,flexShrink:0}}>{listPicker?.id===p.id&&listPicker?.field==="status"?"▲":"▼"}</span></span>
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
                        <button onClick={()=>askConfirm("Delete Project?",`Permanently delete "${p.jobCode||p.name}"?`,()=>delProject(p.id))} title="Delete" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13,padding:2}}>🗑</button>
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
                          onEdit={(id,text)=>editProjectNote(p.id,id,text)}/>
                      </div>
                    </div>
                  </div>
                ); // end _rows.push
                return _rows;
              })}
            </div>
        )}

        {tab==="projects"&&(search||filterClient!=="All"||filterMember!=="All")&&filteredCompleted.length>0&&(
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
          <div>
            <div style={{display:"grid",gridTemplateColumns:"90px 1fr 80px 90px 90px 110px 100px",gap:10,padding:"10px 16px",borderBottom:"1px solid var(--c-border)"}}>
              {["Job Code","Address","Client","Due","Completed","Checklist",""].map(h=><div key={h} style={{color:"var(--c-t5)",fontSize:11,fontWeight:700,textTransform:"uppercase"}}>{h}</div>)}
            </div>
            {projects.filter(p => {
              if (p.status !== "Completed") return false;
              if (filterMember !== "All" && !p.assigned.includes(filterMember)) return false;
              if (filterClient !== "All" && p.client !== filterClient) return false;
              if (search) {
                const q = search.toLowerCase();
                if (!p.name.toLowerCase().includes(q) && !p.client.toLowerCase().includes(q) && !(p.jobCode||"").toLowerCase().includes(q)) return false;
              }
              return true;
            }).map(p=>{
              const cl = p.checklist||[];
              const clDone = cl.filter(c=>c.done).length;
              const clPctVal = cl.length===0 ? 0 : Math.round((clDone/cl.length)*100);
              const clColor = clPctVal===100?"#10B981":clPctVal>=60?"#3B82F6":"#F59E0B";
              const onTime = p.completedDate && p.due && p.completedDate <= p.due;
              return (
                <div key={p.id} style={{display:"grid",gridTemplateColumns:"90px 1fr 80px 90px 90px 110px 100px",gap:10,alignItems:"center",padding:"10px 16px",borderBottom:"1px solid var(--c-border2)"}}>
                  <span style={{fontSize:11,fontFamily:"monospace",fontWeight:900,color:"#F97316",background:"#F9731620",border:"1px solid #F9731644",borderRadius:4,padding:"2px 6px",textAlign:"center"}}>{p.jobCode||"—"}</span>
                  <div onClick={()=>openDetail(p)} style={{fontSize:12,color:"var(--c-t1)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:"pointer",textDecoration:"underline",textDecorationColor:"#334155",textUnderlineOffset:2}}>{p.name}</div>
                  <div style={{fontSize:11,color:"var(--c-t4)"}}>{p.client}</div>
                  <div style={{fontSize:11,color:"var(--c-t4)"}}>{fmtDate(p.due)}</div>
                  <div style={{fontSize:11,color:onTime?"#10B981":"#EF4444",fontWeight:600}}>{fmtDate(p.completedDate)}</div>
                  <button onClick={e=>{e.stopPropagation();goToChecklist(p.id);}} style={{background:`${clColor}15`,border:`1px solid ${clColor}44`,borderRadius:5,padding:"4px 8px",cursor:"pointer"}}>
                    <span style={{fontSize:10,fontWeight:800,color:clColor}}>{clPctVal}%</span>
                  </button>
                  <div style={{display:"flex",gap:3,justifyContent:"flex-end"}}>
                    <button onClick={e=>{e.stopPropagation();askConfirm("Reopen?",`Reopen "${p.jobCode||p.name}"?`,()=>reopenProject(p.id));}} title="Reopen" style={{background:"#3B82F620",border:"1px solid #3B82F644",color:"#3B82F6",borderRadius:4,padding:"3px 7px",cursor:"pointer",fontSize:11,fontWeight:700}}>↺</button>
                    <button onClick={e=>{e.stopPropagation();setEditing(p);setModal("editProject");}} title="Edit" style={{background:"#F9731620",border:"1px solid #F9731644",color:"#F97316",borderRadius:4,padding:"3px 7px",cursor:"pointer",fontSize:11,fontWeight:700}}>✎</button>
                    <button onClick={e=>{e.stopPropagation();askConfirm("Remove?",`Remove "${p.jobCode||p.name}"?`,()=>delProject(p.id));}} title="Delete" style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13}}>🗑</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
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

        {tab==="checklist"&&<ChecklistTab key={checklistJumpId||"cl"} projects={projects} currentUser={currentUser} onUpdateChecklist={updateChecklist} onFieldChange={updateFieldChange} initialId={checklistJumpId} masterTemplate={masterTemplate} setMasterTemplate={setMasterTemplate} onSyncProject={syncProjectWithMaster} onReorderMaster={autoReorderProjects} projectsWithUpdates={projectsWithUpdates} deletedMasterItems={deletedMasterItems} setDeletedMasterItems={setDeletedMasterItems} onToggleNoteDone={toggleNoteDone}/>}

        {tab==="calendar"&&<CalendarTab projects={projects} tasks={tasks} feedback={feedback} calendarEvents={calendarEvents} currentUser={currentUser} onAddEvent={addCalendarEvent} onRemoveEvent={removeCalendarEvent} onUpdateEvent={updateCalendarEvent} onMoveEvent={moveCalendarEvent} onReorderDay={reorderCalendarDay} onToggleSubtask={toggleSubtaskInEvent} onCompleteProject={completeProject} onCompleteTask={completeTask} onToggleNoteDone={toggleNoteDone} draggingNoticeItem={draggingNoticeItem} onCopyEvent={copyCalendarEvent} draggingMyInboxItem={draggingMyInboxItem} onMarkMyInboxItemRead={(type,id,projectId)=>{ if(type==="note") markProjectNoteRead(projectId,id,currentUser); else if(type==="checklist") markChecklistNoteRead(projectId,id,currentUser); else if(type==="feedback") markFeedbackRead(id,currentUser); }}/>}

        {tab==="feedback"&&<FeedbackTab projects={projects} feedback={feedback} currentUser={currentUser} onAdd={addFeedback} onUpdate={updateFeedback} onRemove={removeFeedback} onToggleStatus={toggleFeedbackStatus}/>}
        {tab==="portfolio"&&CAN_MANAGE_WEBSITE&&<PortfolioTab portfolio={portfolio} setPortfolio={setPortfolio} services={siteServices} setServices={setSiteServices} stats={siteStats} setStats={setSiteStats} testimonials={siteTestimonials} setTestimonials={setSiteTestimonials} currentUser={currentUser}/>}
        </div>
        {!isTablet && <MyInbox projects={projects} feedback={feedback} currentUser={currentUser}
          calendarEvents={calendarEvents}
          onToggleCalendarTask={id => updateCalendarEvent(id, {done: !calendarEvents.find(e=>e.id===id)?.done})}
          onOpenProject={(proj,t)=>openDetail(proj,t)}
          onGoToChecklist={goToChecklist}
          onGoToFeedback={()=>goToTab("feedback")}
          onMarkRead={item => {
            if (item.type==="note")      markProjectNoteRead(item.project.id, item.id, currentUser);
            else if (item.type==="checklist") markChecklistNoteRead(item.project.id, item.id, currentUser);
            else if (item.type==="feedback")  markFeedbackRead(item.id, currentUser);
          }}
          onDragStart={item => setDraggingMyInboxItem(item)}
          onDragEnd={() => setDraggingMyInboxItem(null)}
        />}
      </div>

      {(modal==="addProject"||modal==="editProject")&&<Modal title={modal==="editProject"?(editing?.jobCode?`Edit ${editing.jobCode}`:"Edit Project"):"New Project"} onClose={()=>{setModal(null);setEditing(null);}}><ProjectForm initial={editing} currentUser={currentUser} onSave={saveProject} onClose={()=>{setModal(null);setEditing(null);}} masterTemplate={masterTemplate}/></Modal>}
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
              onEdit={(id,text)=>editProjectNote(liveDetail.id,id,text)}/>
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
            <button onClick={()=>askConfirm("Delete?",`Permanently delete "${liveDetail.jobCode||liveDetail.name}"?`,()=>delProject(liveDetail.id))} style={{flex:1,background:"#EF444420",border:"1px solid #EF4444",color:"#EF4444",borderRadius:6,padding:"9px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>🗑 Delete</button>
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
  resetData = () => {
    Object.keys(localStorage).filter(k => k.startsWith("asd_")).forEach(k => localStorage.removeItem(k));
    window.location.reload();
  };
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{minHeight:"100vh",background:"var(--c-page)",color:"var(--c-t1)",display:"flex",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"monospace"}}>
        <div style={{maxWidth:640,background:"var(--c-panel)",border:"1px solid #EF4444",borderRadius:10,padding:24}}>
          <div style={{fontSize:16,fontWeight:800,color:"#EF4444",marginBottom:10}}>⚠ ASD Hub hit an error</div>
          <div style={{fontSize:13,color:"var(--c-t2)",marginBottom:14,whiteSpace:"pre-wrap"}}>{String(this.state.error?.message || this.state.error)}</div>
          <div style={{fontSize:11,color:"var(--c-t4)",marginBottom:18,whiteSpace:"pre-wrap",maxHeight:200,overflowY:"auto"}}>{this.state.error?.stack}</div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={()=>window.location.reload()} style={{flex:1,background:"#334155",border:"none",color:"var(--c-t1)",borderRadius:6,padding:"10px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>Reload</button>
            <button onClick={this.resetData} style={{flex:1,background:"#EF4444",border:"none",color:"#fff",borderRadius:6,padding:"10px 0",cursor:"pointer",fontWeight:700,fontSize:13}}>Clear local data &amp; reload</button>
          </div>
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

  // Stale-tab guard: reload this tab if a newer build has been deployed, and
  // raise the version marker in Firestore if this build is the newest.
  useEffect(() => {
    if (!firebaseConfigured) return;
    const ref = doc(db, "appState", "asd_app_version");
    const unsub = onSnapshot(ref, snap => {
      const v = snap.exists() ? Number(snap.data().value) || 0 : 0;
      if (v > APP_VERSION) window.location.reload();
      else if (v < APP_VERSION) setDoc(ref, { value: APP_VERSION }).catch(() => {});
    }, () => {});
    return () => unsub();
  }, []);

  // Always show login screen in light mode
  useEffect(() => {
    if (!currentUser) document.documentElement.dataset.theme = "light";
  }, [currentUser]);

  const [_team, setTeam] = usePersistentState("asd_team_members", DEFAULT_TEAM);
  // If Firestore or localStorage delivers hashed PINs from an old device, replace them
  // with the known plain-text values from DEFAULT_TEAM so login always works.
  const team = Array.isArray(_team) ? _team.map(m => {
    if (!isHashed(m.pin)) return m;
    const def = DEFAULT_TEAM.find(d => d.name === m.name);
    return def ? { ...m, pin: def.pin } : m;
  }) : DEFAULT_TEAM;
  const teamReady = true;
  const [clients, setClients] = usePersistentState("asd_clients", DEFAULT_CLIENTS);
  const [presence, setPresence] = usePersistentState("asd_presence", { sessions: [], online: {} });
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

  useEffect(() => {
    if (!firebaseConfigured) return;
    const ref = doc(db, "appState", "asd_online");
    const unsub = onSnapshot(ref, snap => {
      if (snap.exists()) {
        const val = snap.data().value || {};
        setOnlineStatus(val);
        localStorage.setItem("asd_online", JSON.stringify(val));
      }
    }, err => console.error("asd_online sync error:", err));
    return () => unsub();
  }, []);

  // Write online status immediately — no debounce, small document.
  // Uses updateDoc with dot-notation paths so concurrent writes from different users
  // update only their own field and don't overwrite each other's sessions.
  const pushOnlineStatus = updates => {
    const next = { ...onlineStatusRef.current, ...updates };
    onlineStatusRef.current = next;
    setOnlineStatus(next);
    localStorage.setItem("asd_online", JSON.stringify(next));
    if (firebaseConfigured) {
      const ref = doc(db, "appState", "asd_online");
      // Build field-level update paths so each user only touches their own key
      const fieldUpdates = Object.fromEntries(
        Object.entries(updates).map(([k, v]) => [`value.${k}`, v])
      );
      updateDoc(ref, fieldUpdates).catch(() =>
        // updateDoc fails if doc doesn't exist yet — fall back to setDoc
        setDoc(ref, { value: next }).catch(console.error)
      );
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

  const verifyPin = (name, enteredPin) => {
    const member = team.find(m => m.name === name);
    if (!member) return false;
    return member.pin === String(enteredPin);
  };

  const addMember = (name, pin) => {
    const usedColors = new Set(team.map(m => m.color));
    const color = TEAM_COLOR_PALETTE.find(c => !usedColors.has(c)) || "#6B7280";
    // pinChangedAt set at creation so the login token comparison always has a concrete value
    setTeam(t => [...t, { name, pin: String(pin), color, role:"member", pinChangedAt: Date.now() }]);
  };
  const removeMember = name => setTeam(t => t.filter(m => m.name !== name));
  const updateMemberPin = (name, pin) => {
    setTeam(t => t.map(m => m.name===name ? { ...m, pin: String(pin), pinChangedAt: Date.now() } : m));
  };

  const addClient = code => setClients(c => [...c, code]);
  const removeClient = code => setClients(c => c.filter(x => x !== code));

  const teamCtx = { team, teamNames, memberColor, memberRole, isAdmin, verifyPin, addMember, removeMember, updateMemberPin, clients, addClient, removeClient, teamReady };

  // Force-logout if the current user's PIN was changed (on any device) or if they were removed
  useEffect(() => {
    if (!currentUser) return;
    const member = team.find(m => m.name === currentUser);
    if (!member) { setCurrentUser(null); setLoginPinToken(null); return; }
    // Normalize both sides: Firestore round-trips drop undefined fields, so a missing
    // pinChangedAt must compare equal whether it arrives as undefined or null.
    if ((member.pinChangedAt ?? null) !== (loginPinToken ?? null)) { setCurrentUser(null); setLoginPinToken(null); }
  }, [team, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = name => {
    const member = team.find(m => m.name === name);
    setLoginPinToken(member?.pinChangedAt);
    setCurrentUser(name);
    if (!localStorage.getItem("asd_device_name")) setShowDevicePrompt(true);
    const sid = mkId();
    const loginAt = nowTs();
    const date = ymd(new Date());
    const system = getSystemInfo();
    activeSessionId.current = sid;
    // Fast path: add this session to the member's session array (supports multi-device)
    const existing = (onlineStatusRef.current[name] || []);
    const prev = Array.isArray(existing) ? existing.filter(isSessionFresh) : [];
    pushOnlineStatus({ [name]: [...prev, { sid, ts: Date.now(), system }] });
    // Slow path: record session in attendance history (debounced, large doc)
    if (PRESENCE_TRACKED.includes(name)) {
      setPresence(p => ({
        ...p,
        sessions: [...(p.sessions||[]), { id:sid, member:name, date, loginAt, logoutAt:null }],
      }));
    }
  };

  // Heartbeat: refresh this session's ts every 60 s — stale entries auto-expire after 2 min
  useEffect(() => {
    if (!currentUser) return;
    const system = getSystemInfo();
    const beat = setInterval(() => {
      const sid = activeSessionId.current;
      if (!sid) return;
      const existing = onlineStatusRef.current[currentUser] || [];
      const arr = Array.isArray(existing) ? existing : [];
      const updated = arr.map(s => s.sid === sid ? { ...s, ts: Date.now() } : s);
      if (!updated.find(s => s.sid === sid)) updated.push({ sid, ts: Date.now(), system });
      pushOnlineStatus({ [currentUser]: updated });
    }, 60000);
    return () => clearInterval(beat);
  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = () => {
    if (currentUser && activeSessionId.current) {
      const sid = activeSessionId.current;
      const logoutAt = nowTs();
      // Fast path: remove this session from the array
      const existing = onlineStatusRef.current[currentUser] || [];
      const arr = Array.isArray(existing) ? existing : [];
      const remaining = arr.filter(s => s.sid !== sid);
      pushOnlineStatus({ [currentUser]: remaining });
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
