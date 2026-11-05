"use client";

import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function LoadingOverlay({
  show,
  label = "Updating…",
  className,
  children,
}: {
  show: boolean;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("relative", className)}>
      {children}
      {show && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/40 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card/90 px-3 py-2 text-sm text-muted-foreground shadow-sm">
            <Spinner className="h-4 w-4 text-primary" />
            <span>{label}</span>
          </div>
        </div>
      )}
    </div>
  );
}

