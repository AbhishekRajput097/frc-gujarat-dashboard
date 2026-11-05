"use client";

import { useDataStore } from "@/lib/data-store";
import { LoadingScreen } from "@/components/loading-screen";
import { Navigation } from "@/components/navigation";
import { DesktopNotice } from "@/components/desktop-notice";
import type { ReactNode } from "react";

export function AppWrapper({ children }: { children: ReactNode }) {
  const { isLoading, loadingProgress, loadingStage, error } = useDataStore();

  if (isLoading) {
    return <LoadingScreen progress={loadingProgress} stage={loadingStage} />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
        <h1 className="text-2xl font-bold text-foreground">Error Loading Data</h1>
        <p className="mt-2 text-muted-foreground">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <DesktopNotice />
      {children}
    </div>
  );
}
