import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router-dom";
import RootApp from "../asd-app.jsx";
import LandingPage from "./LandingPage.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/portal/*" element={<RootApp />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>
);
