import ChikuFace from "../ChikuFace";
import { Notes } from "../components/Notes";
import { StateIcon } from "../components/StateIcon";
import { SunMoon } from "../components/SunMoon";
import { sx } from "../lib/styleString";
import { pill, stepBtn } from "../lib/uiHelpers";
import { CHDARK, MARI, TEAL } from "../data/kidPalette";

const callNotes = [
  { k: "Time as sky, not clock", v: "The sun rises and sets across the session. A child reads 'nearly night' without numbers; the parent set the length in the dashboard." },
  { k: "Two states, two shapes", v: "Listening is an ear glyph in a teal pill with a rotating ring. Speaking is a waveform glyph in a violet pill with a moving mouth. Icon, motion and colour all differ." },
  { k: "Ending is a wave", v: "The end button is a waving-hands glyph, and Chiku's last line points outward: 'Go show Amma your drawing!' No 'stay a bit longer', no next call teaser." },
  { k: "Bounded by design", v: "One call a day, capped by the parent limit. When the moon lands, Chiku says goodbye — the child cannot restart it." },
];

export default function CallChiku({ s, setState, en, chikuBob, go }) {
  const callMap = {
    listening: { emote: "listening", label: "Listening to you", pill: TEAL, line: en ? "I'm listening!" : "వింటున్నాను!" },
    speaking: { emote: "encouraging", label: "Chiku is talking", pill: CHDARK, line: en ? "I painted a cow today. Blue!" : "ఇవాళ ఆవును గీశాను. నీలం!" },
    bye: { emote: "goodbye", label: "Time to go", pill: MARI, line: en ? "Go show Amma your drawing!" : "అమ్మకి బొమ్మ చూపించు!" },
  }[s.call];

  const callSteps = [["listening", "Listening"], ["speaking", "Chiku speaking"], ["bye", "Goodbye"]];

  return (
    <div style={sx("padding-top:24px")}>
      <div style={sx("display:flex;gap:10px;align-items:center;padding-bottom:24px")}>
        <span style={sx("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);margin-right:6px")}>Call state</span>
        {callSteps.map(([id, label]) => (
          <button key={id} onClick={() => setState({ call: id })} style={sx(stepBtn(s.call === id))}>{label}</button>
        ))}
      </div>
      <div style={sx("display:flex;gap:40px;flex-wrap:wrap")}>
        <div className="kid" style={sx("width:390px;flex:0 0 390px;height:800px;border:2px solid var(--color-text);background:#fdf6ec;overflow:hidden;position:relative;font-family:'Baloo 2',system-ui")}>
          <div style={sx("position:absolute;inset:0;background:radial-gradient(120% 70% at 50% 22%, #f5e7d0 0%, #fdf6ec 60%)")} />
          <div style={sx("position:absolute;top:18px;left:20px;right:20px;display:flex;align-items:center;justify-content:space-between")}>
            <div style={sx(pill(callMap.pill, false))}>
              <StateIcon kind={callMap.pill === TEAL ? TEAL : "x"} size={20} />
              <span style={sx("font-size:15px;font-weight:700")}>{callMap.label}</span>
            </div>
            <SunMoon t={0.42} w={168} />
          </div>
          <button onClick={() => setState({ call: s.call === "listening" ? "speaking" : "listening" })} style={sx("position:absolute;left:0;right:0;top:110px;bottom:190px;border:none;background:transparent;cursor:pointer;display:grid;place-items:center")}>
            <div style={sx("width:330px;height:440px;" + chikuBob)}>
              <ChikuFace emote={callMap.emote} viseme={s.call === "speaking" ? s.viseme : "closed"} showBody={true} ring={s.call === "listening"} />
            </div>
          </button>
          <div style={sx("position:absolute;left:20px;right:20px;bottom:26px;display:flex;flex-direction:column;align-items:center;gap:16px")}>
            <div style={sx("font-size:20px;font-weight:700;color:#7d6da3;text-align:center;line-height:1.25")}>{callMap.line}</div>
            <button onClick={go("home")} className="hov-end" style={sx("width:112px;height:112px;border-radius:56px;border:none;background:#e9848c;display:grid;place-items:center;cursor:pointer;box-shadow:0 5px 0 #c96a72")}>
              <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="#fdf6ec" strokeWidth="2.2" strokeLinecap="round"><path d="M8 11c0-4 8-4 8 0M4 15l3-1 1-3M20 15l-3-1-1-3M3 19h18" /></svg>
            </button>
            <div style={sx("font-size:14px;color:#a293c4")}>Wave goodbye · టాటా చెప్పు</div>
          </div>
        </div>
        <div style={sx("flex:1;min-width:300px;max-width:540px")}>
          <Notes items={callNotes} />
        </div>
      </div>
    </div>
  );
}
