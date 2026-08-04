import { Icon } from "./Icon";
import { CREAM, TEAL } from "../data/kidPalette";

// Ear glyph for the teal "listening" pill, waveform glyph for everything else.
export function StateIcon({ kind, size }) {
  return kind === TEAL
    ? <Icon paths={["M6 18a8 8 0 010-12", "M11 15a4 4 0 010-6", "M15 4c4 3 4 13 0 16"]} color={CREAM} size={size} />
    : <Icon paths={["M4 12h3l3-5 3 10 3-5h4"]} color={CREAM} size={size} />;
}
