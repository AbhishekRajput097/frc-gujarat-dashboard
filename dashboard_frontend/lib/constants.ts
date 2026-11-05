import type { Standard } from "./types";

// Hardcoded standards - 19 rows from dim_standard
export const STANDARDS: Standard[] = [
  { standard_id: 1, standard_name: "Nursery", standard_group: "Pre Primary", standard_order: 1 },
  { standard_id: 2, standard_name: "Jr.KG", standard_group: "Pre Primary", standard_order: 2 },
  { standard_id: 3, standard_name: "Sr.KG", standard_group: "Pre Primary", standard_order: 3 },
  { standard_id: 4, standard_name: "Standard 1", standard_group: "Primary", standard_order: 4 },
  { standard_id: 5, standard_name: "Standard 2", standard_group: "Primary", standard_order: 5 },
  { standard_id: 6, standard_name: "Standard 3", standard_group: "Primary", standard_order: 6 },
  { standard_id: 7, standard_name: "Standard 4", standard_group: "Primary", standard_order: 7 },
  { standard_id: 8, standard_name: "Standard 5", standard_group: "Primary", standard_order: 8 },
  { standard_id: 9, standard_name: "Standard 6", standard_group: "Primary", standard_order: 9 },
  { standard_id: 10, standard_name: "Standard 7", standard_group: "Primary", standard_order: 10 },
  { standard_id: 11, standard_name: "Standard 8", standard_group: "Primary", standard_order: 11 },
  { standard_id: 12, standard_name: "Standard 9", standard_group: "Secondary", standard_order: 12 },
  { standard_id: 13, standard_name: "Standard 10", standard_group: "Secondary", standard_order: 13 },
  { standard_id: 14, standard_name: "Standard 11 General", standard_group: "Higher Secondary", standard_order: 14 },
  { standard_id: 15, standard_name: "Standard 11 Arts", standard_group: "Higher Secondary", standard_order: 15 },
  { standard_id: 16, standard_name: "Standard 11 Science", standard_group: "Higher Secondary", standard_order: 16 },
  { standard_id: 17, standard_name: "Standard 12 General", standard_group: "Higher Secondary", standard_order: 17 },
  { standard_id: 18, standard_name: "Standard 12 Arts", standard_group: "Higher Secondary", standard_order: 18 },
  { standard_id: 19, standard_name: "Standard 12 Science", standard_group: "Higher Secondary", standard_order: 19 },
];

// Standard groups for grouping in dropdowns
export const STANDARD_GROUPS = ["Pre Primary", "Primary", "Secondary", "Higher Secondary"] as const;

// Board options
export const BOARDS = ["CBSE", "GSHSEB", "ICSE", "Other"] as const;

// Medium options
export const MEDIUMS = ["All", "English", "Gujarati", "Hindi", "Other"] as const;

// Academic years available (aligned to numeric year mapping: 2018 → 2017-18, …, 2026 → 2025-26)
export const ACADEMIC_YEARS = [
  "2017-18",
  "2018-19",
  "2019-20",
  "2020-21",
  "2021-22",
  "2022-23",
  "2023-24",
  "2024-25",
  "2025-26",
] as const;

// Default filter state
export const DEFAULT_FILTERS = {
  district: "All Gujarat",
  board: "CBSE",
  medium: "All",
  academicYear: "2025-26",
  standardId: 8, // Standard 5
} as const;

// Tier labels
export const FEE_TIERS = {
  BUDGET: "Budget",
  LOWER_MID: "Lower Mid",
  UPPER_MID: "Upper Mid",
  PREMIUM: "Premium",
} as const;

// Market size badges
export const MARKET_BADGES = {
  ACTIVE: { label: "Active Market", minCount: 30, color: "green" },
  GROWING: { label: "Growing Market", minCount: 10, color: "amber" },
  NEW: { label: "New Territory", minCount: 0, color: "orange" },
} as const;

// Increase buckets for histogram
export const INCREASE_BUCKETS = [
  { label: "0-5%", min: 0, max: 5 },
  { label: "5-10%", min: 5, max: 10 },
  { label: "10-15%", min: 10, max: 15 },
  { label: "15-20%", min: 15, max: 20 },
  { label: "20%+", min: 20, max: Infinity },
] as const;

// CSV file paths
export const CSV_PATHS = {
  schools: "/data/dim_school.csv",
  fees: "/data/fact_school_fees.csv",
} as const;

// Chart colors
export const CHART_COLORS = {
  cbse: "#3b82f6", // blue
  gshseb: "#10b981", // emerald
  icse: "#f59e0b", // amber
  other: "#6b7280", // gray
  english: "#3b82f6", // blue
  gujarati: "#10b981", // emerald
  hindi: "#f59e0b", // amber
  budget: "#22c55e", // green
  lowerMid: "#3b82f6", // blue
  upperMid: "#f59e0b", // amber
  premium: "#ef4444", // red
} as const;
