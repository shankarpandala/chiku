/**
 * The voice layer's public surface.
 *
 * Both halves are platform features, so both can be absent: check `available`
 * on each before offering anything that depends on it. A Speaker that is not
 * available still returns handles that resolve, so a caller awaiting lines
 * works unchanged on a silent device — it just runs at reading speed.
 */

export type { HeardResult, Listener, SpeakHandle, Speaker, VoiceLang } from "./types";

export {
  browserSynthPort,
  createSpeaker,
  DEFAULT_PITCH,
  DEFAULT_RATE,
  DEFAULT_STALL_MS,
  MOUTH_TICK_MS,
  pickVoice,
  SPEAK_LANG_TAG,
  type SpeakerOptions,
  type SynthLine,
  type SynthPort,
  type SynthVoiceLike,
} from "./speaker";

export {
  browserRecognitionFactory,
  createListener,
  describeRecognitionError,
  isMicUnusable,
  LISTEN_LANG_TAG,
  MIC_UNUSABLE_ERRORS,
  type ListenerOptions,
  type RecognitionAlternativeLike,
  type RecognitionErrorLike,
  type RecognitionEventLike,
  type RecognitionFactory,
  type RecognitionLike,
  type RecognitionResultLike,
  type RecognitionResultListLike,
} from "./listener";

export { BOUNDARY_DIP_MS, JAW_MAX, JAW_MIN, jawAt } from "./mouth";
