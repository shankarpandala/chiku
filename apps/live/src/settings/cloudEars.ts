// "Cloud ears" — the parent's deliberate, revocable choice to let the browser's
// speech service understand the child when ON-DEVICE recognition does not exist
// on this platform (verified: Chrome 151/macOS answers "unavailable" for every
// language we probe, so without this choice the mic is simply dead).
//
// Doc v0.3 draws the line this module implements: the show may never decide on
// its own to send a child's voice anywhere — but a grown-up may be offered that
// trade "deliberately, on a grown-up surface, with different words". The words
// live in i18n (cloud.*) and must stay honest: audio goes to the browser's
// speech service to be understood; Chiku itself stores nothing.
//
// Default OFF. Stored as a single boolean — no PII.

const KEY = "chiku.live.cloudEars.v1";

export function getCloudEars(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function setCloudEars(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, String(on));
  } catch {
    // storage unavailable — the toggle just won't persist
  }
}
