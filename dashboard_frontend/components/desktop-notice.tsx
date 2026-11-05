"use client";

import { useEffect, useState } from "react";
import { X, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "frc_desktop_notice_dismissed_v1";

export function DesktopNotice({ className }: { className?: string }) {
  // Default to showing on mobile immediately; we then hide if the user previously dismissed it.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (dismissed) return null;

  return (
    <div className={cn("md:hidden border-b border-border bg-sidebar/70 backdrop-blur", className)}>
      <div className="mx-auto flex max-w-[1400px] items-start gap-3 px-4 py-3 md:px-6">
        <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-muted">
          <Monitor className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            Best viewed on desktop
          </div>
          <div className="text-xs text-muted-foreground">
            For a better view of charts and tables, please open this dashboard on a desktop or laptop.
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(STORAGE_KEY, "1");
            } catch {
              // ignore
            }
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

