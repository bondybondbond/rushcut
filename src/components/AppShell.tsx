import { NavDrawer } from "@/components/NavDrawer";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="fixed top-4 left-4 z-50">
        <NavDrawer />
      </div>
      {children}
    </>
  );
}
