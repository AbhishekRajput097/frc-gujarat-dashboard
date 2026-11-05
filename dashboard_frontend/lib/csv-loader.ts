import type { School, SchoolFee, EnrichedFee } from "./types";

// Parse CSV string to array of objects
function parseCSV<T>(csv: string, transform: (row: Record<string, string>) => T): T[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(",").map(h => h.trim());
  const results: T[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length !== headers.length) continue;
    
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index]?.trim() || "";
    });
    
    results.push(transform(row));
  }
  
  return results;
}

// Parse a single CSV line handling quoted values
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  
  result.push(current);
  return result;
}

function normalizeBoard(raw: string): string {
  const value = (raw || "").trim();
  const upper = value.toUpperCase();

  if (upper.includes("CBSE")) return "CBSE";
  if (upper.includes("GSHSEB")) return "GSHSEB";
  if (upper.includes("ICSE") || upper.includes("CISCE")) return "ICSE";

  // IB, Cambridge, and any other boards are grouped under "Other"
  return "Other";
}

// Load and parse schools CSV
export async function loadSchools(csvUrl: string): Promise<Map<string, School>> {
  const response = await fetch(csvUrl);
  const text = await response.text();
  
  const schools = parseCSV(text, (row) => ({
    school_key: row.school_key || "",
    school_id: row.school_id || "",
    school_name: row.school_name || "",
    index_number: row.index_number || "",
    district: row.district || "",
    medium: row.medium || "",
    board: normalizeBoard(row.board || ""),
    source_url: row.source_url || "",
  }));
  
  const schoolMap = new Map<string, School>();
  schools.forEach(school => {
    if (school.school_key) {
      schoolMap.set(school.school_key, school);
    }
  });
  
  return schoolMap;
}

// Load and parse fees CSV
export async function loadFees(csvUrl: string): Promise<SchoolFee[]> {
  const response = await fetch(csvUrl);
  const text = await response.text();
  
  return parseCSV(text, (row) => ({
    fee_key: row.fee_key || "",
    school_key: row.school_key || "",
    standard_id: parseInt(row.standard_id, 10) || 0,
    academic_year: normalizeYear(row.academic_year || ""),
    approved_fee: row.approved_fee ? parseFloat(row.approved_fee) : null,
  }));
}

// Normalize year format
// In the source data:
//   2018 means academic year 2017-2018
//   2026 means academic year 2025-2026
// So we map N -> (N-1)-(N) in short form.
function normalizeYear(year: string): string {
  if (year.includes("-")) return year;
  const yearNum = parseInt(year, 10);
  if (isNaN(yearNum)) return year;
  const startYear = yearNum - 1;
  const nextYear = yearNum % 100;
  return `${startYear}-${nextYear.toString().padStart(2, "0")}`;
}

// Enrich fees with school data
export function enrichFees(
  fees: SchoolFee[],
  schools: Map<string, School>
): EnrichedFee[] {
  return fees
    .filter(fee => schools.has(fee.school_key))
    .map(fee => {
      const school = schools.get(fee.school_key)!;
      return {
        fee_key: fee.fee_key,
        school_key: fee.school_key,
        school_name: school.school_name,
        index_number: school.index_number,
        district: school.district,
        medium: school.medium,
        board: school.board,
        source_url: school.source_url,
        standard_id: fee.standard_id,
        academic_year: fee.academic_year,
        approved_fee: fee.approved_fee,
      };
    });
}

// Load all data and return enriched fees
export async function loadAllData(
  schoolsUrl: string,
  feesUrl: string,
  onProgress?: (stage: string, percent: number) => void
): Promise<EnrichedFee[]> {
  onProgress?.("Loading school data...", 10);
  const schools = await loadSchools(schoolsUrl);
  
  onProgress?.("Loading fee data...", 40);
  const fees = await loadFees(feesUrl);
  
  onProgress?.("Processing data...", 80);
  const enrichedFees = enrichFees(fees, schools);
  
  onProgress?.("Ready!", 100);
  return enrichedFees;
}
