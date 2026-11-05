"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useDataStore } from "@/lib/data-store";
import {
  applyFilters,
  calculateMarketSnapshot,
  formatRupees,
  formatPercent,
  getFeeTier,
  calculateCumulativeGrowth,
} from "@/lib/data-utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { TrendingUp, Building2, IndianRupee, BarChart2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function MarketSnapshot() {
  const { fees, filters } = useDataStore();
  const deferredFilters = useDeferredValue(filters);
  const isUpdating =
    `${filters.district}|${filters.board}|${filters.medium}|${filters.academicYear}|${filters.standardId}` !==
    `${deferredFilters.district}|${deferredFilters.board}|${deferredFilters.medium}|${deferredFilters.academicYear}|${deferredFilters.standardId}`;
  const [proposedFee, setProposedFee] = useState<string>("");

  const filteredFees = useMemo(
    () => applyFilters(fees, deferredFilters, deferredFilters.academicYear),
    [fees, deferredFilters]
  );

  const snapshot = useMemo(
    () => calculateMarketSnapshot(filteredFees),
    [filteredFees]
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
    [fees, deferredFilters]
  );

  const proposedFeeNum = parseFloat(proposedFee.replace(/,/g, "")) || 0;
  const tier = snapshot && proposedFeeNum > 0 ? getFeeTier(proposedFeeNum, snapshot) : null;

  // Market size badge
  const getMarketBadge = (count: number) => {
    if (count >= 30) return { label: "Active Market", color: "bg-emerald-500/20 text-emerald-400" };
    if (count >= 10) return { label: "Growing Market", color: "bg-amber-500/20 text-amber-400" };
    return { label: "New Territory", color: "bg-orange-500/20 text-orange-400" };
  };

  if (!snapshot) {
    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Market Snapshot</h2>
          <p className="text-sm text-muted-foreground">
            Key fee metrics for your selected segment
          </p>
        </div>
        <Card className="border-border bg-card">
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              No data available for this combination.
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  const marketBadge = getMarketBadge(snapshot.schoolCount);

  // Calculate position message
  const getPositionMessage = () => {
    if (!tier || proposedFeeNum <= 0) return null;

    const diffFromPremium = snapshot.premiumEntry - proposedFeeNum;
    const diffFromBudget = proposedFeeNum - snapshot.budgetCeiling;

    if (tier === "Budget") {
      return `${formatRupees(proposedFeeNum)} is in the Budget range. You have ${formatRupees(snapshot.budgetCeiling - proposedFeeNum)} headroom before reaching Lower Mid pricing.`;
    }
    if (tier === "Lower Mid") {
      return `${formatRupees(proposedFeeNum)} sits in the Lower Mid range. A competitive position with ${formatRupees(snapshot.midPoint - proposedFeeNum)} to typical fee.`;
    }
    if (tier === "Upper Mid") {
      return `${formatRupees(proposedFeeNum)} sits in the Upper Mid range. You are ${formatRupees(diffFromPremium)} below the Premium entry point — a defensible position.`;
    }
    return `${formatRupees(proposedFeeNum)} is in the Premium range, ${formatRupees(proposedFeeNum - snapshot.premiumEntry)} above typical premium schools.`;
  };

  // Calculate tier position percentage for the marker
  const getTierPosition = () => {
    if (proposedFeeNum <= snapshot.budgetCeiling) {
      return (proposedFeeNum / snapshot.budgetCeiling) * 25;
    }
    if (proposedFeeNum <= snapshot.midPoint) {
      return 25 + ((proposedFeeNum - snapshot.budgetCeiling) / (snapshot.midPoint - snapshot.budgetCeiling)) * 25;
    }
    if (proposedFeeNum <= snapshot.premiumEntry) {
      return 50 + ((proposedFeeNum - snapshot.midPoint) / (snapshot.premiumEntry - snapshot.midPoint)) * 25;
    }
    const maxFee = snapshot.maxFee;
    const pos = 75 + ((proposedFeeNum - snapshot.premiumEntry) / (maxFee - snapshot.premiumEntry)) * 25;
    return Math.min(pos, 100);
  };

  return (
    <LoadingOverlay show={isUpdating} label="Updating metrics…">
      <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Market Snapshot</h2>
        <p className="text-sm text-muted-foreground">
          Key fee metrics for your selected segment
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Typical Fee */}
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Typical Fee
            </CardTitle>
            <IndianRupee className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {formatRupees(snapshot.typicalFee)}
            </div>
            <p className="text-xs text-muted-foreground">Median approved fee</p>
          </CardContent>
        </Card>

        {/* Fee Range */}
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Fee Range
            </CardTitle>
            <BarChart2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {formatRupees(snapshot.minFee)}
              <span className="mx-1 text-muted-foreground">–</span>
              {formatRupees(snapshot.maxFee)}
            </div>
            <p className="text-xs text-muted-foreground">Min to max approved</p>
          </CardContent>
        </Card>

        {/* Schools in Market */}
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Schools in Market
            </CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold text-foreground">
                {snapshot.schoolCount}
              </span>
              <Badge className={cn("text-xs", marketBadge.color)}>
                {marketBadge.label}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              With approved fees in {deferredFilters.academicYear}
            </p>
          </CardContent>
        </Card>

        {/* Avg Yearly Growth */}
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg Yearly Growth
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {growth ? formatPercent(growth.avgYearlyGrowth) : "—"}
              <span className="text-lg font-normal text-muted-foreground">
                {" "}
                per year
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {growth
                ? `${formatPercent(growth.totalGrowth)} total since ${growth.startYear}`
                : "Insufficient data"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Fee Positioning Bar */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-base font-medium text-foreground">
            Fee Positioning
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            See where any fee lands in this market
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Tier Bar */}
          <div className="relative h-10 w-full overflow-hidden rounded-lg">
            <div className="absolute inset-0 flex">
              <div className="h-full w-1/4 bg-emerald-500/30" />
              <div className="h-full w-1/4 bg-blue-500/30" />
              <div className="h-full w-1/4 bg-amber-500/30" />
              <div className="h-full w-1/4 bg-red-500/30" />
            </div>
            {/* Tier labels */}
            <div className="absolute inset-0 flex text-xs font-medium">
              <div className="flex h-full w-1/4 items-center justify-center text-emerald-400">
                Budget
              </div>
              <div className="flex h-full w-1/4 items-center justify-center text-blue-400">
                Lower Mid
              </div>
              <div className="flex h-full w-1/4 items-center justify-center text-amber-400">
                Upper Mid
              </div>
              <div className="flex h-full w-1/4 items-center justify-center text-red-400">
                Premium
              </div>
            </div>
            {/* Position marker */}
            {proposedFeeNum > 0 && (
              <div
                className="absolute top-0 h-full w-0.5 bg-foreground transition-all duration-300"
                style={{ left: `${getTierPosition()}%` }}
              >
                <div className="absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-2 border-foreground bg-card" />
              </div>
            )}
          </div>

          {/* Tier boundaries */}
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatRupees(snapshot.minFee)}</span>
            <span>Budget Ceiling: {formatRupees(snapshot.budgetCeiling)}</span>
            <span>Mid Point: {formatRupees(snapshot.midPoint)}</span>
            <span>Premium Entry: {formatRupees(snapshot.premiumEntry)}</span>
            <span>{formatRupees(snapshot.maxFee)}</span>
          </div>

          {/* Fee input */}
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-xs">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                ₹
              </span>
              <Input
                type="text"
                placeholder="Enter your proposed fee"
                value={proposedFee}
                onChange={(e) => {
                  const value = e.target.value.replace(/[^\d,]/g, "");
                  setProposedFee(value);
                }}
                className="bg-input pl-7"
              />
            </div>
            {tier && (
              <Badge
                className={cn(
                  "text-sm",
                  tier === "Budget" && "bg-emerald-500/20 text-emerald-400",
                  tier === "Lower Mid" && "bg-blue-500/20 text-blue-400",
                  tier === "Upper Mid" && "bg-amber-500/20 text-amber-400",
                  tier === "Premium" && "bg-red-500/20 text-red-400"
                )}
              >
                {tier}
              </Badge>
            )}
          </div>

          {/* Position message */}
          {getPositionMessage() && (
            <p className="text-sm text-muted-foreground">{getPositionMessage()}</p>
          )}
        </CardContent>
      </Card>
      </section>
    </LoadingOverlay>
  );
}
