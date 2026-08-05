// One surface, no router. Chiku Live is a single room you walk into.

import { LangProvider } from "./i18n";
import { Live } from "./surfaces/live/Live";

export function App() {
  return (
    <LangProvider>
      <Live />
    </LangProvider>
  );
}
