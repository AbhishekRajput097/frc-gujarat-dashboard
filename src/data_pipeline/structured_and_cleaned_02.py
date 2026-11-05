"""
FRC Gujarat — Structure + Clean (Combined Step 2 & 3)
======================================================
Reads from  (never modified):
    data/raw_data/schools_raw.csv
    data/raw_data/fees_raw.csv
    data/structured_data/dim_standard.csv
    data/structured_data/standard_mapping.csv

Appends to / creates:
    data/structured_data/dim_school.csv
        → new school rows appended (dedup by index_number|medium)

    data/structured_data/fact_school_fees.csv
        → new school fee rows appended WITH corrections already applied
          (dedup by school_key + standard_id + academic_year)

    data/structured_data/fee_corrections_log.csv
        → one row per corrected cell for reference
          columns: school_name, standard_name, Academic_year,
                   previous_fee, corrected_fee, pass, inserted_at
          created if missing, appended if exists

Nothing in the existing data is ever modified or overwritten.

Usage:
    python structure_and_clean.py
"""

import csv
import uuid
import re
import sys
import logging
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime, timezone

# ============================================================
# PATHS
# ============================================================
BASE_DIR       = Path(__file__).parent
RAW_DIR        = BASE_DIR / "data" / "raw_data"
STRUCT_DIR     = BASE_DIR / "data" / "structured_data"

STRUCT_DIR.mkdir(parents=True, exist_ok=True)

# Inputs (raw)
SCHOOLS_RAW_CSV  = RAW_DIR   / "../../data/data_pipeline/data/raw_data/schools_raw.csv"
FEES_RAW_CSV     = RAW_DIR   / "fees_raw.csv"

# Reference (never modified)
DIM_STANDARD_CSV = STRUCT_DIR / "dim_standard.csv"
STD_MAPPING_CSV  = STRUCT_DIR / "standard_mapping.csv"

# Outputs (append only)
DIM_SCHOOL_CSV   = STRUCT_DIR / "dim_school.csv"
FACT_FEES_CSV    = STRUCT_DIR / "fact_school_fees.csv"
CORR_LOG_CSV     = STRUCT_DIR / "fee_corrections_log.csv"

# ============================================================
# LOGGING
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(BASE_DIR / "data" / "structure_and_clean.log",
                            encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ============================================================
# COLUMN DEFINITIONS
# ============================================================
DIM_SCHOOL_COLS = [
    "school_key", "school_id", "school_name", "index_number",
    "district", "medium", "board", "zone", "fee_status",
    "source_url", "created_at", "inserted_at", "school_natural_key",
]
FACT_FEES_COLS = [
    "fee_key", "school_key", "standard_id",
    "academic_year", "approved_fee", "inserted_at",
]
CORR_LOG_COLS = [
    "school_name", "standard_name", "Academic_year",
    "previous_fee", "corrected_fee", "pass", "inserted_at",
]

# ============================================================
# ANOMALY DETECTION CONFIG  (v17)
# ============================================================
WITHIN_YEAR_HIGH_RATIO        = 3.0
WITHIN_YEAR_LOW_RATIO         = 0.35
ACCEPT_TOLERANCE              = 0.55
LAKH_THRESHOLD                = 100_000
LAKH_PEER_MIN_RATIO           = 2.0
SCHOOL_WIDE_LAKH_SKIP_FRAC    = 0.60
B4_PEER_LAKH_YEAR_FRAC        = 0.50
UNIFORM_LAKH_MAX_TAIL_YEARS   = 3
UNIFORM_LAKH_PEER_MIN_RATIO   = 5.0
UNIFORM_LAKH_MIN_STD_COVERAGE = 0.80
ALL_LOW_COL_MIN_STD           = 2
ALL_LOW_COL_OWN_RATIO         = 0.35

STD_9_10_NAMES = {
    "9", "10", "std 9", "std 10", "std. 9", "std. 10",
    "standard 9", "standard 10", "class 9", "class 10",
    "ix", "x", "grade 9", "grade 10",
}

def is_std_9_or_10(name: str) -> bool:
    return str(name).strip().lower() in STD_9_10_NAMES

# ============================================================
# GENERAL HELPERS
# ============================================================
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def natural_key(index_number: str, medium: str) -> str:
    return f"{index_number.strip()}|{medium.strip()}"

def extract_year(raw_year: str):
    m = re.search(r"\(?\s*(\d{4})\s*[-–]\s*(\d{4})\s*\)?", raw_year)
    if m:
        return int(m.group(2))
    m2 = re.search(r"\b(\d{4})\b", raw_year)
    return int(m2.group(1)) if m2 else None

def read_csv_plain(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        return list(csv.DictReader(f))

def ensure_csv(path: Path, cols: list):
    if not path.exists():
        with open(path, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=cols).writeheader()
        log.info(f"Created {path.name}")

def append_csv(path: Path, cols: list, rows: list[dict]):
    if not rows:
        return
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=cols)
        writer.writerows(rows)

def format_fee(val) -> str:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return ""
    try:
        f = float(val)
        return str(int(f)) if f == int(f) else f"{f:.2f}"
    except (ValueError, TypeError):
        return str(val)

# ============================================================
# STEP 1 — LOAD REFERENCE DATA
# ============================================================
def load_standard_mapping() -> dict[str, int]:
    rows = read_csv_plain(STD_MAPPING_CSV)
    if not rows:
        log.error(f"standard_mapping.csv missing or empty: {STD_MAPPING_CSV}")
        sys.exit(1)
    mapping = {}
    for r in rows:
        raw = (r.get("raw_standard_name") or "").strip()
        try:
            mapping[raw.upper()] = int(r["standard_id"])
        except (KeyError, ValueError):
            continue
    log.info(f"Loaded {len(mapping)} standard mappings")
    return mapping

def load_dim_standard() -> pd.DataFrame:
    df = pd.read_csv(DIM_STANDARD_CSV, dtype=str)
    df["standard_id"]    = pd.to_numeric(df["standard_id"],    errors="coerce")
    df["standard_order"] = pd.to_numeric(df["standard_order"], errors="coerce")
    return df

# ============================================================
# STEP 2 — FIND NEW SCHOOLS
# ============================================================
def load_existing_natural_keys() -> set:
    """school_natural_key values already in dim_school.csv"""
    rows = read_csv_plain(DIM_SCHOOL_CSV)
    return {(r.get("school_natural_key") or "").strip() for r in rows if r.get("school_natural_key")}

def load_existing_fee_keys() -> set:
    """(school_key, standard_id, academic_year) already in fact_school_fees.csv"""
    if not FACT_FEES_CSV.exists():
        return set()
    df = pd.read_csv(FACT_FEES_CSV,
                     usecols=["school_key", "standard_id", "academic_year"],
                     dtype=str, low_memory=False)
    df = df.fillna("").apply(lambda c: c.str.strip())
    return set(zip(df["school_key"], df["standard_id"], df["academic_year"]))

def find_new_raw_schools(existing_natural_keys: set) -> list[dict]:
    rows = read_csv_plain(SCHOOLS_RAW_CSV)
    new_rows = []
    seen_nk  = set()   # dedup within the raw file itself
    for r in rows:
        idx = (r.get("index_number") or "").strip()
        med = (r.get("medium") or "").strip()
        nk  = natural_key(idx, med)
        if nk in existing_natural_keys or nk in seen_nk:
            continue
        seen_nk.add(nk)
        new_rows.append(r)
    log.info(f"schools_raw.csv: {len(rows)} total | {len(new_rows)} new")
    return new_rows

# ============================================================
# STEP 3 — BUILD dim_school ROWS
# ============================================================
def build_dim_school(new_raw_schools: list[dict]) -> dict[str, dict]:
    """Returns {raw_school_id -> dim_school row}"""
    now  = now_iso()
    rows = {}
    for r in new_raw_schools:
        idx = (r.get("index_number") or "").strip()
        med = (r.get("medium") or "").strip()
        sid = (r.get("school_id") or "").strip()
        rows[sid] = {
            "school_key":         str(uuid.uuid4()),
            "school_id":          sid,
            "school_name":        (r.get("school_name") or "").strip(),
            "index_number":       idx,
            "district":           (r.get("district") or "").strip(),
            "medium":             med,
            "board":              (r.get("board") or "").strip(),
            "zone":               (r.get("zone") or "").strip(),
            "fee_status":         (r.get("fee_status") or "").strip(),
            "source_url":         (r.get("source_url") or "").strip(),
            "created_at":         (r.get("created_at") or r.get("scraped_at") or now).strip(),
            "inserted_at":        now,
            "school_natural_key": natural_key(idx, med),
        }
    log.info(f"Built {len(rows)} dim_school rows")
    return rows

# ============================================================
# STEP 4 — BUILD RAW FEE ROWS FOR NEW SCHOOLS
# ============================================================
def build_raw_fee_rows(
    sid_to_dim: dict[str, dict],
    std_mapping: dict[str, int],
    existing_fee_keys: set,
) -> tuple[list[dict], set]:
    """
    Returns (fee_rows, updated_existing_fee_keys).
    fee_rows are NOT yet corrected — correction happens in step 5.
    """
    all_fees    = read_csv_plain(FEES_RAW_CSV)
    now         = now_iso()
    result      = []
    skipped_std = set()
    skipped_dup = 0

    for r in all_fees:
        raw_sid = (r.get("school_id") or "").strip()
        if raw_sid not in sid_to_dim:
            continue

        dim_row    = sid_to_dim[raw_sid]
        school_key = dim_row["school_key"]

        raw_std = (r.get("standard_name") or "").strip()
        std_id  = std_mapping.get(raw_std.upper())
        if std_id is None:
            skipped_std.add(raw_std)
            continue

        raw_year = (r.get("academic_year") or "").strip()
        year     = extract_year(raw_year)
        if year is None:
            continue

        raw_fee = (r.get("approved_fee") or "").strip()
        fee_val = raw_fee if raw_fee not in {"", "-", "—", "NA", "N/A"} else ""

        dedup_key = (school_key, str(std_id), str(year))
        if dedup_key in existing_fee_keys:
            skipped_dup += 1
            continue

        result.append({
            "fee_key":      str(uuid.uuid4()),
            "school_key":   school_key,
            "standard_id":  std_id,
            "academic_year": year,
            "approved_fee": fee_val,
            "inserted_at":  now,
        })
        existing_fee_keys.add(dedup_key)

    if skipped_std:
        log.warning(f"Unmapped standards skipped (add to standard_mapping.csv): {sorted(skipped_std)}")
    if skipped_dup:
        log.info(f"Skipped {skipped_dup} duplicate fee rows")
    log.info(f"Built {len(result)} raw fee rows for new schools")
    return result, existing_fee_keys

# ============================================================
# STEP 5 — ANOMALY DETECTION + CORRECTION  (v17 logic)
# ============================================================

# ---- Matrix builder ----
def build_matrix(school_df: pd.DataFrame):
    dup_keys = set()
    for (sid, yr), g in school_df.groupby(["standard_id", "academic_year"])["approved_fee"]:
        clean = g.dropna()
        if len(clean) >= 2 and clean.nunique() == 1:
            dup_keys.add((sid, yr))

    first_vals = (school_df
                  .sort_values("approved_fee")
                  .groupby(["standard_id", "standard_name", "standard_order", "academic_year"],
                           sort=False)["approved_fee"]
                  .first()
                  .reset_index())

    stds_df   = (first_vals[["standard_id", "standard_name", "standard_order"]]
                 .drop_duplicates().sort_values("standard_order"))
    std_meta  = list(stds_df.itertuples(index=False, name=None))
    sid_to_row = {sid: i for i, (sid, _, _) in enumerate(std_meta)}
    years      = sorted(first_vals["academic_year"].unique().tolist())
    yr_to_col  = {y: j for j, y in enumerate(years)}
    n_s, n_y   = len(std_meta), len(years)

    arr = np.full((n_s, n_y), np.nan, dtype=np.float64)
    for _, row in first_vals.iterrows():
        si = sid_to_row.get(row["standard_id"])
        yj = yr_to_col.get(row["academic_year"])
        if si is not None and yj is not None:
            v = row["approved_fee"]
            if pd.notna(v) and str(v).strip() not in ("", "-", "—", "NA", "N/A"):
                try:
                    arr[si, yj] = float(v)
                except (ValueError, TypeError):
                    pass

    return arr, std_meta, years, dup_keys

# ---- Statistical helpers ----
def compute_col_medians(arr):
    n_s, n_y = arr.shape
    medians  = np.full(n_y, np.nan)
    for j in range(n_y):
        col = arr[:, j]; col = col[np.isfinite(col) & (col > 0)]
        if len(col) < 2: continue
        q1, q3 = np.percentile(col, 25), np.percentile(col, 75); iqr = q3 - q1
        clean   = col[(col >= q1-3*iqr) & (col <= q3+3*iqr)] if iqr > 0 else col
        medians[j] = np.median(clean) if len(clean) >= 2 else np.median(col)
    return medians

def build_corrected_col_medians(arr, corr_map):
    a2 = arr.copy()
    for (i, j), v in corr_map.items(): a2[i, j] = v
    return compute_col_medians(a2)

def compute_row_stats(arr):
    n_s, n_y  = arr.shape
    clean_med = np.full(n_s, np.nan)
    clean_cv  = np.full(n_s, np.nan)
    for i in range(n_s):
        row = arr[i].copy(); row = row[np.isfinite(row) & (row > 0)]
        if len(row) < 2: continue
        q1, q3 = np.percentile(row, 25), np.percentile(row, 75); iqr = q3 - q1
        clean  = row[(row >= q1-3*iqr) & (row <= q3+3*iqr)] if iqr > 0 else row
        if len(clean) >= 2:
            m = float(np.median(clean)); clean_med[i] = m
            clean_cv[i] = float(np.std(clean)/m) if m > 0 else np.nan
    return clean_med, clean_cv

def get_trusted_values(arr):
    trusted = []
    for i in range(arr.shape[0]):
        row = arr[i]; vals, counts = np.unique(row[np.isfinite(row) & (row > 0)], return_counts=True)
        trusted.append(set(vals[counts >= 2].tolist()))
    return trusted

def get_consistently_low_standards(arr, col_med, low=0.35, maj=0.60):
    s = set()
    for i in range(arr.shape[0]):
        ok = np.isfinite(col_med)&(col_med>0)&np.isfinite(arr[i])&(arr[i]>0)
        if ok.sum()==0: continue
        if (arr[i,ok]/col_med[ok]<=low).sum()/ok.sum()>=maj: s.add(i)
    return s

def get_consistently_high_standards(arr, col_med, high=3.0, maj=0.60):
    s = set()
    for i in range(arr.shape[0]):
        ok = np.isfinite(col_med)&(col_med>0)&np.isfinite(arr[i])&(arr[i]>0)
        if ok.sum()==0: continue
        if (arr[i,ok]/col_med[ok]>=high).sum()/ok.sum()<maj: continue
        vals = np.sort(arr[i,np.isfinite(arr[i])&(arr[i]>0)])
        trimmed = vals[:-1] if len(vals)>2 else vals
        if len(trimmed)==0: continue
        m = np.mean(trimmed)
        if m>0 and np.std(trimmed)/m<=0.50: s.add(i)
    return s

def get_phase_changed_standards(arr, col_med, years,
                                 low=0.35, high=2.0, ml=2, mh=2, cv_max=0.40):
    n_s, n_y = arr.shape; pc = {}
    for i in range(n_s):
        phases = []
        for j in range(n_y):
            v=arr[i,j]; ym=col_med[j]
            if not(np.isfinite(v)and v>0 and np.isfinite(ym)and ym>0): continue
            r=v/ym; phases.append((j,'low'if r<=low else('high'if r>=high else'mid')))
        found=False
        if len(phases)>=ml+mh:
            for sp in range(ml,len(phases)-mh+1):
                early,later=phases[:sp],phases[sp:]
                if all(p=='low'for _,p in early)and all(p=='high'for _,p in later):
                    hf=[arr[i,jj]for jj,_ in later if np.isfinite(arr[i,jj])and arr[i,jj]>0]
                    cv=np.std(hf)/np.mean(hf) if len(hf)>=2 else 0.0
                    if cv<=cv_max: pc[i]=later[0][0];found=True;break
        if found: continue
        ov=[(j,arr[i,j])for j in range(n_y) if np.isfinite(arr[i,j])and arr[i,j]>0]
        if len(ov)<ml+mh: continue
        for sp in range(ml,len(ov)-mh+1):
            ev=[v for _,v in ov[:sp]]; lv=[v for _,v in ov[sp:]]
            if min(lv)<=max(ev)*5.0: continue
            if len(lv)>=2 and np.std(lv)/np.mean(lv)>cv_max: continue
            if len(ev)>=2 and np.std(ev)/np.mean(ev)>cv_max: continue
            pc[i]=ov[sp][0]; break
    return pc

def get_cross_standard_shared_values(arr, col_med, ratio=3.0):
    max_med = float(np.nanmax(col_med)) if np.any(np.isfinite(col_med)) else None
    shared  = []
    for j in range(arr.shape[1]):
        col=arr[:,j]; col=col[np.isfinite(col)&(col>0)]
        if len(col)<2: shared.append(set()); continue
        vals,counts=np.unique(col,return_counts=True)
        cands=set(vals[counts>=2].tolist())
        if max_med and max_med>0: cands={v for v in cands if v/max_med<=ratio}
        shared.append(cands)
    return shared

def get_shared_low_cells(arr, col_med, n_s, n_y, low=0.35, min_c=2):
    sl=set()
    for j in range(n_y):
        ym=col_med[j]
        if not(np.isfinite(ym)and ym>0): continue
        lr=[(i,arr[i,j])for i in range(n_s)
            if np.isfinite(arr[i,j])and arr[i,j]>0 and arr[i,j]/ym<=low]
        if len(lr)<min_c: continue
        vals=[v for _,v in lr]
        if max(vals)<=min(vals)*4:
            for i,_ in lr: sl.add((i,j))
    return sl

def get_locally_low_cells(arr, row_med, col_med, low=0.35, min_nb=1):
    n_s,n_y=arr.shape; ll=set()
    for i in range(n_s):
        om=row_med[i]
        if not(np.isfinite(om)and om>0): continue
        ly=[j for j in range(n_y)
            if np.isfinite(arr[i,j])and arr[i,j]>0 and arr[i,j]/om<=low]
        if not ly: continue
        ls=set(ly)
        for j in ly:
            nb=sum(1 for dj in[-2,-1,1,2] if(j+dj)in ls)
            if nb>=min_nb: ll.add((i,j))
            else:
                v=arr[i,j]; ym=col_med[j]
                np2=np.sum(np.isfinite(arr[:,j])&(arr[:,j]>0))-1
                if np2<2: ll.add((i,j))
                elif np.isfinite(ym)and ym>0:
                    if abs(v/om)<abs(v*10/om-1): ll.add((i,j))
    return ll

def get_all_low_columns(arr, col_med, row_med, low=None, min_s=None):
    if low is None: low=ALL_LOW_COL_OWN_RATIO
    if min_s is None: min_s=ALL_LOW_COL_MIN_STD
    n_s,n_y=arr.shape; alc=set()
    for j in range(n_y):
        rd=[i for i in range(n_s) if np.isfinite(arr[i,j])and arr[i,j]>0]
        if len(rd)<min_s: continue
        all_low=True
        for i in rd:
            fee=arr[i,j]; om=row_med[i]
            ref=(om if np.isfinite(om)and om>0
                 else(col_med[j] if np.isfinite(col_med[j])and col_med[j]>0 else None))
            if ref is None or fee/ref>low: all_low=False; break
        if all_low: alc.add(j)
    return alc

def is_global_year_jump(arr,j_curr,j_prev,ratio=3.0):
    if j_prev<0: return False
    prev=arr[:,j_prev]; curr=arr[:,j_curr]
    mask=np.isfinite(prev)&np.isfinite(curr)&(prev>0)&(curr>0)
    if mask.sum()<2: return False
    return (curr[mask]/prev[mask]>=ratio*0.7).sum()>=mask.sum()*0.5

def is_global_typo_year(arr,j_curr,j_prev,j_next,jump=3.0,maj=0.60):
    tc=te=0
    for i in range(arr.shape[0]):
        cv=arr[i,j_curr]
        if not(np.isfinite(cv)and cv>0): continue
        pv=arr[i,j_prev]if j_prev>=0 else np.nan
        nv=arr[i,j_next]if j_next>=0 else np.nan
        if not(np.isfinite(pv)and pv>0): continue
        if cv/pv<jump*0.7: continue
        te+=1; cor=cv/10
        tvp=abs(cor-pv)/pv<=ACCEPT_TOLERANCE
        if np.isfinite(nv)and nv>0:
            nsh=abs(nv-cv)/cv<=ACCEPT_TOLERANCE; nrv=abs(nv-cor)/cor<=ACCEPT_TOLERANCE
        else: nsh=False; nrv=True
        if(tvp and not nsh)or(nrv and not nsh and np.isfinite(nv)and nv>0): tc+=1
    return (tc/te)>=maj if te>0 else False

def is_local_dip_np(arr,si,j,n_y,col_med,low=0.35,nb=0.50):
    fee=arr[si,j]
    for dj in[-1,1]:
        jn=j+dj
        if not(0<=jn<n_y): continue
        nv=arr[si,jn]
        if not(np.isfinite(nv)and nv>0): continue
        ym=col_med[jn]
        if np.isfinite(ym)and ym>0:
            nr=nv/ym
            if nr<=nb and nr<=1.0 and abs(nv*10-ym)/ym>ACCEPT_TOLERANCE: return True
        if np.isfinite(fee)and fee>0:
            r=nv/fee
            if 1/3.0<=r<=3.0:
                if np.isfinite(ym)and ym>0:
                    if abs(nv*10-ym)/ym>ACCEPT_TOLERANCE: return True
                else: return True
    return False

# ---- Pre-pass B4 ----
def apply_b4(arr, std_meta, years, school_name):
    n_s,n_y=arr.shape; corrs=[]; cmap={}
    af=[arr[ii,jj]for ii in range(n_s)for jj in range(n_y)
        if np.isfinite(arr[ii,jj])and arr[ii,jj]>0]
    if af:
        lf=sum(1 for v in af if v>=LAKH_THRESHOLD)/len(af)
        if(lf>=SCHOOL_WIDE_LAKH_SKIP_FRAC or
           np.median(af)>=LAKH_THRESHOLD or min(af)>=LAKH_THRESHOLD):
            return corrs,cmap
    s910={i for i,(_, sn,_)in enumerate(std_meta) if is_std_9_or_10(sn)}
    for i,(sid,sname,_)in enumerate(std_meta):
        if i not in s910: continue
        nl=[arr[i,jj]for jj in range(n_y)
            if np.isfinite(arr[i,jj])and arr[i,jj]>0 and arr[i,jj]<LAKH_THRESHOLD]
        opm=float(np.median(nl))if nl else np.nan
        if not np.isfinite(opm): continue
        for j,yr in enumerate(years):
            fee=arr[i,j]
            if not(np.isfinite(fee)and fee>0 and fee>=LAKH_THRESHOLD): continue
            if fee<=LAKH_PEER_MIN_RATIO*opm: continue
            oth=[ii for ii in range(n_s)
                 if ii!=i and ii not in s910 and np.isfinite(arr[ii,j])and arr[ii,j]>0]
            if oth and sum(1 for ii in oth if arr[ii,j]>=LAKH_THRESHOLD)/len(oth)>=B4_PEER_LAKH_YEAR_FRAC:
                continue
            cor=fee/10; cmap[(i,j)]=cor
            corrs.append({"school_name":school_name,"standard_name":sname,
                          "standard_id":sid,"Academic_year":yr,
                          "previous_fee":fee,"corrected_fee":cor,
                          "condition":"Condition B4 - Std 9/10 lakh-range extra zero",
                          "year_median":round(opm,2),"expected_fee":round(opm,2),
                          "global_jump_skipped":False,"pass":"pre"})
    return corrs,cmap

# ---- Pre-pass B5 ----
def apply_b5(arr, std_meta, years, school_name, existing_map):
    n_s,n_y=arr.shape; corrs=[]; cmap={}
    if n_y<2: return corrs,cmap
    af=[arr[ii,jj]for ii in range(n_s)for jj in range(n_y)
        if np.isfinite(arr[ii,jj])and arr[ii,jj]>0 and(ii,jj)not in existing_map]
    if af:
        lf=sum(1 for v in af if v>=LAKH_THRESHOLD)/len(af)
        if(lf>=SCHOOL_WIDE_LAKH_SKIP_FRAC or
           float(np.median(af))>=LAKH_THRESHOLD or min(af)>=LAKH_THRESHOLD):
            return corrs,cmap
    for cs in range(1,min(UNIFORM_LAKH_MAX_TAIL_YEARS,n_y-1)+1):
        cc=list(range(n_y-cs,n_y)); pc=list(range(0,n_y-cs))
        if not pc: continue
        swd=[]; sal=[]
        for i in range(n_s):
            cv=[arr[i,j]for j in cc
                if np.isfinite(arr[i,j])and arr[i,j]>0 and(i,j)not in existing_map]
            if not cv: continue
            swd.append(i)
            if all(v>=LAKH_THRESHOLD for v in cv): sal.append(i)
        if not swd or len(sal)/len(swd)<UNIFORM_LAKH_MIN_STD_COVERAGE: continue
        pv=[arr[i,j]for i in range(n_s)for j in pc
            if np.isfinite(arr[i,j])and arr[i,j]>0
            and arr[i,j]<LAKH_THRESHOLD and(i,j)not in existing_map]
        if not pv: continue
        hm=float(np.median(pv))
        if hm>=LAKH_THRESHOLD: continue
        cvals=[arr[i,j]for i in sal for j in cc
               if np.isfinite(arr[i,j])and arr[i,j]>0 and(i,j)not in existing_map]
        if not cvals: continue
        cm=float(np.median(cvals))
        if cm<=UNIFORM_LAKH_PEER_MIN_RATIO*hm: continue
        cormed=cm/10
        if abs(cormed-hm)/hm>ACCEPT_TOLERANCE: continue
        for i in sal:
            sid=std_meta[i][0]; sname=std_meta[i][1]
            for j in cc:
                if(i,j)in existing_map: continue
                fee=arr[i,j]
                if not(np.isfinite(fee)and fee>0 and fee>=LAKH_THRESHOLD): continue
                cmap[(i,j)]=fee/10
                corrs.append({"school_name":school_name,"standard_name":sname,
                              "standard_id":sid,"Academic_year":years[j],
                              "previous_fee":fee,"corrected_fee":fee/10,
                              "condition":"Condition B5 - school-wide uniform lakh jump",
                              "year_median":round(hm,2),"expected_fee":round(cormed,2),
                              "global_jump_skipped":False,"pass":"pre"})
        break
    return corrs,cmap

# ---- Expected fee ----
def expected_fee_np(arr,si,j,n_y,col_med,row_med,skip_peers=False,oh=3.0,ol=0.35):
    ests=[]
    def clean_val(v,jj):
        ym=col_med[jj]
        return(not(np.isfinite(ym)and ym>0))or(ol<v/ym<oh)
    te=[]
    for dj in[-1,1]:
        jn=j+dj
        if 0<=jn<n_y:
            v=arr[si,jn]
            if np.isfinite(v)and v>0 and clean_val(v,jn): te.append(v)
    if not te:
        for step in range(2,n_y):
            found=False
            for dj in[-step,step]:
                jn=j+dj
                if 0<=jn<n_y:
                    v=arr[si,jn]
                    if np.isfinite(v)and v>0 and clean_val(v,jn): te.append(v);found=True
            if found: break
    if not te and skip_peers:
        om=row_med[si]
        if np.isfinite(om)and om>0: te.append(om)
    ests.extend(te)
    if not skip_peers:
        col=arr[:,j].copy(); col[si]=np.nan; col=col[np.isfinite(col)&(col>0)]
        if len(col)>=2: ests.append(float(np.median(col)))
    return float(np.median(ests))if ests else np.nan

def plausible(c, e):
    try:
        e = float(e); c = float(c)
    except (ValueError, TypeError):
        return False
    return not (pd.isna(e) or e == 0) and abs(c - e) / e <= ACCEPT_TOLERANCE

# ---- Candidate fix functions ----
def fix_extra_zero(f): return f/10 if f%10==0 else None
def fix_missing_zero(f): return f*10
def fix_repeated(f):
    s=str(int(f));n=len(s)
    if n%2==0:
        h=n//2
        if s[:h]==s[h:]: return float(s[:h])
    return None
def fix_power_of_ten(f, e, tol=None):
    if tol is None: tol = ACCEPT_TOLERANCE
    try:
        f = float(f); e = float(e); tol = float(tol)
    except (ValueError, TypeError):
        return None
    if pd.isna(e) or e <= 0 or pd.isna(f) or f <= 0: return None
    best = None; bd = float("inf")
    for k in range(2, 9):
        c = f / (10 ** k); d = abs(c - e) / e
        if d <= tol and d < bd: bd = d; best = c
    return best

def fix_extra_inserted_digit(f, e, peers=None, tol=None):
    if tol is None: tol = ACCEPT_TOLERANCE
    try:
        e = float(e)
    except (ValueError, TypeError):
        return None
    if pd.isna(e) or e <= 0: return None
    try: fs=str(int(f))
    except(ValueError,TypeError): return None
    if len(fs)<2: return None
    cands=[]
    for i in range(len(fs)):
        cs=fs[:i]+fs[i+1:]
        if not cs or cs=="0": continue
        c=float(cs)
        if c>0 and abs(c-e)/e<=tol: cands.append((c,abs(c-e)/e))
    return min(cands,key=lambda x:x[1])[0] if cands else None
def fix_decimal(f,e,peers=None,tol=None):
    import math as _m
    if tol is None: tol=ACCEPT_TOLERANCE
    if pd.isna(e)or e<=0 or f>=1000 or f<=0: return None
    fi=f==_m.floor(f)
    if fi and f>=100: return None
    pr={round(float(p))for p in(peers or[])}
    best=None;bd=float("inf")
    for k in range(1,8):
        c=f*(10**k);d=abs(c-e)/e
        if d>tol: continue
        if round(c)in pr: return c
        if fi: continue
        if c==int(c)and d<bd: bd=d;best=c
    return best
def _is_one_del(sh,lo):
    if len(lo)!=len(sh)+1: return False
    for i in range(len(lo)):
        if lo[:i]+lo[i+1:]==sh: return True
    return False
def fix_missing_digit(f,peers,e,tol=None,own_med=None):
    if tol is None: tol=ACCEPT_TOLERANCE
    try: fs=str(int(f))if float(f)==int(float(f))else str(f)
    except(ValueError,TypeError): return None
    cands=[];seen=set()
    for p in peers:
        try: pv=float(p);ps=str(int(pv))if pv==int(pv)else str(pv)
        except(ValueError,TypeError): continue
        if((ps.endswith(fs)and len(ps)>len(fs))or _is_one_del(fs,ps))and pv not in seen:
            cands.append(pv);seen.add(pv)
    if own_med and own_med>0 and cands: cands=[c for c in cands if c/own_med>=0.50]
    if not np.isnan(e)and e>0:
        x10=f*10;x10d=abs(x10-e)/e
        pl=[c for c in cands if abs(c-e)/e<=tol]
        if pl:
            best=min(pl,key=lambda c:abs(c-e)/e)
            if len(set(round(c)for c in cands))==1 and best/f<10: return best
            if abs(best-e)/e<=x10d*1.30: return best
        return x10 if x10d<=tol else None
    return cands[0]if cands else None
def fix_digit_sub(f,e,peers=None,tol=None):
    if tol is None: tol=ACCEPT_TOLERANCE
    if pd.isna(e)or e<=0: return None
    try: fs=str(int(f))
    except(ValueError,OverflowError): return None
    if len(fs)<2: return None
    ps2=set()
    if peers:
        for p in peers:
            try:
                pv=int(float(p))
                if pv>0 and len(str(pv))==len(fs): ps2.add(pv)
            except(ValueError,TypeError): pass
    if not ps2: return None
    best=None;bd=float("inf")
    for pv in ps2:
        pvs=str(pv)
        if len(pvs)!=len(fs): continue
        if sum(a!=b for a,b in zip(fs,pvs))!=1: continue
        d=abs(pv-e)/e
        if d<=tol and d<bd: bd=d;best=float(pv)
    return best

# ---- Core detection loop ----
def _detect_loop(arr,std_meta,years,dup_cells,col_med,row_med,
                  trusted,c_low,c_high,phase_ch,cross_sh,sh_low,loc_low,
                  school_name,yr_meds,all_low_cols=None,skip=None):
    n_s,n_y=arr.shape
    std_ids=[m[0]for m in std_meta]; std_names=[m[1]for m in std_meta]
    if skip is None: skip=set()
    if all_low_cols is None: all_low_cols=set()
    corrs=[]
    for j in range(n_y):
        yr=years[j];ym=float(col_med[j])
        if not(np.isfinite(ym)and ym>0): continue
        if j in all_low_cols: continue
        col=arr[:,j];valid=np.isfinite(col)&(col>0)
        if valid.sum()<2: continue
        jp=j-1 if j>0 else -1;jn=j+1 if j<n_y-1 else -1
        cgj=is_global_year_jump(arr,j,jp)if jp>=0 else False
        gj=(not is_global_typo_year(arr,j,jp,jn))if cgj else False
        if not cgj and j==0 and jn>=0:
            nc=arr[:,jn];nc=nc[np.isfinite(nc)&(nc>0)]
            if len(nc)>=2:
                nym=float(np.median(nc))
                if nym>0:
                    cv2=col[valid]
                    if(cv2/nym>=WITHIN_YEAR_HIGH_RATIO*0.7).sum()>=len(cv2)*0.5:
                        if sum(1 for v in cv2 if abs(v/10-nym)/nym<=ACCEPT_TOLERANCE)>=len(cv2)*0.5:
                            cgj=True;gj=False
        for i in range(n_s):
            if(i,j)in skip: continue
            fee=float(arr[i,j])   # always plain Python float
            ym =float(col_med[j]) # always plain Python float
            if not(np.isfinite(fee)and fee>0): continue
            ratio=fee/ym
            if is_std_9_or_10(std_names[i])and ratio<=WITHIN_YEAR_LOW_RATIO: continue
            if(i,j)in loc_low: continue
            _to=False
            if fee in trusted[i]:
                oe=arr[i].copy();oe[oe==fee]=np.nan;oe=oe[np.isfinite(oe)&(oe>0)]
                if len(oe)>=2:
                    q1t,q3t=np.percentile(oe,25),np.percentile(oe,75);iqrt=q3t-q1t
                    oc=(oe[(oe>=q1t-3*iqrt)&(oe<=q3t+3*iqrt)]if iqrt>0 else oe)
                    if len(oc)>=2:
                        mc=float(np.median(oc));cvc=float(np.std(oc)/mc)if mc>0 else 1.0
                        if mc>0 and cvc<0.5 and fee/mc>=WITHIN_YEAR_HIGH_RATIO and i not in c_high:
                            _to=True
                if not _to: continue
            _sgj=_to
            if(i,j)in dup_cells: continue
            if fee in cross_sh[j]:
                _bp=(cgj and not gj)or _to
                if not _bp and ratio>=WITHIN_YEAR_LOW_RATIO:
                    oh=arr[i].copy();oh[j]=np.nan;oh=oh[np.isfinite(oh)&(oh>0)]
                    if len(oh)>=2:
                        q1o,q3o=np.percentile(oh,25),np.percentile(oh,75);iqro=q3o-q1o
                        oc=(oh[(oh>=q1o-3*iqro)&(oh<=q3o+3*iqro)]if iqro>0 else oh)
                        if len(oc)>=2:
                            om=float(np.median(oc));cvo=float(np.std(oc)/om)if om>0 else 1.0
                            if om>0 and cvo<0.5 and fee/om<=WITHIN_YEAR_LOW_RATIO and i not in c_low:
                                _bp=True
                if not _bp:
                    if ratio>=WITHIN_YEAR_LOW_RATIO: continue
                    elif i in c_low: continue
            if(i,j)in sh_low and i not in c_low: pass
            elif(i,j)in sh_low and i in c_low: continue
            if i in c_low: continue
            ym_eff=ym
            if i in c_high:
                tv=trusted[i];or2=arr[i].copy();or2[j]=np.nan;orv=or2[np.isfinite(or2)&(or2>0)]
                to2=(orv[np.isin(orv,list(tv))]if tv else np.array([]))
                ref=(float(np.median(to2))if len(to2)>=1
                     else(float(np.median(orv))if len(orv)>=1 else np.nan))
                if np.isfinite(ref)and ref>0:
                    r2=fee/ref
                    if 1/WITHIN_YEAR_HIGH_RATIO<=r2<=WITHIN_YEAR_HIGH_RATIO: continue
                    ratio=r2;ym_eff=ref
                else: continue
            if i in phase_ch:
                jt=phase_ch[i]
                if j<jt: continue
                hf=[arr[i,jj]for jj in range(jt,n_y) if np.isfinite(arr[i,jj])and arr[i,jj]>0]
                if hf:
                    ref=float(np.median(hf));r2=fee/ref if ref>0 else 1.0
                    if 1/WITHIN_YEAR_HIGH_RATIO<=r2<=WITHIN_YEAR_HIGH_RATIO: continue
                    ratio=r2;ym_eff=ref
            _egj=gj and not _sgj
            anomaly=None
            if ratio>=WITHIN_YEAR_HIGH_RATIO and not _egj: anomaly="high"
            elif ratio<=WITHIN_YEAR_LOW_RATIO and not _egj: anomaly="low"
            if anomaly is None and not _egj:
                oe=arr[i].copy();oe[j]=np.nan;oe=oe[np.isfinite(oe)&(oe>0)]
                if len(oe)>=2:
                    q1h,q3h=np.percentile(oe,25),np.percentile(oe,75);iqrh=q3h-q1h
                    oc=(oe[(oe>=q1h-3*iqrh)&(oe<=q3h+3*iqrh)]if iqrh>0 else oe)
                    if len(oc)>=2:
                        om=float(np.median(oc));cvo=float(np.std(oc)/om)if om>0 else 1.0
                        if om>0 and cvo<0.5:
                            r2=fee/om
                            if r2<=WITHIN_YEAR_LOW_RATIO and not is_std_9_or_10(std_names[i]):
                                anomaly="low";ym_eff=om;ratio=r2
                            elif r2>=WITHIN_YEAR_HIGH_RATIO and i not in c_high:
                                anomaly="high";ym_eff=om;ratio=r2
            if anomaly=="low" and is_local_dip_np(arr,i,j,n_y,col_med): continue
            if anomaly=="high" and yr_meds:
                cm2={y2:m for y2,m in yr_meds.items()
                     if not(y2==yr and((cgj and not gj)or _sgj))}
                if cm2:
                    mx=max(cm2.values())
                    if mx>0 and fee/mx<=WITHIN_YEAR_HIGH_RATIO: continue
            if anomaly is None: continue
            _sp=(cgj and not gj)or _sgj
            exp=expected_fee_np(arr,i,j,n_y,col_med,row_med,skip_peers=_sp)
            # Always coerce to plain Python float to avoid numpy array ambiguity
            try:
                exp = float(exp)
            except (ValueError, TypeError):
                exp = float("nan")
            pm=np.arange(n_s)!=i; pc2=arr[pm,j]; pf=pc2[np.isfinite(pc2)&(pc2>0)].tolist()
            cor=None;cond=None
            if cor is None and anomaly=="low" and fee<1000:
                c=fix_decimal(fee,exp,pf); 
                if c is not None and plausible(c,exp): cor=c;cond="Condition 6 - decimal point misplacement"
            if cor is None:
                c=fix_repeated(fee)
                if c is not None and plausible(c,exp): cor=c;cond="Condition 3 - repeated digits"
            pr2={round(float(p))for p in pf}if pf else set()
            c1hp=(cor is None and anomaly=="high" and fee%10==0 and round(fee/10)in pr2)
            _gty=(cgj and not gj)or _sgj
            if c1hp or(_gty and fee%10==0):
                c=fix_extra_zero(fee)
                if c is not None and plausible(c,exp): cor=c;cond="Condition 1 - extra zero"
            if cor is None and anomaly=="high":
                c=fix_extra_inserted_digit(fee,exp,pf)
                if c is not None and plausible(c,exp)and(fee%10!=0 or abs(c-fee/10)>1):
                    cor=c;cond="Condition 5 - extra inserted digit"
            if cor is None and anomaly=="high":
                c=fix_power_of_ten(fee,exp,pf)
                if c is not None and plausible(c,exp): cor=c;cond="Condition 8 - multiple extra zeros"
            if cor is None and anomaly=="high":
                c=fix_extra_zero(fee)
                if c is not None and plausible(c,exp): cor=c;cond="Condition 1 - extra zero"
            if cor is None and anomaly=="low":
                oh=arr[i].copy();oh[j]=np.nan;oh=oh[np.isfinite(oh)&(oh>0)]
                om=(float(np.median(oh))if len(oh)>=2 else None)
                c=fix_missing_digit(fee,pf,exp,own_med=om)
                if c is not None and plausible(c,exp): cor=c;cond="Condition 4 - missing digit (peer match)"
            if cor is None and anomaly=="low":
                c=fix_missing_zero(fee)
                if plausible(c,exp): cor=c;cond="Condition 2 - missing zero"
            if cor is None and anomaly=="low":
                c=fix_digit_sub(fee,exp,pf)
                if c is not None and plausible(c,exp): cor=c;cond="Condition 7 - digit substitution"
            if cor is not None:
                corrs.append({
                    "school_name":         school_name,
                    "standard_name":       std_names[i],
                    "standard_id":         std_ids[i],
                    "Academic_year":       yr,
                    "previous_fee":        fee,
                    "corrected_fee":       cor,
                    "condition":           cond,
                    "year_median":         round(float(ym_eff),2),
                    "expected_fee":        round(exp,2)if np.isfinite(exp)else"",
                    "global_jump_skipped": gj,
                    "pass":                "second"if skip else"first",
                })
    return corrs

# ---- Per-school detector ----
def detect_school(school_df: pd.DataFrame, school_name: str) -> list[dict]:
    arr,std_meta,years,dup_keys=build_matrix(school_df)
    n_s,n_y=arr.shape
    std_ids=[m[0]for m in std_meta]
    sid_to_row={sid:i for i,sid in enumerate(std_ids)}
    yr_to_col={y:j for j,y in enumerate(years)}
    dup_cells={(sid_to_row[sid],yr_to_col[yr])
               for sid,yr in dup_keys if sid in sid_to_row and yr in yr_to_col}
    pb4,pm4=apply_b4(arr,std_meta,years,school_name)
    pb5,pm5=apply_b5(arr,std_meta,years,school_name,pm4)
    all_pre={**pm4,**pm5}
    ac=arr.copy()
    for(i,j),v in all_pre.items(): ac[i,j]=v
    col_med=compute_col_medians(ac)
    yr_meds={years[j]:float(col_med[j])for j in range(n_y)if np.isfinite(col_med[j])}
    row_med,_=compute_row_stats(ac)
    trusted=get_trusted_values(ac)
    cl=get_consistently_low_standards(ac,col_med)
    ch=get_consistently_high_standards(ac,col_med)
    pc=get_phase_changed_standards(ac,col_med,years)
    cs=get_cross_standard_shared_values(ac,col_med)
    sl=get_shared_low_cells(ac,col_med,n_s,n_y)
    ll=get_locally_low_cells(ac,row_med,col_med)
    alc=get_all_low_columns(ac,col_med,row_med)
    fp=_detect_loop(ac,std_meta,years,dup_cells,col_med,row_med,
                     trusted,cl,ch,pc,cs,sl,ll,school_name,yr_meds,
                     all_low_cols=alc,skip=set(all_pre.keys()))
    sp=[]
    if fp:
        fm={};
        for c in fp:
            i=sid_to_row.get(c["standard_id"]); j=yr_to_col.get(c["Academic_year"])
            if i is not None and j is not None: fm[(i,j)]=c["corrected_fee"]
        am2={**all_pre,**fm}
        cm2=build_corrected_col_medians(arr,am2)
        cy={jj for jj in range(n_y)
            if np.isfinite(col_med[jj])and np.isfinite(cm2[jj])and col_med[jj]>0
            and abs(cm2[jj]-col_med[jj])/col_med[jj]>0.05}
        if cy:
            rm2,_=compute_row_stats(ac)
            ym2={years[j]:float(cm2[j])for j in range(n_y)if np.isfinite(cm2[j])}
            sp=_detect_loop(ac,std_meta,years,dup_cells,cm2,rm2,
                             get_trusted_values(ac),
                             get_consistently_low_standards(ac,cm2),
                             get_consistently_high_standards(ac,cm2),
                             get_phase_changed_standards(ac,cm2,years),
                             get_cross_standard_shared_values(ac,cm2),
                             get_shared_low_cells(ac,cm2,n_s,n_y),
                             get_locally_low_cells(ac,rm2,cm2),
                             school_name,ym2,
                             all_low_cols=get_all_low_columns(ac,cm2,rm2),
                             skip=set(am2.keys()))
            sp=[c for c in sp if yr_to_col.get(c["Academic_year"])in cy]
    return pb4+pb5+fp+sp

# ============================================================
# STEP 6 — APPLY CORRECTIONS TO FEE ROWS
# ============================================================
def apply_corrections(
    fee_rows: list[dict],
    corrections: list[dict],
    school_key_to_name: dict[str, str],
) -> tuple[list[dict], list[dict]]:
    """
    Applies correction lookup to fee_rows in-place (by value).
    Returns (corrected_fee_rows, log_rows).

    Correction lookup key: (school_key, standard_id, academic_year_str)
    """
    now = now_iso()

    # Build lookup: (school_key, standard_id, str(academic_year)) -> corrected_fee
    corr_map: dict[tuple, float] = {}
    for c in corrections:
        sid  = c["standard_id"]
        yr   = str(c["Academic_year"])
        sname = c["school_name"]
        # Find school_key by matching school_name → school_key
        # (stored as school_key -> name, so invert)
        for sk, nm in school_key_to_name.items():
            if nm == sname:
                corr_map[(sk, str(sid), yr)] = c["corrected_fee"]

    corrected_rows = []
    for row in fee_rows:
        sk  = str(row["school_key"])
        sid = str(row["standard_id"])
        yr  = str(row["academic_year"])
        key = (sk, sid, yr)
        if key in corr_map:
            row = dict(row)  # copy
            row["approved_fee"] = format_fee(corr_map[key])
        corrected_rows.append(row)

    # Build log rows
    log_rows = []
    for c in corrections:
        log_rows.append({
            "school_name":   c["school_name"],
            "standard_name": c["standard_name"],
            "Academic_year": c["Academic_year"],
            "previous_fee":  format_fee(c["previous_fee"]),
            "corrected_fee": format_fee(c["corrected_fee"]),
            "pass":          c.get("pass", ""),
            "inserted_at":   now,
        })

    return corrected_rows, log_rows

# ============================================================
# MAIN
# ============================================================
def main():
    log.info("=" * 60)
    log.info("FRC Gujarat — Structure + Clean")
    log.info("=" * 60)

    # Validate required files
    for p in [SCHOOLS_RAW_CSV, FEES_RAW_CSV, DIM_STANDARD_CSV, STD_MAPPING_CSV]:
        if not p.exists():
            log.error(f"Required file missing: {p}")
            sys.exit(1)

    # Ensure output files exist with headers
    ensure_csv(DIM_SCHOOL_CSV,  DIM_SCHOOL_COLS)
    ensure_csv(FACT_FEES_CSV,   FACT_FEES_COLS)
    ensure_csv(CORR_LOG_CSV,    CORR_LOG_COLS)

    # ── Load reference data ──────────────────────────────────
    std_mapping = load_standard_mapping()
    dim_std_df  = load_dim_standard()

    # ── Find new schools ─────────────────────────────────────
    existing_nk       = load_existing_natural_keys()
    existing_fee_keys = load_existing_fee_keys()

    new_raw_schools = find_new_raw_schools(existing_nk)
    if not new_raw_schools:
        log.info("No new schools found — everything is up to date.")
        return

    # ── Build dim_school rows ────────────────────────────────
    sid_to_dim = build_dim_school(new_raw_schools)   # raw_school_id -> dim row

    # ── Build raw fee rows (unclean) ─────────────────────────
    raw_fee_rows, existing_fee_keys = build_raw_fee_rows(
        sid_to_dim, std_mapping, existing_fee_keys
    )

    if not raw_fee_rows:
        log.info("No new fee rows to process.")
        # Still write dim_school rows if any
        dim_rows = list(sid_to_dim.values())
        append_csv(DIM_SCHOOL_CSV, DIM_SCHOOL_COLS, dim_rows)
        log.info(f"Appended {len(dim_rows)} rows → dim_school.csv")
        return

    # ── Enrich fee rows with standard metadata for detection ─
    # Build lookup: school_key -> school_name
    sk_to_name = {v["school_key"]: v["school_name"] for v in sid_to_dim.values()}

    # Build a DataFrame of new fee rows + standard_name + standard_order
    fee_df = pd.DataFrame(raw_fee_rows)
    fee_df["standard_id"] = pd.to_numeric(fee_df["standard_id"], errors="coerce")
    fee_df = fee_df.merge(
        dim_std_df[["standard_id", "standard_name", "standard_order"]],
        on="standard_id", how="left"
    )
    fee_df["school_name"]   = fee_df["school_key"].map(sk_to_name)
    fee_df["academic_year"] = fee_df["academic_year"].astype(str).str.strip()

    # ── Run anomaly detection per school ─────────────────────
    all_corrections: list[dict] = []
    school_groups = fee_df.groupby("school_key")
    total = len(school_groups)
    log.info(f"Running anomaly detection on {total:,} new schools ...")

    for idx, (sk, sdf) in enumerate(school_groups, 1):
        if idx % 200 == 0 or idx == total:
            log.info(f"  {idx}/{total} schools processed ...")
        school_name = sk_to_name.get(sk, str(sk))
        all_corrections.extend(detect_school(sdf, school_name))

    log.info(f"Anomalies detected: {len(all_corrections):,}")

    # ── Apply corrections to fee rows ────────────────────────
    corrected_fee_rows, log_rows = apply_corrections(
        raw_fee_rows, all_corrections, sk_to_name
    )

    # ── Write outputs ─────────────────────────────────────────
    dim_rows = list(sid_to_dim.values())
    append_csv(DIM_SCHOOL_CSV, DIM_SCHOOL_COLS, dim_rows)
    log.info(f"Appended {len(dim_rows):,} rows → dim_school.csv")

    append_csv(FACT_FEES_CSV, FACT_FEES_COLS, corrected_fee_rows)
    log.info(f"Appended {len(corrected_fee_rows):,} rows → fact_school_fees.csv")

    append_csv(CORR_LOG_CSV, CORR_LOG_COLS, log_rows)
    log.info(f"Appended {len(log_rows):,} rows → fee_corrections_log.csv")

    # ── Summary ───────────────────────────────────────────────
    if log_rows:
        from collections import Counter
        conds = Counter(c.get("condition","") for c in all_corrections)
        log.info("\n-- Correction breakdown --")
        for cond, cnt in conds.most_common():
            log.info(f"  {cnt:>5}  {cond}")

    log.info("=" * 60)
    log.info("Done.")
    log.info("=" * 60)

if __name__ == "__main__":
    main()