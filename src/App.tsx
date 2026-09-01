import "./App.css";
import { AppShell } from "./components/layout";
if (import.meta.env.DEV) {
  document.title = "OmniSSH-dev";
}

function App() {
  return <AppShell />;
}

export default App;
