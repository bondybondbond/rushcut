import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";

export function NavDrawer() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (open && drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Close on route change
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  function go(path: string) {
    navigate(path);
    setOpen(false);
  }

  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path + "/");

  return (
    <div ref={drawerRef} className="relative z-50">
      {/* Hamburger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Open menu"
        className="flex flex-col justify-center gap-1.5 w-8 h-8 p-1 text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
      >
        <span className={`block h-0.5 bg-current transition-all duration-200 ${open ? "rotate-45 translate-y-2" : ""}`} />
        <span className={`block h-0.5 bg-current transition-all duration-200 ${open ? "opacity-0" : ""}`} />
        <span className={`block h-0.5 bg-current transition-all duration-200 ${open ? "-rotate-45 -translate-y-2" : ""}`} />
      </button>

      {/* Drawer */}
      {open && (
        <div className="absolute top-10 left-0 w-52 bg-[#111111] border border-white/15 rounded-lg shadow-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10">
            <p className="text-xs text-[#a3a3a3] uppercase tracking-wider font-medium">RushCut</p>
          </div>
          <nav className="py-2">
            <NavItem
              label="New Project"
              icon="+"
              active={isActive("/upload")}
              onClick={() => go("/upload")}
            />
            <NavItem
              label="My Projects"
              icon="◈"
              active={isActive("/library")}
              onClick={() => go("/library")}
            />
          </nav>
        </div>
      )}
    </div>
  );
}

function NavItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors text-left ${
        active
          ? "text-[#FF8A65] bg-[#FF8A65]/10"
          : "text-[#e5e5e5] hover:bg-white/5"
      }`}
    >
      <span className="text-[#a3a3a3] w-4 text-center font-medium">{icon}</span>
      {label}
    </button>
  );
}
