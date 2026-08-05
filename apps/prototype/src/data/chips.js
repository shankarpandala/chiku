import { MARI, TEAL, LEAF } from "./kidPalette";

// The three answer chips, shared by Episode Player, TV Stage and Phone Remote.
const chipDefs = [
  { label: "Leaf", te: "ఆకు", bg: "#dcecd2", shape: "width:38px;height:38px;border-radius:50% 6px 50% 6px;background:" + LEAF, tv: "width:2.6em;height:2.6em;border-radius:50% .4em 50% .4em;background:" + LEAF, correct: true },
  { label: "Mango", te: "మామిడి", bg: "#fbe6c6", shape: "width:40px;height:34px;border-radius:50%;background:" + MARI, tv: "width:2.75em;height:2.3em;border-radius:50%;background:" + MARI },
  { label: "Sky", te: "ఆకాశం", bg: "#d8e6ef", shape: "width:38px;height:38px;border-radius:19px;background:#6f9fc4", tv: "width:2.6em;height:2.6em;border-radius:50%;background:#6f9fc4" },
];

const chipBase = "border:3px solid transparent;background:#fff;border-radius:24px;padding:10px;cursor:pointer;transition:transform .15s;box-shadow:0 2px 0 rgba(44,42,53,.1)";

export function makeChips(s, setState, en) {
  return chipDefs.map((c) => ({
    label: en ? c.label : c.te,
    bg: c.bg,
    shape: c.shape,
    shapeTv: c.tv,
    style: chipBase + ";border-color:" + (s.cp === "retry" ? TEAL : "transparent") + ";opacity:" + (s.cp === "ask" ? ".55" : "1"),
    remoteStyle: chipBase + ";border-color:#efe4d0",
    tvStyle: "background:#fff;border-radius:1.75em;padding:.875em;border:.38em solid " + (c.correct ? MARI : "transparent") + ";transform:scale(" + (c.correct ? 1.04 : 1) + ")",
    pick: () => setState({ cp: c.correct ? "answered" : "retry" }),
  }));
}
