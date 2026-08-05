import ChikuFace from "../ChikuFace";
import { sx } from "../lib/styleString";
import { CREAM, CHIKU, MARI, TEAL } from "../data/kidPalette";

const icons = [
  {
    num: "Option 1", name: "Face on marigold", emote: "happy",
    note: "Maximum warmth and the highest contrast on a dark home screen. Risk: the trunk detail closes up at 48px.",
    big: "width:180px;height:180px;border-radius:40px;background:" + MARI + ";overflow:hidden;display:grid;place-items:center",
    mid: "width:96px;height:96px;border-radius:22px;background:" + MARI + ";overflow:hidden;display:grid;place-items:center",
    small: "width:48px;height:48px;border-radius:11px;background:" + MARI + ";overflow:hidden;display:grid;place-items:center",
    inner: "width:120%;height:120%",
  },
  {
    num: "Option 2", name: "Listening ring", emote: "listening",
    note: "Puts the product idea in the icon — the ring says 'this one hears you'. Busiest of the three.",
    big: "width:180px;height:180px;border-radius:40px;background:" + CREAM + ";border:6px solid " + TEAL + ";overflow:hidden;display:grid;place-items:center",
    mid: "width:96px;height:96px;border-radius:22px;background:" + CREAM + ";border:4px solid " + TEAL + ";overflow:hidden;display:grid;place-items:center",
    small: "width:48px;height:48px;border-radius:11px;background:" + CREAM + ";border:3px solid " + TEAL + ";overflow:hidden;display:grid;place-items:center",
    inner: "width:112%;height:112%",
  },
  {
    num: "Option 3", name: "Trunk crop", emote: "idle",
    note: "Crops hard into the trunk curl and one ear. Reads as a mark rather than a portrait, and holds at 48px. Recommended.",
    big: "width:180px;height:180px;border-radius:40px;background:" + CHIKU + ";overflow:hidden;display:grid;place-items:center",
    mid: "width:96px;height:96px;border-radius:22px;background:" + CHIKU + ";overflow:hidden;display:grid;place-items:center",
    small: "width:48px;height:48px;border-radius:11px;background:" + CHIKU + ";overflow:hidden;display:grid;place-items:center",
    inner: "width:190%;height:190%;transform:translate(-14%,14%)",
  },
];

export default function AppIcons() {
  return (
    <>
      <div style={sx("padding-top:32px;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:32px")}>
        {icons.map((ic) => (
          <div key={ic.num} style={sx("border:2px solid var(--color-text);background:#fff")}>
            <div style={sx("padding:32px;display:flex;align-items:flex-end;gap:24px;background:var(--color-neutral-100)")}>
              {[ic.big, ic.mid, ic.small].map((boxStyle, i) => (
                <div key={i} style={sx(boxStyle)}>
                  <div style={sx(ic.inner)}><ChikuFace crop="head" emote={ic.emote} /></div>
                </div>
              ))}
            </div>
            <div style={sx("border-top:2px solid var(--color-text);padding:20px 22px")}>
              <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent-700)")}>{ic.num}</div>
              <div style={sx("font-family:var(--font-heading);font-size:19px;margin-top:6px")}>{ic.name}</div>
              <div style={sx("font-size:13px;line-height:1.55;color:var(--color-neutral-700);margin-top:8px")}>{ic.note}</div>
            </div>
          </div>
        ))}
      </div>
      <p style={sx("max-width:60ch;font-size:14px;line-height:1.6;color:var(--color-neutral-700);margin-top:32px")}>Shown at 180 / 96 / 48 px. The 48px row is the test that matters: option 3 survives it because the trunk curl is a shape, not a detail.</p>
    </>
  );
}
