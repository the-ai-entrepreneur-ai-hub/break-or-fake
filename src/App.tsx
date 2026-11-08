import { Component, type ReactNode, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import Shop from "./Shop";
import Claim from "./Claim";
import Seller from "./Seller";
import { Shell } from "./components";

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="fatal-state"><p className="eyebrow">A small interruption</p><h1>Let’s try that again.</h1><p>Your saved order and evidence are not changed.</p><button className="button primary" onClick={() => window.location.reload()}>Reload this page</button><a href="/shop">Back to the shop</a></main>;
    return this.props.children;
  }
}

export default function App() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    document.title = location.pathname.startsWith("/seller") ? "Seller desk, Break or Fake" : location.pathname.startsWith("/claim") ? "Report damage, Break or Fake" : "Sunday Supply, a Break or Fake test store";
  }, [location.pathname]);
  return <ErrorBoundary><Shell><Routes>
    <Route path="/shop" element={<Shop />} />
    <Route path="/claim/:id" element={<Claim key={location.pathname} />} />
    <Route path="/seller" element={<Seller />} />
    <Route path="*" element={<Navigate to="/shop" replace />} />
  </Routes></Shell></ErrorBoundary>;
}
