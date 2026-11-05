"use client";

import { useDeferredValue, useMemo } from "react";
import { useDataStore } from "@/lib/data-store";
import {
  calculateDistrictRankings,
  calculateGradeSupply,
  formatRupees,
  getStateWideAverage,
} from "@/lib/data-utils";
import { STANDARDS } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";

function abbreviateDistrictLabel(label: string): string {
  return (label || "")
    .replace(/\bCorporation\b/gi, "Corp.")
    .replace(/\s+/g, " ")
    .trim();
}

function abbreviateStandardLabel(label: string): string {
  return (label || "")
    .replace(/\bStandard\b/gi, "Std")
    .replace(/\bGeneral\b/gi, "Gen")
    .replace(/\bScience\b/gi, "Sci")
    .replace(/\bArts\b/gi, "Arts")
    .replace(/\s+/g, " ")
    .trim();
}

function SingleLineYAxisTick({
  x,
  y,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
}) {
  const value = abbreviateDistrictLabel(payload?.value ?? "");
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={3}
        textAnchor="end"
        fill="#64748b"
        fontSize={10}
      >
        {value}
      </text>
    </g>
  );
}

function StandardYAxisTick({
  x,
  y,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
}) {
  const value = abbreviateStandardLabel(payload?.value ?? "");
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={3}
        textAnchor="end"
        fill="#64748b"
        fontSize={10}
      >
        {value}
      </text>
    </g>
  );
}

function DistrictTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: {
    payload: { district: string; typicalFee: number; schoolCount: number };
  }[];
}) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
        <p className="font-medium text-foreground">{data.district}</p>
        <p className="text-sm text-muted-foreground">
          Typical Fee: {formatRupees(data.typicalFee)}
        </p>
        <p className="text-sm text-muted-foreground">
          {data.schoolCount} schools
        </p>
      </div>
    );
  }
  return null;
}

function GradeTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: { standardName: string; count: number } }[];
}) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
        <p className="font-medium text-foreground">{data.standardName}</p>
        <p className="text-sm text-muted-foreground">
          {data.count} schools offering this grade
        </p>
      </div>
    );
  }
  return null;
}

export function DistrictComparison() {
  const { fees, filters, setFilters } = useDataStore();
  const deferredFilters = useDeferredValue(filters);
  const isUpdating =
    `${filters.district}|${filters.board}|${filters.medium}|${filters.academicYear}|${filters.standardId}` !==
    `${deferredFilters.district}|${deferredFilters.board}|${deferredFilters.medium}|${deferredFilters.academicYear}|${deferredFilters.standardId}`;

  const districtRankings = useMemo(
    () =>
      calculateDistrictRankings(
        fees,
        deferredFilters.board,
        deferredFilters.medium,
        deferredFilters.standardId,
        deferredFilters.academicYear
      ),
    [fees, deferredFilters.board, deferredFilters.standardId, deferredFilters.academicYear, deferredFilters.medium]
  );

  const gradeSupply = useMemo(
    () =>
      calculateGradeSupply(fees, deferredFilters.district, deferredFilters.board, deferredFilters.medium, deferredFilters.academicYear),
    [fees, deferredFilters.district, deferredFilters.board, deferredFilters.academicYear, deferredFilters.medium]
  );

  const stateWideAvg = useMemo(
    () =>
      getStateWideAverage(fees, deferredFilters.board, deferredFilters.medium, deferredFilters.standardId, deferredFilters.academicYear),
    [fees, deferredFilters.board, deferredFilters.standardId, deferredFilters.academicYear, deferredFilters.medium]
  );

  const xDomainMax = useMemo(() => {
    const maxVal = Math.max(
      stateWideAvg || 0,
      ...districtRankings.map((d) => d.typicalFee || 0),
      0
    );
    // round up to nearest 5k for nicer tick spacing
    return Math.max(5000, Math.ceil(maxVal / 5000) * 5000);
  }, [districtRankings, stateWideAvg]);

  const gradeSupplyChartHeight = useMemo(() => {
    // Give each label enough vertical room; keep a sensible minimum.
    return Math.max(520, gradeSupply.length * 28);
  }, [gradeSupply.length]);

  const districtChartHeight = useMemo(() => {
    // District list can be long; make it scrollable while preserving readability.
    return Math.max(520, districtRankings.length * 22);
  }, [districtRankings.length]);

  // Find current district rank
  const currentDistrictRank = districtRankings.findIndex(
    (d) => d.district === deferredFilters.district
  );
  const selectedStandard = STANDARDS.find(
    (s) => s.standard_id === deferredFilters.standardId
  );

  // Get color for grade supply bar
  const getSupplyColor = (count: number) => {
    if (count < 10) return "#22c55e"; // green - opportunity
    if (count < 30) return "#f59e0b"; // amber - growing
    return "#ef4444"; // red - competitive
  };

  return (
    <LoadingOverlay show={isUpdating} label="Updating charts…">
      <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-foreground">
          Gujarat District Comparison
        </h2>
        <p className="text-sm text-muted-foreground">
          Compare fees across districts and find market opportunities
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* District Fee Ranking */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-base font-medium text-foreground">
              All Districts Fee Ranking
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Typical fee for {filters.board} {selectedStandard?.standard_name}{" "}
              by district
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {districtRankings.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground">
                No data available
              </p>
            ) : (
              <>
                {/* Scrollable plot area + fixed X-axis footer (so ticks never scroll away) */}
                <div className="h-[520px] w-full">
                  <div className="h-[462px] w-full overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                    <div style={{ height: districtChartHeight }} className="w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={districtRankings}
                          layout="vertical"
                          margin={{ top: 24, right: 12, left: 16, bottom: 10 }}
                          barCategoryGap={6}
                        >
                          {/* Hide X-axis here; we render it once in the fixed footer */}
                          <XAxis type="number" domain={[0, xDomainMax]} hide />
                          <YAxis
                            type="category"
                            dataKey="district"
                            stroke="#64748b"
                            width={120}
                            tickLine={false}
                            tickMargin={8}
                            tick={<SingleLineYAxisTick />}
                          />
                          <Tooltip content={<DistrictTooltip />} />
                          <ReferenceLine
                            x={stateWideAvg}
                            stroke="#94a3b8"
                            strokeDasharray="3 3"
                            label={{
                              value: "State Avg",
                              position: "top",
                              fill: "#94a3b8",
                              fontSize: 10,
                            }}
                          />
                          <Bar
                            dataKey="typicalFee"
                            radius={[0, 4, 4, 0]}
                            cursor="pointer"
                            onClick={(data) => {
                              if (data && (data as any).district) {
                                setFilters({ district: (data as any).district });
                              }
                            }}
                          >
                            {districtRankings.map((entry) => (
                              <Cell
                                key={entry.district}
                                fill={
                                  entry.district === deferredFilters.district
                                    ? "#3b82f6"
                                    : "#475569"
                                }
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Fixed X axis */}
                  <div className="h-[58px] w-full border-t border-border/60 px-2 pt-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={[{ v: 0 }]}
                        margin={{ top: 0, right: 12, left: 140, bottom: 16 }}
                      >
                        <XAxis
                          type="number"
                          dataKey="v"
                          domain={[0, xDomainMax]}
                          tickFormatter={(val) => `₹${(val / 1000).toFixed(0)}K`}
                          stroke="#64748b"
                          fontSize={11}
                          tickLine={false}
                          axisLine
                        />
                        <YAxis type="category" dataKey="v" hide />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                {deferredFilters.district !== "All Gujarat" && currentDistrictRank >= 0 && (
                  <p className="mt-4 pt-1 text-sm text-muted-foreground text-center">
                    <span className="font-medium text-foreground">
                      {deferredFilters.district}
                    </span>{" "}
                    ranks{" "}
                    <span className="font-medium text-foreground">
                      {currentDistrictRank + 1}
                      {currentDistrictRank === 0 ? "st" : currentDistrictRank === 1 ? "nd" : currentDistrictRank === 2 ? "rd" : "th"}
                    </span>{" "}
                    highest out of {districtRankings.length} districts for{" "}
                    {deferredFilters.board} {selectedStandard?.standard_name}.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Grade Supply Opportunity */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-base font-medium text-foreground">
              Which Grades Have Room for a New School?
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Schools offering each grade in{" "}
              {deferredFilters.district === "All Gujarat"
                ? "Gujarat"
                : deferredFilters.district}{" "}
              ({deferredFilters.board})
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="h-[520px] w-full overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              <div style={{ height: gradeSupplyChartHeight }} className="w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={gradeSupply}
                    layout="vertical"
                    // Extra top/bottom margin so X-axis ticks are not
                    // flush with the card border.
                    margin={{ top: 20, right: 12, left: 16, bottom: 20 }}
                    barCategoryGap={10}
                  >
                    <XAxis
                      type="number"
                      stroke="#64748b"
                      fontSize={11}
                      tickMargin={8}
                    />
                    <YAxis
                      type="category"
                      dataKey="standardName"
                      stroke="#64748b"
                      width={120}
                      tickLine={false}
                    tickMargin={8}
                    tick={<StandardYAxisTick />}
                    />
                    <Tooltip content={<GradeTooltip />} />
                    <Bar
                      dataKey="count"
                      radius={[0, 4, 4, 0]}
                      cursor="pointer"
                      onClick={(data) => {
                        if (data && data.standardId) {
                          setFilters({ standardId: data.standardId });
                        }
                      }}
                    >
                      {gradeSupply.map((entry) => (
                        <Cell
                          key={entry.standardId}
                          fill={
                            entry.standardId === filters.standardId
                              ? "#3b82f6"
                              : getSupplyColor(entry.count)
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded bg-emerald-500" />
                <span className="text-muted-foreground">
                  Opportunity Gap ({'<'}10)
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded bg-amber-500" />
                <span className="text-muted-foreground">Growing (10-30)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded bg-red-500" />
                <span className="text-muted-foreground">Competitive (30+)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded bg-[#3b82f6]" />
                <span className="text-muted-foreground">Selected grade</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      </section>
    </LoadingOverlay>
  );
}
