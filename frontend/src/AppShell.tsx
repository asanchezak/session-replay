import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, GitBranch, Play, ScrollText, Cable, Settings } from "lucide-react";

export default function AppShell() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <TopBar />
        <main className="flex-1 p-6 overflow-auto" role="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const navItems = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { label: "Workflows", path: "/workflows", icon: GitBranch },
  { label: "Runs", path: "/runs", icon: Play },
  { label: "Audit", path: "/audit", icon: ScrollText },
  { label: "Connectors", path: "/connectors", icon: Cable },
  { label: "Settings", path: "/settings", icon: Settings },
];

function Sidebar() {
  return (
    <nav className="w-56 bg-[#1A1D27] border-r border-[#2D3148] flex flex-col p-4 gap-1" role="navigation" aria-label="Main navigation">
      <div className="text-[#E8EAED] font-semibold text-base mb-6 px-3">
        Session Replay
      </div>
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                isActive
                  ? "bg-[#242836] text-[#E8EAED]"
                  : "text-[#9AA0B0] hover:text-[#E8EAED] hover:bg-[#242836]"
              }`
            }
            aria-current={({ isActive }: { isActive: boolean }) => isActive ? "page" : undefined}
          >
            <Icon size={16} />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function TopBar() {
  return (
    <header className="h-12 border-b border-[#2D3148] flex items-center px-6 gap-4">
      <div className="flex items-center gap-3 flex-1">
        <span className="text-[#9AA0B0] text-sm">Search</span>
      </div>
      <div className="flex items-center gap-2 text-xs" aria-label="System status: All systems healthy">
        <span className="w-2 h-2 rounded-full bg-[#00B894]" />
        <span className="text-[#9AA0B0]">All Systems</span>
      </div>
    </header>
  );
}
