import { NextResponse } from "next/server";
import { getDbPool } from "@/lib/db";

export const runtime = "nodejs";

type YearsMode = "latest" | "recent" | "all";
type ResponseShape = "rows" | "normalized" | "packed";

function normalizeYear(year: string): string {
  if (!year) return year;
  if (year.includes("-")) return year;
  const yearNum = parseInt(year, 10);
  if (Number.isNaN(yearNum)) return year;
  const startYear = yearNum - 1;
  const nextYear = yearNum % 100;
  return `${startYear}-${nextYear.toString().padStart(2, "0")}`;
}

function normalizeBoard(raw: string): string {
  const value = (raw || "").trim();
  const upper = value.toUpperCase();

  if (upper.includes("CBSE")) return "CBSE";
  if (upper.includes("GSHSEB")) return "GSHSEB";
  if (upper.includes("ICSE") || upper.includes("CISCE")) return "ICSE";
  return "Other";
}

function parseYearsMode(value: string | null): YearsMode {
  if (!value) return "recent";
  const v = value.toLowerCase().trim();
  if (v === "latest") return "latest";
  if (v === "all") return "all";
  return "recent";
}

function parseShape(value: string | null): ResponseShape {
  if (!value) return "rows";
  const v = value.toLowerCase().trim();
  if (v === "normalized" || v === "normalised") return "normalized";
  if (v === "packed") return "packed";
  return "rows";
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const yearsMode = parseYearsMode(url.searchParams.get("years"));
    const shape = parseShape(url.searchParams.get("shape"));

    // Default to "recent" to keep payloads small on first load.
    // - latest: only the most recent academic year (fastest)
    // - recent: last 3 academic years (good for most UX + still fast)
    // - all: full history (needed for deeper analyses)
    const yearsWhereSql =
      yearsMode === "all"
        ? ""
        : yearsMode === "latest"
          ? "where f.academic_year::text = (select max(academic_year::text) from fact_school_fees)"
          : `where f.academic_year::text in (
              select academic_year::text
              from (
                select distinct academic_year::text as academic_year
                from fact_school_fees
                order by academic_year::text desc
                limit 3
              ) y
            )`;

    if (shape === "normalized" || shape === "packed") {
      const { rows: feeRowsRaw } = await getDbPool().query<{
        fee_key: string;
        school_key: string;
        standard_id: number;
        academic_year: string | number | null;
        approved_fee: number | null;
      }>(`
        select
          f.fee_key::text as fee_key,
          f.school_key::text as school_key,
          f.standard_id::int as standard_id,
          f.academic_year::text as academic_year,
          f.approved_fee::float8 as approved_fee
        from fact_school_fees f
        ${yearsWhereSql}
      `);

      const { rows: schoolRows } = await getDbPool().query<{
        school_key: string;
        school_name: string | null;
        index_number: string | null;
        district: string | null;
        medium: string | null;
        board: string | null;
      }>(`
        select
          s.school_key::text as school_key,
          s.school_name::text as school_name,
          s.index_number::text as index_number,
          s.district::text as district,
          s.medium::text as medium,
          s.board::text as board
        from dim_school s
        where s.school_key in (
          select distinct f.school_key
          from fact_school_fees f
          ${yearsWhereSql.replaceAll("f.", "f.")}
        )
      `);

      const schools = schoolRows.map((s) => ({
        school_key: s.school_key ?? "",
        school_name: s.school_name ?? "",
        index_number: s.index_number ?? "",
        district: s.district ?? "",
        medium: s.medium ?? "",
        board: normalizeBoard(s.board ?? ""),
        source_url: "",
      }));

      if (shape === "packed") {
        const fees = feeRowsRaw.map((r) => [
          r.fee_key ?? "",
          r.school_key ?? "",
          Number(r.standard_id) || 0,
          normalizeYear(String(r.academic_year ?? "")),
          r.approved_fee === null ? null : Number(r.approved_fee),
        ]);
        const packedSchools = schools.map((s) => [
          s.school_key,
          s.school_name,
          s.index_number,
          s.district,
          s.medium,
          s.board,
          s.source_url,
        ]);

        return NextResponse.json(
          {
            feeColumns: ["fee_key", "school_key", "standard_id", "academic_year", "approved_fee"],
            schoolColumns: [
              "school_key",
              "school_name",
              "index_number",
              "district",
              "medium",
              "board",
              "source_url",
            ],
            fees,
            schools: packedSchools,
          },
          {
            headers: {
              "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
            },
          }
        );
      }

      const fees = feeRowsRaw.map((r) => ({
        fee_key: r.fee_key ?? "",
        school_key: r.school_key ?? "",
        standard_id: Number(r.standard_id) || 0,
        academic_year: normalizeYear(String(r.academic_year ?? "")),
        approved_fee: r.approved_fee === null ? null : Number(r.approved_fee),
      }));

      return NextResponse.json(
        {
          fees,
          schools,
        },
        {
          headers: {
            "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
          },
        }
      );
    }

    // Backward-compatible default: return denormalized rows (larger payload).
    const { rows } = await getDbPool().query<{
      fee_key: string;
      school_key: string;
      school_name: string;
      index_number: string | null;
      district: string | null;
      medium: string | null;
      board: string | null;
      standard_id: number;
      academic_year: string | number | null;
      approved_fee: number | null;
    }>(`
      select
        f.fee_key::text as fee_key,
        f.school_key::text as school_key,
        s.school_name::text as school_name,
        s.index_number::text as index_number,
        s.district::text as district,
        s.medium::text as medium,
        s.board::text as board,
        f.standard_id::int as standard_id,
        f.academic_year::text as academic_year,
        f.approved_fee::float8 as approved_fee
      from fact_school_fees f
      join dim_school s on s.school_key = f.school_key
      ${yearsWhereSql}
    `);

    const enrichedFees = rows.map((r) => ({
      fee_key: r.fee_key ?? "",
      school_key: r.school_key ?? "",
      school_name: r.school_name ?? "",
      index_number: r.index_number ?? "",
      district: r.district ?? "",
      medium: r.medium ?? "",
      board: normalizeBoard(r.board ?? ""),
      source_url: "",
      standard_id: Number(r.standard_id) || 0,
      academic_year: normalizeYear(String(r.academic_year ?? "")),
      approved_fee: r.approved_fee === null ? null : Number(r.approved_fee),
    }));

    return NextResponse.json(enrichedFees, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
      },
    });
  } catch (err) {
    console.error("Failed to query enriched fees:", err);
    return NextResponse.json(
      { error: "Failed to load data" },
      { status: 500 }
    );
  }
}

