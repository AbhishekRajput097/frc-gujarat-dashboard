"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useDataStore } from "@/lib/data-store";
import {
  formatRupees,
  formatPercent,
  filterValidFees,
  median,
  calculateMarketSnapshot,
  applyFilters,
  getFeeTier,
  quantile,
} from "@/lib/data-utils";
import { STANDARDS, ACADEMIC_YEARS, CHART_COLORS } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
  BarChart,
  Bar,
  Cell,
  CartesianGrid,
  Label,
} from "recharts";
import { cn } from "@/lib/utils";
import { Search, Building2, TrendingUp, Scale, FileText, Download } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface SchoolData {
  school_key: string;
  school_name: string;
  index_number: string;
  district: string;
  board: string;
  medium: string;
  source_url: string;
}

function FeeDistributionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { start: number; end: number; count: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="font-medium text-foreground">
        {formatRupees(p.start)} – {formatRupees(p.end)}
      </p>
      <p className="text-sm text-muted-foreground">{p.count} schools</p>
    </div>
  );
}

function FrozenYearsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const value = payload[0]!.value;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="font-medium text-foreground">{label}</p>
      <p className="text-sm text-muted-foreground">
        Change: {formatPercent(value, 0)}
      </p>
    </div>
  );
}

export function MySchoolAnalysis() {
  const { fees, latestYear } = useDataStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSchool, setSelectedSchool] = useState<SchoolData | null>(null);
  const [proposedFeesByStandard, setProposedFeesByStandard] = useState<
    Record<number, string>
  >({});
  const [focusStandardId, setFocusStandardId] = useState<number>(8);
  const deferredSelectedSchoolKey = useDeferredValue(selectedSchool?.school_key ?? "");
  const deferredFocusStandardId = useDeferredValue(focusStandardId);
  const isUpdatingCharts =
    deferredSelectedSchoolKey !== (selectedSchool?.school_key ?? "") ||
    deferredFocusStandardId !== focusStandardId;
  const roomBarRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingPin, setIsDraggingPin] = useState(false);

  const proposedFee = proposedFeesByStandard[focusStandardId] ?? "";
  const proposedFeeNum = parseFloat(proposedFee.replace(/,/g, "")) || 0;

  // Get unique schools from fees
  const schools = useMemo(() => {
    const schoolMap = new Map<string, SchoolData>();
    fees.forEach((f) => {
      if (!schoolMap.has(f.school_key)) {
        schoolMap.set(f.school_key, {
          school_key: f.school_key,
          school_name: f.school_name,
          index_number: f.index_number,
          district: f.district,
          board: f.board,
          medium: f.medium,
          source_url: f.source_url,
        });
      }
    });
    return Array.from(schoolMap.values());
  }, [fees]);

  // Search results
  const searchResults = useMemo(() => {
    if (searchQuery.length < 2) return [];
    const query = searchQuery.toLowerCase();
    return schools
      .filter(
        (s) =>
          s.school_name.toLowerCase().includes(query) ||
          s.index_number.includes(query)
      )
      .slice(0, 10);
  }, [schools, searchQuery]);

  // Get school's fee history
  const schoolFees = useMemo(() => {
    if (!selectedSchool) return [];
    return filterValidFees(fees)
      .filter((f) => f.school_key === selectedSchool.school_key)
      .sort((a, b) => a.academic_year.localeCompare(b.academic_year));
  }, [fees, selectedSchool]);

  // Get fee history by standard
  const feesByStandard = useMemo(() => {
    const result: Record<
      number,
      { year: string; fee: number; marketMedian: number }[]
    > = {};

    if (!selectedSchool) return result;

    STANDARDS.forEach((standard) => {
      const standardFees = schoolFees.filter(
        (f) => f.standard_id === standard.standard_id
      );
      if (standardFees.length === 0) return;

      result[standard.standard_id] = standardFees.map((sf) => {
        // Calculate market median for comparison
        const marketFees = filterValidFees(fees).filter(
          (f) =>
            f.standard_id === standard.standard_id &&
            f.board === selectedSchool.board &&
            f.academic_year === sf.academic_year &&
            f.approved_fee !== null &&
            f.approved_fee > 0
        );
        const marketMedian = median(marketFees.map((f) => f.approved_fee!));

        return {
          year: sf.academic_year,
          fee: sf.approved_fee!,
          marketMedian,
        };
      });
    });

    return result;
  }, [fees, schoolFees, selectedSchool]);

  // Calculate years without increase
  const yearsNoIncrease = useMemo(() => {
    const result: Record<number, number> = {};

    Object.entries(feesByStandard).forEach(([standardId, history]) => {
      let count = 0;
      for (let i = history.length - 1; i > 0; i--) {
        if (history[i].fee <= history[i - 1].fee) {
          count++;
        } else {
          break;
        }
      }
      result[parseInt(standardId)] = count;
    });

    return result;
  }, [feesByStandard]);

  // Calculate total growth
  const totalGrowth = useMemo(() => {
    const result: Record<
      number,
      { startFee: number; endFee: number; growth: number; years: number }
    > = {};

    Object.entries(feesByStandard).forEach(([standardId, history]) => {
      if (history.length < 2) return;
      const startFee = history[0].fee;
      const endFee = history[history.length - 1].fee;
      const growth = ((endFee - startFee) / startFee) * 100;
      result[parseInt(standardId)] = {
        startFee,
        endFee,
        growth,
        years: history.length - 1,
      };
    });

    return result;
  }, [feesByStandard]);

  // Get current fees and market position
  const currentPosition = useMemo(() => {
    if (!selectedSchool) return [];

    return STANDARDS.map((standard) => {
      const schoolFee = schoolFees.find(
        (f) =>
          f.standard_id === standard.standard_id &&
          f.academic_year === latestYear
      );
      if (!schoolFee || !schoolFee.approved_fee) return null;

      const marketFees = applyFilters(
        fees,
        {
          district: selectedSchool.district,
          board: selectedSchool.board,
          medium: selectedSchool.medium,
          standardId: standard.standard_id,
        },
        latestYear
      );
      const snapshot = calculateMarketSnapshot(marketFees);
      if (!snapshot) return null;

      const tier = getFeeTier(schoolFee.approved_fee, snapshot);
      const percentile =
        (marketFees.filter((f) => f.approved_fee! <= schoolFee.approved_fee!)
          .length /
          marketFees.length) *
        100;

      return {
        standardId: standard.standard_id,
        standardName: standard.standard_name,
        currentFee: schoolFee.approved_fee,
        marketMedian: snapshot.typicalFee,
        tier,
        percentile,
        schoolCount: snapshot.schoolCount,
      };
    }).filter(Boolean);
  }, [fees, schoolFees, selectedSchool, latestYear]);

  const gradeOptions = useMemo(() => {
    const fromCurrent = currentPosition
      .filter(Boolean)
      .map((p) => ({ id: p!.standardId, name: p!.standardName }));
    if (fromCurrent.length > 0) return fromCurrent.sort((a, b) => a.id - b.id);

    const fromHistory = Object.keys(feesByStandard)
      .map((id) => parseInt(id))
      .filter((id) => Number.isFinite(id))
      .sort((a, b) => a - b)
      .map((id) => ({
        id,
        name: STANDARDS.find((s) => s.standard_id === id)?.standard_name ?? `Grade ${id}`,
      }));
    return fromHistory;
  }, [currentPosition, feesByStandard]);

  const focusStandard = useMemo(
    () => STANDARDS.find((s) => s.standard_id === focusStandardId),
    [focusStandardId]
  );

  const focusHistory = useMemo(() => {
    if (!selectedSchool) return [];
    return (feesByStandard[focusStandardId] || []).slice().sort((a, b) => a.year.localeCompare(b.year));
  }, [feesByStandard, focusStandardId, selectedSchool]);

  const currentFee = useMemo(() => {
    if (!selectedSchool) return 0;
    const row = focusHistory.find((h) => h.year === latestYear);
    return row?.fee || 0;
  }, [focusHistory, latestYear, selectedSchool]);

  const segmentFeesLatestYear = useMemo(() => {
    if (!selectedSchool) return [];
    return applyFilters(
      fees,
      {
        district: selectedSchool.district,
        board: selectedSchool.board,
        medium: selectedSchool.medium,
        standardId: focusStandardId,
      },
      latestYear
    ).filter((f) => f.approved_fee !== null && f.approved_fee > 0);
  }, [fees, focusStandardId, latestYear, selectedSchool]);

  const segmentSnapshot = useMemo(() => {
    if (!selectedSchool) return null;
    return calculateMarketSnapshot(segmentFeesLatestYear);
  }, [segmentFeesLatestYear, selectedSchool]);

  const segmentMedianFee = segmentSnapshot?.typicalFee || 0;

  const marketIncreases = useMemo(() => {
    if (!selectedSchool) return [];
    const seg = filterValidFees(fees).filter((f) => {
      return (
        f.district === selectedSchool.district &&
        f.board === selectedSchool.board &&
        f.medium === selectedSchool.medium &&
        f.standard_id === focusStandardId
      );
    });
    const bySchool = new Map<string, Map<string, number>>();
    seg.forEach((f) => {
      if (!bySchool.has(f.school_key)) bySchool.set(f.school_key, new Map());
      bySchool.get(f.school_key)!.set(f.academic_year, f.approved_fee!);
    });
    const increases: number[] = [];
    bySchool.forEach((yearMap) => {
      const years = [...yearMap.keys()].sort();
      for (let i = 1; i < years.length; i++) {
        const prev = yearMap.get(years[i - 1])!;
        const curr = yearMap.get(years[i])!;
        if (prev > 0 && curr > 0) {
          const inc = ((curr - prev) / prev) * 100;
          if (isFinite(inc)) increases.push(inc);
        }
      }
    });
    return increases;
  }, [fees, focusStandardId, selectedSchool]);

  const marketTypicalIncrease = useMemo(() => {
    if (marketIncreases.length === 0) return 0;
    return median(marketIncreases);
  }, [marketIncreases]);

  const marketApprovedIncreaseRange = useMemo(() => {
    if (!marketTypicalIncrease) return { min: 0, max: 0 };
    const min = Math.max(0, marketTypicalIncrease * 0.5);
    const max = marketTypicalIncrease * 1.5;
    return { min, max };
  }, [marketTypicalIncrease]);

  const proposedIncreasePct = useMemo(() => {
    if (!currentFee || !proposedFeeNum) return 0;
    return ((proposedFeeNum - currentFee) / currentFee) * 100;
  }, [currentFee, proposedFeeNum]);

  const marketGrowth = useMemo(() => {
    if (!selectedSchool) return null;
    const seg = filterValidFees(fees).filter((f) => {
      return (
        f.district === selectedSchool.district &&
        f.board === selectedSchool.board &&
        f.medium === selectedSchool.medium &&
        f.standard_id === focusStandardId
      );
    });
    const yearMedians = new Map<string, number>();
    ACADEMIC_YEARS.forEach((y) => {
      const yearFees = seg.filter((f) => f.academic_year === y).map((f) => f.approved_fee!);
      if (yearFees.length >= 5) yearMedians.set(y, median(yearFees));
    });
    const years = [...yearMedians.keys()].sort();
    if (years.length < 2) return null;
    const startYear = years[0];
    const endYear = years[years.length - 1];
    const startFee = yearMedians.get(startYear)!;
    const endFee = yearMedians.get(endYear)!;
    const totalGrowth = ((endFee - startFee) / startFee) * 100;
    return { startYear, endYear, totalGrowth };
  }, [fees, focusStandardId, selectedSchool]);

  const schoolGrowth = useMemo(() => {
    if (focusHistory.length < 2) return null;
    const start = focusHistory[0].fee;
    const end = focusHistory[focusHistory.length - 1].fee;
    if (!start || !end) return null;
    const totalGrowth = ((end - start) / start) * 100;
    return { startYear: focusHistory[0].year, endYear: focusHistory[focusHistory.length - 1].year, totalGrowth };
  }, [focusHistory]);

  const frozenYears = useMemo(() => {
    if (focusHistory.length < 2) return [];
    const years: { year: string; changePct: number }[] = [];
    for (let i = 1; i < focusHistory.length; i++) {
      const prev = focusHistory[i - 1].fee;
      const curr = focusHistory[i].fee;
      const changePct = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
      years.push({ year: focusHistory[i].year, changePct });
    }
    return years;
  }, [focusHistory]);

  const checks = useMemo(() => {
    const normalMin = segmentSnapshot?.budgetCeiling ?? 0;
    const normalMax = segmentSnapshot?.premiumEntry ?? 0;
    const check1 = proposedFeeNum > 0 && normalMax > 0 && proposedFeeNum >= normalMin && proposedFeeNum <= normalMax;
    const check2 =
      proposedFeeNum > 0 &&
      currentFee > 0 &&
      proposedIncreasePct >= marketApprovedIncreaseRange.min &&
      proposedIncreasePct <= marketApprovedIncreaseRange.max;
    const check3 =
      Boolean(schoolGrowth && marketGrowth) &&
      (schoolGrowth?.totalGrowth ?? Infinity) <= (marketGrowth?.totalGrowth ?? -Infinity);
    const check4 = frozenYears.some((y) => Math.abs(y.changePct) < 0.0001);
    const check5 =
      frozenYears.every((y) => y.changePct >= -0.0001) &&
      (marketTypicalIncrease ? frozenYears.every((y) => y.changePct <= marketTypicalIncrease * 1.5 + 0.0001) : true);

    return { check1, check2, check3, check4, check5, normalMin, normalMax };
  }, [
    currentFee,
    frozenYears,
    marketApprovedIncreaseRange.max,
    marketApprovedIncreaseRange.min,
    marketGrowth,
    marketTypicalIncrease,
    proposedFeeNum,
    proposedIncreasePct,
    schoolGrowth,
    segmentSnapshot,
  ]);

  const caseScore = (Number(checks.check1) + Number(checks.check2) + Number(checks.check3) + Number(checks.check4) + Number(checks.check5)) * 20;
  const caseLabel =
    caseScore >= 80 ? "Strong Case" : caseScore >= 60 ? "Defensible" : caseScore >= 40 ? "Needs Support" : "High Risk";

  const gapVsMarketTypical = proposedFeeNum && segmentMedianFee ? proposedFeeNum - segmentMedianFee : 0;
  const premiumEntry = segmentSnapshot?.premiumEntry ?? 0;
  const roomToIncrease = currentFee && premiumEntry ? Math.max(0, premiumEntry - currentFee) : 0;

  const previousYear = useMemo(() => {
    const idx = ACADEMIC_YEARS.indexOf(latestYear as (typeof ACADEMIC_YEARS)[number]);
    if (idx <= 0) return null;
    return ACADEMIC_YEARS[idx - 1];
  }, [latestYear]);

  const schoolIncreaseLastYear = useMemo(() => {
    if (!previousYear) return null;
    const prev = focusHistory.find((h) => h.year === previousYear)?.fee;
    const curr = focusHistory.find((h) => h.year === latestYear)?.fee;
    if (!prev || !curr) return null;
    return ((curr - prev) / prev) * 100;
  }, [focusHistory, latestYear, previousYear]);

  const marketTypicalIncreaseLastYear = useMemo(() => {
    if (!selectedSchool || !previousYear) return null;
    const seg = filterValidFees(fees).filter((f) => {
      return (
        f.district === selectedSchool.district &&
        f.board === selectedSchool.board &&
        f.medium === selectedSchool.medium &&
        f.standard_id === focusStandardId &&
        (f.academic_year === latestYear || f.academic_year === previousYear)
      );
    });
    const bySchool = new Map<string, { prev?: number; curr?: number }>();
    seg.forEach((f) => {
      if (!bySchool.has(f.school_key)) bySchool.set(f.school_key, {});
      const entry = bySchool.get(f.school_key)!;
      if (f.academic_year === previousYear) entry.prev = f.approved_fee!;
      if (f.academic_year === latestYear) entry.curr = f.approved_fee!;
    });
    const increases: number[] = [];
    bySchool.forEach((v) => {
      if (v.prev && v.curr) {
        increases.push(((v.curr - v.prev) / v.prev) * 100);
      }
    });
    if (increases.length < 5) return null;
    return median(increases);
  }, [fees, focusStandardId, latestYear, previousYear, selectedSchool]);

  const feeHistogram = useMemo(() => {
    const values = segmentFeesLatestYear.map((f) => f.approved_fee!).filter((v) => v > 0);
    if (values.length === 0) return null;
    const min = Math.floor(Math.min(...values) / 5000) * 5000;
    const max = Math.ceil(Math.max(...values) / 5000) * 5000;
    const bins: { start: number; end: number; count: number }[] = [];
    for (let s = min; s < max; s += 5000) {
      const e = s + 5000;
      bins.push({ start: s, end: e, count: values.filter((v) => v >= s && v < e).length });
    }
    const total = values.length;
    const alreadyChargeMorePct =
      proposedFeeNum > 0 ? (values.filter((v) => v >= proposedFeeNum).length / total) * 100 : 0;
    return { bins, min, max, total, alreadyChargeMorePct };
  }, [proposedFeeNum, segmentFeesLatestYear]);

  const marketMediansByYear = useMemo(() => {
    if (!selectedSchool) return new Map<string, number>();
    const seg = filterValidFees(fees).filter((f) => {
      return (
        f.district === selectedSchool.district &&
        f.board === selectedSchool.board &&
        f.medium === selectedSchool.medium &&
        f.standard_id === focusStandardId
      );
    });
    const map = new Map<string, number>();
    ACADEMIC_YEARS.forEach((y) => {
      const arr = seg.filter((f) => f.academic_year === y).map((f) => f.approved_fee!);
      if (arr.length >= 5) map.set(y, median(arr));
    });
    return map;
  }, [fees, focusStandardId, selectedSchool]);

  const catchUpEntitlement = useMemo(() => {
    if (frozenYears.length === 0) return null;
    let frozenCount = 0;
    let marketGrowthDuringFreeze = 0;
    for (const y of frozenYears) {
      if (Math.abs(y.changePct) < 0.0001) {
        frozenCount++;
        const idx = ACADEMIC_YEARS.indexOf(y.year as (typeof ACADEMIC_YEARS)[number]);
        if (idx > 0) {
          const prevYear = ACADEMIC_YEARS[idx - 1];
          const prev = marketMediansByYear.get(prevYear);
          const curr = marketMediansByYear.get(y.year);
          if (prev && curr && prev > 0) {
            marketGrowthDuringFreeze += ((curr - prev) / prev) * 100;
          }
        }
      }
    }
    if (frozenCount === 0) return null;
    const entitlementPct = Math.max(0, marketGrowthDuringFreeze);
    const amount = currentFee ? (currentFee * entitlementPct) / 100 : 0;
    return { frozenCount, marketGrowthDuringFreeze: entitlementPct, amount };
  }, [currentFee, frozenYears, marketMediansByYear]);

  const comparableSchools = useMemo(() => {
    if (!selectedSchool) return [];
    if (!proposedFeeNum) return [];
    const peers = segmentFeesLatestYear
      .map((f) => ({
        school_key: f.school_key,
        school_name: f.school_name,
        index_number: f.index_number,
        fee: f.approved_fee!,
      }))
      .sort((a, b) => Math.abs(a.fee - proposedFeeNum) - Math.abs(b.fee - proposedFeeNum));
    const top = peers.slice(0, 10);
    const your = peers.find((p) => p.school_key === selectedSchool.school_key);
    const pinned = your ? [your, ...top.filter((p) => p.school_key !== your.school_key).slice(0, 9)] : top;
    return pinned;
  }, [proposedFeeNum, segmentFeesLatestYear, selectedSchool]);

  const segmentMedianLine = useMemo(() => {
    const values = segmentFeesLatestYear.map((f) => f.approved_fee!).filter((v) => v > 0);
    if (values.length === 0) return 0;
    return median(values);
  }, [segmentFeesLatestYear]);

  const downloadEvidenceSummaryPdf = () => {
    if (!selectedSchool) return;
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text("FRC Evidence Summary", 14, 16);
    doc.setFontSize(10);
    doc.text(`School: ${selectedSchool.school_name}`, 14, 24);
    doc.text(`District: ${selectedSchool.district} | Board: ${selectedSchool.board} | Medium: ${selectedSchool.medium}`, 14, 30);
    doc.text(`Grade: ${focusStandard?.standard_name ?? "—"} | Year: ${latestYear}`, 14, 36);
    doc.text(`Proposed fee: ${proposedFeeNum ? formatRupees(proposedFeeNum) : "—"}`, 14, 42);
    doc.text(`Case score: ${caseScore}/100 (${caseLabel})`, 14, 48);

    autoTable(doc, {
      startY: 56,
      head: [["Metric", "Value"]],
      body: [
        ["Current fee", currentFee ? formatRupees(currentFee) : "—"],
        ["Market typical", segmentSnapshot ? formatRupees(segmentSnapshot.typicalFee) : "—"],
        ["Premium entry point", segmentSnapshot ? formatRupees(segmentSnapshot.premiumEntry) : "—"],
        ["Proposed increase", currentFee && proposedFeeNum ? formatPercent(proposedIncreasePct, 0) : "—"],
        ["Market typical increase", marketTypicalIncrease ? formatPercent(marketTypicalIncrease, 0) : "—"],
        ["Your total growth", schoolGrowth ? formatPercent(schoolGrowth.totalGrowth, 0) : "—"],
        ["Market total growth", marketGrowth ? formatPercent(marketGrowth.totalGrowth, 0) : "—"],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });

    doc.save("frc-evidence-summary.pdf");
  };

  const downloadPeerComparisonPdf = () => {
    if (!selectedSchool) return;
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(14);
    doc.text("Peer Comparison Table", 14, 16);
    doc.setFontSize(10);
    doc.text(`School: ${selectedSchool.school_name} | Proposed: ${proposedFeeNum ? formatRupees(proposedFeeNum) : "—"}`, 14, 24);
    doc.text(`Segment: ${selectedSchool.district} | ${selectedSchool.board} | ${selectedSchool.medium} | ${focusStandard?.standard_name ?? "—"} | ${latestYear}`, 14, 30);

    autoTable(doc, {
      startY: 38,
      head: [["School", "Index", "Their fee", "vs your proposed"]],
      body: comparableSchools.map((p) => {
        const diff = p.fee - proposedFeeNum;
        const vs =
          !proposedFeeNum
            ? "—"
            : diff >= 0
              ? `+${formatRupees(diff)} above yours`
              : `−${formatRupees(Math.abs(diff))} below`;
        const name = p.school_key === selectedSchool.school_key ? `${p.school_name} (Your School)` : p.school_name;
        return [name, p.index_number, formatRupees(p.fee), vs];
      }),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: { 0: { cellWidth: 120 } },
    });

    doc.save("peer-comparison-table.pdf");
  };

  const downloadEvidenceSummaryPdfAllGrades = () => {
    if (!selectedSchool) return;
    const standardIds = gradeOptions.map((g) => g.id);
    if (standardIds.length === 0) return;

    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text("FRC Evidence Summary (All Grades)", 14, 16);
    doc.setFontSize(10);
    doc.text(`School: ${selectedSchool.school_name}`, 14, 24);
    doc.text(
      `District: ${selectedSchool.district} | Board: ${selectedSchool.board} | Medium: ${selectedSchool.medium}`,
      14,
      30
    );
    doc.text(`Year: ${latestYear}`, 14, 36);
    doc.text(
      "Note: Proposed fee uses your entered value; if blank, it uses the current approved fee for that grade.",
      14,
      42
    );

    const rows = standardIds.map((standardId) => {
      const name =
        STANDARDS.find((s) => s.standard_id === standardId)?.standard_name ??
        `Grade ${standardId}`;
      const hist = feesByStandard[standardId] ?? [];
      const curr = hist.find((h) => h.year === latestYear)?.fee ?? 0;
      const proposedRaw = (proposedFeesByStandard[standardId] ?? "").replace(/,/g, "");
      const proposedParsed = parseFloat(proposedRaw);
      const proposed = Number.isFinite(proposedParsed) && proposedParsed > 0 ? proposedParsed : curr;
      const incPct = curr > 0 && proposed > 0 ? ((proposed - curr) / curr) * 100 : 0;

      const marketFees = applyFilters(
        fees,
        {
          district: selectedSchool.district,
          board: selectedSchool.board,
          medium: selectedSchool.medium,
          standardId,
        },
        latestYear
      ).filter((f) => f.approved_fee !== null && f.approved_fee > 0);
      const snapshot = calculateMarketSnapshot(marketFees);

      return [
        name,
        curr ? formatRupees(curr) : "—",
        proposed ? formatRupees(proposed) : "—",
        curr && proposed ? formatPercent(incPct, 0) : "—",
        snapshot ? formatRupees(snapshot.typicalFee) : "—",
        snapshot ? formatRupees(snapshot.premiumEntry) : "—",
      ];
    });

    autoTable(doc, {
      startY: 50,
      head: [["Grade", "Current", "Proposed", "Increase", "Market typical", "Premium entry"]],
      body: rows,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: {
        0: { cellWidth: 40 },
        1: { halign: "right" },
        2: { halign: "right" },
        3: { halign: "right" },
        4: { halign: "right" },
        5: { halign: "right" },
      },
    });

    doc.save("frc-evidence-summary-all-grades.pdf");
  };

  const downloadPeerComparisonPdfAllGrades = () => {
    if (!selectedSchool) return;
    const standardIds = gradeOptions.map((g) => g.id);
    if (standardIds.length === 0) return;

    const doc = new jsPDF({ orientation: "landscape" });
    const addHeader = (title: string, sub: string) => {
      doc.setFontSize(14);
      doc.text(title, 14, 16);
      doc.setFontSize(10);
      doc.text(`School: ${selectedSchool.school_name}`, 14, 24);
      doc.text(sub, 14, 30);
    };

    let first = true;
    for (const standardId of standardIds) {
      const name =
        STANDARDS.find((s) => s.standard_id === standardId)?.standard_name ??
        `Grade ${standardId}`;
      const hist = feesByStandard[standardId] ?? [];
      const curr = hist.find((h) => h.year === latestYear)?.fee ?? 0;
      const proposedRaw = (proposedFeesByStandard[standardId] ?? "").replace(/,/g, "");
      const proposedParsed = parseFloat(proposedRaw);
      const proposed = Number.isFinite(proposedParsed) && proposedParsed > 0 ? proposedParsed : curr;
      if (!proposed) continue;

      const segment = applyFilters(
        fees,
        {
          district: selectedSchool.district,
          board: selectedSchool.board,
          medium: selectedSchool.medium,
          standardId,
        },
        latestYear
      ).filter((f) => f.approved_fee !== null && f.approved_fee > 0);

      const peers = segment
        .map((f) => ({
          school_key: f.school_key,
          school_name: f.school_name,
          index_number: f.index_number,
          fee: f.approved_fee!,
        }))
        .sort((a, b) => Math.abs(a.fee - proposed) - Math.abs(b.fee - proposed));
      const top = peers.slice(0, 10);
      const your = peers.find((p) => p.school_key === selectedSchool.school_key);
      const pinned = your
        ? [your, ...top.filter((p) => p.school_key !== your.school_key).slice(0, 9)]
        : top;

      if (!first) doc.addPage();
      first = false;

      addHeader(
        "Peer Comparison (All Grades)",
        `Segment: ${selectedSchool.district} | ${selectedSchool.board} | ${selectedSchool.medium} | ${name} | ${latestYear} | Proposed: ${formatRupees(proposed)}`
      );

      autoTable(doc, {
        startY: 38,
        head: [["School", "Index", "Their fee", "vs your proposed"]],
        body: pinned.map((p) => {
          const diff = p.fee - proposed;
          const vs =
            diff >= 0
              ? `+${formatRupees(diff)} above yours`
              : `−${formatRupees(Math.abs(diff))} below`;
          const label =
            p.school_key === selectedSchool.school_key
              ? `${p.school_name} (Your School)`
              : p.school_name;
          return [label, p.index_number, formatRupees(p.fee), vs];
        }),
        styles: { fontSize: 9 },
        headStyles: { fillColor: [30, 41, 59] },
        columnStyles: { 0: { cellWidth: 120 } },
      });
    }

    doc.save("peer-comparison-all-grades.pdf");
  };

  const computeRoomPinFromClientX = (clientX: number) => {
    if (!roomBarRef.current) return;
    if (!segmentSnapshot || !currentFee) return;
    const rect = roomBarRef.current.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const ratio = rect.width > 0 ? x / rect.width : 0;
    const min = currentFee;
    const max = segmentSnapshot.premiumEntry;
    const value = Math.round(min + ratio * (max - min));
    setProposedFeesByStandard((prev) => ({
      ...prev,
      [focusStandardId]: value > 0 ? value.toString() : "",
    }));
  };

  useEffect(() => {
    if (!isDraggingPin) return;
    const onMove = (e: MouseEvent) => computeRoomPinFromClientX(e.clientX);
    const onUp = () => setIsDraggingPin(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDraggingPin, segmentSnapshot, currentFee]);

  // Chart tooltip
  const ChartTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: Array<{
      value: number;
      name: string;
      color: string;
      dataKey: string;
    }>;
    label?: string;
  }) => {
    if (active && payload && payload.length) {
      return (
        <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
          <p className="mb-1 font-medium text-foreground">{label}</p>
          {payload.map((entry) => (
            <p
              key={entry.dataKey}
              className="text-sm"
              style={{ color: entry.color }}
            >
              {entry.name}: {formatRupees(entry.value)}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground md:text-3xl">
          My School Analysis
        </h1>
        <p className="mt-1 text-muted-foreground">
          Build evidence for your fee revision application
        </p>
      </div>

      {/* School Search */}
      <Card className="mb-8 border-border bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-medium text-foreground">
            <Search className="h-4 w-4" />
            Find Your School
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 pb-3">
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <div className="relative flex-1">
              <Input
                type="text"
                placeholder="Search by school name or index number..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-input"
              />
            {searchResults.length > 0 && !selectedSchool && (
              <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-border bg-popover shadow-lg">
                {searchResults.map((school) => (
                  <button
                    key={school.school_key}
                    onClick={() => {
                      const latestFees = filterValidFees(fees)
                        .filter(
                          (f) =>
                            f.school_key === school.school_key &&
                            f.academic_year === latestYear
                        )
                        .map((f) => f.standard_id);

                      setSelectedSchool(school);
                      setSearchQuery(school.school_name);
                      if (latestFees.length > 0) {
                        setFocusStandardId(latestFees[0]);
                      } else {
                        setFocusStandardId(8);
                      }
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted"
                  >
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-foreground">
                        {school.school_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {school.district} | {school.board} | Index:{" "}
                        {school.index_number}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            </div>

              <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center">
                {selectedSchool && gradeOptions.length > 0 && (
                  <div className="w-full md:w-[170px]">
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                      Grade
                    </div>
                    <Select
                      value={String(focusStandardId)}
                      onValueChange={(v) => setFocusStandardId(parseInt(v))}
                    >
                      <SelectTrigger size="sm" className="w-full">
                        <SelectValue placeholder="Select grade" />
                      </SelectTrigger>
                      <SelectContent>
                        {gradeOptions.map((g) => (
                          <SelectItem key={g.id} value={String(g.id)}>
                            {g.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="w-full md:w-[220px]">
                  <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                    <span>Proposed fee</span>
                    <span className="font-normal">
                      Current:{" "}
                      <span className="font-medium text-foreground">
                        {currentFee ? formatRupees(currentFee) : "—"}
                      </span>
                    </span>
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      ₹
                    </span>
                    <Input
                      type="text"
                      placeholder="0"
                      value={proposedFee}
                      onChange={(e) => {
                        const value = e.target.value.replace(/[^\d,]/g, "");
                        setProposedFeesByStandard((prev) => ({
                          ...prev,
                          [focusStandardId]: value,
                        }));
                      }}
                      className="bg-input pl-7"
                    />
                  </div>
                </div>
              </div>
            </div>

          {selectedSchool && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="bg-primary/20 text-primary">
                  {selectedSchool.board}
                </Badge>
                <Badge className="bg-muted text-muted-foreground">
                  {selectedSchool.medium} Medium
                </Badge>
                <Badge className="bg-muted text-muted-foreground">
                  {selectedSchool.district}
                </Badge>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedSchool(null);
                  setSearchQuery("");
                  setProposedFeesByStandard({});
                  setFocusStandardId(8);
                }}
              >
                Change School
              </Button>
            </div>
          )}
          </div>
        </CardContent>
      </Card>

      {selectedSchool ? (
        <div className="space-y-8">
          <Card className="relative overflow-hidden border-border bg-card">
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/12 via-transparent to-transparent" />
            <CardHeader className="relative pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base font-semibold text-foreground">
                      Grade analysis
                    </CardTitle>
                    <div className="mt-1 text-sm text-muted-foreground">
                      Changes with selected grade and proposed fee.
                    </div>
                  </div>
                  <Badge className="bg-muted text-muted-foreground">
                    {focusStandard?.standard_name ?? "—"}
                  </Badge>
                </div>
            </CardHeader>
            <CardContent className="relative space-y-8 pt-0">

          {/* Case Strength Gauge */}
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Case Strength Gauge
              </h2>
              <p className="text-sm text-muted-foreground">
                Live strength score for your proposed fee
              </p>
            </div>

            <Card className="border-border bg-card">
              <CardContent className="pt-6">
                <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
                  <div className="flex flex-col items-center">
                    <div className="relative h-64 w-64">
                      <svg viewBox="0 0 120 120" className="h-full w-full">
                        <circle
                          cx="60"
                          cy="60"
                          r="50"
                          fill="none"
                          stroke="hsl(var(--muted))"
                          strokeWidth="10"
                        />
                        {[
                          checks.check1,
                          checks.check2,
                          checks.check3,
                          checks.check4,
                          checks.check5,
                        ].map((ok, i) => {
                          const circumference = 2 * Math.PI * 50;
                          const seg = circumference / 5;
                          const gap = 6;
                          const segLen = seg - gap;
                          const offset = circumference - i * seg;
                          return (
                            <circle
                              key={i}
                              cx="60"
                              cy="60"
                              r="50"
                              fill="none"
                              stroke={ok ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))"}
                              strokeOpacity={ok ? 0.9 : 0.35}
                              strokeWidth="10"
                              strokeDasharray={`${segLen} ${circumference}`}
                              strokeDashoffset={offset}
                              strokeLinecap="round"
                              transform="rotate(-90 60 60)"
                            />
                          );
                        })}
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <div className="text-4xl font-bold text-foreground">
                          {caseScore}
                        </div>
                        <div className="mt-1 text-sm font-medium text-muted-foreground">
                          {caseLabel}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="grid gap-2">
                      <div className="flex items-start gap-2 text-sm">
                        <span className={checks.check1 ? "text-emerald-400" : "text-muted-foreground"}>
                          {checks.check1 ? "✓" : "✗"}
                        </span>
                        <span className="text-muted-foreground">
                          Proposed fee is within the normal approved range for this segment ({formatRupees(checks.normalMin)} – {formatRupees(checks.normalMax)}).
                        </span>
                      </div>
                      <div className="flex items-start gap-2 text-sm">
                        <span className={checks.check2 ? "text-emerald-400" : "text-muted-foreground"}>
                          {checks.check2 ? "✓" : "✗"}
                        </span>
                        <span className="text-muted-foreground">
                          Proposed increase ({formatPercent(proposedIncreasePct, 0)}) sits within what FRC has typically approved here ({formatPercent(marketApprovedIncreaseRange.min, 0)} – {formatPercent(marketApprovedIncreaseRange.max, 0)}).
                        </span>
                      </div>
                      <div className="flex items-start gap-2 text-sm">
                        <span className={checks.check3 ? "text-emerald-400" : "text-muted-foreground"}>
                          {checks.check3 ? "✓" : "✗"}
                        </span>
                        <span className="text-muted-foreground">
                          Your total fee growth is lower than market growth since the earliest year.
                        </span>
                      </div>
                      <div className="flex items-start gap-2 text-sm">
                        <span className={checks.check4 ? "text-emerald-400" : "text-muted-foreground"}>
                          {checks.check4 ? "✓" : "✗"}
                        </span>
                        <span className="text-muted-foreground">
                          You have at least one year with zero fee increase on this grade.
                        </span>
                      </div>
                      <div className="flex items-start gap-2 text-sm">
                        <span className={checks.check5 ? "text-emerald-400" : "text-muted-foreground"}>
                          {checks.check5 ? "✓" : "✗"}
                        </span>
                        <span className="text-muted-foreground">
                          Your fee history shows consistent, grade-appropriate increases.
                        </span>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <Card className="border-border bg-card">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">
                            Your Fee vs Market Typical
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-xl font-bold text-foreground">
                            {gapVsMarketTypical ? formatRupees(Math.abs(gapVsMarketTypical)) : "—"}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {gapVsMarketTypical >= 0 ? "above" : "below"} typical
                          </p>
                        </CardContent>
                      </Card>

                      <Card className="border-border bg-card">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">
                            Your Total Growth vs Market Growth
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-sm font-medium text-foreground">
                            You: {schoolGrowth ? formatPercent(schoolGrowth.totalGrowth, 0) : "—"} · Market: {marketGrowth ? formatPercent(marketGrowth.totalGrowth, 0) : "—"}
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="border-border bg-card">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">
                            Room to Increase
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-xl font-bold text-foreground">
                            {roomToIncrease ? formatRupees(roomToIncrease) : "—"}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            before Premium Entry Point
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Last year increase vs market */}
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                How Did Your Fee Change Compare to Similar Schools Last Year?
              </h2>
              <p className="text-sm text-muted-foreground">
                {focusStandard?.standard_name} in {selectedSchool.district}
              </p>
            </div>
            <Card className="border-border bg-card">
              <CardContent className="pt-6">
                <div className="grid gap-6 md:grid-cols-2">
                  <div>
                    <div className="text-sm font-medium text-muted-foreground">
                      Your Increase Last Year
                    </div>
                    <div className="mt-2 h-3 w-full overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-primary"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(0, ((schoolIncreaseLastYear ?? 0) / 25) * 100)
                          )}%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 text-sm font-medium text-foreground">
                      {schoolIncreaseLastYear === null
                        ? "—"
                        : formatPercent(schoolIncreaseLastYear, 0)}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-muted-foreground">
                      Market Typical Increase
                    </div>
                    <div className="mt-2 h-3 w-full overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-slate-500"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(
                              0,
                              ((marketTypicalIncreaseLastYear ?? 0) / 25) * 100
                            )
                          )}%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 text-sm font-medium text-foreground">
                      {marketTypicalIncreaseLastYear === null
                        ? "—"
                        : formatPercent(marketTypicalIncreaseLastYear, 0)}
                    </div>
                  </div>
                </div>
                {schoolIncreaseLastYear !== null &&
                  marketTypicalIncreaseLastYear !== null && (
                    <p
                      className={cn(
                        "mt-4 text-sm font-medium",
                        schoolIncreaseLastYear <= marketTypicalIncreaseLastYear
                          ? "text-emerald-400"
                          : "text-red-400"
                      )}
                    >
                      {schoolIncreaseLastYear <= marketTypicalIncreaseLastYear
                        ? "Your last-year increase was below market typical."
                        : "Your last-year increase was above market typical."}
                    </p>
                  )}
              </CardContent>
            </Card>
          </section>

          {/* Proposed fee placement */}
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Where Does Your Proposed Fee Sit?
              </h2>
              <p className="text-sm text-muted-foreground">
                Distribution and available room up to Premium Entry Point
              </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base font-medium text-foreground">
                    Fee Distribution
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {!feeHistogram ? (
                    <p className="py-8 text-center text-muted-foreground">
                      No data available for this segment.
                    </p>
                  ) : (
                    <>
                      <LoadingOverlay show={isUpdatingCharts} label="Updating chart…">
                        <div className="mt-2 h-64 w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                              data={feeHistogram.bins}
                              margin={{ top: 12, right: 12, left: 28, bottom: 28 }}
                              barCategoryGap={2}
                            >
                              <CartesianGrid
                                stroke="#334155"
                                strokeOpacity={0.25}
                                vertical={false}
                              />
                              <XAxis
                                dataKey="start"
                                stroke="#64748b"
                                fontSize={10}
                                tickLine={false}
                                interval="preserveStartEnd"
                                tickFormatter={(v) => `₹${Math.round(Number(v) / 1000)}K`}
                                label={{
                                  value: "Fee (₹)",
                                  position: "insideBottom",
                                  offset: -18,
                                  fill: "#94a3b8",
                                  fontSize: 11,
                                }}
                              />
                              <YAxis
                                stroke="#64748b"
                                fontSize={10}
                                tickLine={false}
                                allowDecimals={false}
                                label={{
                                  value: "Schools",
                                  angle: -90,
                                  position: "insideLeft",
                                  offset: 0,
                                  fill: "#94a3b8",
                                  fontSize: 11,
                                }}
                              />
                              <Tooltip content={<FeeDistributionTooltip />} />
                              {proposedFeeNum > 0 && (
                                <ReferenceLine
                                  x={Math.floor(proposedFeeNum / 5000) * 5000}
                                  stroke="hsl(var(--foreground))"
                                  strokeOpacity={0.8}
                                />
                              )}
                              <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="#475569" />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </LoadingOverlay>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {proposedFeeNum > 0 ? (
                          <>
                            <span className="font-medium text-foreground">
                              {formatPercent(feeHistogram.alreadyChargeMorePct, 0)}
                            </span>{" "}
                            of schools already charge this or more.
                          </>
                        ) : (
                          "Enter a proposed fee to see where it sits."
                        )}
                      </p>
                      {proposedFeeNum > 0 && (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {feeHistogram.alreadyChargeMorePct >= 60
                            ? "This ask is common in this segment."
                            : feeHistogram.alreadyChargeMorePct >= 30
                              ? "This ask is defensible but not typical."
                              : "This ask is above most schools in this segment."}
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base font-medium text-foreground">
                    Room to Increase
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {!segmentSnapshot || !currentFee ? (
                    <p className="py-8 text-center text-muted-foreground">
                      Select a grade with current fee data to view room.
                    </p>
                  ) : (
                    <>
                      <div
                        ref={roomBarRef}
                        className="relative mt-4 h-10 w-full overflow-hidden rounded-lg bg-muted"
                        onMouseDown={(e) => {
                          setIsDraggingPin(true);
                          computeRoomPinFromClientX(e.clientX);
                        }}
                      >
                        <div className="absolute inset-0 flex">
                          <div className="h-full w-[70%] bg-emerald-500/25" />
                          <div className="h-full flex-1 bg-amber-500/20" />
                        </div>
                        {/* Pin */}
                        {proposedFeeNum > 0 && (
                          <div
                            className="absolute top-0 h-full w-0.5 bg-foreground"
                            style={{
                              left: `${Math.min(
                                100,
                                Math.max(
                                  0,
                                  ((proposedFeeNum - currentFee) /
                                    (segmentSnapshot.premiumEntry - currentFee)) *
                                    100
                                )
                              )}%`,
                            }}
                          >
                            <div className="absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-2 border-foreground bg-card" />
                          </div>
                        )}
                      </div>
                      <div className="mt-3 flex justify-between text-xs text-muted-foreground">
                        <span>Current: {formatRupees(currentFee)}</span>
                        <span>
                          Premium Entry Point: {formatRupees(segmentSnapshot.premiumEntry)}
                        </span>
                      </div>
                      {proposedFeeNum > 0 && segmentSnapshot.premiumEntry > currentFee && (
                        (() => {
                          const available = segmentSnapshot.premiumEntry - currentFee;
                          const asking = proposedFeeNum - currentFee;
                          const pct = (asking / available) * 100;
                          const descriptor =
                            pct <= 70 ? "comfortable" : pct <= 100 ? "aggressive" : "above-market";
                          return (
                            <p className="mt-3 text-sm text-muted-foreground">
                              You are requesting{" "}
                              <span className="font-medium text-foreground">
                                {formatRupees(Math.max(0, asking))}
                              </span>{" "}
                              of your{" "}
                              <span className="font-medium text-foreground">
                                {formatRupees(available)}
                              </span>{" "}
                              available room ({formatPercent(Math.max(0, pct), 0)}). This is a{" "}
                              <span className="font-medium text-foreground">
                                {descriptor}
                              </span>{" "}
                              ask.
                            </p>
                          );
                        })()
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </section>

          {/* Frozen fee years */}
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Frozen Fee Years &amp; Your Catch-Up Entitlement
              </h2>
              <p className="text-sm text-muted-foreground">
                {focusStandard?.standard_name} fee change % per year
              </p>
            </div>
            <Card className="border-border bg-card">
              <CardContent className="pt-6">
                {frozenYears.length === 0 ? (
                  <p className="text-muted-foreground">
                    Not enough fee history to evaluate freezes for this grade.
                  </p>
                ) : (
                  <>
                    <LoadingOverlay show={isUpdatingCharts} label="Updating chart…">
                      <div className="h-[280px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart
                            data={frozenYears.map((y) => ({ ...y, label: y.year }))}
                            margin={{ top: 12, right: 16, left: 34, bottom: 28 }}
                          >
                            <CartesianGrid stroke="#334155" strokeOpacity={0.25} vertical={false} />
                            <XAxis
                              dataKey="label"
                              stroke="#64748b"
                              fontSize={11}
                              tickLine={false}
                              label={{
                                value: "Academic year",
                                position: "insideBottom",
                                offset: -18,
                                fill: "#94a3b8",
                                fontSize: 11,
                              }}
                            />
                            <YAxis
                              stroke="#64748b"
                              fontSize={11}
                              tickLine={false}
                              tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                            >
                              <Label
                                value="Fee change (%)"
                                angle={-90}
                                position="insideLeft"
                                style={{
                                  textAnchor: "middle",
                                  fill: "#94a3b8",
                                  fontSize: 11,
                                }}
                              />
                            </YAxis>
                            <Tooltip content={<FrozenYearsTooltip />} />
                            <Bar dataKey="changePct" radius={[4, 4, 0, 0]}>
                              {frozenYears.map((y) => (
                                <Cell
                                  key={y.year}
                                  fill={
                                    Math.abs(y.changePct) < 0.0001
                                      ? "#f59e0b"
                                      : CHART_COLORS.cbse
                                  }
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </LoadingOverlay>
                    <p className="mt-3 text-sm text-muted-foreground">
                      {catchUpEntitlement ? (
                        <>
                          You had{" "}
                          <span className="font-medium text-foreground">
                            {catchUpEntitlement.frozenCount}
                          </span>{" "}
                          year(s) of no increase. In those years the market grew by{" "}
                          <span className="font-medium text-foreground">
                            {formatPercent(catchUpEntitlement.marketGrowthDuringFreeze, 0)}
                          </span>
                          . This gives you a catch-up entitlement of up to{" "}
                          <span className="font-medium text-foreground">
                            {formatPercent(catchUpEntitlement.marketGrowthDuringFreeze, 0)}
                          </span>{" "}
                          — approximately{" "}
                          <span className="font-medium text-foreground">
                            {formatRupees(catchUpEntitlement.amount)}
                          </span>{" "}
                          at your current fee.
                        </>
                      ) : (
                        "Your school increased fees every year — no freeze argument available."
                      )}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </section>

          {/* Approved peers */}
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Schools FRC Has Already Approved at Similar Fees
              </h2>
              <p className="text-sm text-muted-foreground">
                Comparable schools in {selectedSchool.district} ({selectedSchool.board})
              </p>
            </div>
            <Card className="border-border bg-card">
              <CardContent className="pt-6">
                {comparableSchools.length === 0 ? (
                  <p className="text-muted-foreground">
                    Enter a proposed fee to see comparable schools.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {
                          comparableSchools.filter((p) => p.fee >= proposedFeeNum)
                            .length
                        }
                      </span>{" "}
                      of {comparableSchools.length} comparable schools already charge{" "}
                      <span className="font-medium text-foreground">
                        {formatRupees(proposedFeeNum)}
                      </span>{" "}
                      or more for {focusStandard?.standard_name} in{" "}
                      {selectedSchool.district}.
                    </p>

                    <div className="mt-4 overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border hover:bg-transparent">
                            <TableHead className="text-muted-foreground">
                              School Name
                            </TableHead>
                            <TableHead className="text-muted-foreground">
                              Index Number
                            </TableHead>
                            <TableHead className="text-right text-muted-foreground">
                              Their Fee
                            </TableHead>
                            <TableHead className="text-right text-muted-foreground">
                              vs. Your Proposed Fee
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {comparableSchools.map((p) => {
                            const diff = p.fee - proposedFeeNum;
                            const isYou = p.school_key === selectedSchool.school_key;
                            return (
                              <TableRow key={p.school_key} className="border-border">
                                <TableCell className="font-medium text-foreground">
                                  <div className="flex items-center gap-2">
                            <span className="max-w-[420px] truncate">
                              {p.school_name}
                            </span>
                                    {isYou && (
                                      <Badge className="bg-primary/20 text-primary">
                                        Your School
                                      </Badge>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                  {p.index_number}
                                </TableCell>
                                <TableCell className="text-right font-medium text-foreground">
                                  {formatRupees(p.fee)}
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    "text-right text-sm",
                                    diff >= 0 ? "text-emerald-400" : "text-muted-foreground"
                                  )}
                                >
                                  {diff >= 0
                                    ? `+${formatRupees(diff)} above yours`
                                    : `−${formatRupees(Math.abs(diff))} below`}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Dot plot */}
                    <div className="mt-6">
                      <div className="relative h-12 w-full rounded bg-muted">
                        {(() => {
                          const peerFees = comparableSchools.map((p) => p.fee);
                          const min = Math.min(...peerFees, proposedFeeNum);
                          const max = Math.max(...peerFees, proposedFeeNum);
                          const pos = (v: number) =>
                            max === min ? 50 : ((v - min) / (max - min)) * 100;
                          return (
                            <>
                              <div
                                className="absolute top-0 bottom-0 w-0.5 bg-slate-400/70"
                                style={{ left: `${pos(segmentMedianLine)}%` }}
                              />
                              {comparableSchools.map((p) => (
                                <div
                                  key={p.school_key}
                                  className="absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-slate-200/80"
                                  style={{ left: `${pos(p.fee)}%` }}
                                  title={`${p.school_name}: ${formatRupees(p.fee)}`}
                                />
                              ))}
                              <div
                                className="absolute top-1/2 -translate-y-1/2 text-foreground"
                                style={{ left: `${pos(proposedFeeNum)}%` }}
                                title={`Proposed: ${formatRupees(proposedFeeNum)}`}
                              >
                                ★
                              </div>
                            </>
                          );
                        })()}
                      </div>
                      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                        <span>Lower</span>
                        <span>Higher</span>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </section>

            </CardContent>
          </Card>

          <Card className="relative overflow-hidden border-border bg-card">
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-slate-500/10 via-transparent to-transparent" />
            <CardHeader className="relative pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base font-semibold text-foreground">
                      School overview
                    </CardTitle>
                    <div className="mt-1 text-sm text-muted-foreground">
                      Changes only when you change the school.
                    </div>
                  </div>
                </div>
            </CardHeader>
            <CardContent className="relative space-y-8 pt-0">

          {/* Fee History Overview */}
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Your Fee History
              </h2>
              <p className="text-sm text-muted-foreground">
                Historical approved fees vs. market median
              </p>
            </div>

            {Object.keys(feesByStandard).length === 0 ? (
              <Card className="border-border bg-card">
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">
                    No fee data found for this school
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {Object.entries(feesByStandard)
                  .sort(([a], [b]) => parseInt(a) - parseInt(b))
                  .map(([standardId, history]) => {
                    const standard = STANDARDS.find(
                      (s) => s.standard_id === parseInt(standardId)
                    );
                    const growth = totalGrowth[parseInt(standardId)];

                    return (
                      <Card
                        key={standardId}
                        className="border-border bg-card"
                      >
                        <CardHeader className="pb-2">
                          <CardTitle className="text-base font-medium text-foreground">
                            {standard?.standard_name}
                          </CardTitle>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            {growth && (
                              <>
                                <span className="flex items-center gap-1">
                                  <TrendingUp className="h-3 w-3" />
                                  {formatPercent(growth.growth)} total growth
                                </span>
                                <span>
                                  {yearsNoIncrease[parseInt(standardId)] || 0}{" "}
                                  years of no increase
                                </span>
                              </>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="h-[200px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart
                                data={history}
                                margin={{
                                  top: 10,
                                  right: 20,
                                  left: 20,
                                  bottom: 5,
                                }}
                              >
                                <XAxis
                                  dataKey="year"
                                  stroke="#64748b"
                                  fontSize={10}
                                  tickLine={false}
                                />
                                <YAxis
                                  stroke="#64748b"
                                  fontSize={10}
                                  tickLine={false}
                                  tickFormatter={(val) =>
                                    `₹${(val / 1000).toFixed(0)}K`
                                  }
                                />
                                <Tooltip content={<ChartTooltip />} />
                                <Legend verticalAlign="top" height={30} />
                                <Line
                                  type="monotone"
                                  dataKey="fee"
                                  name="Your Fee"
                                  stroke="#3b82f6"
                                  strokeWidth={2}
                                  dot={{ r: 3 }}
                                />
                                <Line
                                  type="monotone"
                                  dataKey="marketMedian"
                                  name="Market Median"
                                  stroke="#64748b"
                                  strokeWidth={1}
                                  strokeDasharray="5 5"
                                  dot={false}
                                />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
              </div>
            )}
          </section>

          {/* Current Market Position */}
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Current Market Position
              </h2>
              <p className="text-sm text-muted-foreground">
                Where your fees stand compared to similar schools in{" "}
                {selectedSchool.district}
              </p>
            </div>

            <Card className="border-border bg-card">
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-muted-foreground">
                          Grade
                        </TableHead>
                        <TableHead className="text-right text-muted-foreground">
                          Your Fee
                        </TableHead>
                        <TableHead className="text-right text-muted-foreground">
                          Market Typical
                        </TableHead>
                        <TableHead className="text-center text-muted-foreground">
                          Position
                        </TableHead>
                        <TableHead className="text-center text-muted-foreground">
                          Market Size
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {currentPosition.map((pos) =>
                        pos ? (
                          <TableRow
                            key={pos.standardId}
                            className={cn(
                              "cursor-pointer border-border transition-colors hover:bg-muted/50",
                              pos.standardId === focusStandardId && "bg-primary/10"
                            )}
                            onClick={() => setFocusStandardId(pos.standardId)}
                          >
                            <TableCell className="font-medium text-foreground">
                              {pos.standardName}
                            </TableCell>
                            <TableCell className="text-right font-semibold text-foreground">
                              {formatRupees(pos.currentFee)}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {formatRupees(pos.marketMedian)}
                            </TableCell>
                            <TableCell className="text-center">
                              <Badge
                                className={cn(
                                  "text-xs",
                                  pos.tier === "Budget" &&
                                    "bg-emerald-500/20 text-emerald-400",
                                  pos.tier === "Lower Mid" &&
                                    "bg-blue-500/20 text-blue-400",
                                  pos.tier === "Upper Mid" &&
                                    "bg-amber-500/20 text-amber-400",
                                  pos.tier === "Premium" &&
                                    "bg-red-500/20 text-red-400"
                                )}
                              >
                                {pos.tier}
                              </Badge>
                              <span className="ml-2 text-xs text-muted-foreground">
                                Top {formatPercent(100 - pos.percentile, 0)}
                              </span>
                            </TableCell>
                            <TableCell className="text-center text-muted-foreground">
                              {pos.schoolCount} schools
                            </TableCell>
                          </TableRow>
                        ) : null
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Evidence Summary */}
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Evidence Summary for FRC Application
              </h2>
              <p className="text-sm text-muted-foreground">
                Key points to support your fee revision request
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <TrendingUp className="h-4 w-4" />
                    Fee Stability
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {Object.values(yearsNoIncrease).some((y) => y > 0) ? (
                    <p className="text-foreground">
                      Your school has maintained fees without increase for{" "}
                      <span className="font-semibold">
                        {Math.max(...Object.values(yearsNoIncrease))} years
                      </span>{" "}
                      on some grades, demonstrating commitment to affordability.
                    </p>
                  ) : (
                    <p className="text-muted-foreground">
                      Your school has had regular fee adjustments.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Scale className="h-4 w-4" />
                    Market Position
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {currentPosition.length > 0 && (
                    <p className="text-foreground">
                      Your fees are in the{" "}
                      <span className="font-semibold">
                        {
                          currentPosition.filter(
                            (p) =>
                              p?.tier === "Budget" || p?.tier === "Lower Mid"
                          ).length
                        }{" "}
                        of {currentPosition.length}
                      </span>{" "}
                      grades positioned in Budget or Lower Mid tier, below
                      market median.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <FileText className="h-4 w-4" />
                    Growth Rate
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {Object.keys(totalGrowth).length > 0 && (
                    <p className="text-foreground">
                      Average annual fee growth of{" "}
                      <span className="font-semibold">
                        {formatPercent(
                          Object.values(totalGrowth).reduce(
                            (sum, g) => sum + g.growth / g.years,
                            0
                          ) / Object.keys(totalGrowth).length
                        )}
                      </span>{" "}
                      — modest compared to market trends.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3">
              <div>
                <div className="text-sm font-medium text-foreground">Downloads</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Exports include all grades. If you didn’t enter a proposed fee for a grade, the current fee is used.
                </div>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="gap-2">
                    <Download className="h-4 w-4" />
                    Download reports
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>PDF exports</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={downloadEvidenceSummaryPdfAllGrades}>
                    <FileText className="h-4 w-4" />
                    Evidence summary (all grades)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={downloadPeerComparisonPdfAllGrades}>
                    <FileText className="h-4 w-4" />
                    Peer comparison (all grades)
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={downloadEvidenceSummaryPdf}>
                    <FileText className="h-4 w-4" />
                    Evidence summary (selected grade)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={downloadPeerComparisonPdf}>
                    <FileText className="h-4 w-4" />
                    Peer comparison (selected grade)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </section>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
            <h3 className="text-lg font-medium text-foreground">
              Select Your School
            </h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Search for your school above to view detailed fee history, market
              positioning, and generate evidence for your FRC application.
            </p>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
