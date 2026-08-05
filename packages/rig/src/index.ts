// Public API of @chiku/rig — exactly the pinned surface.

export type { RigState, Viseme, Emote, VisemeMark, RigOptions, Rig, RigAudio, AmplitudeSource } from "./types";
export { createRig } from "./rig";
export { defaultCreateAudio } from "./audio";

// The live rig — persistent-node renderer with continuous numeric inputs, for
// the realtime surface. Shares all art data with the episode rig.
export { createLiveRig } from "./live";
export type { LiveRig, LiveRigOptions } from "./live";
