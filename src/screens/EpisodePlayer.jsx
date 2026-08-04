import ChikuFace from "../ChikuFace";
import { Notes } from "../components/Notes";
import { StateIcon } from "../components/StateIcon";
import { SunMoon } from "../components/SunMoon";
import { sx } from "../lib/styleString";
import { pill, stepBtn } from "../lib/uiHelpers";
import { makeChips } from "../data/chips";
import { CHDARK, MARI, TEAL, ROSE, LEAF, CHIKU } from "../data/kidPalette";

const cpNotes = [
  { k: "State 1 — Chiku asks", v: "Mouth runs the viseme set off TTS timing marks; ears at rest, no ring. The answer chips are dimmed to 55% so nothing is tappable while Chiku is still talking." },
  { k: "State 2 — Listening", v: "Three simultaneous cues, only one of them colour: the head leans in and the near ear cups forward, a dashed ring rotates around the head, and six bars ride the input level. On a greyscale screen it still reads." },
  { k: "State 3 — Answered", v: "Celebrate is 1.2 seconds of confetti and a happy emote, then the episode resumes. The word the child earned is shown in Telugu and Latin — no points, no badge." },
  { k: "State 4 — Gentle retry", v: "Never 'wrong'. Chiku models the word slowly and the picture chips gain a teal border, so a mishear is always escapable by tapping." },
  { k: "Mic permission", v: "Framed as turning on Chiku's ears, held behind one grown-up tap, with the plain-language promise directly under the button." },
];

export default function EpisodePlayer({ s, setState, en, calm, still, chikuBob, go }) {
  const speakingPlayer = s.cp === "ask" || s.cp === "answered" || s.cp === "retry";
  const cpMap = {
    ask: { emote: "encouraging", label: "Chiku is talking", line: en ? "Which one is green?" : "పచ్చగా ఉన్నది ఏది?", te: en ? "పచ్చగా ఉన్నది ఏది?" : "Which one is green?", pill: CHDARK, hint: "Chiku is still speaking" },
    listen: { emote: "listening", label: "Listening to you", line: "…", te: "నీ మాట వింటున్నాను", pill: TEAL, hint: "Say it, or tap a picture" },
    answered: { emote: "happy", label: "Chiku heard you", line: en ? "Yes! The leaf is green." : "అవును! ఆకు పచ్చగా ఉంది.", te: en ? "అవును! ఆకు పచ్చ!" : "Yes! The leaf is green.", pill: MARI, hint: "Tap a picture to say more" },
    retry: { emote: "encouraging", label: "Let's try together", line: en ? "Let's say it together — pach-cha!" : "కలిసి చెప్పుదాం — పచ్చ!", te: en ? "కలిసి చెప్పుదాం!" : "Let's say it together!", pill: CHDARK, hint: "Or tap the green one" },
  }[s.cp] || {};

  const chips = makeChips(s, setState, en);
  const cpSteps = [["ask", "1 · Chiku asks"], ["listen", "2 · Listening"], ["answered", "3 · Child answered"], ["retry", "4 · Gentle retry"], ["mic", "0 · Mic permission"]];
  const confetti = (calm || still ? [] : [0, 1, 2, 3, 4, 5, 6, 7]).map((i) =>
    "position:absolute;left:" + (8 + i * 12) + "%;bottom:0;width:" + (7 + (i % 3) * 3) + "px;height:" + (7 + (i % 2) * 5) + "px;border-radius:" + (i % 2 ? "50%" : "2px") + ";background:" + [MARI, TEAL, ROSE, LEAF, CHIKU][i % 5] + ";animation:chConfetti " + (1.5 + (i % 4) * 0.35) + "s ease-out " + (i * 0.14) + "s infinite"
  );

  return (
    <div style={sx("padding-top:24px")}>
      <div style={sx("display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-bottom:24px")}>
        <span style={sx("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);margin-right:6px")}>Checkpoint state</span>
        {cpSteps.map(([id, label]) => (
          <button key={id} onClick={() => setState({ cp: id })} style={sx(stepBtn(s.cp === id))}>{label}</button>
        ))}
      </div>

      <div style={sx("display:flex;gap:40px;flex-wrap:wrap")}>
        <div className="kid" style={sx("width:390px;flex:0 0 390px;height:800px;border:2px solid var(--color-text);background:#2c2a35;overflow:hidden;position:relative;font-family:'Baloo 2',system-ui")}>
          <div style={sx("position:absolute;inset:0;background:linear-gradient(#6aa84f22,#2c2a35),#3b3746")} />
          <div style={sx("position:absolute;top:0;left:0;right:0;height:56%;background:#4a5c3f;display:grid;place-items:center")}>
            <div style={sx("text-align:center;color:#cbd8c0;font-size:13px;letter-spacing:.1em;text-transform:uppercase")}>Episode video<br /><span style={sx("opacity:.7;text-transform:none;letter-spacing:0")}>Colours at the Market</span></div>
          </div>

          <div style={sx("position:absolute;top:16px;left:16px;right:16px;display:flex;align-items:center;gap:12px")}>
            <button onClick={go("home")} className="hov-back" style={sx("width:64px;height:64px;border-radius:32px;border:none;background:#fdf6ecdd;display:grid;place-items:center;cursor:pointer")}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#2c2a35" strokeWidth="2.6" strokeLinecap="round"><path d="M4 12h16M4 12l6-6M4 12l6 6" /></svg>
            </button>
            <div style={{ marginLeft: "auto" }}><SunMoon t={0.42} w={168} /></div>
          </div>

          {s.cp === "mic" && (
            <div style={sx("position:absolute;inset:0;background:#2c2a35e8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:32px;text-align:center")}>
              <div style={sx("width:150px;height:150px;border-radius:75px;background:#2f8f86;display:grid;place-items:center;position:relative")}>
                <div style={sx("position:absolute;inset:-14px;border-radius:89px;border:5px solid #2f8f86;animation:chPulse 1.8s ease-in-out infinite")} />
                <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="#fdf6ec" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.5a3.4 3.4 0 013.4 3.4v4.8a3.4 3.4 0 01-6.8 0V6.9A3.4 3.4 0 0112 3.5z" /><path d="M5.8 11.2a6.2 6.2 0 0012.4 0" /><path d="M12 17.4V21M8.6 21h6.8" /></svg>
              </div>
              <div style={sx("color:#fdf6ec;font-size:26px;font-weight:700;line-height:1.2")}>Chiku wants to hear you!</div>
              <div style={sx("font-family:'Baloo Tammudu 2',serif;color:#cdc3e4;font-size:17px")}>చికు మీ మాట వినాలనుకుంటున్నాడు</div>
              <button onClick={() => setState({ cp: "ask" })} style={sx("height:88px;padding:0 40px;border:none;border-radius:26px;background:#f0a33c;font-family:'Baloo 2';font-size:24px;font-weight:800;color:#2c2a35;cursor:pointer;box-shadow:0 5px 0 #d1832a")}>Turn on the ears</button>
              <div style={sx("color:#a293c4;font-size:13px;font-family:var(--font-body)")}>A grown-up taps this once. Nothing is recorded or stored.</div>
            </div>
          )}

          {s.cp !== "mic" && (
            <div style={sx("position:absolute;left:0;right:0;bottom:0;top:46%;background:#fdf6ec;border-radius:36px 36px 0 0;padding:20px;display:flex;flex-direction:column")}>
              <div style={sx("display:flex;gap:16px;align-items:flex-start")}>
                <div style={sx("width:132px;height:132px;flex:0 0 132px;position:relative;" + chikuBob)}>
                  <ChikuFace emote={cpMap.emote} viseme={speakingPlayer ? s.viseme : "closed"} ring={s.cp === "listen"} bars={false} crop="head" />
                </div>
                <div style={sx("padding-top:6px")}>
                  <div style={sx(pill(cpMap.pill || CHDARK, false))}>
                    <StateIcon kind={cpMap.pill === TEAL ? TEAL : "x"} size={20} />
                    <span style={sx("font-size:15px;font-weight:700;letter-spacing:.02em")}>{cpMap.label}</span>
                  </div>
                  <div style={sx("font-size:23px;font-weight:700;color:#2c2a35;line-height:1.2;margin-top:12px")}>{cpMap.line}</div>
                  <div style={sx("font-family:'Baloo Tammudu 2',serif;font-size:16px;color:#7d6da3;line-height:1.35;margin-top:3px")}>{cpMap.te}</div>
                </div>
              </div>

              {s.cp === "listen" && (
                <div style={sx("display:flex;align-items:flex-end;gap:9px;height:56px;justify-content:center;margin:18px 0 4px")}>
                  {[0, 0.12, 0.24, 0.36, 0.48, 0.6].map((d) => (
                    <div key={d} style={sx("width:12px;height:100%;border-radius:6px;background:#2f8f86;animation:chBarUp .9s ease-in-out " + d + "s infinite")} />
                  ))}
                </div>
              )}

              {s.cp === "answered" && (
                <div style={sx("position:relative;height:56px;margin:14px 0 0")}>
                  {confetti.map((c, i) => <div key={i} style={sx(c)} />)}
                  <div style={sx("position:absolute;inset:0;display:grid;place-items:center;font-size:19px;font-weight:700;color:#2f8f86")}>{en ? "పచ్చ · pach-cha · green" : "pach-cha · green"}</div>
                </div>
              )}

              <div style={{ marginTop: "auto" }}>
                <div style={sx("font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a293c4;font-family:var(--font-body);margin-bottom:8px")}>{cpMap.hint}</div>
                <div style={sx("display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px")}>
                  {chips.map((ch) => (
                    <button key={ch.label} onClick={ch.pick} className="hov-chip" style={sx(ch.style)}>
                      <div style={{ ...sx("width:100%;height:64px;border-radius:18px;display:grid;place-items:center"), background: ch.bg }}>
                        <div style={sx(ch.shape)} />
                      </div>
                      <div style={sx("font-size:15px;font-weight:700;color:#2c2a35;margin-top:6px")}>{ch.label}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={sx("flex:1;min-width:300px;max-width:540px")}>
          <Notes items={cpNotes} />
        </div>
      </div>
    </div>
  );
}
