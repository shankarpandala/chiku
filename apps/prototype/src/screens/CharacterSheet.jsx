import ChikuFace from "../ChikuFace";
import { sx } from "../lib/styleString";
import { CREAM, SAND } from "../data/kidPalette";

const scales = [
  { label: "6 cm · phone", box: "width:56px;height:56px;background:" + CREAM },
  { label: "TV thumb", box: "width:96px;height:96px;background:" + CREAM },
  { label: "48px icon", box: "width:48px;height:48px;background:" + SAND },
  { label: "60 cm · TV", box: "width:200px;height:200px;background:" + CREAM },
];

const emotes = [
  { id: "happy", label: "Happy / celebrate", note: "Eyes arc closed, ears up, blush on. Used for 1.2s only." },
  { id: "listening", label: "Listening / thinking", note: "Lean-in, near ear cupped, ring and bars. The critical state." },
  { id: "encouraging", label: "Encouraging", note: "Trunk lifted, one brow up, small smile. Used for retries." },
  { id: "goodbye", label: "Goodbye wave", note: "Trunk swings out and up; the session-end pose." },
];

const visemes = [
  { id: "closed", label: "closed", note: "rest / silence" },
  { id: "A", label: "A", note: "ah, aa" },
  { id: "E", label: "E", note: "eh, ee" },
  { id: "O", label: "O", note: "oh, au" },
  { id: "U", label: "U / W", note: "oo, w" },
  { id: "F", label: "F / V", note: "labiodental" },
  { id: "L", label: "L", note: "tongue visible" },
  { id: "smile", label: "wide smile", note: "laughter, yay" },
];

const listenCards = [
  { emote: "idle", ring: false, bars: false, label: "Idle — not listening", note: "Ears at rest, no ring, mouth closed. The child's turn has not started." },
  { emote: "listening", ring: true, bars: false, label: "Listening — ring only", note: "Head leans in, near ear cups forward, dashed ring rotates. Works with sound off." },
  { emote: "listening", ring: true, bars: true, label: "Listening — with level", note: "Bars ride the mic input, so the child sees their own voice land." },
];

export default function CharacterSheet() {
  return (
    <div style={sx("padding-top:32px")}>
      <div style={sx("display:grid;grid-template-columns:340px 1fr;gap:40px;align-items:start")}>
        <div style={sx("border:2px solid var(--color-text);background:#fff;padding:24px")}>
          <div style={sx("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)")}>Direction chosen</div>
          <h3 style={sx("font-family:var(--font-heading);font-size:26px;margin:8px 0 14px;letter-spacing:-.02em")}>Elephant calf</h3>
          <div style={sx("height:300px;background:#fdf6ec;display:grid;place-items:center;margin-bottom:16px")}>
            <div style={sx("width:230px;height:290px")}><ChikuFace emote="idle" showBody={true} /></div>
          </div>
          <p style={sx("font-size:14px;line-height:1.6;margin:0;color:var(--color-neutral-700)")}>Two circles and a curl: the ears carry the silhouette, the trunk carries the identity. The trunk sweeps left and clears the mouth entirely, so all eight visemes stay readable at 6 cm.</p>
        </div>
        <div>
          <div style={sx("border-bottom:2px solid var(--color-divider);padding-bottom:10px;margin-bottom:20px")}><h3 style={sx("font-family:var(--font-heading);font-size:20px;margin:0")}>Silhouette &amp; scale test</h3></div>
          <div style={sx("display:flex;align-items:flex-end;gap:40px;flex-wrap:wrap")}>
            {scales.map((s) => (
              <div key={s.label}>
                <div style={sx(s.box)}><ChikuFace crop="head" emote="idle" /></div>
                <div style={sx("font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600);margin-top:10px")}>{s.label}</div>
              </div>
            ))}
          </div>
          <div style={sx("border-bottom:2px solid var(--color-divider);padding-bottom:10px;margin:36px 0 20px")}><h3 style={sx("font-family:var(--font-heading);font-size:20px;margin:0")}>4 emotes</h3></div>
          <div style={sx("display:grid;grid-template-columns:repeat(4,1fr);gap:2px;background:var(--color-divider);border:2px solid var(--color-text)")}>
            {emotes.map((e) => (
              <div key={e.id} style={sx("background:#fdf6ec;padding:18px 14px;text-align:left")}>
                <div style={sx("height:170px")}><ChikuFace emote={e.id} crop="head" /></div>
                <div style={sx("font-family:var(--font-heading);font-size:15px;margin-top:12px")}>{e.label}</div>
                <div style={sx("font-size:12px;color:var(--color-neutral-700);line-height:1.45;margin-top:4px")}>{e.note}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={sx("border-bottom:2px solid var(--color-divider);padding-bottom:10px;margin:44px 0 20px;display:flex;align-items:baseline;justify-content:space-between")}>
        <h3 style={sx("font-family:var(--font-heading);font-size:20px;margin:0")}>8 mouth visemes</h3>
        <span style={sx("font-size:12px;color:var(--color-neutral-600)")}>Discrete, swappable layers — driven by TTS timing marks</span>
      </div>
      <div style={sx("display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:2px;background:var(--color-divider);border:2px solid var(--color-text)")}>
        {visemes.map((v) => (
          <div key={v.id} style={sx("background:#fff;padding:14px 10px")}>
            <div style={sx("height:130px;background:#fdf6ec")}><ChikuFace crop="head" viseme={v.id} /></div>
            <div style={sx("font-family:var(--font-heading);font-size:16px;margin-top:10px")}>{v.label}</div>
            <div style={sx("font-size:11px;color:var(--color-neutral-600)")}>{v.note}</div>
          </div>
        ))}
      </div>

      <div style={sx("border-bottom:2px solid var(--color-divider);padding-bottom:10px;margin:44px 0 20px")}><h3 style={sx("font-family:var(--font-heading);font-size:20px;margin:0")}>The listening state — the one moment that must be unmistakable</h3></div>
      <div style={sx("display:grid;grid-template-columns:repeat(3,1fr);gap:32px")}>
        {listenCards.map((l) => (
          <div key={l.label} style={sx("border:2px solid var(--color-text);background:#fdf6ec")}>
            <div style={sx("height:250px;display:grid;place-items:center;padding:26px")}>
              <div style={sx("width:190px;height:190px")}><ChikuFace crop="head" emote={l.emote} ring={l.ring} bars={l.bars} /></div>
            </div>
            <div style={sx("background:#fff;border-top:2px solid var(--color-text);padding:16px 18px")}>
              <div style={sx("font-family:var(--font-heading);font-size:16px")}>{l.label}</div>
              <div style={sx("font-size:13px;color:var(--color-neutral-700);line-height:1.5;margin-top:5px")}>{l.note}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
