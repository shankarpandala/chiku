import { CREAM } from "../data/kidPalette";

export function navBtn(active) {
  return "display:flex;align-items:center;gap:10px;width:100%;padding:11px 20px;border:none;background:" + (active ? "var(--color-accent-100)" : "transparent") +
    ";border-left:4px solid " + (active ? "var(--color-accent)" : "transparent") +
    ";font-family:var(--font-body);font-size:14px;font-weight:" + (active ? 600 : 400) + ";color:var(--color-text);text-align:left;cursor:pointer";
}

export function stepBtn(active) {
  return "height:36px;padding:0 16px;border:2px solid " + (active ? "var(--color-accent)" : "var(--color-divider)") + ";background:" + (active ? "var(--color-accent)" : "#fff") +
    ";color:" + (active ? "#fff" : "var(--color-text)") + ";font-family:var(--font-body);font-size:13px;font-weight:600;letter-spacing:.02em;cursor:pointer";
}

export function pill(color, big) {
  return big
    ? "display:inline-flex;align-items:center;gap:.7em;background:" + color + ";color:" + CREAM + ";border-radius:999px;padding:.6em 1.2em;font-family:'Baloo 2'"
    : "display:inline-flex;align-items:center;gap:8px;background:" + color + ";color:" + CREAM + ";border-radius:999px;padding:8px 15px;font-family:'Baloo 2'";
}
