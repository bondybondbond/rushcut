import { useNavigate } from "react-router-dom";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Home, Scissors, Layers, Music, Clapperboard } from "lucide-react";
import type { ConfigurableTab } from "@/hooks/useConfiguredTabs";

export type ActiveTab = "trim" | "arrange" | "sound" | "render";

interface BottomTabBarProps {
  projectId: string;
  activeTab: ActiveTab;
  configured: Set<ConfigurableTab>;
}

export function BottomTabBar({ projectId, activeTab, configured }: BottomTabBarProps) {
  const navigate = useNavigate();

  function goHome() {
    navigate("/upload");
  }

  // U1d: in a Tauri webview, native `window.confirm` is routed to the dialog
  // plugin and REJECTED unless `dialog:allow-confirm` is granted -- it never
  // blocks and logs an unhandled rejection. Use the plugin's async `confirm`
  // (capability added in capabilities/default.json) so the render-readiness
  // gate actually works.
  async function goTab(tab: ActiveTab) {
    if (tab === "render") {
      const arrangeOk = configured.has("arrange");
      const soundOk = configured.has("sound");
      if (!arrangeOk && !soundOk) {
        const ok = await confirm(
          "You haven't set transitions or music yet. Render anyway?",
          { title: "Render", kind: "warning" }
        );
        if (!ok) return;
      }
      navigate(`/render/${projectId}`);
      return;
    }
    const routes: Record<ActiveTab, string> = {
      trim: `/trimmer/${projectId}`,
      arrange: `/arrange/${projectId}`,
      sound: `/sound/${projectId}`,
      render: `/render/${projectId}`,
    };
    navigate(routes[tab]);
  }

  const tabs: { id: ActiveTab; label: string; Icon: React.ElementType }[] = [
    { id: "trim",   label: "Trim",    Icon: Scissors    },
    { id: "arrange",label: "Arrange", Icon: Layers      },
    { id: "sound",  label: "Music",   Icon: Music       },
    { id: "render", label: "Render",  Icon: Clapperboard },
  ];

  function tabClass(id: ActiveTab) {
    if (id === activeTab) return "text-[#FF8A65] border-b-2 border-[#FF8A65]";
    if (configured.has(id as ConfigurableTab)) return "text-[#e5e5e5] hover:text-[#FF8A65]/70";
    return "text-[#a3a3a3] hover:text-[#e5e5e5]";
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 h-12 bg-[#0a0a0a] border-t border-white/10 flex items-center px-2 z-40">
      {/* Home */}
      <button
        data-testid="tab-home"
        onClick={goHome}
        className="flex flex-col items-center justify-center w-12 h-full gap-0.5 text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors flex-shrink-0"
        aria-label="Home"
      >
        <Home size={16} />
        <span className="text-[10px]">Home</span>
      </button>

      {/* Separator */}
      <div className="w-px h-6 bg-white/10 mx-1 flex-shrink-0" />

      {/* Step tabs */}
      <div className="flex flex-1 items-stretch justify-center gap-1">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            data-testid={`tab-${id}`}
            onClick={() => goTab(id)}
            className={`flex flex-col items-center justify-center px-4 h-full gap-0.5 transition-colors ${tabClass(id)}`}
          >
            <Icon size={16} />
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        ))}
      </div>

      {/* RC wordmark placeholder (Batch I: real SVG logo) */}
      <div className="flex-shrink-0 px-3 text-sm font-bold text-[#FF8A65] tracking-widest select-none">
        RC
      </div>
    </div>
  );
}
