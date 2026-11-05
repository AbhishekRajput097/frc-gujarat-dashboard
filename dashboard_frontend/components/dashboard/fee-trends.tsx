"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useDataStore } from "@/lib/data-store";
import {
  calculateFeeTrends,
  calculateFeeTrendsByMedium,
  calculateIncreaseDistribution,
  calculateCumulativeGrowth,
  formatRupees,
  formatPercent,
} from "@/lib/data-utils";
import { STANDARDS, CHART_COLORS } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string; dataKey: string }>;
  label?: string;
}) {
  if (active && payload && payload.length) {
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
        <p className="mb-1 font-medium text-foreground">{label}</p>
        {payload.map(
          (entry) =>
            entry.value && (
              <p
                key={entry.dataKey}
                className="text-sm"
                style={{ color: entry.color }}
              >
                {entry.name}: {formatRupees(entry.value)}
              </p>
            )
        )}
      </div>
    );
  }
  return null;
}

function HistogramTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { label: string; count: number } }>;
}) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
        <p className="font-medium text-foreground">{data.label} increase</p>
        <p className="text-sm text-muted-foreground">
          {data.count} schools approved
        </p>
      </div>
    );
  }
  return null;
}

export function FeeTrends() {
  const { fees, filters } = useDataStore();
  const deferredFilters = useDeferredValue(filters);
  const isUpdating =
    `${filters.district}|${filters.board}|${filters.medium}|${filters.academicYear}|${filters.standardId}` !==
    `${deferredFilters.district}|${deferredFilters.board}|${deferredFilters.medium}|${deferredFilters.academicYear}|${deferredFilters.standardId}`;

  const [compareMode, setCompareMode] = useState<"board" | "medium">("board");

  const trendsByBoard = useMemo(
    () =>
      calculateFeeTrends(fees, deferredFilters.district, deferredFilters.standardId),
    [fees, deferredFilters.district, deferredFilters.standardId]
  );

  const trendsByMedium = useMemo(
    () =>
      calculateFeeTrendsByMedium(
        fees,
        deferredFilters.district,
        deferredFilters.standardId,
        deferredFilters.board
      ),
    [fees, deferredFilters.district, deferredFilters.standardId, deferredFilters.board]
  );

  const increases = useMemo(
    () =>
      calculateIncreaseDistribution(
        fees,
        deferredFilters.district,
        deferredFilters.board,
        deferredFilters.medium,
        deferredFilters.standardId
      ),
    [fees, deferredFilters.district, deferredFilters.board, deferredFilters.standardId, deferredFilters.medium]
  );

  const growth = useMemo(
    () =>
      calculateCumulativeGrowth(
        fees,
        deferredFilters.district,
        deferredFilters.board,
        deferredFilters.medium,
        deferredFilters.standardId
      ),
    [fees, deferredFilters.district, deferredFilters.board, deferredFilters.standardId, deferredFilters.medium]
  );

  const growthByMedium = useMemo(() => {
    if (compareMode !== "medium") return null;
    const mediums = ["English", "Gujarati", "Hindi"] as const;
    const entries = mediums
      .map((m) => ({
        medium: m,
        growth: calculateCumulativeGrowth(
          fees,
          filters.district,
          filters.board,
          m,
          filters.standardId
        ),
      }))
      .filter((e) => e.growth);
    if (entries.length === 0) return null;
    entries.sort((a, b) => (b.growth!.totalGrowth ?? 0) - (a.growth!.totalGrowth ?? 0));
    return entries[0];
  }, [compareMode, fees, filters.district, filters.board, filters.standardId]);

  const selectedStandard = STANDARDS.find(
    (s) => s.standard_id === deferredFilters.standardId
  );

  // Find most common increase bucket
  const mostCommonBucket = increases.reduce(
    (max, bucket) => (bucket.count > max.count ? bucket : max),
    increases[0] || { label: "N/A", count: 0 }
  );

  return (
    <LoadingOverlay show={isUpdating} label="Updating trends…">
      <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-foreground">
          Fee Trends Over Time
        </h2>
        <p className="text-sm text-muted-foreground">
          Historical fee patterns and FRC-approved increases
        </p>
      </div>

      {/* Multi-line trend chart */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-base font-medium text-foreground">
            {compareMode === "board"
              ? "Typical Fee by Board (2018–2026)"
              : "Typical Fee by Medium (2018–2026)"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {selectedStandard?.standard_name} in{" "}
            {deferredFilters.district === "All Gujarat"
              ? "Gujarat"
              : deferredFilters.district}
          </p>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center justify-end">
            <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCompareMode("board")}
                disabled
                className={cn(
                  "h-7 px-3 text-xs font-medium",
                  compareMode === "board"
                    ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Compare by Board
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCompareMode("medium")}
                disabled
                className={cn(
                  "h-7 px-3 text-xs font-medium",
                  compareMode === "medium"
                    ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Compare by Medium
              </Button>
            </div>
          </div>
          <div className="flex h-[300px] w-full flex-col items-center justify-center gap-4 rounded-lg border border-border/60 bg-muted/10 px-6 text-center">
            <div className="space-y-2">
              <div className="text-lg font-semibold text-foreground">
                Coming soon
              </div>
              <div className="text-sm text-muted-foreground">
                We’re polishing this interactive trends view for a smoother experience.
              </div>
            </div>
            <div className="w-full max-w-md space-y-3">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-10/12" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Increase distribution histogram */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-base font-medium text-foreground">
            What Fee Increases Has FRC Actually Approved?
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Distribution of year-on-year increases for {filters.board}{" "}
            {selectedStandard?.standard_name}
          </p>
        </CardHeader>
        <CardContent className="pt-4 pb-4">
          {increases.every((b) => b.count === 0) ? (
            <p className="py-8 text-center text-muted-foreground">
              Not enough year-over-year data to show distribution
            </p>
          ) : (
            <>
              <div className="h-[260px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={increases}
                    margin={{ top: 10, right: 24, left: 24, bottom: 20 }}
                  >
                    <XAxis
                      dataKey="label"
                      stroke="#64748b"
                      fontSize={11}
                      tickLine={false}
                    />
                    <YAxis
                      stroke="#64748b"
                      fontSize={11}
                      tickLine={false}
                    />
                    <Tooltip content={<HistogramTooltip />} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {increases.map((entry, index) => (
                        <Cell
                          key={entry.label}
                          fill={
                            entry.label === mostCommonBucket.label
                              ? "#3b82f6"
                              : "#475569"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Most schools in this market received a{" "}
                <span className="font-medium text-foreground">
                  {mostCommonBucket.label}
                </span>{" "}
                increase. The typical approved increase was around{" "}
                <span className="font-medium text-foreground">
                  {(mostCommonBucket.min + Math.min(mostCommonBucket.max, 25)) / 2}%
                </span>
                .
              </p>
            </>
          )}
        </CardContent>
      </Card>
      </section>
    </LoadingOverlay>
  );
}
