"use client";

import { AppWrapper } from "@/components/app-wrapper";
import { FilterBar } from "@/components/filter-bar";
import { MarketSnapshot } from "@/components/dashboard/market-snapshot";
import { DistrictComparison } from "@/components/dashboard/district-comparison";
import { FeeTrends } from "@/components/dashboard/fee-trends";
import { GradeStructure } from "@/components/dashboard/grade-structure";

function DashboardContent() {
  return (
    <>
      <FilterBar />
      <main className="mx-auto max-w-[1400px] space-y-8 px-4 py-6 md:px-6 md:py-8">
        <MarketSnapshot />
        <DistrictComparison />
        <FeeTrends />
        <GradeStructure />
      </main>
    </>
  );
}

export default function Page() {
  return (
    <AppWrapper>
      <DashboardContent />
    </AppWrapper>
  );
}
