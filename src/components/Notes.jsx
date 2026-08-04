import { sx } from "../lib/styleString";

// The annotation rail that sits beside each mocked-up device frame.
export function Notes({ items }) {
  return items.map((n) => (
    <div key={n.k} style={sx("padding:16px 0;border-bottom:2px solid var(--color-divider)")}>
      <div style={sx("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent-700)")}>{n.k}</div>
      <div style={sx("font-size:15px;line-height:1.55;margin-top:6px")}>{n.v}</div>
    </div>
  ));
}
