import { sx } from "../lib/styleString";

export function ScreenHeader({ kicker, title, note }) {
  return (
    <header style={sx("display:flex;align-items:flex-end;justify-content:space-between;gap:32px;padding-bottom:14px;border-bottom:2px solid var(--color-divider)")}>
      <div>
        <div style={sx("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)")}>{kicker}</div>
        <h1 style={sx("font-family:var(--font-heading);font-size:38px;line-height:1.05;margin:6px 0 0;letter-spacing:-.025em")}>{title}</h1>
      </div>
      <p style={sx("max-width:44ch;font-size:14px;line-height:1.55;margin:0;color:var(--color-neutral-700)")}>{note}</p>
    </header>
  );
}
