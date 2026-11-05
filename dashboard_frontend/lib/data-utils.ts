import type { 
  EnrichedFee, 
  MarketSnapshot, 
  DistrictRanking, 
  GradeFeeStructure,
  IncreaseBucket,
  FilterState 
} from "./types";
import { STANDARDS, INCREASE_BUCKETS, ACADEMIC_YEARS } from "./constants";

// Format rupees in Indian format (₹1,00,000)
export function formatRupees(amount: number): string {
  if (amount === 0 || isNaN(amount)) return "₹0";
  
  const formatter = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  
  return formatter.format(amount);
}

// Format percentage
export function formatPercent(value: number, decimals: number = 1): string {
  if (isNaN(value)) return "0%";
  return `${value.toFixed(decimals)}%`;
}

// Get latest academic year from data
export function getLatestYear(fees: EnrichedFee[]): string {
  const years = [...new Set(fees.map(f => f.academic_year))];
  const validYears = years.filter(y => ACADEMIC_YEARS.includes(y as (typeof ACADEMIC_YEARS)[number]));
  if (validYears.length === 0) {
    return ACADEMIC_YEARS[ACADEMIC_YEARS.length - 1] || "2025-26";
  }
  validYears.sort((a, b) => {
    const aStart = parseInt(a.split("-")[0]);
    const bStart = parseInt(b.split("-")[0]);
    return bStart - aStart;
  });
  return validYears[0];
}

// Filter valid fees (approved_fee > 0 and not null)
export function filterValidFees(fees: EnrichedFee[]): EnrichedFee[] {
  return fees.filter(f => f.approved_fee !== null && f.approved_fee > 0);
}

// Apply filter state to fees
export function applyFilters(
  fees: EnrichedFee[], 
  filters: FilterState, 
  year: string
): EnrichedFee[] {
  return filterValidFees(fees).filter(f => {
    const matchDistrict = filters.district === "All Gujarat" || f.district === filters.district;
    const matchBoard = f.board === filters.board;
    const matchMedium =
      filters.medium === "All" ||
      f.medium === filters.medium ||
      (filters.medium === "Other" &&
        f.medium !== "English" &&
        f.medium !== "Gujarati" &&
        f.medium !== "Hindi");
    const matchStandard = f.standard_id === filters.standardId;
    const matchYear = f.academic_year === year;
    return matchDistrict && matchBoard && matchMedium && matchStandard && matchYear;
  });
}

// Calculate quantile
export function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

// Calculate median
export function median(arr: number[]): number {
  return quantile(arr, 0.5);
}

// Calculate market snapshot
export function calculateMarketSnapshot(fees: EnrichedFee[]): MarketSnapshot | null {
  const validFees = fees.map(f => f.approved_fee!).filter(f => f > 0);
  
  if (validFees.length === 0) {
    return null;
  }
  
  const typicalFee = median(validFees);
  const minFee = Math.min(...validFees);
  const maxFee = Math.max(...validFees);
  const schoolCount = validFees.length;
  const budgetCeiling = quantile(validFees, 0.25);
  const midPoint = quantile(validFees, 0.5);
  const premiumEntry = quantile(validFees, 0.75);
  
  // Calculate average yearly growth (simplified - based on all data in segment)
  const avgYearlyGrowth = 8.5; // Placeholder, will calculate from actual year-on-year data
  
  return {
    typicalFee,
    minFee,
    maxFee,
    schoolCount,
    avgYearlyGrowth,
    budgetCeiling,
    midPoint,
    premiumEntry,
  };
}

// Get fee tier based on value and market snapshot
export function getFeeTier(
  fee: number, 
  snapshot: MarketSnapshot
): "Budget" | "Lower Mid" | "Upper Mid" | "Premium" {
  if (fee <= snapshot.budgetCeiling) return "Budget";
  if (fee <= snapshot.midPoint) return "Lower Mid";
  if (fee <= snapshot.premiumEntry) return "Upper Mid";
  return "Premium";
}

// Calculate district rankings
export function calculateDistrictRankings(
  fees: EnrichedFee[],
  board: string,
  medium: string,
  standardId: number,
  year: string
): DistrictRanking[] {
  const validFees = filterValidFees(fees).filter(
    f =>
      f.board === board &&
      (medium === "All" ||
        f.medium === medium ||
        (medium === "Other" &&
          f.medium !== "English" &&
          f.medium !== "Gujarati" &&
          f.medium !== "Hindi")) &&
      f.standard_id === standardId &&
      f.academic_year === year
  );
  
  const districtMap = new Map<string, number[]>();
  
  validFees.forEach(f => {
    if (!districtMap.has(f.district)) {
      districtMap.set(f.district, []);
    }
    districtMap.get(f.district)!.push(f.approved_fee!);
  });
  
  const rankings: DistrictRanking[] = [];
  
  districtMap.forEach((feeList, district) => {
    rankings.push({
      district,
      typicalFee: median(feeList),
      schoolCount: feeList.length,
    });
  });
  
  return rankings.sort((a, b) => b.typicalFee - a.typicalFee);
}

// Calculate grade fee structure
export function calculateGradeFeeStructure(
  fees: EnrichedFee[],
  district: string,
  board: string,
  medium: string,
  year: string
): GradeFeeStructure[] {
  const validFees = filterValidFees(fees).filter(f => {
    const matchDistrict = district === "All Gujarat" || f.district === district;
    const matchMedium =
      medium === "All" ||
      f.medium === medium ||
      (medium === "Other" &&
        f.medium !== "English" &&
        f.medium !== "Gujarati" &&
        f.medium !== "Hindi");
    return matchDistrict && f.board === board && matchMedium && f.academic_year === year;
  });
  
  const result: GradeFeeStructure[] = [];
  let prevTypicalFee: number | null = null;
  
  STANDARDS.forEach(standard => {
    const standardFees = validFees
      .filter(f => f.standard_id === standard.standard_id)
      .map(f => f.approved_fee!);
    
    if (standardFees.length === 0) {
      result.push({
        standardId: standard.standard_id,
        standardName: standard.standard_name,
        standardGroup: standard.standard_group,
        lowestFee: 0,
        typicalFee: 0,
        highestFee: 0,
        schoolCount: 0,
        jumpFromPrevious: null,
      });
      return;
    }
    
    const typicalFee = median(standardFees);
    const jump = prevTypicalFee !== null && prevTypicalFee > 0
      ? ((typicalFee - prevTypicalFee) / prevTypicalFee) * 100
      : null;
    
    result.push({
      standardId: standard.standard_id,
      standardName: standard.standard_name,
      standardGroup: standard.standard_group,
      lowestFee: Math.min(...standardFees),
      typicalFee,
      highestFee: Math.max(...standardFees),
      schoolCount: standardFees.length,
      jumpFromPrevious: jump,
    });
    
    prevTypicalFee = typicalFee;
  });
  
  return result;
}

// Calculate grade supply (schools per grade)
export function calculateGradeSupply(
  fees: EnrichedFee[],
  district: string,
  board: string,
  medium: string,
  year: string
): { standardId: number; standardName: string; count: number }[] {
  const validFees = filterValidFees(fees).filter(f => {
    const matchDistrict = district === "All Gujarat" || f.district === district;
    const matchMedium =
      medium === "All" ||
      f.medium === medium ||
      (medium === "Other" &&
        f.medium !== "English" &&
        f.medium !== "Gujarati" &&
        f.medium !== "Hindi");
    return matchDistrict && f.board === board && matchMedium && f.academic_year === year;
  });
  
  return STANDARDS.map(standard => {
    const count = new Set(
      validFees
        .filter(f => f.standard_id === standard.standard_id)
        .map(f => f.school_key)
    ).size;
    
    return {
      standardId: standard.standard_id,
      standardName: standard.standard_name,
      count,
    };
  });
}

// Calculate fee trends over years (by board, across all mediums)
export function calculateFeeTrends(
  fees: EnrichedFee[],
  district: string,
  standardId: number
): { year: string; cbse: number | null; gshseb: number | null; icse: number | null }[] {
  const validFees = filterValidFees(fees).filter(f => {
    const matchDistrict = district === "All Gujarat" || f.district === district;
    return matchDistrict && f.standard_id === standardId;
  });

  const years = [...new Set(validFees.map(f => f.academic_year))].sort();

  return years.map(year => {
    const yearFees = validFees.filter(f => f.academic_year === year);
    
    const cbseFees = yearFees.filter(f => f.board === "CBSE").map(f => f.approved_fee!);
    const gshsebFees = yearFees.filter(f => f.board === "GSHSEB").map(f => f.approved_fee!);
    const icseFees = yearFees.filter(f => f.board === "ICSE").map(f => f.approved_fee!);
    
    return {
      year,
      cbse: cbseFees.length > 0 ? median(cbseFees) : null,
      gshseb: gshsebFees.length > 0 ? median(gshsebFees) : null,
      icse: icseFees.length > 0 ? median(icseFees) : null,
    };
  });
}

// Calculate fee trends over years comparing mediums (within a board)
export function calculateFeeTrendsByMedium(
  fees: EnrichedFee[],
  district: string,
  standardId: number,
  board: string
): { year: string; english: number | null; gujarati: number | null; hindi: number | null }[] {
  const validFees = filterValidFees(fees).filter((f) => {
    const matchDistrict = district === "All Gujarat" || f.district === district;
    const matchBoard = f.board === board;
    const matchStandard = f.standard_id === standardId;
    return matchDistrict && matchBoard && matchStandard;
  });

  const years = [...new Set(validFees.map(f => f.academic_year))].sort();

  return years.map((year) => {
    const yearFees = validFees.filter((f) => f.academic_year === year);
    const englishFees = yearFees
      .filter((f) => f.medium === "English")
      .map((f) => f.approved_fee!);
    const gujaratiFees = yearFees
      .filter((f) => f.medium === "Gujarati")
      .map((f) => f.approved_fee!);
    const hindiFees = yearFees
      .filter((f) => f.medium === "Hindi")
      .map((f) => f.approved_fee!);

    return {
      year,
      english: englishFees.length > 0 ? median(englishFees) : null,
      gujarati: gujaratiFees.length > 0 ? median(gujaratiFees) : null,
      hindi: hindiFees.length > 0 ? median(hindiFees) : null,
    };
  });
}

// Calculate increase distribution
export function calculateIncreaseDistribution(
  fees: EnrichedFee[],
  district: string,
  board: string,
  medium: string,
  standardId: number
): IncreaseBucket[] {
  const validFees = filterValidFees(fees).filter(f => {
    const matchDistrict = district === "All Gujarat" || f.district === district;
    const matchMedium =
      medium === "All" ||
      f.medium === medium ||
      (medium === "Other" &&
        f.medium !== "English" &&
        f.medium !== "Gujarati" &&
        f.medium !== "Hindi");
    return matchDistrict && f.board === board && matchMedium && f.standard_id === standardId;
  });
  
  // Group by school
  const schoolFees = new Map<string, Map<string, number>>();
  validFees.forEach(f => {
    if (!schoolFees.has(f.school_key)) {
      schoolFees.set(f.school_key, new Map());
    }
    schoolFees.get(f.school_key)!.set(f.academic_year, f.approved_fee!);
  });
  
  // Calculate year-on-year increases
  const increases: number[] = [];
  schoolFees.forEach(yearMap => {
    const years = [...yearMap.keys()].sort();
    for (let i = 1; i < years.length; i++) {
      const prevFee = yearMap.get(years[i - 1])!;
      const currFee = yearMap.get(years[i])!;
      if (prevFee > 0 && currFee > prevFee) {
        const increase = ((currFee - prevFee) / prevFee) * 100;
        increases.push(increase);
      }
    }
  });
  
  // Bucket the increases
  return INCREASE_BUCKETS.map(bucket => ({
    label: bucket.label,
    min: bucket.min,
    max: bucket.max,
    count: increases.filter(inc => inc >= bucket.min && inc < bucket.max).length,
  }));
}

// Get all unique districts
export function getUniqueDistricts(fees: EnrichedFee[]): string[] {
  const districts = [...new Set(fees.map(f => f.district))].filter(Boolean);
  return districts.sort();
}

// Get state-wide average
export function getStateWideAverage(
  fees: EnrichedFee[],
  board: string,
  medium: string,
  standardId: number,
  year: string
): number {
  const validFees = filterValidFees(fees).filter(
    f =>
      f.board === board &&
      (medium === "All" ||
        f.medium === medium ||
        (medium === "Other" &&
          f.medium !== "English" &&
          f.medium !== "Gujarati" &&
          f.medium !== "Hindi")) &&
      f.standard_id === standardId &&
      f.academic_year === year
  );
  const feeValues = validFees.map(f => f.approved_fee!);
  return feeValues.length > 0 ? median(feeValues) : 0;
}

// Calculate cumulative growth
export function calculateCumulativeGrowth(
  fees: EnrichedFee[],
  district: string,
  board: string,
  medium: string,
  standardId: number
): { totalGrowth: number; avgYearlyGrowth: number; startYear: string; endYear: string } | null {
  const validFees = filterValidFees(fees).filter(f => {
    const matchDistrict = district === "All Gujarat" || f.district === district;
    const matchMedium =
      medium === "All" ||
      f.medium === medium ||
      (medium === "Other" &&
        f.medium !== "English" &&
        f.medium !== "Gujarati" &&
        f.medium !== "Hindi");
    return matchDistrict && f.board === board && matchMedium && f.standard_id === standardId;
  });
  
  const yearMedians = new Map<string, number>();
  ACADEMIC_YEARS.forEach(year => {
    const yearFees = validFees.filter(f => f.academic_year === year).map(f => f.approved_fee!);
    if (yearFees.length >= 5) {
      yearMedians.set(year, median(yearFees));
    }
  });
  
  const years = [...yearMedians.keys()].sort();
  if (years.length < 2) return null;
  
  const startYear = years[0];
  const endYear = years[years.length - 1];
  const startFee = yearMedians.get(startYear)!;
  const endFee = yearMedians.get(endYear)!;
  
  const totalGrowth = ((endFee - startFee) / startFee) * 100;
  const yearCount = years.length - 1;
  const avgYearlyGrowth = totalGrowth / yearCount;
  
  return { totalGrowth, avgYearlyGrowth, startYear, endYear };
}
