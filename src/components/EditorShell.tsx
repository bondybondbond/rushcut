import type { ReactNode } from "react";
import { TopInfoBar } from "@/components/TopInfoBar";
import { BottomTabBar, type ActiveTab } from "@/components/BottomTabBar";
import { ChosenEffects } from "@/components/ChosenEffects";
import type { ConfigurableTab } from "@/hooks/useConfiguredTabs";

interface EditorShellProps {
  projectId: string;
  projectName: string;
  clipCount: number;
  totalMs: number;
  activeTab: ActiveTab;
  configured: Set<ConfigurableTab>;
  /** Left panel (MediaPantry). Omit to hide the left column. */
  leftPanel?: ReactNode;
  /** Right column top area — per-screen controls. Omit if none. */
  actionBar?: ReactNode;
  /** Currently chosen transition value (e.g. "crossfade") */
  transitionValue?: string | null;
  /** Opening transition (e.g. "dip_to_black") */
  openingTransition?: string | null;
  /** Closing transition (e.g. "dip_to_black") */
  closingTransition?: string | null;
  /** Currently chosen music mood (e.g. "cinematic") */
  soundMood?: string | null;
  /** Overall timeline HUD (StickyFilmStrip). Omit on Render screen. */
  timelineHud?: ReactNode;
  children: ReactNode;
}

export function EditorShell({
  projectId,
  projectName,
  clipCount,
  totalMs,
  activeTab,
  configured,
  leftPanel,
  actionBar,
  transitionValue,
  openingTransition,
  closingTransition,
  soundMood,
  timelineHud,
  children,
}: EditorShellProps) {
  return (
    <div className="flex flex-col h-screen pb-12 bg-[#0a0a0a] text-[#e5e5e5] overflow-hidden">
      <TopInfoBar
        projectName={projectName}
        clipCount={clipCount}
        totalMs={totalMs}
      />

      <div className="flex flex-col flex-1 overflow-hidden min-h-0">
        {/* Main content row — left panel (optional) + center */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Left panel — MediaPantry (Trimmer only) */}
          {leftPanel && (
            <aside className="w-52 flex-shrink-0 border-r border-white/10 overflow-y-auto bg-[#0a0a0a]">
              {leftPanel}
            </aside>
          )}

          {/* Center — main content */}
          <main className="flex flex-1 overflow-hidden min-w-0">
            {children}
          </main>
        </div>

        {/* Timeline row — always same proportions across screens */}
        {timelineHud && (
          <div className="flex flex-shrink-0 border-t-2 border-[#99B3FF]/30">
            {/* Left gutter — mirrors pantry width, blank (reserved for future) */}
            <div className="w-52 flex-shrink-0 bg-[#0a0a0a]" />
            {/* Filmstrip fills the center */}
            <div className="flex-1 min-w-0 overflow-hidden">
              {timelineHud}
            </div>
            {/* Effects compact panel — same height as filmstrip */}
            <aside className="w-48 flex-shrink-0 border-l border-white/10 bg-[#0a0a0a] overflow-hidden">
              <ChosenEffects
                transitionValue={transitionValue}
                openingTransition={openingTransition}
                closingTransition={closingTransition}
                soundMood={soundMood}
              />
            </aside>
          </div>
        )}
      </div>

      <BottomTabBar
        projectId={projectId}
        activeTab={activeTab}
        configured={configured}
      />
    </div>
  );
}
