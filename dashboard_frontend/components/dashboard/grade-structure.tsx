"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useDataStore } from "@/lib/data-store";
import {
  calculateGradeFeeStructure,
  calculateMarketSnapshot,
  applyFilters,
  formatRupees,
  formatPercent,
  getFeeTier,
} from "@/lib/data-utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { STANDARDS } from "@/lib/constants";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

export function GradeStructure() {
  const { fees, filters, setFilters } = useDataStore();
  const deferredFilters = useDeferredValue(filters);
  const isUpdating =
    `${filters.district}|${filters.board}|${filters.medium}|${filters.academicYear}|${filters.standardId}` !==
    `${deferredFilters.district}|${deferredFilters.board}|${deferredFilters.medium}|${deferredFilters.academicYear}|${deferredFilters.standardId}`;
  const [proposedFees, setProposedFees] = useState<Record<number, string>>({});

  const gradeStructure = useMemo(
    () =>
      calculateGradeFeeStructure(
        fees,
        deferredFilters.district,
        deferredFilters.board,
        deferredFilters.medium,
        deferredFilters.academicYear
      ),
    [fees, deferredFilters.district, deferredFilters.board, deferredFilters.medium, deferredFilters.academicYear]
  );

  // Calculate snapshot for each grade to determine tiers
  const gradeSnapshots = useMemo(() => {
    const snapshots: Record<number, ReturnType<typeof calculateMarketSnapshot>> = {};
    gradeStructure.forEach((grade) => {
      if (grade.schoolCount > 0) {
        const gradeFees = applyFilters(
          fees,
          { ...deferredFilters, standardId: grade.standardId },
          deferredFilters.academicYear
        );
        snapshots[grade.standardId] = calculateMarketSnapshot(gradeFees);
      }
    });
    return snapshots;
  }, [fees, deferredFilters, gradeStructure]);

  // Get tier badge color
  const getTierBadge = (tier: string) => {
    switch (tier) {
      case "Budget":
        return "bg-emerald-500/20 text-emerald-400";
      case "Lower Mid":
        return "bg-blue-500/20 text-blue-400";
      case "Upper Mid":
        return "bg-amber-500/20 text-amber-400";
      case "Premium":
        return "bg-red-500/20 text-red-400";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  // Get jump badge color
  const getJumpBadge = (jump: number | null) => {
    if (jump === null) return null;
    if (jump < 10) return "bg-emerald-500/20 text-emerald-400";
    if (jump < 20) return "bg-amber-500/20 text-amber-400";
    return "bg-red-500/20 text-red-400";
  };

  // Check if proposed fee jump is too high
  const checkFeeJump = (standardId: number, proposedFee: number) => {
    const idx = gradeStructure.findIndex((g) => g.standardId === standardId);
    if (idx <= 0) return null;

    const prevGrade = gradeStructure[idx - 1];
    const prevProposedFee = parseFloat(
      proposedFees[prevGrade.standardId]?.replace(/,/g, "") || "0"
    );
    if (!prevProposedFee) return null;
    if (!proposedFee) return null;

    const jump = ((proposedFee - prevProposedFee) / prevProposedFee) * 100;
    const marketJump = gradeStructure[idx].jumpFromPrevious || 10;

    const suggestedMin = prevProposedFee * (1 + marketJump / 100);
    const suggestedMax = prevProposedFee * (1 + (marketJump * 1.5) / 100);
    return {
      isHigh: jump > marketJump * 1.5,
      jump,
      marketJump,
      suggestedMin,
      suggestedMax,
    };
  };

  const flaggedTransitionsCount = useMemo(() => {
    return gradeStructure.reduce((count, grade, idx) => {
      if (idx <= 0) return count;
      const prevGrade = gradeStructure[idx - 1];
      const prevProposed = parseFloat(
        proposedFees[prevGrade.standardId]?.replace(/,/g, "") || "0"
      );
      const currProposed = parseFloat(
        proposedFees[grade.standardId]?.replace(/,/g, "") || "0"
      );
      if (!prevProposed || !currProposed) return count;
      const jump = ((currProposed - prevProposed) / prevProposed) * 100;
      const marketJump = grade.jumpFromPrevious || 10;
      return jump > marketJump * 1.5 ? count + 1 : count;
    }, 0);
  }, [gradeStructure, proposedFees]);

  const feeScheduleBadge = useMemo(() => {
    if (flaggedTransitionsCount === 0) {
      return {
        text: "Fee Schedule: No Issues ✓",
        className: "bg-emerald-500/20 text-emerald-400",
      };
    }
    if (flaggedTransitionsCount <= 2) {
      return {
        text: `${flaggedTransitionsCount} Transition${flaggedTransitionsCount === 1 ? "" : "s"} Flagged ⚠`,
        className: "bg-red-500/20 text-red-400",
      };
    }
    return { text: "Review Needed ✗", className: "bg-red-500/20 text-red-400" };
  }, [flaggedTransitionsCount]);

  const selectedStandard = useMemo(
    () => STANDARDS.find((s) => s.standard_id === deferredFilters.standardId),
    [deferredFilters.standardId]
  );

  const topSchools = useMemo(() => {
    const segmentFees = applyFilters(fees, deferredFilters, deferredFilters.academicYear).filter(
      (f) => f.approved_fee !== null && f.approved_fee > 0
    );
    const sorted = [...segmentFees].sort(
      (a, b) => (b.approved_fee || 0) - (a.approved_fee || 0)
    );
    return {
      highest: sorted.slice(0, 5),
      lowest: [...sorted].reverse().slice(0, 5),
    };
  }, [fees, deferredFilters]);

  return (
    <TooltipProvider>
      <LoadingOverlay show={isUpdating} label="Updating grade table…">
        <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">
            Grade-by-Grade Fee Structure
          </h2>
          <p className="text-sm text-muted-foreground">
            Fee breakdown by grade for {filters.board} schools in{" "}
            {deferredFilters.district === "All Gujarat"
              ? "Gujarat"
              : deferredFilters.district}
          </p>
        </div>

        <Card className="border-border bg-card">
          <CardContent className="p-0">
            <div className="flex items-center justify-end border-b border-border px-4 py-3">
              <Badge className={cn("text-xs", feeScheduleBadge.className)}>
                {feeScheduleBadge.text}
              </Badge>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">Grade</TableHead>
                    <TableHead className="text-right text-muted-foreground">
                      Lowest Fee
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                      <span className="font-semibold text-foreground">
                        Typical Fee
                      </span>
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                      Highest Fee
                    </TableHead>
                    <TableHead className="text-center text-muted-foreground">
                      Schools
                    </TableHead>
                    <TableHead className="text-center text-muted-foreground">
                      Jump from Previous
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                      My Proposed Fee
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gradeStructure.map((grade) => {
                    const proposedFeeStr = proposedFees[grade.standardId] || "";
                    const proposedFeeNum =
                      parseFloat(proposedFeeStr.replace(/,/g, "")) || 0;
                    const snapshot = gradeSnapshots[grade.standardId];
                    const tier =
                      snapshot && proposedFeeNum > 0
                        ? getFeeTier(proposedFeeNum, snapshot)
                        : null;
                    const jumpWarning = checkFeeJump(
                      grade.standardId,
                      proposedFeeNum
                    );
                    const jumpIsEvaluated = Boolean(jumpWarning);
                    const isSelected = deferredFilters.standardId === grade.standardId;

                    return (
                      <TableRow
                        key={grade.standardId}
                        className={cn(
                          "cursor-pointer border-border transition-colors",
                          isSelected
                            ? "bg-primary/10 hover:bg-primary/15"
                            : "hover:bg-muted/50"
                        )}
                        onClick={() =>
                          setFilters({ standardId: grade.standardId })
                        }
                      >
                        <TableCell className="font-medium text-foreground">
                          <div>
                            <span>{grade.standardName}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {grade.standardGroup}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {grade.schoolCount > 0
                            ? formatRupees(grade.lowestFee)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-foreground">
                          {grade.schoolCount > 0
                            ? formatRupees(grade.typicalFee)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {grade.schoolCount > 0
                            ? formatRupees(grade.highestFee)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-center">
                          {grade.schoolCount > 0 ? (
                            <span className="text-muted-foreground">
                              {grade.schoolCount}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {grade.jumpFromPrevious !== null ? (
                            <Badge
                              className={cn(
                                "text-xs",
                                getJumpBadge(grade.jumpFromPrevious)
                              )}
                            >
                              +{formatPercent(grade.jumpFromPrevious, 0)}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-end gap-2">
                            <div className="relative w-28">
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                                ₹
                              </span>
                              <Input
                                type="text"
                                placeholder="0"
                                value={proposedFeeStr}
                                onChange={(e) => {
                                  const value = e.target.value.replace(
                                    /[^\d,]/g,
                                    ""
                                  );
                                  setProposedFees((prev) => ({
                                    ...prev,
                                    [grade.standardId]: value,
                                  }));
                                }}
                                className="h-8 bg-input pl-5 pr-2 text-right text-sm"
                              />
                            </div>
                            {tier && (
                              <Badge
                                className={cn("text-xs", getTierBadge(tier))}
                              >
                                {tier}
                              </Badge>
                            )}
                            {jumpIsEvaluated && jumpWarning?.isHigh && (
                              <Tooltip>
                                <TooltipTrigger>
                                  <AlertTriangle className="h-4 w-4 text-red-400" />
                                </TooltipTrigger>
                                <TooltipContent className="max-w-sm">
                                  <p>
                                    Your jump here is{" "}
                                    {formatPercent(jumpWarning.jump, 0)}. Market
                                    norm is{" "}
                                    {formatPercent(jumpWarning.marketJump, 0)}.
                                    FRC may question this. Suggested range:{" "}
                                    {formatRupees(jumpWarning.suggestedMin)} –{" "}
                                    {formatRupees(jumpWarning.suggestedMax)}.
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {jumpIsEvaluated && !jumpWarning?.isHigh && (
                              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {gradeStructure.filter((g) => g.schoolCount > 0).length < 5 && (
          <p className="text-sm text-amber-500">
            Too few schools for reliable data. Try widening your filters.
          </p>
        )}

        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium text-foreground">
              Highest &amp; Lowest Fee Schools in{" "}
              {deferredFilters.district === "All Gujarat" ? "Gujarat" : deferredFilters.district}{" "}
              for {deferredFilters.board} {selectedStandard?.standard_name}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <div className="grid gap-6 md:grid-cols-2">
              {/* Highest-fee list */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm font-medium text-foreground">
                  <span>Top 5 Highest-fee Schools</span>
                </div>
                <ol className="space-y-2">
                  {topSchools.highest.map((s, idx) => (
                    <li
                      key={s.fee_key}
                      className="group rounded-lg border border-border/60 bg-card/60 px-3 py-2 transition-colors hover:border-primary/60 hover:bg-primary/5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {idx + 1}.
                            </span>
                            <span className="truncate text-sm font-medium text-foreground">
                              {s.school_name}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {s.district} · {s.medium} · {s.board}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-semibold text-foreground">
                            {formatRupees(s.approved_fee!)}
                          </div>
                          <Badge className="mt-1 bg-red-500/20 text-red-400">
                            Premium
                          </Badge>
                        </div>
                      </div>
                    </li>
                  ))}
                  {topSchools.highest.length === 0 && (
                    <p className="py-4 text-sm text-muted-foreground">
                      No schools found for this segment.
                    </p>
                  )}
                </ol>
              </div>

              {/* Lowest-fee list */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm font-medium text-foreground">
                  <span>Top 5 Lowest-fee Schools</span>
                </div>
                <ol className="space-y-2">
                  {topSchools.lowest.map((s, idx) => (
                    <li
                      key={s.fee_key}
                      className="group rounded-lg border border-border/60 bg-card/60 px-3 py-2 transition-colors hover:border-emerald-500/60 hover:bg-emerald-500/5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {idx + 1}.
                            </span>
                            <span className="truncate text-sm font-medium text-foreground">
                              {s.school_name}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {s.district} · {s.medium} · {s.board}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-semibold text-foreground">
                            {formatRupees(s.approved_fee!)}
                          </div>
                          <Badge className="mt-1 bg-emerald-500/20 text-emerald-400">
                            Budget
                          </Badge>
                        </div>
                      </div>
                    </li>
                  ))}
                  {topSchools.lowest.length === 0 && (
                    <p className="py-4 text-sm text-muted-foreground">
                      No schools found for this segment.
                    </p>
                  )}
                </ol>
              </div>
            </div>
          </CardContent>
        </Card>
        </section>
      </LoadingOverlay>
    </TooltipProvider>
  );
}
