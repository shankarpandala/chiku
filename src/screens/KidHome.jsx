import ChikuFace from "../ChikuFace";
import { Notes } from "../components/Notes";
import { sx } from "../lib/styleString";
import { SAND, CHDARK, MARI, TEAL, ROSE, LEAF, CHIKU, CREAM } from "../data/kidPalette";

const cardStyle = "position:relative;border:none;background:#fff;border-radius:26px;padding:12px;cursor:pointer;text-align:left;transition:transform .18s;box-shadow:0 3px 0 rgba(44,42,53,.12)";

const episodes = [
  ["Colours at the Market", "సంతలో రంగులు", SAND, "width:44px;height:44px;border-radius:22px;background:" + MARI, "position:absolute;right:16px;bottom:14px;width:52px;height:34px;border-radius:26px 26px 6px 6px;background:" + LEAF],
  ["Counting with Thatha", "తాతతో లెక్కలు", "#e4ecdd", "width:56px;height:56px;border-radius:28px;background:" + LEAF, "position:absolute;left:14px;bottom:14px;width:64px;height:10px;border-radius:5px;background:" + CHDARK],
  ["Where Does Rain Go?", "వాన ఎక్కడికి పోతుంది?", "#dbe7ef", "width:64px;height:32px;border-radius:32px 32px 0 0;background:#6f9fc4", "position:absolute;right:22px;bottom:12px;width:14px;height:30px;border-radius:7px;background:" + TEAL],
  ["Amma's Kitchen Sounds", "అమ్మ వంటగది శబ్దాలు", "#f6ded9", "width:52px;height:52px;border-radius:26px;background:" + ROSE, "position:absolute;left:20px;top:14px;width:12px;height:44px;border-radius:6px;background:" + CREAM],
  ["The Slow Little Snail", "నెమ్మది నత్త", "#e8e2f2", "width:54px;height:54px;border-radius:27px;border:12px solid " + CHIKU + ";box-sizing:border-box", "position:absolute;left:18px;bottom:16px;width:42px;height:12px;border-radius:6px;background:" + CHDARK],
].map(([title, te, bg, motif, motif2]) => ({ title, te, bg, motif, motif2 }));

const homeNotes = [
  { k: "No reading required", v: "Titles are decorative — a child navigates by picture and by Chiku's voice reading the row aloud on focus. Removing all five labels would not break the screen." },
  { k: "One primary action", v: "Call Chiku is the only full-width element and the only one with a drop shadow, so it wins at a glance on phone and across a room." },
  { k: "No autoplay, no next-up", v: "Finishing an episode returns here. There is no queue, no recommendation rail and no reason to keep scrolling." },
  { k: "Grown-ups, top right", v: "A person glyph, not a gear, and it opens the press-and-hold gate — visible trust, out of a child's path." },
];

export default function KidHome({ go }) {
  return (
    <div style={sx("display:flex;gap:40px;padding-top:32px;flex-wrap:wrap")}>
      <div className="kid" style={sx("width:390px;flex:0 0 390px;height:800px;border:2px solid var(--color-text);background:#fdf6ec;overflow:hidden;position:relative;font-family:'Baloo 2',system-ui")}>
        <div style={sx("display:flex;align-items:center;justify-content:space-between;padding:18px 20px 6px")}>
          <div style={sx("display:flex;align-items:center;gap:10px")}>
            <div style={sx("width:56px;height:56px")}><ChikuFace crop="head" emote="idle" /></div>
            <div>
              <div style={sx("font-size:26px;font-weight:800;color:#7d6da3;line-height:1")}>Chiku</div>
              <div style={sx("font-family:'Baloo Tammudu 2',serif;font-size:15px;color:#a293c4;line-height:1.1")}>చికు</div>
            </div>
          </div>
          <button onClick={go("parent")} title="Grown-ups" className="hov-parent" style={sx("width:64px;height:64px;border-radius:32px;border:none;background:#f5e7d0;display:grid;place-items:center;cursor:pointer")}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#7d6da3" strokeWidth="2.2" strokeLinecap="round"><path d="M12 2a5 5 0 100 10 5 5 0 000-10" /><path d="M3 22c0-4.4 4-8 9-8s9 3.6 9 8" /></svg>
          </button>
        </div>

        <div style={sx("padding:8px 20px 0;display:grid;grid-template-columns:1fr 1fr;gap:14px")}>
          {episodes.map((ep) => (
            <button key={ep.title} onClick={go("player")} className="hov-card" style={sx(cardStyle)}>
              <div style={{ ...sx("height:104px;border-radius:20px;position:relative;overflow:hidden;display:grid;place-items:center"), background: ep.bg }}>
                <div style={sx(ep.motif)} />
                <div style={sx(ep.motif2)} />
              </div>
              <div style={sx("padding:10px 4px 0;text-align:left")}>
                <div style={sx("font-size:17px;font-weight:700;color:#2c2a35;line-height:1.15")}>{ep.title}</div>
                <div style={sx("font-family:'Baloo Tammudu 2',serif;font-size:13px;color:#7d6da3;line-height:1.3;margin-top:2px")}>{ep.te}</div>
              </div>
              <div style={sx("position:absolute;top:12px;right:12px;width:44px;height:44px;border-radius:22px;background:#fdf6ec;display:grid;place-items:center;box-shadow:0 2px 0 rgba(44,42,53,.12)")}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#7d6da3"><path d="M6 3l16 9-16 9z" /></svg>
              </div>
            </button>
          ))}
        </div>

        <div style={sx("position:absolute;left:20px;right:20px;bottom:22px")}>
          <button onClick={go("call")} className="hov-cta" style={sx("width:100%;height:104px;border:none;border-radius:30px;background:#f0a33c;display:flex;align-items:center;gap:16px;padding:0 20px;cursor:pointer;box-shadow:0 5px 0 #d1832a")}>
            <div style={sx("width:72px;height:72px;flex:0 0 72px;border-radius:36px;background:#fdf6ec;display:grid;place-items:center;overflow:hidden")}>
              <div style={sx("width:66px;height:66px;transform:translateY(3px)")}><ChikuFace crop="head" emote="goodbye" /></div>
            </div>
            <div style={sx("text-align:left")}>
              <div style={sx("font-size:24px;font-weight:800;color:#2c2a35;line-height:1.05")}>Call Chiku</div>
              <div style={sx("font-family:'Baloo Tammudu 2',serif;font-size:15px;color:#5d4a20")}>చికుకి కాల్ చేయి</div>
            </div>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#2c2a35" strokeWidth="2.4" strokeLinecap="round" style={{ marginLeft: "auto" }}><path d="M4 5c0 8 7 15 15 15l2-4-5-2-2 2c-2-1-5-4-6-6l2-2-2-5z" /></svg>
          </button>
          <div style={sx("display:flex;align-items:center;gap:8px;justify-content:center;margin-top:12px")}>
            <div style={sx("width:10px;height:10px;border-radius:5px;background:#2f8f86")} />
            <div style={sx("font-size:13px;color:#7d6da3")}>Today's call is ready · ఇవాళ్టి కాల్ సిద్ధం</div>
          </div>
        </div>
      </div>

      <div style={sx("flex:1;min-width:280px;max-width:520px")}>
        <Notes items={homeNotes} />
      </div>
    </div>
  );
}
