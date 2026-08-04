import { sx } from "../lib/styleString";

const gateNotes = [
  { k: "Why hold, not PIN", v: "A PIN is one more thing to forget and one more thing to watch a parent type. Two seconds of sustained pressure is beyond an accidental tap and inside a distracted parent's patience." },
  { k: "No dark pattern", v: "The gate protects settings and transcripts. It never gates the child's exit — a child can always leave a session without a grown-up." },
  { k: "What is behind it", v: "Talk time, the full transcript, the daily limit, language, and the promises. Nothing to purchase." },
];

const stats = [
  { k: "Talk time today", v: "27", sub: "words Anu said to Chiku — the metric we optimise" },
  { k: "Turns taken", v: "9", sub: "checkpoints answered out of 11 asked" },
  { k: "New word", v: "green", sub: "పచ్చ · said twice unprompted" },
  { k: "Screen time", v: "14m", sub: "of the 20m you allowed" },
];

const transcript = [
  ["16:04", "Chiku", "Which one is green?"],
  ["16:04", "Anu", "the leaf!"],
  ["16:05", "Chiku", "Yes! The leaf is green — pachcha."],
  ["16:07", "Chiku", "How many bananas do you see?"],
  ["16:07", "Anu", "one two… five!"],
  ["16:08", "Chiku", "Let's count together — one, two, three."],
  ["16:11", "Anu", "pachcha!"],
  ["16:12", "Chiku", "Go show Amma your drawing!"],
];

export default function ParentDashboard({ s, setState, en, holdStart, holdStop }) {
  if (!s.gate) {
    return (
      <div style={sx("padding-top:64px;display:flex;gap:56px;flex-wrap:wrap;align-items:flex-start")}>
        <div style={sx("width:420px;border:2px solid var(--color-text);background:#fff;padding:40px")}>
          <div style={sx("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)")}>Grown-up gate</div>
          <h2 style={sx("font-family:var(--font-heading);font-size:30px;margin:10px 0 8px;letter-spacing:-.02em")}>Press and hold</h2>
          <p style={sx("font-size:15px;line-height:1.55;color:var(--color-neutral-700);margin:0 0 28px")}>Hold the circle for two seconds. No PIN to forget, and a three-year-old will not get through it by tapping.</p>
          <div style={sx("display:grid;place-items:center;padding:8px 0 20px")}>
            <button onMouseDown={holdStart} onMouseUp={holdStop} onMouseLeave={holdStop} onTouchStart={holdStart} onTouchEnd={holdStop} style={sx("width:180px;height:180px;border-radius:90px;border:2px solid var(--color-text);background:var(--color-accent);position:relative;cursor:pointer;display:grid;place-items:center;overflow:hidden")}>
              <div style={sx("position:absolute;left:0;bottom:0;width:100%;height:" + Math.round(s.hold * 100) + "%;background:var(--color-accent-700);transition:height .07s linear")} />
              <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" style={{ position: "relative" }}><path d="M9 11V7a3 3 0 016 0v4" /><rect x="5" y="11" width="14" height="10" /></svg>
            </button>
          </div>
          <div style={sx("height:2px;background:var(--color-divider);margin:8px 0 16px")} />
          <div style={sx("font-size:13px;color:var(--color-neutral-600);letter-spacing:.04em")}>{s.hold > 0 ? "Keep holding… " + Math.round(s.hold * 100) + "%" : "Hold to enter the grown-up area"}</div>
        </div>
        <div style={sx("flex:1;min-width:300px;max-width:480px")}>
          {gateNotes.map((n) => (
            <div key={n.k} style={sx("padding:16px 0;border-bottom:2px solid var(--color-divider)")}>
              <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent-700)")}>{n.k}</div>
              <div style={sx("font-size:15px;line-height:1.55;margin-top:6px")}>{n.v}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={sx("padding-top:32px")}>
      <div style={sx("display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:2px solid var(--color-text);background:#fff")}>
        {stats.map((st, i) => (
          <div key={st.k} style={sx("padding:24px;border-right:" + (i < 3 ? "2px solid var(--color-divider)" : "none"))}>
            <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)")}>{st.k}</div>
            <div style={sx("font-family:var(--font-heading);font-size:44px;line-height:1;margin-top:14px;letter-spacing:-.03em")}>{st.v}</div>
            <div style={sx("font-size:13px;color:var(--color-neutral-700);margin-top:8px")}>{st.sub}</div>
          </div>
        ))}
      </div>

      <div style={sx("display:grid;grid-template-columns:1.4fr 1fr;gap:32px;margin-top:32px;align-items:start")}>
        <div>
          <div style={sx("display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px solid var(--color-divider);padding-bottom:10px")}>
            <h3 style={sx("font-family:var(--font-heading);font-size:20px;margin:0;letter-spacing:-.01em")}>Today's transcript</h3>
            <span style={sx("font-size:12px;color:var(--color-neutral-600)")}>Kept on this device · deleted after 7 days</span>
          </div>
          <table className="table" style={{ width: "100%" }}>
            <thead><tr><th style={{ width: 64 }}>Time</th><th style={{ width: 88 }}>Who</th><th>What was said</th></tr></thead>
            <tbody>
              {transcript.map(([time, who, text], i) => (
                <tr key={i}>
                  <td style={sx("font-variant-numeric:tabular-nums;color:var(--color-neutral-600)")}>{time}</td>
                  <td><span style={sx("display:inline-block;padding:2px 10px;font-size:12px;font-weight:600;background:" + (who === "Anu" ? "var(--color-accent-100);color:var(--color-accent-700)" : "var(--color-neutral-200);color:var(--color-neutral-700)"))}>{who}</span></td>
                  <td>{text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={sx("display:flex;flex-direction:column;gap:0;border:2px solid var(--color-text);background:#fff")}>
          <div style={sx("padding:22px 22px 20px")}>
            <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)")}>Daily limit</div>
            <div style={sx("font-family:var(--font-heading);font-size:32px;margin:10px 0 4px;letter-spacing:-.02em")}>{s.limit + " minutes a day"}</div>
            <input type="range" min="5" max="45" step="5" value={s.limit} onChange={(e) => setState({ limit: +e.target.value })} style={sx("width:100%;accent-color:var(--color-accent);margin-top:10px")} />
            <div style={sx("display:flex;justify-content:space-between;font-size:12px;color:var(--color-neutral-600);margin-top:4px")}><span>5 min</span><span>45 min</span></div>
          </div>
          <div style={sx("height:2px;background:var(--color-divider)")} />
          <div style={sx("padding:22px")}>
            <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:12px")}>Chiku speaks</div>
            <div className="seg">
              <button className={"seg-opt" + (en ? " is-active" : "")} onClick={() => setState({ lang: "en" })}>English</button>
              <button className={"seg-opt" + (en ? "" : " is-active")} onClick={() => setState({ lang: "te" })}>తెలుగు</button>
            </div>
            <div style={sx("font-size:13px;color:var(--color-neutral-700);margin-top:12px;line-height:1.5")}>{en ? "Chiku speaks Indian English and drops in Telugu words as rewards. Switch to Telugu-first at any time — the child screens re-order, they do not translate." : "చికు తెలుగులో మాట్లాడుతాడు; English words come in as rewards."}</div>
          </div>
          <div style={sx("height:2px;background:var(--color-divider)")} />
          <div style={sx("padding:22px;background:var(--color-accent-100)")}>
            <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent-700)")}>Our promises</div>
            <ul style={sx("margin:12px 0 0;padding-left:18px;font-size:14px;line-height:1.7")}>
              <li>No ads. Ever.</li>
              <li>No tracking, no profiles, no third-party analytics.</li>
              <li>Voice is transcribed on-device and never stored without your consent.</li>
              <li>No streaks, badges or notifications to pull your child back.</li>
            </ul>
            <button className="btn btn-secondary" style={{ marginTop: 18 }} onClick={() => setState({ gate: false })}>Lock the grown-up area</button>
          </div>
        </div>
      </div>
    </div>
  );
}
