"use client";

import { Spinner } from "@/components/ui/spinner";

interface LoadingScreenProps {
  progress: number;
  stage: string;
}

export function LoadingScreen({ progress, stage }: LoadingScreenProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8 px-4 text-center">
        {/* Logo / Title */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            FRC Gujarat
          </h1>
          <p className="text-lg text-muted-foreground">
            School Fees Analytics Dashboard
          </p>
        </div>

        {/* Progress indicator */}
        <div className="w-full max-w-sm space-y-4">
          <div className="flex items-center justify-center gap-3">
            <Spinner className="h-5 w-5 text-primary" />
            <span className="text-sm text-muted-foreground">{stage}</span>
          </div>
          
          {/* Progress bar */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          
          <p className="text-xs text-muted-foreground">
            Loading Gujarat school fee data...
          </p>
        </div>

        {/* Decorative elements */}
        <div className="mt-8 flex items-center gap-6 text-xs text-muted-foreground">
          <span>15,000+ Schools</span>
          <span className="h-1 w-1 rounded-full bg-muted-foreground" />
          <span>8 Years of Data</span>
          <span className="h-1 w-1 rounded-full bg-muted-foreground" />
          <span>33 Districts</span>
        </div>
      </div>
    </div>
  );
}
