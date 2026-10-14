import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { SharedPage, sharedToken } from "./SharedPage.tsx";
import "./style.css";

// A link's page is not the app: it is drawn before anything asks who is signed in, and never does.
const token = sharedToken(location.pathname);

createRoot(document.getElementById("root")!).render(<StrictMode>{token ? <SharedPage token={token} /> : <App />}</StrictMode>);
