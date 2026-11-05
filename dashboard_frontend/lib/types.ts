// School dimension
export interface School {
  school_key: string;
  school_id: string;
  school_name: string;
  index_number: string;
  district: string;
  medium: string;
  board: string;
  source_url: string;
}

// Standard dimension (hardcoded)
export interface Standard {
  standard_id: number;
  standard_name: string;
  standard_group: string;
  standard_order: number;
}

// Fact table - raw from CSV
export interface SchoolFee {
  fee_key: string;
  school_key: string;
  standard_id: number;
  academic_year: string;
  approved_fee: number | null;
}

// Enriched fee record with school data joined
export interface EnrichedFee {
  fee_key: string;
  school_key: string;
  school_name: string;
  index_number: string;
  district: string;
  medium: string;
  board: string;
  source_url: string;
  standard_id: number;
  academic_year: string;
  approved_fee: number | null;
}

// Filter state
export interface FilterState {
  district: string; // "All Gujarat" or specific district
  board: string; // CBSE, GSHSEB, ICSE, Other
  medium: string; // All, English, Gujarati, Hindi, Other
  academicYear: string; // e.g. "2025-26"
  standardId: number; // standard_id
}

// Market snapshot metrics
export interface MarketSnapshot {
  typicalFee: number;
  minFee: number;
  maxFee: number;
  schoolCount: number;
  avgYearlyGrowth: number;
  budgetCeiling: number; // 25th percentile
  midPoint: number; // 50th percentile
  premiumEntry: number; // 75th percentile
}

// Grade fee structure row
export interface GradeFeeStructure {
  standardId: number;
  standardName: string;
  standardGroup: string;
  lowestFee: number;
  typicalFee: number;
  highestFee: number;
  schoolCount: number;
  jumpFromPrevious: number | null;
}

// District ranking
export interface DistrictRanking {
  district: string;
  typicalFee: number;
  schoolCount: number;
}

// Increase distribution bucket
export interface IncreaseBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}
