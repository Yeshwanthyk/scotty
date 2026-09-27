import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="shell">
      <header className="site-header">
        <Link to="/sessions" className="brand">
          Scotty
        </Link>
        <nav aria-label="Main">
          <Link to="/sessions">Sessions</Link>
          <Link to="/sessions/create">New session</Link>
        </nav>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
