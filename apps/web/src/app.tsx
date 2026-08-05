import { LangProvider } from "./i18n";
import { Home } from "./surfaces/home/Home";

export function App() {
  return (
    <LangProvider>
      <Home />
    </LangProvider>
  );
}
