import { sx } from "../lib/styleString";
import { navBtn } from "../lib/uiHelpers";

const groups = [
  {
    label: "Prototype",
    items: [
      ["01", "Kid Home", "home"],
      ["02", "Episode Player", "player"],
      ["03", "Call Chiku", "call"],
      ["04", "TV Stage", "tv"],
      ["05", "Phone Remote", "remote"],
      ["06", "Parent Dashboard", "parent"],
    ],
  },
  {
    label: "Deliverables",
    items: [
      ["01", "Character Sheet", "character"],
      ["03", "Design System", "system"],
      ["04", "App Icons", "icons"],
    ],
  },
];

export function NavSidebar({ S, go }) {
  return (
    <nav style={sx("width:264px;flex:0 0 264px;border-right:2px solid var(--color-divider);background:#fff;position:sticky;top:0;height:100vh;overflow:auto;padding:24px 0")}>
      <div style={sx("padding:0 20px 18px")}>
        <div style={sx("font-family:var(--font-heading);font-weight:700;font-size:20px;letter-spacing:-.02em")}>Chiku</div>
        <div style={sx("font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent-700);margin-top:4px")}>The show that hears you</div>
        <div style={sx("font-size:12px;color:var(--color-neutral-600);margin-top:10px")}>Prototype v0.1 — 6 screens + deliverables</div>
      </div>
      <div style={sx("height:2px;background:var(--color-divider)")} />
      {groups.map((grp) => (
        <div key={grp.label} style={sx("padding:18px 0 6px")}>
          <div style={sx("padding:0 20px 8px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600)")}>{grp.label}</div>
          {grp.items.map(([num, label, id]) => (
            <button key={id} onClick={go(id)} className="hov-nav" style={sx(navBtn(S === id))}>
              <span style={sx("font-size:11px;width:20px;flex:0 0 20px;color:var(--color-neutral-600)")}>{num}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      ))}
      <div style={sx("height:2px;background:var(--color-divider);margin-top:12px")} />
      <div style={sx("padding:16px 20px;font-size:12px;line-height:1.5;color:var(--color-neutral-700)")}>
        Grown-up chrome is Modernist. Kid screens use the Chiku palette and rounded 64px+ targets — see <span style={sx("color:var(--color-accent-700)")}>Design System</span> for why.
      </div>
    </nav>
  );
}
