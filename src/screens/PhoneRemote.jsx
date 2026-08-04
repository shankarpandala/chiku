import ChikuFace from "../ChikuFace";
import { Notes } from "../components/Notes";
import { Icon } from "../components/Icon";
import { sx } from "../lib/styleString";
import { makeChips } from "../data/chips";
import { CREAM, INK, CHDARK, TEAL } from "../data/kidPalette";

const remoteNotes = [
  { k: "One giant target", v: "290px push-to-talk, held rather than toggled, so a three-year-old's grip maps to 'my turn'. Releasing ends the turn — no stop button to find." },
  { k: "Mishear fallback", v: "Picture chips sit directly under the mic. Two failed attempts and Chiku switches to 'point to it' without ever saying the child was wrong." },
  { k: "Colour-safe", v: "Talking is a filled circle with an ear glyph, an outer pulse ring and live bars. Idle is an outlined circle with a mic glyph and flat bars." },
  { k: "Grown-up strip", v: "Docked at the bottom in Archivo, small and square-cornered — deliberately in the parent's visual language so a child skims past it." },
];

const remoteControls = [
  { label: "Pause", paths: ["M9 5v14", "M15 5v14"] },
  { label: "End", paths: ["M5 5l14 14", "M19 5L5 19"] },
  { label: "Volume", paths: ["M4 10v4h3l4 4V6L7 10H4", "M16 9a4 4 0 010 6"] },
];

export default function PhoneRemote({ s, setState, en }) {
  const talking = s.talking;
  const chips = makeChips(s, setState, en);
  const talkOn = () => setState({ talking: true });
  const talkOff = () => setState({ talking: false });

  const pttStyle = "position:relative;width:290px;height:290px;border-radius:145px;border:none;background:" + (talking ? TEAL : CREAM) + ";box-shadow:0 6px 0 " + (talking ? "#25736c" : "#e7dcc8") + ",inset 0 0 0 6px " + (talking ? "#25736c" : "#efe4d0") + ";display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer";
  const pttRing = talking ? "position:absolute;inset:-18px;border-radius:163px;border:6px solid " + TEAL + ";animation:chPulse 1.6s ease-in-out infinite" : "display:none";
  const pttBars = [0, 1, 2, 3, 4, 5, 6].map((i) =>
    "width:11px;height:100%;border-radius:6px;background:" + (talking ? TEAL : "#e7dcc8") + ";transform-origin:bottom;animation:" + (talking ? "chBarUp .85s ease-in-out " + i * 0.1 + "s infinite" : "none") + ";transform:" + (talking ? "none" : "scaleY(.3)")
  );

  return (
    <div style={sx("display:flex;gap:40px;padding-top:32px;flex-wrap:wrap")}>
      <div className="kid" style={sx("width:390px;flex:0 0 390px;height:800px;border:2px solid var(--color-text);background:#fdf6ec;overflow:hidden;position:relative;font-family:'Baloo 2',system-ui")}>
        <div style={sx("padding:20px 20px 0;display:flex;align-items:center;gap:10px")}>
          <div style={sx("width:44px;height:44px")}><ChikuFace crop="head" emote="idle" /></div>
          <div style={sx("font-size:15px;color:#7d6da3;font-family:var(--font-body)")}>Paired with <strong>Living room TV</strong></div>
          <div style={sx("margin-left:auto;width:12px;height:12px;border-radius:6px;background:#2f8f86")} />
        </div>

        <div style={sx("padding:26px 20px 0;display:grid;place-items:center")}>
          <button onMouseDown={talkOn} onMouseUp={talkOff} onMouseLeave={talkOff} onTouchStart={talkOn} onTouchEnd={talkOff} style={sx(pttStyle)}>
            <div style={sx(pttRing)} />
            {talking
              ? <Icon paths={["M6 18a8 8 0 010-12", "M11 15a4 4 0 010-6", "M15 4c4 3 4 13 0 16"]} color={CREAM} size={96} />
              : <Icon paths={["M12 3.5a3.4 3.4 0 013.4 3.4v4.8a3.4 3.4 0 01-6.8 0V6.9A3.4 3.4 0 0112 3.5z", "M5.8 11.2a6.2 6.2 0 0012.4 0", "M12 17.4V21", "M8.6 21h6.8"]} color={CHDARK} size={96} />}
            <div style={{ ...sx("font-size:22px;font-weight:800;margin-top:10px"), color: talking ? CREAM : CHDARK }}>
              {talking ? (en ? "Chiku hears you" : "చికు వింటున్నాడు") : (en ? "Hold to talk" : "నొక్కి మాట్లాడు")}
            </div>
          </button>
          <div style={sx("height:34px;display:flex;align-items:flex-end;gap:7px;margin-top:18px")}>
            {pttBars.map((b, i) => <div key={i} style={sx(b)} />)}
          </div>
        </div>

        <div style={sx("padding:22px 20px 0")}>
          <div style={sx("font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a293c4;font-family:var(--font-body);margin-bottom:10px")}>Or tap the answer</div>
          <div style={sx("display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px")}>
            {chips.map((ch) => (
              <button key={ch.label} onClick={ch.pick} className="hov-chip" style={sx(ch.remoteStyle)}>
                <div style={{ ...sx("width:100%;height:64px;border-radius:18px;display:grid;place-items:center"), background: ch.bg }}>
                  <div style={sx(ch.shape)} />
                </div>
                <div style={sx("font-size:15px;font-weight:700;color:#2c2a35;margin-top:6px")}>{ch.label}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={sx("position:absolute;left:0;right:0;bottom:0;border-top:2px solid #e7dcc8;background:#fff;padding:16px 20px 22px;font-family:var(--font-body)")}>
          <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a293c4;margin-bottom:10px")}>Grown-up controls</div>
          <div style={sx("display:flex;gap:10px")}>
            {remoteControls.map((rc) => (
              <button key={rc.label} className="hov-rc" style={sx("flex:1;height:64px;border:2px solid #efe4d0;background:#fdf6ec;border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer")}>
                <Icon paths={rc.paths} color={INK} size={20} />
                <span style={sx("font-size:13px;font-weight:600;color:#2c2a35")}>{rc.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div style={sx("flex:1;min-width:300px;max-width:540px")}>
        <Notes items={remoteNotes} />
      </div>
    </div>
  );
}
