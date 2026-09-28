import { Outlet, useLocation } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { SessionsProvider } from "../data/sessions-store";
import { CommandMenu } from "./CommandMenu";
import { Icon } from "./Icon";
import { Sidebar } from "./Sidebar";

type LayoutState = { sidebar: boolean; showSidebar: () => void; search: () => void };
const Context = createContext<LayoutState>({
  sidebar: true,
  showSidebar: () => undefined,
  search: () => undefined,
});
export const useLayout = () => useContext(Context);

const sidebarKey = "scotty.sidebar";
const stored = () => {
  try {
    return localStorage.getItem(sidebarKey) !== "closed";
  } catch {
    return true;
  }
};

export function Layout() {
  const [sidebar, setSidebar] = useState(stored);
  const [menu, setMenu] = useState(false);
  const path = useLocation({ select: (location) => location.pathname });
  const list = path.replace(/\/$/, "") === "/sessions";
  const toggle = useCallback((open: boolean) => {
    setSidebar(open);
    try {
      localStorage.setItem(sidebarKey, open ? "open" : "closed");
    } catch {
      // Storage can be refused; the choice then lasts for this page only.
    }
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMenu((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        setSidebar((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const closeMenu = useCallback(() => setMenu(false), []);
  return (
    <SessionsProvider>
      <Context.Provider
        value={{ sidebar, showSidebar: () => toggle(true), search: () => setMenu(true) }}
      >
        <div
          className="app"
          data-sidebar={sidebar ? "open" : "closed"}
          data-route={list ? "list" : "page"}
        >
          <Sidebar onSearch={() => setMenu(true)} onCollapse={() => toggle(false)} />
          <main className="main">
            <Outlet />
          </main>
        </div>
        {menu ? <CommandMenu onClose={closeMenu} /> : null}
      </Context.Provider>
    </SessionsProvider>
  );
}

// Shown in a header only while the desktop sidebar is hidden.
export function SidebarButton() {
  const { sidebar, showSidebar } = useLayout();
  if (sidebar) return null;
  return (
    <button
      type="button"
      className="icon-button pressable desktop-only"
      aria-label="Show sidebar"
      onClick={showSidebar}
    >
      <Icon name="sidebar" />
    </button>
  );
}
