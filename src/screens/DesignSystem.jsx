import { SunMoon } from "../components/SunMoon";
import { sx } from "../lib/styleString";
import { pill } from "../lib/uiHelpers";
import { CREAM, SAND, INK, CHIKU, CHDARK, MARI, TEAL, ROSE } from "../data/kidPalette";

const palette = [
  { name: "Cream", hex: "#FDF6EC", use: "Kid ground. Warm, low-glare, safe under a TV's brightness.", chip: "height:96px;background:" + CREAM },
  { name: "Chiku violet", hex: "#A293C4", use: "The character. Never a UI surface, so Chiku is always the figure.", chip: "height:96px;background:" + CHIKU },
  { name: "Marigold", hex: "#F0A33C", use: "One primary action per screen. Also the D-pad focus ring.", chip: "height:96px;background:" + MARI },
  { name: "Listening teal", hex: "#2F8F86", use: "Reserved: only ever means 'Chiku is hearing you'.", chip: "height:96px;background:" + TEAL },
  { name: "Rose", hex: "#E9848C", use: "Ending and leaving. Warm, not alarming.", chip: "height:96px;background:" + ROSE },
  { name: "Ink", hex: "#2C2A35", use: "Type and the mouth. Shared with the Modernist parent area.", chip: "height:96px;background:" + INK },
];

const components = [
  { num: "01", name: "Episode card", note: "Picture tile, decorative title, 44px play chip. Whole card is the target.", demoStyle: "margin-top:14px;background:" + SAND + ";border-radius:20px;height:70px;display:flex;align-items:center;padding:0 14px;gap:10px;font-family:'Baloo 2';font-weight:700;color:" + INK, demo: "Colours at the Market" },
  { num: "02", name: "Listening indicator", note: "Ring + ear-cup + level bars. Three cues, one colour — never colour alone.", demoStyle: "margin-top:14px;" + pill(TEAL, false), demo: "Listening to you" },
  { num: "03", name: "Checkpoint overlay", note: "Sheet over the video: Chiku, one line, state pill, chips. Four states.", demoStyle: "margin-top:14px;background:" + CREAM + ";border-radius:18px 18px 0 0;height:70px;display:flex;align-items:flex-end;padding:10px 14px;font-family:'Baloo 2';font-weight:700;color:" + CHDARK, demo: "Which one is green?" },
  {
    num: "04", name: "Answer chips", note: "Picture-first fallback for mishears. Dimmed while Chiku talks, teal-bordered on retry.", demoStyle: "margin-top:14px;display:flex;gap:8px",
    demo: ["#dcecd2", "#fbe6c6", "#d8e6ef"].map((c, i) => (
      <div key={i} style={{ flex: 1, height: 60, borderRadius: 16, background: c, border: i === 0 ? "3px solid " + TEAL : "3px solid transparent" }} />
    )),
  },
  {
    num: "05", name: "Grown-up gate", note: "Two-second press-and-hold, fill from the bottom. No PIN.", demoStyle: "margin-top:14px;display:flex;align-items:center;gap:12px",
    demo: <div style={{ width: 60, height: 60, borderRadius: 30, border: "2px solid " + INK, background: "linear-gradient(to top, var(--color-accent-700) 42%, var(--color-accent) 42%)" }} />,
  },
  { num: "06", name: "Sun-to-moon timer", note: "Session length as a sky, not a countdown. Parent sets the arc.", demoStyle: "margin-top:14px", demo: <SunMoon t={0.55} w={200} /> },
  { num: "07", name: "Pairing card", note: "QR + one instruction, docked in a TV corner for the whole session.", demoStyle: "margin-top:14px;border:3px solid " + INK + ";height:70px;display:flex;align-items:center;gap:10px;padding:8px 12px;font-family:'Baloo 2';font-weight:700;font-size:14px", demo: "Scan with a grown-up's phone" },
  { num: "08", name: "Celebrate moment", note: "1.2s of confetti and a happy emote, then straight back to the story. No score.", demoStyle: "margin-top:14px;background:" + CREAM + ";border-radius:18px;height:70px;display:flex;align-items:center;justify-content:center;font-family:'Baloo 2';font-weight:700;color:" + TEAL, demo: "పచ్చ · pach-cha · green" },
];

export default function DesignSystem() {
  return (
    <div style={sx("padding-top:32px")}>
      <div style={sx("display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:2px;background:var(--color-divider);border:2px solid var(--color-text)")}>
        {palette.map((p) => (
          <div key={p.name} style={sx("background:#fff")}>
            <div style={sx(p.chip)} />
            <div style={sx("padding:14px")}>
              <div style={sx("font-family:var(--font-heading);font-size:15px")}>{p.name}</div>
              <div style={sx("font-size:12px;color:var(--color-neutral-600);font-variant-numeric:tabular-nums")}>{p.hex}</div>
              <div style={sx("font-size:12px;color:var(--color-neutral-700);line-height:1.45;margin-top:6px")}>{p.use}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:40px")}>
        <div style={sx("border:2px solid var(--color-text);background:#fff;padding:26px")}>
          <div style={sx("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)")}>Type pairing — kid screens</div>
          <div style={sx("font-family:'Baloo 2';font-size:44px;font-weight:800;line-height:1.05;margin-top:14px;color:#2c2a35")}>Which one is green?</div>
          <div style={sx("font-family:'Baloo Tammudu 2',serif;font-size:32px;color:#7d6da3;line-height:1.3;margin-top:8px")}>పచ్చగా ఉన్నది ఏది?</div>
          <div style={sx("height:2px;background:var(--color-divider);margin:20px 0")} />
          <div style={sx("font-size:14px;line-height:1.6;color:var(--color-neutral-700)")}>Baloo 2 with Baloo Tammudu 2 — one superfamily, so the Latin and Telugu share weight, roundness and x-height. Kid copy is spoken aloud and never load-bearing; it sits at 17px minimum on phone, 24px on TV.</div>
        </div>
        <div style={sx("border:2px solid var(--color-text);background:#fff;padding:26px")}>
          <div style={sx("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)")}>Type — grown-up screens</div>
          <div style={sx("font-family:var(--font-heading);font-size:44px;font-weight:700;line-height:1.05;margin-top:14px;letter-spacing:-.03em")}>Anu said 27 words</div>
          <div style={sx("font-family:var(--font-body);font-size:16px;color:var(--color-neutral-700);margin-top:10px")}>Archivo, flush left, on the Modernist grid.</div>
          <div style={sx("height:2px;background:var(--color-divider);margin:20px 0")} />
          <div style={sx("font-size:14px;line-height:1.6;color:var(--color-neutral-700)")}>The parent area keeps Modernist intact: zero radius, 2px rules, red used only for the primary action. The switch in typeface and corner radius is itself the signal that this room belongs to the grown-up.</div>
        </div>
      </div>

      <div style={sx("border-bottom:2px solid var(--color-divider);padding-bottom:10px;margin:44px 0 0")}><h3 style={sx("font-family:var(--font-heading);font-size:20px;margin:0")}>Eight components</h3></div>
      <div style={sx("display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:2px;background:var(--color-divider);border:2px solid var(--color-text);border-top:none")}>
        {components.map((c) => (
          <div key={c.num} style={sx("background:#fff;padding:22px")}>
            <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)")}>{c.num}</div>
            <div style={sx("font-family:var(--font-heading);font-size:17px;margin-top:6px")}>{c.name}</div>
            <div style={sx("font-size:13px;color:var(--color-neutral-700);line-height:1.5;margin-top:6px;min-height:56px")}>{c.note}</div>
            <div style={sx(c.demoStyle)}>{c.demo}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
