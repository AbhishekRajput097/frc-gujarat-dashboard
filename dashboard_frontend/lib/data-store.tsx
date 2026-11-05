"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { EnrichedFee, FilterState } from "./types";
import { getLatestYear, getUniqueDistricts } from "./data-utils";
import { DEFAULT_FILTERS, ACADEMIC_YEARS } from "./constants";

interface DataStore {
  fees: EnrichedFee[];
  isLoading: boolean;
  loadingProgress: number;
  loadingStage: string;
  error: string | null;
  latestYear: string;
  districts: string[];
  filters: FilterState;
  setFilters: (filters: Partial<FilterState>) => void;
}

const DataStoreContext = createContext<DataStore | null>(null);

const CACHE_KEY = "frc_enrichedFees_v3";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

type CachedPayload = { fetchedAt: number; mode: "latest" | "all"; fees: EnrichedFee[] };

function tryReadCache(): CachedPayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!parsed?.fetchedAt || !Array.isArray(parsed?.fees)) return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    if (parsed.mode !== "latest" && parsed.mode !== "all") return null;
    return parsed;
  } catch {
    return null;
  }
}

function tryWriteCache(payload: CachedPayload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota / privacy mode.
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

type NormalizedDataset = {
  fees: Array<{
    fee_key: string;
    school_key: string;
    standard_id: number;
    academic_year: string;
    approved_fee: number | null;
  }>;
  schools: Array<{
    school_key: string;
    school_name: string;
    index_number: string;
    district: string;
    medium: string;
    board: string;
    source_url: string;
  }>;
};

type PackedDataset = {
  feeColumns: string[];
  schoolColumns: string[];
  fees: Array<[string, string, number, string, number | null]>;
  schools: Array<[string, string, string, string, string, string, string]>;
};

function isNormalizedDataset(data: unknown): data is NormalizedDataset {
  if (!data || typeof data !== "object") return false;
  const d = data as any;
  return Array.isArray(d.fees) && Array.isArray(d.schools);
}

function isPackedDataset(data: unknown): data is PackedDataset {
  if (!data || typeof data !== "object") return false;
  const d = data as any;
  return Array.isArray(d.fees) && Array.isArray(d.schools) && Array.isArray(d.feeColumns);
}

function hydrateFees(data: EnrichedFee[] | NormalizedDataset | PackedDataset): EnrichedFee[] {
  if (Array.isArray(data)) return data;
  if (isPackedDataset(data)) {
    const schools = data.schools.map((s) => ({
      school_key: s[0],
      school_name: s[1],
      index_number: s[2],
      district: s[3],
      medium: s[4],
      board: s[5],
      source_url: s[6],
    }));
    const fees = data.fees.map((f) => ({
      fee_key: f[0],
      school_key: f[1],
      standard_id: f[2],
      academic_year: f[3],
      approved_fee: f[4],
    }));
    return hydrateFees({ schools, fees });
  }
  const schoolMap = new Map<
    string,
    {
      school_name: string;
      index_number: string;
      district: string;
      medium: string;
      board: string;
      source_url: string;
    }
  >();
  data.schools.forEach((s) => {
    if (!s?.school_key) return;
    schoolMap.set(s.school_key, {
      school_name: s.school_name ?? "",
      index_number: s.index_number ?? "",
      district: s.district ?? "",
      medium: s.medium ?? "",
      board: s.board ?? "",
      source_url: s.source_url ?? "",
    });
  });
  return data.fees.map((f) => {
    const school = schoolMap.get(f.school_key);
    return {
      fee_key: f.fee_key,
      school_key: f.school_key,
      school_name: school?.school_name ?? "",
      index_number: school?.index_number ?? "",
      district: school?.district ?? "",
      medium: school?.medium ?? "",
      board: school?.board ?? "",
      source_url: school?.source_url ?? "",
      standard_id: Number(f.standard_id) || 0,
      academic_year: String(f.academic_year ?? ""),
      approved_fee: f.approved_fee === null ? null : Number(f.approved_fee),
    };
  });
}

export function DataStoreProvider({ children }: { children: ReactNode }) {
  const [fees, setFees] = useState<EnrichedFee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingStage, setLoadingStage] = useState("Initializing...");
  const [error, setError] = useState<string | null>(null);
  const [latestYear, setLatestYear] = useState("2025-26");
  const [districts, setDistricts] = useState<string[]>([]);
  const [filters, setFiltersState] = useState<FilterState>(DEFAULT_FILTERS);

  const setFilters = useCallback((newFilters: Partial<FilterState>) => {
    setFiltersState(prev => ({ ...prev, ...newFilters }));
  }, []);

  useEffect(() => {
    async function loadData() {
      try {
        const applyFees = (enrichedFees: EnrichedFee[]) => {
          setFees(enrichedFees);
          const computedLatest = getLatestYear(enrichedFees);
          setLatestYear(computedLatest);
          setFiltersState((prev) => {
            const desired = prev.academicYear;
            const isValid = ACADEMIC_YEARS.includes(desired as (typeof ACADEMIC_YEARS)[number]);
            return {
              ...prev,
              academicYear: isValid ? desired : computedLatest,
            };
          });
          setDistricts(getUniqueDistricts(enrichedFees));
        };

        setError(null);
        setIsLoading(true);
        setLoadingStage("Initializing…");
        setLoadingProgress(5);

        // Fast path: if cached data exists, show it immediately (avoids blank/error screen).
        const cached = tryReadCache();
        if (cached?.fees?.length) {
          setLoadingStage("Loading cached data…");
          setLoadingProgress(40);
          applyFees(cached.fees);
          setIsLoading(false);
        } else {
          setLoadingStage("Loading data from database…");
          setLoadingProgress(20);
        }

        // Always revalidate (with retry) so data stays fresh.
        // Strategy:
        // - If no cache: download a smaller "latest" dataset first (fast initial render).
        // - Then (in the background) fetch the full history and cache it for future visits.
        const fetchWithRetry = async (url: string, label: string) => {
          const maxAttempts = 3;
          let lastErr: unknown = null;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              if (attempt > 1) {
                setLoadingStage(`Retrying ${label}… (${attempt}/${maxAttempts})`);
                setLoadingProgress(20 + attempt * 10);
                await sleep(600 * attempt); // simple backoff
              }

              const res = await fetch(url);
              if (!res.ok) throw new Error(`Failed to load data (HTTP ${res.status})`);
              const json = (await res.json()) as unknown;
              if (isPackedDataset(json)) return hydrateFees(json);
              if (isNormalizedDataset(json)) return hydrateFees(json);
              return json as EnrichedFee[];
            } catch (e) {
              lastErr = e;
            }
          }
          throw lastErr instanceof Error ? lastErr : new Error("Failed to load data");
        };

        // If we don't already have a cached dataset shown, pull recent data first.
        if (!cached?.fees?.length) {
          const recentFees = await fetchWithRetry(
            "/api/enriched-fees?years=latest&shape=packed",
            "latest-year data"
          );
          setLoadingStage("Processing data…");
          setLoadingProgress(80);
          applyFees(recentFees);
          tryWriteCache({ fetchedAt: Date.now(), mode: "latest", fees: recentFees });
          setLoadingStage("Ready!");
          setLoadingProgress(100);
          setIsLoading(false);
        }

        // Background upgrade: fetch all years and replace + cache.
        // This runs even when we had cached data, so the app self-heals to the latest dataset.
        fetchWithRetry("/api/enriched-fees?years=all&shape=packed", "full history")
          .then((allFees) => {
            if (!Array.isArray(allFees) || allFees.length === 0) return;
            applyFees(allFees);
            tryWriteCache({ fetchedAt: Date.now(), mode: "all", fees: allFees });
          })
          .catch((e) => {
            // If we already showed something (cache or recent), keep the app usable.
            console.warn("Failed to refresh full dataset; continuing with current data.", e);
          });

        // If we got here: all retries failed.
        // If we already showed cached data, keep the app usable and avoid the error screen.
        if (cached?.fees?.length) {
          console.warn("Failed to refresh data; showing cached dataset.");
          setIsLoading(false);
          setLoadingStage("Offline (showing cached data)");
          setLoadingProgress(100);
          return;
        }
      } catch (err) {
        console.error("Failed to load data:", err);
        setError(err instanceof Error ? err.message : "Failed to load data");
        setIsLoading(false);
      }
    }
    
    loadData();
  }, []);

  return (
    <DataStoreContext.Provider
      value={{
        fees,
        isLoading,
        loadingProgress,
        loadingStage,
        error,
        latestYear,
        districts,
        filters,
        setFilters,
      }}
    >
      {children}
    </DataStoreContext.Provider>
  );
}

export function useDataStore(): DataStore {
  const context = useContext(DataStoreContext);
  if (!context) {
    throw new Error("useDataStore must be used within a DataStoreProvider");
  }
  return context;
}
