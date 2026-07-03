import { useState, useEffect, useRef } from "react";
import { useSyncedState } from "./useSyncedState";
import { supabase } from "./supabaseClient";

const TEAM = ["RAJ", "LESLIE", "LALITHA", "SAI", "SRIKANTH"];
const MEMBER_COLOR = { RAJ:"#F97316", LESLIE:"#3B82F6", LALITHA:"#EC4899", SAI:"#10B981", SRIKANTH:"#8B5CF6" };
const MEMBER_PIN = { RAJ:"1234", LESLIE:"2345", LALITHA:"3456", SAI:"4567", SRIKANTH:"5678" };

const PROJECT_STATUS = {
  "Tender":      { color:"#F59E0B", bg:"#FEF3C720" },
  "In Progress": { color:"#3B82F6", bg:"#3B82F620" },
  "On Hold":     { color:"#8B5CF6", bg:"#8B5CF620" },
  "IFA Review":  { color:"#EC4899", bg:"#EC489920" },
  "Completed":   { color:"#10B981", bg:"#10B98120" },
};
const TASK_STATUS = {
  "Not Started": { color:"#6B7280", bg:"#6B728020" },
  "In Progress": { color:"#3B82F6", bg:"#3B82F620" },
  "On Hold":     { color:"#F59E0B", bg:"#F59E0B20" },
  "Completed":   { color:"#10B981", bg:"#10B98120" },
  "Urgent":      { color:"#EF4444", bg:"#EF444420" },
};
const PRIORITY = ["Low","Medium","High","Urgent"];
const PRIORITY_CLR = { Low:"#6B7280", Medium:"#F59E0B", High:"#EF4444", Urgent:"#7C3AED" };
const PHASES = ["Takeoff","Modelling","Drafting","Checking","Issued"];
const CL_SECTIONS = ["Modelling","GA Drawings","Issue GA","RFI & Acceptance","Fab Drawing","Issued Drawings"];
const SECTION_CLR = {
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

const MASTER_DEFAULT = INITIAL_TEMPLATE.map((item, i) => ({
  id: `tpl_${String(i).padStart(3,"0")}`,
  section: item.section,
  label: item.label,
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
  }));
};

const getProjectUpdates = (project, master) => {
  const cl = project.checklist || [];
  const projectTplIds = new Set(cl.map(c => c.templateId).filter(Boolean));
  const newItems = master.filter(m => !projectTplIds.has(m.id));
  const changedItems = master.filter(m => {
    const existing = cl.find(c => c.templateId === m.id);
    return existing && existing.label !== m.label;
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

const TODAY = new Date().toISOString().slice(0,10);

const SEED_PROJECTS = [
  { id:"p1", jobCode:"USS-001", name:"55 Molesworth St, Kew", client:"USS", type:"Residential", status:"In Progress", priority:"Medium", phase:"Drafting", assigned:["LESLIE"], due:"", pct:20, notes:"Basement cols.", completedDate:"", checklist:seedWithFlags(makeChecklist(),[2,5],"LESLIE") },
  { id:"p2", jobCode:"USS-002", name:"370 Ballarat Rd, Skye", client:"USS", type:"Residential", status:"In Progress", priority:"Medium", phase:"Checking", assigned:["LESLIE"], due:"", pct:80, notes:"Received feedback.", completedDate:"", checklist:seedWithFlags(makeChecklist(),[18],"LESLIE") },
  { id:"p3", jobCode:"USS-003", name:"59 Porter St, Dandenong", client:"USS", type:"Residential", status:"In Progress", priority:"Medium", phase:"Drafting", assigned:["LESLIE"], due:"", pct:40, notes:"Awaiting approval.", completedDate:"", checklist:makeChecklist() },
  { id:"p4", jobCode:"DF-001", name:"57 Drummond St, Carlton", client:"DF", type:"Residential", status:"In Progress", priority:"Medium", phase:"Modelling", assigned:["RAJ"], due:"", pct:20, notes:"", completedDate:"", checklist:makeChecklist() },
  { id:"p5", jobCode:"DF-002", name:"12 Fairy St, Ivanhoe", client:"DF", type:"Residential", status:"In Progress", priority:"High", phase:"Checking", assigned:["RAJ"], due:"2026-07-11", pct:80, notes:"Preliminary required.", completedDate:"", checklist:seedWithFlags(makeChecklist(),[10,19,22],"LESLIE") },
  { id:"p6", jobCode:"GS-001", name:"187 Bossington St, Oakleigh South", client:"GS", type:"Residential", status:"In Progress", priority:"High", phase:"Drafting", assigned:["RAJ"], due:"2026-07-15", pct:40, notes:"Preliminary required.", completedDate:"", checklist:makeChecklist() },
  { id:"p7", jobCode:"USS-004", name:"26 Orchard Cres, Mt Albert North", client:"USS", type:"Residential", status:"In Progress", priority:"Medium", phase:"Modelling", assigned:["LESLIE"], due:"2026-07-20", pct:20, notes:"", completedDate:"", checklist:makeChecklist() },
  { id:"p8", jobCode:"USS-005", name:"11 Campbell Rd, Deepdene", client:"USS", type:"Residential", status:"In Progress", priority:"Medium", phase:"Modelling", assigned:["LESLIE"], due:"2026-08-06", pct:10, notes:"", completedDate:"", checklist:makeChecklist() },
  { id:"p9", jobCode:"USS-006", name:"239 Highfield Rd, Camberwell", client:"USS", type:"Residential", status:"In Progress", priority:"Medium", phase:"Modelling", assigned:["LESLIE"], due:"2026-07-29", pct:10, notes:"", completedDate:"", checklist:makeChecklist() },
  { id:"p10", jobCode:"USS-007", name:"33 Urquhart St, Hawthorn", client:"USS", type:"Residential", status:"In Progress", priority:"Medium", phase:"Drafting", assigned:["LESLIE"], due:"", pct:20, notes:"", completedDate:"", checklist:makeChecklist() },
  { id:"p11", jobCode:"DF-003", name:"1 Goble St, Niddrie", client:"DF", type:"Residential", status:"In Progress", priority:"Medium", phase:"Drafting", assigned:["LESLIE"], due:"", pct:20, notes:"", completedDate:"", checklist:makeChecklist() },
  { id:"p12", jobCode:"DF-004", name:"18 Coate Av, Alphington", client:"DF", type:"Residential", status:"In Progress", priority:"High", phase:"Checking", assigned:["LESLIE"], due:"", pct:40, notes:"RAJ to review.", completedDate:"", checklist:makeChecklist() },
  { id:"p19", jobCode:"GS-002", name:"48 Taronga Cres, Croydon", client:"GS", type:"Residential", status:"In Progress", priority:"Urgent", phase:"Checking", assigned:["LESLIE"], due:"2026-07-25", pct:40, notes:"Steel install 10 June.", completedDate:"", checklist:makeChecklist() },
  { id:"p23", jobCode:"DF-005", name:"65 Somerville Rd, Yarraville", client:"DF", type:"Residential", status:"In Progress", priority:"High", phase:"Checking", assigned:["RAJ"], due:"", pct:40, notes:"Feedback received.", completedDate:"", checklist:makeChecklist() },
  { id:"p26", jobCode:"USS-008", name:"72 Viewhill Rd, Balwyn North", client:"USS", type:"Residential", status:"Tender", priority:"Low", phase:"Takeoff", assigned:["LESLIE"], due:"2026-08-02", pct:0, notes:"", completedDate:"", checklist:makeChecklist() },
  { id:"pc1", jobCode:"USS-C01", name:"4 Parkside St, Malvern", client:"USS", type:"Residential", status:"Completed", priority:"Medium", phase:"Issued", assigned:["LESLIE"], due:"2026-04-15", pct:100, notes:"Issued and signed off.", completedDate:"2026-04-12", checklist:completedChecklist(["LESLIE","RAJ"],"2026-04-12") },
  { id:"pc2", jobCode:"USS-C02", name:"25 Anna St, Blackburn North", client:"USS", type:"Residential", status:"Completed", priority:"Medium", phase:"Issued", assigned:["LESLIE"], due:"2026-04-20", pct:100, notes:"Late — engineer revisions.", completedDate:"2026-04-22", checklist:completedChecklist(["LESLIE","RAJ","LALITHA"],"2026-04-22") },
  { id:"pc3", jobCode:"DF-C01", name:"9 Clydesdale Rd, Airport West", client:"DF", type:"Residential", status:"Completed", priority:"Medium", phase:"Issued", assigned:["LESLIE"], due:"2026-05-06", pct:100, notes:"Issued on time.", completedDate:"2026-05-05", checklist:completedChecklist(["LESLIE","SAI"],"2026-05-05") },
  { id:"pc6", jobCode:"GS-C01", name:"19-20 Maclaine Crt, Narre Warren", client:"GS", type:"Residential", status:"Completed", priority:"Medium", phase:"Issued", assigned:["RAJ"], due:"2026-05-20", pct:100, notes:"Wait for Stage 2.", completedDate:"2026-05-18", checklist:completedChecklist(["RAJ","SRIKANTH","LESLIE"],"2026-05-18") },
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
// Dates are relative to TODAY so it always looks "current" regardless of when this runs.
const _addDays = n => { const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };
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
const daysLeft = d => d ? Math.ceil((new Date(d)-new Date(TODAY))/86400000) : null;
const clPct = cl => cl.length===0 ? 0 : Math.round((cl.filter(c=>c.done).length/cl.length)*100);

const IS = { width:"100%", background:"#0F172A", border:"1px solid #334155", borderRadius:6, padding:"7px 10px", color:"#F1F5F9", fontSize:13, boxSizing:"border-box", outline:"none" };

function Modal({ title, onClose, children, wide, extraWide }) {
  const mw = extraWide ? 820 : wide ? 640 : 500;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div style={{background:"#1E293B",border:"1px solid #334155",borderRadius:12,padding:26,width:"100%",maxWidth:mw,maxHeight:"92vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <h3 style={{margin:0,color:"#F1F5F9",fontSize:15,fontWeight:700}}>{title}</h3>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#64748B",cursor:"pointer",fontSize:20}}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel, confirmColor, onConfirm, onClose }) {
  const label = confirmLabel || "Delete";
  const color = confirmColor || "#EF4444";
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div style={{background:"#1E293B",border:"1px solid #EF444466",borderRadius:12,padding:26,width:"100%",maxWidth:460}} onClick={e=>e.stopPropagation()}>
        <h3 style={{margin:0,color:"#F1F5F9",fontSize:15,fontWeight:800,marginBottom:14}}>⚠ {title}</h3>
        <div style={{color:"#CBD5E1",fontSize:13,lineHeight:1.5,marginBottom:20,whiteSpace:"pre-wrap"}}>{message}</div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={()=>{onConfirm();onClose();}} style={{flex:1,background:color,border:"none",borderRadius:6,padding:"10px 0",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>{label}</button>
          <button onClick={onClose} style={{padding:"10px 20px",background:"transparent",border:"1px solid #334155",borderRadius:6,color:"#94A3B8",cursor:"pointer",fontSize:13}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{marginBottom:13}}>
      <label style={{display:"block",color:"#94A3B8",fontSize:11,fontWeight:700,letterSpacing:"0.06em",marginBottom:5,textTransform:"uppercase"}}>{label}</label>
      {children}
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
  return <div style={{background:"#0F172A",borderRadius:3,height:6,overflow:"hidden"}}><div style={{width:`${pct}%`,height:"100%",background:c,borderRadius:3,transition:"width 0.4s"}}/></div>;
}

function Avatar({ name, size }) {
  const sz = size || 26;
  return <span title={name} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:sz,height:sz,borderRadius:"50%",background:MEMBER_COLOR[name]||"#6B7280",color:"#fff",fontSize:sz*0.38,fontWeight:800,border:"2px solid #0F172A",marginRight:-6,flexShrink:0}}>{name.slice(0,2)}</span>;
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
      win.document.write(
        `<title>${att.name}</title><body style="margin:0;background:#0F172A;">` +
        `<iframe src="${att.dataUrl}" style="border:none;width:100vw;height:100vh;"></iframe>`
      );
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
      <div style={{fontSize:13,color:"#CBD5E1",marginBottom:14,padding:"10px 12px",background:"#0F172A",borderRadius:6,borderLeft:"3px solid #F97316"}}>
        {item.label}
      </div>

      <div style={{border:"2px dashed #475569",borderRadius:8,padding:"24px 16px",textAlign:"center",marginBottom:14,background:"#0F172A",transition:"border-color 0.15s"}}
        onMouseEnter={e=>e.currentTarget.style.borderColor="#F97316"}
        onMouseLeave={e=>e.currentTarget.style.borderColor="#475569"}>
        <input type="file" multiple onChange={handleFileSelect} id="ck-file-upload" style={{display:"none"}} disabled={uploading}/>
        <label htmlFor="ck-file-upload" style={{cursor:uploading?"wait":"pointer",display:"block"}}>
          <div style={{fontSize:36,marginBottom:8}}>📎</div>
          <div style={{fontSize:13,fontWeight:700,color:"#F97316",marginBottom:4}}>
            {uploading ? "Reading files…" : "Click to attach files"}
          </div>
          <div style={{fontSize:11,color:"#64748B"}}>Images · PDFs · Word · Excel · ZIP (max 50MB each)</div>
        </label>
      </div>

      {errMsg && (
        <div style={{background:"#EF444420",border:"1px solid #EF4444",borderRadius:6,padding:"8px 12px",fontSize:12,color:"#EF4444",marginBottom:14}}>
          ⚠ {errMsg}
        </div>
      )}

      {attachments.length === 0 ? (
        <div style={{textAlign:"center",color:"#475569",padding:"20px 0",fontSize:13}}>No attachments yet</div>
      ) : (
        <div style={{marginBottom:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:11,fontWeight:800,color:"#64748B",textTransform:"uppercase",letterSpacing:"0.06em"}}>{attachments.length} file{attachments.length!==1?"s":""}</span>
            <span style={{fontSize:11,color:"#475569"}}>Total: {fmtFileSize(totalSize)}</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:6,maxHeight:300,overflowY:"auto"}}>
            {attachments.map(att => {
              const isImage = att.type.startsWith("image/");
              const mc = MEMBER_COLOR[att.member]||"#6B7280";
              const actionLabel = openLabel(att.type);
              const actionIcon = openIcon(att.type);
              return (
                <div key={att.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"#0F172A",borderRadius:6,border:"1px solid #1E293B"}}>
                  {/* ── Thumbnail / icon — click to open ── */}
                  {isImage ? (
                    <img
                      src={att.dataUrl} alt={att.name}
                      onClick={() => openAttachment(att, setPreview)}
                      title={actionLabel}
                      style={{width:44,height:44,objectFit:"cover",borderRadius:5,cursor:"pointer",border:"1px solid #334155",flexShrink:0}}
                    />
                  ) : (
                    <div
                      onClick={() => openAttachment(att, setPreview)}
                      title={actionLabel}
                      style={{width:44,height:44,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,background:"#1E293B",borderRadius:5,flexShrink:0,cursor:"pointer"}}
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
                    <div style={{fontSize:12,color:"#F1F5F9",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{att.name}</div>
                    <div style={{fontSize:10,color:"#475569",display:"flex",gap:8,alignItems:"center",marginTop:2}}>
                      <span>{fmtFileSize(att.size)}</span>
                      <span style={{color:mc,fontWeight:700}}>{att.member}</span>
                      <span>{fmtTs(att.ts)}</span>
                    </div>
                  </div>

                  {/* ── Open / preview button ── */}
                  <button
                    onClick={() => openAttachment(att, setPreview)}
                    title={actionLabel}
                    style={{background:"none",border:"none",color:"#94A3B8",cursor:"pointer",fontSize:14,padding:"0 2px"}}
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
          <div style={{marginTop:16,color:"#F1F5F9",fontSize:13}}>{preview.name} · {fmtFileSize(preview.size)}</div>
          <button onClick={()=>setPreview(null)} style={{position:"absolute",top:20,right:20,background:"#1E293B",border:"1px solid #334155",borderRadius:50,width:40,height:40,color:"#F1F5F9",cursor:"pointer",fontSize:18}}>✕</button>
        </div>
      )}

      <div style={{display:"flex",gap:10}}>
        <button onClick={handleSave} style={{flex:1,background:"#10B981",border:"none",borderRadius:6,padding:"10px 0",color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>Save Changes</button>
        <button onClick={onClose} style={{padding:"10px 20px",background:"transparent",border:"1px solid #334155",borderRadius:6,color:"#94A3B8",cursor:"pointer",fontSize:13}}>Cancel</button>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════
// SNIP MODAL — screen capture via getDisplayMedia
// Phases: idle → sharing → captured → error
// ═════════════════════════════════════════════════
function ScreenshotModal({ item, currentUser, onSave, onClose }) {
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  // idle: show instructions  sharing: stream live  captured: show snip  error: show msg
  const [phase, setPhase]           = useState("idle");
  const [capturedUrl, setCapturedUrl] = useState(null);
  const [srcLabel, setSrcLabel]      = useState("");
  const [errMsg, setErrMsg]          = useState("");

  // Stop the stream whenever phase leaves "sharing"
  const stopStream = () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
  };

  // Cleanup on unmount
  useEffect(() => () => stopStream(), []);

  // When stream ends externally (user clicks "Stop sharing" in browser bar)
  const onStreamEnd = () => {
    if (phase === "sharing") { stopStream(); setPhase("idle"); }
  };

  const startShare = async () => {
    setErrMsg("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: false,
      });
      streamRef.current = stream;
      stream.getVideoTracks()[0].addEventListener("ended", onStreamEnd);
      const track = stream.getVideoTracks()[0];
      setSrcLabel(track.label || "Screen");
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase("sharing");
    } catch (err) {
      if (err.name === "NotAllowedError") {
        // User cancelled the picker — just go back to idle silently
        setPhase("idle");
      } else {
        setErrMsg(`Screen capture error: ${err.message}`);
        setPhase("error");
      }
    }
  };

  const snip = () => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width  = video.videoWidth  || 1920;
    canvas.height = video.videoHeight || 1080;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const url = canvas.toDataURL("image/png");
    stopStream();
    setCapturedUrl(url);
    setPhase("captured");
  };

  const retake = () => {
    setCapturedUrl(null);
    setPhase("idle");
  };

  const confirm = () => {
    if (!capturedUrl) return;
    const ts   = nowTs();
    const name = `snip_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
    const approxSize = Math.round((capturedUrl.length - capturedUrl.indexOf(",") - 1) * 0.75);