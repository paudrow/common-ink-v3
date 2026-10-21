import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { tellUncaught } from "./faults.ts";
import { SharedPage, sharedToken } from "./SharedPage.tsx";
import "./style.css";
import { followWindowColor } from "./theme.ts";

// A link's page is not the app: it is drawn before anything asks who is signed in, and never does.
const token = sharedToken(location.pathname);

followWindowColor();

createRoot(document.getElementById("root")!).render(<StrictMode>{token ? <SharedPage token={token} /> : <App />}</StrictMode>);

// A page the browser kept and shows again on Back is as it was, even after signing out. It asks who is signed in, and is drawn afresh when nobody is.
if (!token) {
  // Only a member's page is heard, so a link's page, which has nobody signed in, tells nothing.
  tellUncaught();
  addEventListener("pageshow", (event) => {
    if (event.persisted) void fetch("/api/me", { credentials: "same-origin" }).then((res) => res.status === 401 && location.reload());
  });
}
