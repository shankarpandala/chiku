// Two rooms, and the door between them is a grown-up's choice.
//
// This app used to be one surface with no router, and for the 3-8 band it still
// is: `Live` owns the whole welcome → camera → play → goodbye machine. Toddler
// mode is not another activity inside that machine, it is a different SHAPE of
// play for a child below the band the machine was designed for (see
// surfaces/toddler/Toddler.tsx), so it is a sibling surface rather than a mode.
//
// Still no router, and deliberately: a router implies addresses, and there are
// exactly two states with no history, no deep links and nothing to restore.
// This is the whole thing.
//
// THE DOOR IS ON THE WELCOME SCREEN, next to "Let's play!", because a mode a
// grown-up cannot find is a mode that does not exist — the failure this repo
// has shipped in one form or another every phase so far. `Live` renders it when
// (and only when) it is handed the callback, so the surface tests that mount
// `Live` on its own see exactly the screen they always did.

import { useState } from "react";
import { LangProvider } from "./i18n";
import { Live } from "./surfaces/live/Live";
import { Toddler } from "./surfaces/toddler/Toddler";

export type Room = "live" | "toddler";

export function App() {
  const [room, setRoom] = useState<Room>("live");

  return (
    <LangProvider>
      {room === "toddler" ? (
        <Toddler onExit={() => setRoom("live")} />
      ) : (
        <Live onToddlerMode={() => setRoom("toddler")} />
      )}
    </LangProvider>
  );
}
