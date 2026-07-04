import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const LOGO = "/logo.jpg";

// ── Inject landing-page CSS (animations, scroll reveal, responsive) ──────────
function injectCSS() {
  if (document.getElementById("asd-landing-css")) return;
  const el = document.createElement("style");
  el.id = "asd-landing-css";
  el.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { background: #0A0F1E; color: #F1F5F9; font-family: 'Segoe UI', system-ui, sans-serif; }

    .asd-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 100; transition: background 0.3s, box-shadow 0.3s; }
    .asd-nav.scrolled { background: rgba(10,15,30,0.97); box-shadow: 0 1px 0 rgba(255,255,255,0.06); backdrop-filter: blur(12px); }

    @keyframes fadeUp { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
    @keyframes gridMove { from { transform: translateY(0); } to { transform: translateY(60px); } }
    @keyframes float { 0%,100% { transform: translateY(0px) rotate(-1deg); } 50% { transform: translateY(-12px) rotate(1deg); } }

    .hero-title { animation: fadeUp 0.9s ease both; }
    .hero-sub   { animation: fadeUp 0.9s 0.15s ease both; }
    .hero-btns  { animation: fadeUp 0.9s 0.3s ease both; }
    .hero-badge { animation: fadeUp 0.9s 0.45s ease both; }

    .reveal { opacity: 0; transform: translateY(24px); transition: opacity 0.7s ease, transform 0.7s ease; }
    .reveal.visible { opacity: 1; transform: none; }

    .svc-card { background: #111827; border: 1px solid #1E293B; border-radius: 12px; padding: 28px 24px; transition: transform 0.25s, border-color 0.25s, box-shadow 0.25s; cursor: default; }
    .svc-card:hover { transform: translateY(-4px); border-color: #F9731644; box-shadow: 0 8px 32px #F9731614; }

    .port-card { background: #111827; border: 1px solid #1E293B; border-radius: 12px; overflow: hidden; transition: transform 0.25s, box-shadow 0.25s; }
    .port-card:hover { transform: translateY(-4px); box-shadow: 0 12px 40px rgba(0,0,0,0.5); }

    .stat-num { font-size: 42px; font-weight: 900; font-family: monospace; color: #F97316; line-height: 1; }

    .cta-btn { display: inline-flex; align-items: center; gap: 8px; background: #F97316; color: #fff; border: none; border-radius: 8px; padding: 14px 28px; font-size: 15px; font-weight: 700; cursor: pointer; transition: background 0.2s, transform 0.15s, box-shadow 0.2s; text-decoration: none; }
    .cta-btn:hover { background: #EA6C0A; transform: translateY(-2px); box-shadow: 0 6px 24px #F9731640; }

    .ghost-btn { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: #F1F5F9; border: 1px solid #334155; border-radius: 8px; padding: 13px 26px; font-size: 15px; font-weight: 600; cursor: pointer; transition: border-color 0.2s, background 0.2s; text-decoration: none; }
    .ghost-btn:hover { border-color: #F97316; background: #F9731610; }

    .section { padding: 96px 0; }
    .section-alt { background: #0D1424; }

    .container { max-width: 1200px; margin: 0 auto; padding: 0 32px; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; }

    .tag { display: inline-block; background: #F9731618; border: 1px solid #F9731644; color: #F97316; border-radius: 20px; padding: 4px 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 16px; }

    .section-title { font-size: 38px; font-weight: 900; color: #F1F5F9; line-height: 1.15; margin-bottom: 16px; }
    .section-sub { font-size: 17px; color: #94A3B8; line-height: 1.7; max-width: 560px; }

    input, textarea, select { outline: none; }
    input:focus, textarea:focus { border-color: #F97316 !important; }

    @media (max-width: 900px) {
      .grid-2 { grid-template-columns: 1fr; }
      .grid-3 { grid-template-columns: 1fr 1fr; }
      .grid-4 { grid-template-columns: 1fr 1fr; }
      .section-title { font-size: 28px; }
      .container { padding: 0 20px; }
      .section { padding: 64px 0; }
    }
    @media (max-width: 600px) {
      .grid-3, .grid-4 { grid-template-columns: 1fr; }
      .hero-actions { flex-direction: column; align-items: stretch; }
      .cta-btn, .ghost-btn { justify-content: center; }
    }
  `;
  document.head.appendChild(el);
}

// ── Scroll-reveal hook ───────────────────────────────────────────────────────
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("visible"); obs.unobserve(e.target); } });
    }, { threshold: 0.12 });
    els.forEach(el => obs.observe(el));
    return () => obs.disconnect();
  });
}

// ── Sample portfolio projects ────────────────────────────────────────────────
const PORTFOLIO = [
  {
    code: "DF-0142",
    name: "Multi-Storey Commercial Frame",
    client: "DF",
    type: "Commercial",
    phase: "Issued Drawings",
    year: "2024",
    desc: "Complete structural steel modelling and fabrication drawings for a 6-storey commercial building including connections, bolting and erection sequences.",
    tags: ["Structural Modelling", "Fab Drawings", "GA Drawings"],
    color: "#3B82F6",
  },
  {
    code: "GS-0089",
    name: "Residential Duplex Frames",
    client: "GS",
    type: "Residential",
    phase: "Issued Drawings",
    year: "2024",
    desc: "Steel portal frame design documentation and shop drawings for a residential duplex project, coordinated with architectural and civil disciplines.",
    tags: ["Shop Drawings", "RFI Management", "Modelling"],
    color: "#10B981",
  },
  {
    code: "USS-0231",
    name: "Industrial Warehouse Structure",
    client: "USS",
    type: "Industrial",
    phase: "Issued Drawings",
    year: "2023",
    desc: "Large-span industrial warehouse with mezzanine levels. Full take-off, modelling, GA and fabrication drawing package delivered to program.",
    tags: ["Take-off", "GA Drawings", "Fab Drawings"],
    color: "#F97316",
  },
  {
    code: "DF-0118",
    name: "Apartment Building Steel Package",
    client: "DF",
    type: "Commercial",
    phase: "Issued Drawings",
    year: "2023",
    desc: "Detailed steel connection and member drawings for a 4-level apartment building. Coordinated with concrete structure and services.",
    tags: ["Connections", "Structural Modelling", "RFI"],
    color: "#8B5CF6",
  },
  {
    code: "GS-0067",
    name: "Retail Centre Canopy",
    client: "GS",
    type: "Commercial",
    phase: "Issued Drawings",
    year: "2023",
    desc: "Feature canopy steel structure for a retail centre entry. Included bespoke curved members, cladding support framing and shop drawings.",
    tags: ["Shop Drawings", "Modelling", "Fabrication"],
    color: "#EC4899",
  },
  {
    code: "USS-0199",
    name: "Distribution Centre Extension",
    client: "USS",
    type: "Industrial",
    phase: "Issued Drawings",
    year: "2024",
    desc: "Extension to an existing distribution centre. Matching existing structure profiles, new dock leveller pits and crane runway beam documentation.",
    tags: ["Take-off", "GA Drawings", "Fab Drawings"],
    color: "#06B6D4",
  },
];

const SERVICES = [
  {
    icon: "⬡",
    title: "Structural Steel Modelling",
    desc: "3D modelling of structural steel frameworks using industry-standard software for accuracy and coordination across disciplines.",
    color: "#3B82F6",
  },
  {
    icon: "📐",
    title: "GA Drawings",
    desc: "General arrangement drawings showing member positions, connections, levels and setting-out information for construction.",
    color: "#F97316",
  },
  {
    icon: "🔩",
    title: "Fabrication Drawings",
    desc: "Detailed shop and fabrication drawings for steel members, connections, base plates and all associated steelwork.",
    color: "#10B981",
  },
  {
    icon: "📋",
    title: "RFI Management",
    desc: "Systematic handling of Requests for Information, ensuring design queries are resolved and documented before fabrication.",
    color: "#8B5CF6",
  },
  {
    icon: "📊",
    title: "Steel Take-offs",
    desc: "Accurate quantity take-offs and weight schedules for estimating, procurement and project costing.",
    color: "#EC4899",
  },
  {
    icon: "✅",
    title: "Issued Drawing Packages",
    desc: "Managed drawing issue and revision control — ensuring the right revision reaches the right people at the right time.",
    color: "#06B6D4",
  },
];

const STATS = [
  { num: "200+", label: "Projects Completed" },
  { num: "10+", label: "Years Experience" },
  { num: "3", label: "Major Fabricators" },
  { num: "100%", label: "On-Time Delivery" },
];

// ── Contact form ─────────────────────────────────────────────────────────────
function ContactForm() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", type: "", message: "" });
  const [sent, setSent] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const IS = {
    width: "100%", background: "#0A0F1E", border: "1px solid #1E293B", borderRadius: 8,
    padding: "12px 14px", color: "#F1F5F9", fontSize: 14, fontFamily: "inherit",
  };

  if (sent) return (
    <div style={{ background: "#10B98118", border: "1px solid #10B98144", borderRadius: 12, padding: "40px 32px", textAlign: "center" }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: "#10B981", marginBottom: 8 }}>Message Sent!</div>
      <div style={{ color: "#94A3B8", fontSize: 14 }}>We'll be in touch within 1 business day.</div>
    </div>
  );

  return (
    <form onSubmit={e => { e.preventDefault(); setSent(true); }} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8", display: "block", marginBottom: 6 }}>Full Name *</label>
          <input required value={form.name} onChange={set("name")} placeholder="John Smith" style={IS} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8", display: "block", marginBottom: 6 }}>Email *</label>
          <input required type="email" value={form.email} onChange={set("email")} placeholder="john@company.com.au" style={IS} />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8", display: "block", marginBottom: 6 }}>Phone</label>
          <input value={form.phone} onChange={set("phone")} placeholder="+61 4xx xxx xxx" style={IS} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8", display: "block", marginBottom: 6 }}>Project Type</label>
          <select value={form.type} onChange={set("type")} style={{ ...IS, cursor: "pointer" }}>
            <option value="">Select type…</option>
            <option>Residential</option>
            <option>Commercial</option>
            <option>Industrial</option>
            <option>Other</option>
          </select>
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8", display: "block", marginBottom: 6 }}>Message *</label>
        <textarea required rows={5} value={form.message} onChange={set("message")} placeholder="Tell us about your project…" style={{ ...IS, resize: "vertical", minHeight: 110 }} />
      </div>
      <button type="submit" className="cta-btn" style={{ alignSelf: "flex-start" }}>
        Send Enquiry →
      </button>
    </form>
  );
}

// ── Main landing page ─────────────────────────────────────────────────────────
export default function LandingPage() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [portFilter, setPortFilter] = useState("All");
  useReveal();

  useEffect(() => {
    injectCSS();
    document.title = "Advanced Steel Drafting | Precision Structural Steel Documentation";
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navLinks = [
    { label: "Services", href: "#services" },
    { label: "Portfolio", href: "#portfolio" },
    { label: "About", href: "#about" },
    { label: "Contact", href: "#contact" },
  ];

  const filteredPort = portFilter === "All" ? PORTFOLIO : PORTFOLIO.filter(p => p.type === portFilter);

  return (
    <div style={{ minHeight: "100vh", background: "#0A0F1E", color: "#F1F5F9" }}>

      {/* ── NAV ─────────────────────────────────────────────────────────── */}
      <nav className={`asd-nav ${scrolled ? "scrolled" : ""}`} style={{ padding: "0 32px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", height: 66 }}>
          {/* Logo */}
          <a href="#" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", flex: "0 0 auto" }}>
            <img src={LOGO} alt="ASD Logo" style={{ width: 42, height: 42, borderRadius: 8, objectFit: "cover", objectPosition: "center", display: "block" }} />
            <div>
              <div style={{ fontWeight: 900, fontSize: 14, color: "#F1F5F9", lineHeight: 1.1 }}>ADVANCED STEEL</div>
              <div style={{ fontWeight: 600, fontSize: 10, color: "#94A3B8", letterSpacing: "0.12em", textTransform: "uppercase" }}>DRAFTING</div>
            </div>
          </a>

          <div style={{ flex: 1 }} />

          {/* Desktop links */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }} className="desktop-nav">
            {navLinks.map(l => (
              <a key={l.label} href={l.href} style={{ color: "#94A3B8", fontSize: 13, fontWeight: 600, padding: "6px 12px", borderRadius: 6, textDecoration: "none", transition: "color 0.2s" }}
                onMouseEnter={e => e.target.style.color = "#F1F5F9"} onMouseLeave={e => e.target.style.color = "#94A3B8"}>
                {l.label}
              </a>
            ))}
            <button onClick={() => navigate("/portal")} className="cta-btn" style={{ marginLeft: 12, padding: "8px 18px", fontSize: 13 }}>
              Team Portal →
            </button>
          </div>
        </div>
      </nav>

      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section style={{ minHeight: "100vh", display: "flex", alignItems: "center", position: "relative", overflow: "hidden", paddingTop: 66 }}>
        {/* Animated grid background */}
        <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(249,115,22,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(249,115,22,0.04) 1px, transparent 1px)", backgroundSize: "60px 60px", animation: "gridMove 8s linear infinite alternate" }} />
        {/* Gradient overlay */}
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 80% 60% at 50% 40%, rgba(249,115,22,0.08) 0%, transparent 70%)" }} />

        <div className="container" style={{ position: "relative", zIndex: 1, paddingTop: 40, paddingBottom: 80 }}>
          <div style={{ maxWidth: 740 }}>
            {/* Logo mark above headline */}
            <div className="hero-title" style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
              <img src={LOGO} alt="Advanced Steel Drafting" style={{ width: 72, height: 72, borderRadius: 14, objectFit: "cover", boxShadow: "0 0 0 1px rgba(255,255,255,0.08), 0 8px 32px rgba(0,0,0,0.6)" }} />
              <div>
                <div style={{ fontWeight: 900, fontSize: 22, color: "#F1F5F9", lineHeight: 1.1 }}>ADVANCED STEEL</div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#94A3B8", letterSpacing: "0.18em", textTransform: "uppercase" }}>DRAFTING</div>
              </div>
            </div>
            <div className="tag">Precision · Speed · Quality</div>
            <h1 className="hero-title section-title" style={{ fontSize: 58, marginBottom: 24, lineHeight: 1.08 }}>
              Structural Steel<br />
              <span style={{ color: "#F97316" }}>Documentation</span><br />
              Done Right.
            </h1>
            <p className="hero-sub" style={{ fontSize: 19, color: "#94A3B8", lineHeight: 1.7, marginBottom: 40, maxWidth: 560 }}>
              Advanced Steel Drafting delivers high-quality steel modelling, GA drawings, fabrication packages and RFI management — on time, every time.
            </p>
            <div className="hero-btns hero-actions" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <a href="#contact" className="cta-btn">Get a Quote →</a>
              <a href="#portfolio" className="ghost-btn">View Our Work</a>
            </div>

            {/* Stats row */}
            <div className="hero-badge" style={{ display: "flex", gap: 40, marginTop: 60, flexWrap: "wrap" }}>
              {STATS.map(s => (
                <div key={s.label}>
                  <div className="stat-num">{s.num}</div>
                  <div style={{ fontSize: 12, color: "#64748B", marginTop: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Decorative logo watermark */}
        <div style={{ position: "absolute", right: "5%", top: "50%", transform: "translateY(-50%)", pointerEvents: "none", animation: "float 7s ease-in-out infinite" }}>
          <img src={LOGO} alt="" aria-hidden="true" style={{ width: 360, height: 360, objectFit: "cover", borderRadius: 24, opacity: 0.12, display: "block" }} />
        </div>
      </section>

      {/* ── SERVICES ─────────────────────────────────────────────────────── */}
      <section className="section section-alt" id="services">
        <div className="container">
          <div style={{ textAlign: "center", marginBottom: 56 }} className="reveal">
            <div className="tag">What We Do</div>
            <h2 className="section-title" style={{ margin: "0 auto 16px" }}>Our Services</h2>
            <p className="section-sub" style={{ margin: "0 auto" }}>
              From initial take-off through to issued fabrication drawings, we handle the full steel documentation workflow.
            </p>
          </div>
          <div className="grid-3">
            {SERVICES.map((s, i) => (
              <div key={s.title} className="svc-card reveal" style={{ animationDelay: `${i * 0.07}s` }}>
                <div style={{ width: 48, height: 48, borderRadius: 10, background: `${s.color}18`, border: `1px solid ${s.color}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 18 }}>
                  {s.icon}
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: "#F1F5F9", marginBottom: 10 }}>{s.title}</h3>
                <p style={{ fontSize: 14, color: "#64748B", lineHeight: 1.65 }}>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PORTFOLIO ────────────────────────────────────────────────────── */}
      <section className="section" id="portfolio">
        <div className="container">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 48, flexWrap: "wrap", gap: 20 }} className="reveal">
            <div>
              <div className="tag">Completed Projects</div>
              <h2 className="section-title" style={{ marginBottom: 0 }}>Our Portfolio</h2>
            </div>
            {/* Filter tabs */}
            <div style={{ display: "flex", background: "#111827", border: "1px solid #1E293B", borderRadius: 8, padding: 4, gap: 4 }}>
              {["All", "Residential", "Commercial", "Industrial"].map(f => (
                <button key={f} onClick={() => setPortFilter(f)}
                  style={{ padding: "7px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, background: portFilter === f ? "#F97316" : "transparent", color: portFilter === f ? "#fff" : "#64748B", transition: "all 0.2s" }}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="grid-3" style={{ gap: 28 }}>
            {filteredPort.map((p, i) => (
              <div key={p.code} className="port-card reveal" style={{ transitionDelay: `${i * 0.07}s` }}>
                {/* Card header strip */}
                <div style={{ height: 6, background: p.color }} />
                <div style={{ padding: "22px 24px 24px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                    <div>
                      <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 900, color: p.color, background: `${p.color}18`, border: `1px solid ${p.color}44`, borderRadius: 4, padding: "2px 8px" }}>{p.code}</span>
                      <div style={{ fontSize: 9, color: "#475569", marginTop: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{p.type} · {p.year}</div>
                    </div>
                    <div style={{ background: "#10B98118", border: "1px solid #10B98144", borderRadius: 4, padding: "2px 8px", fontSize: 9, fontWeight: 800, color: "#10B981" }}>✓ ISSUED</div>
                  </div>
                  <h3 style={{ fontSize: 15, fontWeight: 800, color: "#F1F5F9", marginBottom: 10, lineHeight: 1.3 }}>{p.name}</h3>
                  <p style={{ fontSize: 13, color: "#64748B", lineHeight: 1.65, marginBottom: 18 }}>{p.desc}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {p.tags.map(t => (
                      <span key={t} style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", background: "#1E293B", border: "1px solid #334155", borderRadius: 4, padding: "3px 8px" }}>{t}</span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {filteredPort.length === 0 && (
            <div style={{ textAlign: "center", color: "#475569", padding: "60px 0", fontSize: 15 }}>No projects in this category yet.</div>
          )}
        </div>
      </section>

      {/* ── WHY ASD ──────────────────────────────────────────────────────── */}
      <section className="section section-alt" id="about">
        <div className="container">
          <div className="grid-2" style={{ alignItems: "center", gap: 64 }}>
            <div className="reveal">
              <div className="tag">Why Choose Us</div>
              <h2 className="section-title">Built for Fabricators &amp; Builders</h2>
              <p style={{ color: "#64748B", fontSize: 16, lineHeight: 1.75, marginBottom: 32 }}>
                We understand the pressures of the steel fabrication industry — tight programs, complex connections, and last-minute RFIs. Our team is trained to handle high-volume documentation with precision and speed.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {[
                  { icon: "⚡", title: "Fast Turnaround", desc: "We work to your program, not ours. Urgent packages handled as priority." },
                  { icon: "🎯", title: "Zero Defect Culture", desc: "Multi-stage checking processes ensure drawings leave our office error-free." },
                  { icon: "🔗", title: "Seamless Coordination", desc: "We coordinate directly with engineers, architects and fabricators to resolve clashes before they hit site." },
                ].map(item => (
                  <div key={item.title} style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ width: 42, height: 42, borderRadius: 8, background: "#F9731618", border: "1px solid #F9731633", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{item.icon}</div>
                    <div>
                      <div style={{ fontWeight: 800, color: "#F1F5F9", marginBottom: 4, fontSize: 15 }}>{item.title}</div>
                      <div style={{ color: "#64748B", fontSize: 14, lineHeight: 1.6 }}>{item.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Process steps */}
              <div style={{ background: "#111827", border: "1px solid #1E293B", borderRadius: 12, padding: 28 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#F97316", marginBottom: 20, textTransform: "uppercase", letterSpacing: "0.08em" }}>Our Process</div>
                {[
                  { n: "01", label: "Job Study", desc: "Review documentation, confirm scope & specifications" },
                  { n: "02", label: "Modelling", desc: "3D structural model built to engineering drawings" },
                  { n: "03", label: "GA Drawings", desc: "General arrangement and setting-out drawings issued" },
                  { n: "04", label: "RFI Stage", desc: "Queries raised and resolved with engineer / client" },
                  { n: "05", label: "Fab Drawings", desc: "Full fabrication and shop drawing package produced" },
                  { n: "06", label: "Issue & Close", desc: "Final drawing issue, revision control and handover" },
                ].map((step, i, arr) => (
                  <div key={step.n} style={{ display: "flex", gap: 16, alignItems: "flex-start", paddingBottom: i < arr.length - 1 ? 16 : 0, marginBottom: i < arr.length - 1 ? 16 : 0, borderBottom: i < arr.length - 1 ? "1px solid #1E293B" : "none" }}>
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#F9731620", border: "1px solid #F9731644", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900, color: "#F97316", flexShrink: 0 }}>{step.n}</div>
                    <div>
                      <div style={{ fontWeight: 700, color: "#F1F5F9", fontSize: 13 }}>{step.label}</div>
                      <div style={{ color: "#64748B", fontSize: 12, marginTop: 2 }}>{step.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA BANNER ───────────────────────────────────────────────────── */}
      <section style={{ padding: "72px 0", background: "linear-gradient(135deg, #F97316 0%, #EA580C 100%)", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, opacity: 0.06, fontSize: 400, display: "flex", alignItems: "center", justifyContent: "flex-end", pointerEvents: "none", userSelect: "none", paddingRight: 40 }}>⬡</div>
        <div className="container reveal" style={{ position: "relative", textAlign: "center" }}>
          <h2 style={{ fontSize: 36, fontWeight: 900, color: "#fff", marginBottom: 16 }}>Ready to Start Your Project?</h2>
          <p style={{ fontSize: 17, color: "rgba(255,255,255,0.8)", marginBottom: 36, maxWidth: 500, margin: "0 auto 36px" }}>
            Get in touch today for a fast, obligation-free quote on your steel documentation package.
          </p>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
            <a href="#contact" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#fff", color: "#EA580C", border: "none", borderRadius: 8, padding: "14px 28px", fontSize: 15, fontWeight: 800, cursor: "pointer", textDecoration: "none", transition: "transform 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.transform = "translateY(-2px)"} onMouseLeave={e => e.currentTarget.style.transform = ""}>
              Get a Quote →
            </a>
            <a href="mailto:admin@advancedsteeldrafting.com" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.15)", color: "#fff", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 8, padding: "14px 28px", fontSize: 15, fontWeight: 700, cursor: "pointer", textDecoration: "none" }}>
              📧 Email Us
            </a>
          </div>
        </div>
      </section>

      {/* ── CONTACT ──────────────────────────────────────────────────────── */}
      <section className="section" id="contact">
        <div className="container">
          <div className="grid-2" style={{ gap: 64, alignItems: "flex-start" }}>
            <div className="reveal">
              <div className="tag">Get In Touch</div>
              <h2 className="section-title">Request a Quote</h2>
              <p className="section-sub" style={{ marginBottom: 40 }}>
                Send us your project details and we'll respond within 1 business day with a quote and timeframe.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {[
                  { icon: "📧", label: "Email", val: "admin@advancedsteeldrafting.com", href: "mailto:admin@advancedsteeldrafting.com" },
                  { icon: "🕐", label: "Response Time", val: "Within 1 business day" },
                  { icon: "📍", label: "Location", val: "Australia" },
                ].map(item => (
                  <div key={item.label} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: "#F9731618", border: "1px solid #F9731633", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>{item.icon}</div>
                    <div>
                      <div style={{ fontSize: 11, color: "#475569", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{item.label}</div>
                      {item.href
                        ? <a href={item.href} style={{ color: "#F97316", fontSize: 14, fontWeight: 600, textDecoration: "none" }}>{item.val}</a>
                        : <div style={{ color: "#94A3B8", fontSize: 14 }}>{item.val}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="reveal">
              <ContactForm />
            </div>
          </div>
        </div>
      </section>

      {/* ── FOOTER ───────────────────────────────────────────────────────── */}
      <footer style={{ background: "#060B14", borderTop: "1px solid #0F172A", padding: "40px 32px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img src={LOGO} alt="ASD Logo" style={{ width: 34, height: 34, borderRadius: 6, objectFit: "cover", display: "block" }} />
            <div>
              <div style={{ fontWeight: 900, fontSize: 12, color: "#94A3B8" }}>ADVANCED STEEL DRAFTING</div>
              <div style={{ fontSize: 11, color: "#334155" }}>© {new Date().getFullYear()} All rights reserved</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
            {navLinks.map(l => (
              <a key={l.label} href={l.href} style={{ color: "#475569", fontSize: 12, fontWeight: 600, textDecoration: "none", transition: "color 0.2s" }}
                onMouseEnter={e => e.target.style.color = "#94A3B8"} onMouseLeave={e => e.target.style.color = "#475569"}>
                {l.label}
              </a>
            ))}
            <button onClick={() => navigate("/portal")} style={{ background: "#F9731620", border: "1px solid #F9731644", color: "#F97316", borderRadius: 6, padding: "5px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Team Portal →
            </button>
          </div>
        </div>
      </footer>

    </div>
  );
}
