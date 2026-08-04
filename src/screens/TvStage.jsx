import ChikuFace from "../ChikuFace";
import { StateIcon } from "../components/StateIcon";
import { SunMoon } from "../components/SunMoon";
import { sx } from "../lib/styleString";
import { pill, stepBtn } from "../lib/uiHelpers";
import { makeChips } from "../data/chips";
import { INK, TEAL } from "../data/kidPalette";
import { QRBITS } from "../data/kidPalette";

const tvNotes = [
  { k: "Type floor", v: "24px minimum, 44px for anything a child acts on. Chiku's head is 200px so the listening ring is legible from three metres." },
  { k: "Focus is not colour", v: "The D-pad focus ring is a 6px marigold outline plus a 1.04× scale bump, so it survives colour-blindness and washed-out TV panels." },
  { k: "Pairing, not casting", v: "The QR card lives in the corner all session. Scanning it makes the phone the microphone and the remote — the TV never listens on its own." },
];

export default function TvStage({ s, setState, en, chikuBob }) {
  const chips = makeChips(s, setState, en);
  const tvSteps = [["player", "Player on TV"], ["call", "Call on TV"]];
  const statePillStyleTv = pill(TEAL, true);

  return (
    <div style={sx("padding-top:24px")}>
      <div style={sx("display:flex;gap:10px;align-items:center;padding-bottom:24px")}>
        <span style={sx("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);margin-right:6px")}>TV mode</span>
        {tvSteps.map(([id, label]) => (
          <button key={id} onClick={() => setState({ tv: id })} style={sx(stepBtn(s.tv === id))}>{label}</button>
        ))}
      </div>

      <div style={sx("width:100%;max-width:1180px;container-type:inline-size")}>
        <div className="kid" style={sx("width:100%;aspect-ratio:16/9;border:2px solid var(--color-text);background:#231f2e;position:relative;overflow:hidden;font-family:'Baloo 2',system-ui;font-size:1.25cqw")}>
          {s.tv === "player" && (
            <div style={sx("position:absolute;inset:0;display:grid;grid-template-columns:1.1fr .9fr")}>
              <div style={sx("background:#4a5c3f;display:grid;place-items:center;color:#cbd8c0;font-size:1em;letter-spacing:.12em;text-transform:uppercase")}>Episode video</div>
              <div style={sx("background:#fdf6ec;display:flex;flex-direction:column;padding:2.75em 2.75em 2.75em")}>
                <div style={sx("display:flex;align-items:center;gap:1.4em")}>
                  <div style={sx("width:12.5em;height:12.5em;flex:0 0 12.5em")}><ChikuFace emote="listening" crop="head" /></div>
                  <div>
                    <div style={sx(statePillStyleTv)}><span style={sx("width:1.9em;height:1.9em;display:grid")}><StateIcon kind={TEAL} size="100%" /></span><span style={sx("font-size:1.5em;font-weight:700")}>Listening</span></div>
                    <div style={sx("font-size:2.75em;font-weight:800;color:#2c2a35;line-height:1.1;margin-top:.36em")}>Which one is green?</div>
                    <div style={sx("font-family:'Baloo Tammudu 2',serif;font-size:1.625em;color:#7d6da3;margin-top:.2em")}>పచ్చగా ఉన్నది ఏది?</div>
                  </div>
                </div>
                <div style={sx("display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.375em;margin-top:auto")}>
                  {chips.map((ch) => (
                    <div key={ch.label} style={sx(ch.tvStyle)}>
                      <div style={{ ...sx("width:100%;height:6.5em;border-radius:1.375em;display:grid;place-items:center"), background: ch.bg }}>
                        <div style={sx(ch.shapeTv)} />
                      </div>
                      <div style={sx("font-size:1.625em;font-weight:700;color:#2c2a35;margin-top:.38em")}>{ch.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {s.tv === "call" && (
            <div style={sx("position:absolute;inset:0;background:radial-gradient(90% 80% at 50% 30%,#f5e7d0,#fdf6ec);display:grid;place-items:center")}>
              <div style={sx("display:flex;align-items:center;gap:3.5em;padding:0 2em 1.5em 7em")}>
                <div style={sx("width:24em;height:32em;" + chikuBob)}><ChikuFace emote="listening" showBody={true} /></div>
                <div>
                  <div style={sx(statePillStyleTv)}><span style={sx("width:1.9em;height:1.9em;display:grid")}><StateIcon kind={TEAL} size="100%" /></span><span style={sx("font-size:1.625em;font-weight:700")}>Listening</span></div>
                  <div style={sx("font-size:3.4em;font-weight:800;color:#2c2a35;line-height:1.05;margin-top:.35em;max-width:13ch")}>Tell me one thing you did today!</div>
                  <div style={sx("font-family:'Baloo Tammudu 2',serif;font-size:1.875em;color:#7d6da3;margin-top:.4em")}>ఇవాళ ఏం చేశావో చెప్పు!</div>
                </div>
              </div>
            </div>
          )}

          <div style={sx("position:absolute;top:2em;left:2em;display:flex;align-items:center;gap:.875em")}>
            <div style={sx("width:3.5em;height:3.5em")}><ChikuFace crop="head" emote="idle" /></div>
            <div style={sx("color:#fdf6ec;font-size:1.5em;font-weight:800;text-shadow:0 .12em .5em rgba(0,0,0,.35)")}>Chiku</div>
          </div>
          <div style={sx("position:absolute;top:2em;right:2em;width:16em")}><SunMoon t={0.42} w={260} cssW="100%" /></div>

          <div style={sx("position:absolute;bottom:2em;left:2em;width:17.5em;background:#fdf6ec;border:.25em solid #2c2a35;padding:1.1em;display:flex;gap:1em;align-items:center")}>
            <div style={sx("width:6em;height:6em;flex:0 0 6em;display:grid;grid-template-columns:repeat(9,1fr);grid-template-rows:repeat(9,1fr);gap:.06em")}>
              {QRBITS.split("").map((b, i) => (
                <div key={i} style={{ background: b === "1" ? INK : "transparent" }} />
              ))}
            </div>
            <div>
              <div style={sx("font-size:1.2em;font-weight:800;color:#2c2a35;line-height:1.15")}>Scan with a grown-up's phone</div>
              <div style={sx("font-family:var(--font-body);font-size:.75em;color:#7d6da3;margin-top:.5em;line-height:1.4")}>Turns the phone into Chiku's ears + remote</div>
            </div>
          </div>

          <div style={sx("position:absolute;top:6.5em;left:2em;max-width:19em;display:flex;align-items:center;gap:.75em;background:#231f2ecc;padding:.75em 1.1em;color:#fdf6ec")}>
            <svg width="1.6em" height="1.6em" viewBox="0 0 24 24" fill="none" stroke="#f0a33c" strokeWidth="2.4" strokeLinecap="round" style={{ flex: "0 0 auto" }}><path d="M12 4v6M12 14v6M4 12h6M14 12h6" /></svg>
            <span style={sx("font-size:.94em;font-family:var(--font-body);letter-spacing:.04em;line-height:1.4")}>D-pad focus ring: marigold outline + 1.04× scale — never colour alone</span>
          </div>
        </div>
      </div>

      <div style={sx("display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 32px;margin-top:32px")}>
        {tvNotes.map((n) => (
          <div key={n.k} style={sx("padding:16px 0;border-top:2px solid var(--color-divider)")}>
            <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent-700)")}>{n.k}</div>
            <div style={sx("font-size:15px;line-height:1.55;margin-top:6px")}>{n.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
