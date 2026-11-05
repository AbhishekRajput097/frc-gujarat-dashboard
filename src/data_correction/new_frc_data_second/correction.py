"""
School Fee Anomaly Detection & Correction  (v17)
================================================
Built on top of v16.

Changes in v17
--------------

NEW YEAR-LEVEL GATE in B4 — Cross-standard lakh check per year.

  Problem in v16:
    B4 correctly skipped Std 9/10 correction when the standard had no
    non-lakh history (own_peer_median = NaN).  But for schools where
    Std 9/10 has SOME non-lakh history in early years and then jumps to
    lakh-range in later years — and ALL other standards also jump to
    lakh-range in those same years — B4 was still incorrectly dividing
    the Std 9/10 lakh-range fees by 10.

  New gate (added inside the per-cell loop in apply_std9_10_lakh_fix):
    For each year-column where Std 9/10 has a lakh-range fee, check what
    fraction of OTHER (non-9/10) standards in that SAME year also have
    lakh-range fees.

      - If >= B4_PEER_LAKH_YEAR_FRAC (default 0.5) of peer standards
        are also in lakh range that year → the school is genuinely
        expensive that year → SKIP correction for Std 9/10.

      - Only correct if the peer standards are in thousands, confirming
        that the Std 9/10 lakh value is an isolated typo.

  This is the most targeted fix: it operates year-by-year, so a school
  that transitions from thousands to lakhs mid-history is handled
  correctly — early years (where peers are in thousands) are still
  corrected, later years (where peers are also in lakhs) are not.

  All other v16 behaviour (school-level gate, standard-level NaN gate,
  own-history ratio gate) preserved and still run first.
"""


import pandas as pd
import numpy as np
import os


# ---------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------
_BASE = os.path.dirname(os.path.abspath(__file__))


FEES_PATH   = os.path.join(_BASE, "fact_school_fees.csv")
STD_PATH    = os.path.join(_BASE, "../../../data/dashboard_local/data/dim_standard.csv")
SCHOOL_PATH = os.path.join(_BASE, "../../../data/dashboard_local/data/dim_school.csv")
OUT_FEES    = os.path.join(_BASE, "updated_fact_school_fees.csv")
OUT_CHANGES = os.path.join(_BASE, "../../../data/data_correction/new_frc_data_second/fee_corrections_log.csv")


WITHIN_YEAR_HIGH_RATIO = 3.0
WITHIN_YEAR_LOW_RATIO  = 0.35
ACCEPT_TOLERANCE       = 0.55


# ---------------------------------------------------------------
# FIX_B4 CONFIG
# ---------------------------------------------------------------
LAKH_THRESHOLD            = 100_000
LAKH_PEER_MIN_RATIO       = 2.0
LAKH_SCHOOL_WIDE_MIN_FRAC = 0.5

# NEW in v14, revised in v15:
# If >= this fraction of ALL school cells are lakh-range, skip B4 & B5
# entirely (the school is genuinely expensive).
# Lowered from 0.80 → 0.60 in v15 to catch schools like NAVRACHNA where
# a few cheaper standards slightly dilute the lakh fraction.
SCHOOL_WIDE_LAKH_SKIP_FRAC = 0.60

# NEW in v17: per-year cross-standard lakh check in B4.
# If >= this fraction of OTHER (non-9/10) standards in the same year
# are also lakh-range, skip correcting Std 9/10 for that year.
B4_PEER_LAKH_YEAR_FRAC = 0.50

# ---------------------------------------------------------------
# FIX_B5 CONFIG
# ---------------------------------------------------------------
UNIFORM_LAKH_MAX_TAIL_YEARS    = 3    # max consecutive trailing years to treat as a cluster
UNIFORM_LAKH_PEER_MIN_RATIO    = 5.0  # cluster median must be > this × historical median
UNIFORM_LAKH_MIN_STD_COVERAGE  = 0.80 # fraction of standards that must be in lakh range in cluster

# ---------------------------------------------------------------
# ALL-LOW COLUMN GUARD CONFIG  (new in v14, revised in v15)
# ---------------------------------------------------------------
ALL_LOW_COL_MIN_STD   = 2     # minimum standards with data required to apply the guard
# v15: compare each standard's fee against its OWN cross-year median
# (not the within-column median) to catch columns like JIVAN JYOT 2017-18
# where all three fees (75, 50, 50) look normal within their column but
# are tiny relative to the school's own history (660-1900).
ALL_LOW_COL_OWN_RATIO = 0.35  # same as WITHIN_YEAR_LOW_RATIO


STD_9_10_NAMES = {
    "9", "10",
    "std 9", "std 10",
    "std. 9", "std. 10",
    "standard 9", "standard 10",
    "class 9", "class 10",
    "ix", "x",
    "grade 9", "grade 10",
}


def is_std_9_or_10(standard_name: str) -> bool:
    return str(standard_name).strip().lower() in STD_9_10_NAMES


# ---------------------------------------------------------------
# LOAD & ENRICH
# ---------------------------------------------------------------
def load_and_enrich():
    fees   = pd.read_csv(FEES_PATH)
    stds   = pd.read_csv(STD_PATH)
    school = pd.read_csv(SCHOOL_PATH)
    df = fees.merge(stds[["standard_id","standard_name","standard_group","standard_order"]],
                    on="standard_id", how="left")
    df = df.merge(school[["school_key","school_name"]], on="school_key", how="left")
    df["approved_fee"]  = pd.to_numeric(df["approved_fee"], errors="coerce")
    df["academic_year"] = df["academic_year"].astype(str).str.strip()
    return df, fees


# ---------------------------------------------------------------
# MATRIX BUILDER
# ---------------------------------------------------------------
def build_matrix(school_df: pd.DataFrame):
    dup_keys = set()
    for (sid, yr), g in school_df.groupby(["standard_id","academic_year"])["approved_fee"]:
        clean = g.dropna()
        if len(clean) >= 2 and clean.nunique() == 1:
            dup_keys.add((sid, yr))

    first_vals = (school_df
                  .sort_values("approved_fee")
                  .groupby(["standard_id","standard_name","standard_order","academic_year"],
                           sort=False)["approved_fee"]
                  .first()
                  .reset_index())

    stds_df = (first_vals[["standard_id","standard_name","standard_order"]]
               .drop_duplicates()
               .sort_values("standard_order"))
    std_meta = list(stds_df.itertuples(index=False, name=None))
    std_id_to_row = {sid: i for i, (sid, _, _) in enumerate(std_meta)}

    years = sorted(first_vals["academic_year"].unique().tolist())
    yr_to_col = {y: j for j, y in enumerate(years)}

    n_s, n_y = len(std_meta), len(years)
    arr = np.full((n_s, n_y), np.nan, dtype=np.float64)

    for _, row in first_vals.iterrows():
        si = std_id_to_row.get(row["standard_id"])
        yj = yr_to_col.get(row["academic_year"])
        if si is not None and yj is not None:
            v = row["approved_fee"]
            if pd.notna(v):
                arr[si, yj] = float(v)

    return arr, std_meta, years, dup_keys


# ---------------------------------------------------------------
# COLUMN (YEAR) MEDIANS — vectorised, IQR-cleaned
# ---------------------------------------------------------------
def compute_col_medians(arr: np.ndarray) -> np.ndarray:
    n_s, n_y = arr.shape
    medians = np.full(n_y, np.nan)
    for j in range(n_y):
        col = arr[:, j]
        col = col[np.isfinite(col) & (col > 0)]
        if len(col) < 2:
            continue
        q1, q3 = np.percentile(col, 25), np.percentile(col, 75)
        iqr = q3 - q1
        if iqr > 0:
            clean = col[(col >= q1 - 3*iqr) & (col <= q3 + 3*iqr)]
            medians[j] = np.median(clean) if len(clean) >= 2 else np.median(col)
        else:
            medians[j] = np.median(col)
    return medians


# ---------------------------------------------------------------
# FIX_B1: Compute col_medians with known corrections applied
# ---------------------------------------------------------------
def build_corrected_col_medians(arr: np.ndarray,
                                 corrections_map: dict) -> np.ndarray:
    arr2 = arr.copy()
    for (i, j), val in corrections_map.items():
        arr2[i, j] = val
    return compute_col_medians(arr2)


# ---------------------------------------------------------------
# ROW (STANDARD) CLEAN HISTORY STATS
# ---------------------------------------------------------------
def compute_row_stats(arr: np.ndarray, exclude_col: int = -1):
    n_s, n_y = arr.shape
    clean_med = np.full(n_s, np.nan)
    clean_cv  = np.full(n_s, np.nan)
    for i in range(n_s):
        row = arr[i].copy()
        if exclude_col >= 0:
            row[exclude_col] = np.nan
        row = row[np.isfinite(row) & (row > 0)]
        if len(row) < 2:
            continue
        q1, q3 = np.percentile(row, 25), np.percentile(row, 75)
        iqr = q3 - q1
        clean = row[(row >= q1 - 3*iqr) & (row <= q3 + 3*iqr)] if iqr > 0 else row
        if len(clean) >= 2:
            m = float(np.median(clean))
            clean_med[i] = m
            clean_cv[i]  = float(np.std(clean) / m) if m > 0 else np.nan
    return clean_med, clean_cv


# ---------------------------------------------------------------
# YEAR-LEVEL CHECKS
# ---------------------------------------------------------------
def is_global_year_jump(arr, j_curr, j_prev, ratio=3.0):
    if j_prev < 0:
        return False
    prev = arr[:, j_prev]
    curr = arr[:, j_curr]
    mask = np.isfinite(prev) & np.isfinite(curr) & (prev > 0) & (curr > 0)
    if mask.sum() < 2:
        return False
    ratios    = curr[mask] / prev[mask]
    high_jump = (ratios >= ratio * 0.7).sum()
    return high_jump >= mask.sum() * 0.5


def is_global_typo_year(arr, j_curr, j_prev, j_next,
                         jump_ratio=3.0, typo_majority=0.60):
    typo_count = tested = 0
    n_s = arr.shape[0]
    for i in range(n_s):
        curr_val = arr[i, j_curr]
        if not np.isfinite(curr_val) or curr_val <= 0:
            continue
        prev_val = arr[i, j_prev] if j_prev >= 0 else np.nan
        next_val = arr[i, j_next] if j_next >= 0 else np.nan
        if not np.isfinite(prev_val) or prev_val <= 0:
            continue
        if curr_val / prev_val < jump_ratio * 0.7:
            continue
        tested += 1
        corrected = curr_val / 10
        typo_vs_prev = (abs(corrected - prev_val) / prev_val <= ACCEPT_TOLERANCE)
        if np.isfinite(next_val) and next_val > 0:
            next_stays_high = abs(next_val - curr_val) / curr_val <= ACCEPT_TOLERANCE
            next_reverts    = abs(next_val - corrected) / corrected <= ACCEPT_TOLERANCE
        else:
            next_stays_high = False
            next_reverts    = True
        is_typo = (typo_vs_prev and not next_stays_high) or \
                  (next_reverts and not next_stays_high
                   and np.isfinite(next_val) and next_val > 0)
        if is_typo:
            typo_count += 1
    if tested == 0:
        return False
    return (typo_count / tested) >= typo_majority


# ---------------------------------------------------------------
# GUARD FUNCTIONS
# ---------------------------------------------------------------
def get_trusted_values(arr: np.ndarray) -> list:
    trusted = []
    for i in range(arr.shape[0]):
        row = arr[i]
        vals, counts = np.unique(row[np.isfinite(row) & (row > 0)], return_counts=True)
        trusted.append(set(vals[counts >= 2].tolist()))
    return trusted


def get_consistently_low_standards(arr, col_medians,
                                    low_threshold=0.35, majority_frac=0.60) -> set:
    n_s, n_y = arr.shape
    consistently_low = set()
    for i in range(n_s):
        years_ok = np.isfinite(col_medians) & (col_medians > 0) & \
                   np.isfinite(arr[i]) & (arr[i] > 0)
        if years_ok.sum() == 0:
            continue
        ratios = arr[i, years_ok] / col_medians[years_ok]
        if (ratios <= low_threshold).sum() / years_ok.sum() >= majority_frac:
            consistently_low.add(i)
    return consistently_low


def get_consistently_high_standards(arr, col_medians,
                                     high_threshold=3.0, majority_frac=0.60) -> set:
    n_s, n_y = arr.shape
    consistently_high = set()
    for i in range(n_s):
        years_ok = np.isfinite(col_medians) & (col_medians > 0) & \
                   np.isfinite(arr[i]) & (arr[i] > 0)
        if years_ok.sum() == 0:
            continue
        ratios = arr[i, years_ok] / col_medians[years_ok]
        if (ratios >= high_threshold).sum() / years_ok.sum() < majority_frac:
            continue
        vals    = np.sort(arr[i, np.isfinite(arr[i]) & (arr[i] > 0)])
        trimmed = vals[:-1] if len(vals) > 2 else vals
        if len(trimmed) == 0:
            continue
        mean = np.mean(trimmed)
        if mean > 0 and np.std(trimmed) / mean <= 0.50:
            consistently_high.add(i)
    return consistently_high


def get_phase_changed_standards(arr, col_medians, years,
                                 low_ratio=0.35, high_ratio=2.0,
                                 min_low_years=2, min_high_years=2,
                                 high_phase_cv_max=0.40) -> dict:
    n_s, n_y = arr.shape
    phase_changed = {}

    for i in range(n_s):
        phases = []
        for j in range(n_y):
            v  = arr[i, j]
            ym = col_medians[j]
            if not (np.isfinite(v) and v > 0 and np.isfinite(ym) and ym > 0):
                continue
            r = v / ym
            if r <= low_ratio:
                phases.append((j, 'low'))
            elif r >= high_ratio:
                phases.append((j, 'high'))
            else:
                phases.append((j, 'mid'))

        found = False
        if len(phases) >= min_low_years + min_high_years:
            for split in range(min_low_years, len(phases) - min_high_years + 1):
                early, later = phases[:split], phases[split:]
                if (all(p == 'low'  for _, p in early) and
                        all(p == 'high' for _, p in later)):
                    high_fees = [arr[i, jj] for jj, _ in later
                                 if np.isfinite(arr[i, jj]) and arr[i, jj] > 0]
                    cv = (np.std(high_fees) / np.mean(high_fees)
                          if len(high_fees) >= 2 else 0.0)
                    if cv <= high_phase_cv_max:
                        phase_changed[i] = later[0][0]
                        found = True
                        break

        if found:
            continue

        # FIX_B3: own-history phase detection
        own_vals = [(j, arr[i, j]) for j in range(n_y)
                    if np.isfinite(arr[i, j]) and arr[i, j] > 0]
        if len(own_vals) < min_low_years + min_high_years:
            continue

        for split in range(min_low_years, len(own_vals) - min_high_years + 1):
            early_vals = [v for _, v in own_vals[:split]]
            later_vals = [v for _, v in own_vals[split:]]

            early_max = max(early_vals)
            later_min = min(later_vals)

            own_step_ratio = 5.0
            if later_min <= early_max * own_step_ratio:
                continue

            if len(later_vals) >= 2:
                cv = np.std(later_vals) / np.mean(later_vals)
                if cv > high_phase_cv_max:
                    continue

            if len(early_vals) >= 2:
                early_cv = np.std(early_vals) / np.mean(early_vals)
                if early_cv > high_phase_cv_max:
                    continue

            transition_j = own_vals[split][0]
            phase_changed[i] = transition_j
            break

    return phase_changed


def get_cross_standard_shared_values(arr, col_medians,
                                      plausibility_ratio=3.0) -> list:
    n_s, n_y = arr.shape
    max_med = float(np.nanmax(col_medians)) if np.any(np.isfinite(col_medians)) else None
    shared  = []
    for j in range(n_y):
        col = arr[:, j]
        col = col[np.isfinite(col) & (col > 0)]
        if len(col) < 2:
            shared.append(set())
            continue
        vals, counts = np.unique(col, return_counts=True)
        cands = set(vals[counts >= 2].tolist())
        if max_med and max_med > 0:
            cands = {v for v in cands if v / max_med <= plausibility_ratio}
        shared.append(cands)
    return shared


def get_shared_low_cells(arr, col_medians, n_s, n_y,
                          low_ratio=0.35, min_count=2) -> set:
    shared_low = set()
    for j in range(n_y):
        ym = col_medians[j]
        if not (np.isfinite(ym) and ym > 0):
            continue
        low_rows = [(i, arr[i, j]) for i in range(n_s)
                    if np.isfinite(arr[i, j]) and arr[i, j] > 0
                    and arr[i, j] / ym <= low_ratio]
        if len(low_rows) < min_count:
            continue
        vals = [v for _, v in low_rows]
        if max(vals) <= min(vals) * 4:
            for i, _ in low_rows:
                shared_low.add((i, j))
    return shared_low


# ---------------------------------------------------------------
# FIX_B2: Locally-low year protection
# ---------------------------------------------------------------
def get_locally_low_cells(arr: np.ndarray,
                           row_clean_med: np.ndarray,
                           col_medians: np.ndarray,
                           low_ratio: float = 0.35,
                           min_neighbour_agree: int = 1) -> set:
    n_s, n_y = arr.shape
    locally_low = set()

    for i in range(n_s):
        own_med = row_clean_med[i]
        if not (np.isfinite(own_med) and own_med > 0):
            continue

        own_low_years = []
        for j in range(n_y):
            v = arr[i, j]
            if np.isfinite(v) and v > 0 and v / own_med <= low_ratio:
                own_low_years.append(j)

        if not own_low_years:
            continue

        own_low_set = set(own_low_years)
        for j in own_low_years:
            neighbours_low = sum(
                1 for dj in [-2, -1, 1, 2]
                if (j + dj) in own_low_set
            )
            if neighbours_low >= min_neighbour_agree:
                locally_low.add((i, j))
            else:
                v = arr[i, j]
                ym = col_medians[j]
                n_peers = np.sum(np.isfinite(arr[:, j]) & (arr[:, j] > 0)) - 1
                if n_peers < 2:
                    locally_low.add((i, j))
                elif np.isfinite(ym) and ym > 0:
                    corrected = v * 10
                    ratio_raw = abs(v - own_med) / own_med
                    ratio_cor = abs(corrected - own_med) / own_med
                    if ratio_raw < ratio_cor:
                        locally_low.add((i, j))

    return locally_low


# ---------------------------------------------------------------
# NEW in v14, revised in v15: All-low column guard
# ---------------------------------------------------------------
def get_all_low_columns(arr: np.ndarray,
                         col_medians: np.ndarray,
                         row_clean_med: np.ndarray,
                         low_ratio: float = None,
                         min_std: int = None) -> set:
    """
    Returns a set of column indices (year positions) where ALL standards
    with data in that column have fees that are low relative to that
    standard's OWN cross-year median.

    v15 change: compare against each row's own historical median
    (row_clean_med[i]) rather than the within-column median.  This catches
    columns like JIVAN JYOT 2017-18 where fees (75, 50, 50) are tiny
    relative to the school's later years (660–1900), but look "normal"
    within their own column since all three values are similarly tiny.

    Fallback: if a standard has no cross-year median (single data point),
    fall back to comparing against col_medians[j].

    Parameters
    ----------
    arr           : fee matrix (n_standards × n_years)
    col_medians   : IQR-cleaned column medians (used as fallback)
    row_clean_med : each standard's own IQR-cleaned historical median
    low_ratio     : threshold; defaults to ALL_LOW_COL_OWN_RATIO (0.35)
    min_std       : minimum standards with data; defaults to ALL_LOW_COL_MIN_STD

    Returns
    -------
    set of column indices that are all-low
    """
    if low_ratio is None:
        low_ratio = ALL_LOW_COL_OWN_RATIO
    if min_std is None:
        min_std = ALL_LOW_COL_MIN_STD

    n_s, n_y = arr.shape
    all_low_cols = set()

    for j in range(n_y):
        rows_with_data = [
            i for i in range(n_s)
            if np.isfinite(arr[i, j]) and arr[i, j] > 0
        ]

        if len(rows_with_data) < min_std:
            continue

        all_low = True
        for i in rows_with_data:
            fee = arr[i, j]
            own_med = row_clean_med[i]

            if np.isfinite(own_med) and own_med > 0:
                # Primary check: fee vs this standard's own historical median
                if fee / own_med > low_ratio:
                    all_low = False
                    break
            else:
                # Fallback: fee vs within-column median
                ym = col_medians[j]
                if np.isfinite(ym) and ym > 0:
                    if fee / ym > low_ratio:
                        all_low = False
                        break
                # If no reference at all, can't declare it low
                else:
                    all_low = False
                    break

        if all_low:
            all_low_cols.add(j)

    return all_low_cols


# ---------------------------------------------------------------
# FIX_B4: Pre-pass lakh-range correction for Std 9 & 10
# ---------------------------------------------------------------
def apply_std9_10_lakh_fix(arr: np.ndarray,
                            std_meta: list,
                            years: list,
                            school_name: str) -> tuple:
    """
    Pre-pass: for any Standard 9 or 10 row, if the fee >= LAKH_THRESHOLD,
    correct it by dividing by 10 EXACTLY ONCE — but only when the context
    confirms this is an extra-zero typo and NOT a legitimately expensive school.

    Gate hierarchy (v17):

      SCHOOL-LEVEL GATE (runs once, skips entire B4 if triggered):
        Skip B4 entirely if ANY of:
          (a) >= SCHOOL_WIDE_LAKH_SKIP_FRAC (60%) of all cells are lakh-range
          (b) School-wide median fee >= LAKH_THRESHOLD
          (c) Minimum fee across whole school >= LAKH_THRESHOLD

      STANDARD-LEVEL GATE (per Std 9/10 row):
        Skip this standard if it has NO non-lakh history at all
        (own_peer_median is NaN), meaning it has always been expensive.

      YEAR-LEVEL GATE — NEW in v17 (per cell):
        For each year where Std 9/10 fee is in lakh range, check whether
        the OTHER (non-9/10) standards in that SAME year column also have
        lakh-range fees.

        - If the majority of other standards in that year are ALSO in
          lakh range  →  skip correction (school is genuinely expensive
          in that year, Std 9/10 lakh fee is legitimate).
        - Only correct if the other standards in that year are in
          thousands (i.e. the Std 9/10 lakh value is an outlier typo).

        Threshold: B4_PEER_LAKH_YEAR_FRAC (default 0.5) — if >= 50% of
        peer standards with data in that year are lakh-range, treat the
        year as genuinely expensive and skip.
    """
    n_s, n_y = arr.shape
    corrections     = []
    corrections_map = {}

    # ---- SCHOOL-LEVEL GATE ----
    all_fees = [
        arr[ii, jj]
        for ii in range(n_s)
        for jj in range(n_y)
        if np.isfinite(arr[ii, jj]) and arr[ii, jj] > 0
    ]
    if all_fees:
        school_wide_lakh_frac = sum(1 for v in all_fees if v >= LAKH_THRESHOLD) / len(all_fees)
        school_median_fee     = float(np.median(all_fees))
        min_fee               = min(all_fees)
        if (school_wide_lakh_frac >= SCHOOL_WIDE_LAKH_SKIP_FRAC
                or school_median_fee >= LAKH_THRESHOLD
                or min_fee >= LAKH_THRESHOLD):
            return corrections, corrections_map

    # Identify which row indices are Std 9 or 10
    std9_10_rows = {
        i for i, (_, sname, _) in enumerate(std_meta)
        if is_std_9_or_10(sname)
    }

    for i, (sid, sname, _) in enumerate(std_meta):
        if i not in std9_10_rows:
            continue

        # ---- STANDARD-LEVEL GATE ----
        non_lakh_own = [
            arr[i, jj] for jj in range(n_y)
            if np.isfinite(arr[i, jj]) and arr[i, jj] > 0
            and arr[i, jj] < LAKH_THRESHOLD
        ]
        own_peer_median = float(np.median(non_lakh_own)) if non_lakh_own else np.nan

        # If this standard has NO non-lakh history, it is always expensive — skip.
        if not np.isfinite(own_peer_median):
            continue

        for j, year in enumerate(years):
            fee = arr[i, j]
            if not (np.isfinite(fee) and fee > 0):
                continue
            if fee < LAKH_THRESHOLD:
                continue

            # Own-history ratio gate (unchanged)
            if fee <= LAKH_PEER_MIN_RATIO * own_peer_median:
                continue

            # ---- YEAR-LEVEL GATE (new in v17) ----
            # Check whether OTHER standards in this same year are also lakh-range.
            # If they are, the school is genuinely expensive that year — don't correct.
            other_rows = [
                ii for ii in range(n_s)
                if ii != i
                and ii not in std9_10_rows          # only compare against non-9/10 standards
                and np.isfinite(arr[ii, j])
                and arr[ii, j] > 0
            ]
            if other_rows:
                other_lakh_count = sum(
                    1 for ii in other_rows
                    if arr[ii, j] >= LAKH_THRESHOLD
                )
                other_lakh_frac = other_lakh_count / len(other_rows)
                # If >= 50% of other standards are also lakh-range in this year,
                # the school is expensive — do NOT divide Std 9/10 by 10.
                if other_lakh_frac >= B4_PEER_LAKH_YEAR_FRAC:
                    continue

            corrected = fee / 10
            corrections_map[(i, j)] = corrected
            corrections.append({
                "school_name":         school_name,
                "standard_name":       sname,
                "standard_id":         sid,
                "Academic_year":       year,
                "previous_fee":        fee,
                "corrected_fee":       corrected,
                "condition":           "Condition B4 - Std 9/10 lakh-range extra zero",
                "year_median":         round(own_peer_median, 2),
                "expected_fee":        round(own_peer_median, 2),
                "global_jump_skipped": False,
                "pass":                "pre",
            })

    return corrections, corrections_map


# ---------------------------------------------------------------
# FIX_B5: School-wide uniform lakh-range tail-year correction
# ---------------------------------------------------------------
def apply_school_wide_uniform_lakh_fix(arr: np.ndarray,
                                        std_meta: list,
                                        years: list,
                                        school_name: str,
                                        existing_corrections_map: dict) -> tuple:
    """
    Second pre-pass: detect when ALL (or nearly all) standards in a school
    simultaneously jump to a lakh-range value in the LAST N consecutive years,
    and the jump is inconsistent with historical fees.
    """
    n_s, n_y = arr.shape
    corrections     = []
    corrections_map = {}

    if n_y < 2:
        return corrections, corrections_map

    # ---- v15/v16: skip B5 entirely if school is uniformly lakh-range ----
    # (same guard as B4 — genuinely expensive schools should not be corrected)
    all_fees_b5 = [
        arr[ii, jj]
        for ii in range(n_s)
        for jj in range(n_y)
        if np.isfinite(arr[ii, jj]) and arr[ii, jj] > 0
        and (ii, jj) not in existing_corrections_map
    ]
    if all_fees_b5:
        school_lakh_frac_b5   = sum(1 for v in all_fees_b5 if v >= LAKH_THRESHOLD) / len(all_fees_b5)
        school_median_fee_b5  = float(np.median(all_fees_b5))
        min_fee_b5            = min(all_fees_b5)
        if (school_lakh_frac_b5 >= SCHOOL_WIDE_LAKH_SKIP_FRAC
                or school_median_fee_b5 >= LAKH_THRESHOLD
                or min_fee_b5 >= LAKH_THRESHOLD):
            return corrections, corrections_map

    for cluster_size in range(1, min(UNIFORM_LAKH_MAX_TAIL_YEARS, n_y - 1) + 1):
        cluster_cols = list(range(n_y - cluster_size, n_y))
        pre_cols     = list(range(0, n_y - cluster_size))

        if not pre_cols:
            continue

        stds_with_cluster_data = []
        stds_all_lakh_in_cluster = []

        for i in range(n_s):
            cluster_vals = [arr[i, j] for j in cluster_cols
                            if np.isfinite(arr[i, j]) and arr[i, j] > 0
                            and (i, j) not in existing_corrections_map]
            if not cluster_vals:
                continue
            stds_with_cluster_data.append(i)
            if all(v >= LAKH_THRESHOLD for v in cluster_vals):
                stds_all_lakh_in_cluster.append(i)

        if not stds_with_cluster_data:
            continue

        lakh_coverage = len(stds_all_lakh_in_cluster) / len(stds_with_cluster_data)
        if lakh_coverage < UNIFORM_LAKH_MIN_STD_COVERAGE:
            continue

        pre_vals = []
        for i in range(n_s):
            for j in pre_cols:
                v = arr[i, j]
                if (np.isfinite(v) and v > 0
                        and v < LAKH_THRESHOLD
                        and (i, j) not in existing_corrections_map):
                    pre_vals.append(v)

        if not pre_vals:
            continue

        hist_median = float(np.median(pre_vals))
        if hist_median >= LAKH_THRESHOLD:
            continue

        cluster_vals_all = []
        for i in stds_all_lakh_in_cluster:
            for j in cluster_cols:
                v = arr[i, j]
                if (np.isfinite(v) and v > 0
                        and (i, j) not in existing_corrections_map):
                    cluster_vals_all.append(v)

        if not cluster_vals_all:
            continue

        cluster_median = float(np.median(cluster_vals_all))
        if cluster_median <= UNIFORM_LAKH_PEER_MIN_RATIO * hist_median:
            continue

        corrected_median = cluster_median / 10
        plausibility = abs(corrected_median - hist_median) / hist_median
        if plausibility > ACCEPT_TOLERANCE:
            continue

        for i in stds_all_lakh_in_cluster:
            sid   = std_meta[i][0]
            sname = std_meta[i][1]
            for j in cluster_cols:
                if (i, j) in existing_corrections_map:
                    continue
                fee = arr[i, j]
                if not (np.isfinite(fee) and fee > 0 and fee >= LAKH_THRESHOLD):
                    continue

                corrected = fee / 10
                corrections_map[(i, j)] = corrected
                corrections.append({
                    "school_name":         school_name,
                    "standard_name":       sname,
                    "standard_id":         sid,
                    "Academic_year":       years[j],
                    "previous_fee":        fee,
                    "corrected_fee":       corrected,
                    "condition":           "Condition B5 - school-wide uniform lakh jump",
                    "year_median":         round(hist_median, 2),
                    "expected_fee":        round(corrected_median, 2),
                    "global_jump_skipped": False,
                    "pass":                "pre",
                })

        break

    return corrections, corrections_map


# ---------------------------------------------------------------
# EXPECTED FEE
# ---------------------------------------------------------------
def expected_fee_np(arr, std_i, j_curr, n_y, col_medians,
                    row_clean_med_global,
                    skip_peer_axis=False,
                    outlier_high=3.0, outlier_low=0.35):
    estimates = []
    own_clean_med = row_clean_med_global[std_i]

    def is_clean_neighbour(val, j):
        if not skip_peer_axis:
            return True
        if not (np.isfinite(own_clean_med) and own_clean_med > 0):
            return True
        return val / own_clean_med < outlier_high

    def is_clean_value(val, j):
        ym = col_medians[j]
        if not (np.isfinite(ym) and ym > 0):
            return True
        r = val / ym
        return outlier_low < r < outlier_high

    time_estimates = []
    for dj in [-1, 1]:
        jn = j_curr + dj
        if 0 <= jn < n_y:
            v = arr[std_i, jn]
            if np.isfinite(v) and v > 0 and is_clean_value(v, jn) and is_clean_neighbour(v, jn):
                time_estimates.append(v)

    if not time_estimates:
        for step in range(2, n_y):
            found = False
            for dj in [-step, step]:
                jn = j_curr + dj
                if 0 <= jn < n_y:
                    v = arr[std_i, jn]
                    if np.isfinite(v) and v > 0 and is_clean_value(v, jn) and is_clean_neighbour(v, jn):
                        time_estimates.append(v)
                        found = True
            if found:
                break

    if not time_estimates and skip_peer_axis and np.isfinite(own_clean_med) and own_clean_med > 0:
        time_estimates.append(own_clean_med)

    estimates.extend(time_estimates)

    if not skip_peer_axis:
        col = arr[:, j_curr].copy()
        col[std_i] = np.nan
        col = col[np.isfinite(col) & (col > 0)]
        if len(col) >= 2:
            estimates.append(float(np.median(col)))

    if not estimates:
        return np.nan
    return float(np.median(estimates))


# ---------------------------------------------------------------
# CANDIDATE CORRECTIONS
# ---------------------------------------------------------------
def try_fix_extra_zero(fee):
    if fee % 10 == 0:
        return fee / 10
    return None


def try_fix_missing_zero(fee):
    return fee * 10


def try_fix_digit_substitution(fee, expected, peer_fees=None, accept_tolerance=None):
    if accept_tolerance is None: accept_tolerance = ACCEPT_TOLERANCE
    if pd.isna(expected) or expected <= 0: return None
    try:
        fee_int = int(fee); fee_str = str(fee_int)
    except (ValueError, OverflowError): return None
    if len(fee_str) < 2: return None
    peer_set = set()
    if peer_fees:
        for p in peer_fees:
            try:
                pv = int(float(p))
                if pv > 0 and len(str(pv)) == len(fee_str): peer_set.add(pv)
            except (ValueError, TypeError): pass
    if not peer_set: return None
    best = None; best_dev = float("inf")
    for pv in peer_set:
        ps = str(pv)
        if len(ps) != len(fee_str): continue
        if sum(a != b for a, b in zip(fee_str, ps)) != 1: continue
        dev = abs(pv - expected) / expected
        if dev <= accept_tolerance and dev < best_dev:
            best_dev = dev; best = float(pv)
    return best


def _sig_digits(x):
    s = f"{x:.10f}".rstrip("0").replace(".", "")
    return s.lstrip("0")


def try_fix_decimal_misplacement(fee, expected, peer_fees=None, accept_tolerance=None):
    import math as _math
    if accept_tolerance is None: accept_tolerance = ACCEPT_TOLERANCE
    if pd.isna(expected) or expected <= 0: return None
    if fee >= 1000 or fee <= 0: return None
    fee_is_integer = (fee == _math.floor(fee))
    if fee_is_integer and fee >= 100: return None
    fee_sig = _sig_digits(fee)
    if not fee_sig: return None
    peer_set = set()
    if peer_fees:
        for p in peer_fees:
            try:
                pv = float(p)
                if pv > 0: peer_set.add(pv)
            except (ValueError, TypeError): pass
    peer_rounded   = {round(p) for p in peer_set}
    requires_peer  = fee_is_integer
    tight_tolerance = 0.10 if (fee < 1 and not fee_is_integer) else accept_tolerance
    best_candidate = None; best_deviation = float("inf")
    for k in range(1, 8):
        candidate = fee * (10 ** k)
        cand_sig  = _sig_digits(candidate)
        if not (cand_sig.startswith(fee_sig) or fee_sig.startswith(cand_sig)): continue
        deviation = abs(candidate - expected) / expected
        if deviation > accept_tolerance: continue
        if round(candidate) in peer_rounded: return candidate
        if requires_peer: continue
        if fee < 1 and deviation > tight_tolerance: continue
        if candidate == int(candidate) and deviation < best_deviation:
            best_deviation = deviation; best_candidate = candidate
    return best_candidate


def _is_one_digit_deletion(shorter, longer):
    if len(longer) != len(shorter) + 1: return False
    for i in range(len(longer)):
        if longer[:i] + longer[i+1:] == shorter: return True
    return False


def try_fix_extra_inserted_digit(fee, expected, peer_fees=None, accept_tolerance=None):
    if accept_tolerance is None: accept_tolerance = ACCEPT_TOLERANCE
    if pd.isna(expected) or expected <= 0: return None
    try:
        fee_int = int(fee); fee_str = str(fee_int)
    except (ValueError, TypeError): return None
    if len(fee_str) < 2: return None
    peer_set = set()
    if peer_fees:
        for p in peer_fees:
            try: peer_set.add(int(float(p)))
            except (ValueError, TypeError): pass
    candidates = []
    for i in range(len(fee_str)):
        cs = fee_str[:i] + fee_str[i+1:]
        if not cs or cs == "0": continue
        c = float(cs)
        if c <= 0: continue
        if i == len(fee_str)-1 and fee_str[i] == "0" and c == fee/10: continue
        dev = abs(c - expected) / expected
        if dev > accept_tolerance: continue
        candidates.append((c, dev, int(c) in peer_set))
    if not candidates: return None
    pm = [(c,d,p) for c,d,p in candidates if p]
    if pm: return min(pm, key=lambda x: x[1])[0]
    return min(candidates, key=lambda x: x[1])[0]


def try_fix_missing_digit(fee, peer_fees, expected, accept_tolerance=None, own_median=None):
    if accept_tolerance is None: accept_tolerance = ACCEPT_TOLERANCE
    try:
        fee_str = str(int(fee)) if float(fee) == int(float(fee)) else str(fee)
    except (ValueError, TypeError): return None
    candidates = []; seen = set()
    for p in peer_fees:
        try:
            p_val = float(p)
            p_str = str(int(p_val)) if p_val == int(p_val) else str(p_val)
        except (ValueError, TypeError): continue
        match_a = p_str.endswith(fee_str) and len(p_str) > len(fee_str)
        match_b = _is_one_digit_deletion(fee_str, p_str)
        if (match_a or match_b) and p_val not in seen:
            candidates.append(p_val); seen.add(p_val)
    if own_median and own_median > 0 and candidates:
        candidates = [c for c in candidates if c / own_median >= 0.50]
    if not np.isnan(expected) and expected > 0:
        x10 = fee * 10; x10_dev = abs(x10 - expected) / expected
        plausible = [c for c in candidates if abs(c-expected)/expected <= accept_tolerance]
        if plausible:
            best = min(plausible, key=lambda c: abs(c-expected)/expected)
            unique_vals = set(round(c) for c in candidates)
            if len(unique_vals) == 1 and best / fee < 10: return best
            if abs(best-expected)/expected <= x10_dev * 1.30: return best
        if x10_dev <= accept_tolerance: return x10
        return None
    elif candidates: return candidates[0]
    return None


def try_fix_repeated(fee):
    s = str(int(fee)); n = len(s)
    if n % 2 == 0:
        h = n // 2
        if s[:h] == s[h:]: return float(s[:h])
    s_orig = str(fee)
    if '.' in s_orig:
        s_nodot = s_orig.replace('.', '')
        n2 = len(s_nodot)
        if n2 % 2 == 0:
            h2 = n2 // 2
            if s_nodot[:h2] == s_nodot[h2:]:
                half = s_nodot[:h2]
                chars_after_dot = len(s_orig) - s_orig.index('.') - 1
                insert_pos = len(half) - chars_after_dot
                if 0 < insert_pos < len(half):
                    try: return float(half[:insert_pos] + '.' + half[insert_pos:])
                    except ValueError: pass
    return None


def try_fix_power_of_ten(fee, expected, peer_fees=None, max_power=8, accept_tolerance=None):
    if accept_tolerance is None: accept_tolerance = ACCEPT_TOLERANCE
    if pd.isna(expected) or expected <= 0: return None
    peer_set = set()
    if peer_fees:
        for p in peer_fees:
            try:
                pv = float(p)
                if pv > 0: peer_set.add(pv)
            except (ValueError, TypeError): pass
    best_cand = None; best_dev = float("inf")
    for k in range(2, max_power + 1):
        candidate = fee / (10 ** k)
        if peer_set:
            for pv in peer_set:
                if abs(candidate - pv) / pv <= 0.01:
                    candidate = pv; break
        dev = abs(candidate - expected) / expected
        if dev <= accept_tolerance and dev < best_dev:
            best_dev = dev; best_cand = candidate
    return best_cand


def candidate_is_plausible(candidate, expected):
    if pd.isna(expected) or expected == 0: return False
    return abs(candidate - expected) / expected <= ACCEPT_TOLERANCE


# ---------------------------------------------------------------
# LOCAL-DIP GUARD
# ---------------------------------------------------------------
def is_local_dip_np(arr, std_i, j_curr, n_y, col_medians,
                    low_threshold=0.35, neighbour_agree_threshold=0.50):
    fee = arr[std_i, j_curr]
    for dj in [-1, 1]:
        jn = j_curr + dj
        if not (0 <= jn < n_y): continue
        nv = arr[std_i, jn]
        if not (np.isfinite(nv) and nv > 0): continue
        ny_median = col_medians[jn]
        if np.isfinite(ny_median) and ny_median > 0:
            nv_ratio = nv / ny_median
            if nv_ratio <= neighbour_agree_threshold and nv_ratio <= 1.0:
                if abs(nv * 10 - ny_median) / ny_median > ACCEPT_TOLERANCE:
                    return True
        if np.isfinite(fee) and fee > 0:
            nr = nv / fee
            if 1/3.0 <= nr <= 3.0:
                if np.isfinite(ny_median) and ny_median > 0:
                    if abs(nv * 10 - ny_median) / ny_median > ACCEPT_TOLERANCE:
                        return True
                else:
                    return True
    return False


# ---------------------------------------------------------------
# CORE DETECTION LOOP
# ---------------------------------------------------------------
def _run_detection_loop(arr, std_meta, years, dup_cells,
                         col_medians, row_clean_med_global,
                         trusted_values, consistently_low, consistently_high,
                         phase_changed, cross_shared, shared_low_cells,
                         locally_low_cells,
                         school_name, school_year_medians,
                         all_low_cols=None,        # NEW in v14
                         skip_cells=None):
    n_s, n_y = arr.shape
    std_ids   = [m[0] for m in std_meta]
    std_names = [m[1] for m in std_meta]

    if skip_cells is None:
        skip_cells = set()
    if all_low_cols is None:
        all_low_cols = set()

    corrections = []

    for j in range(n_y):
        year = years[j]
        ym   = col_medians[j]
        if not (np.isfinite(ym) and ym > 0):
            continue

        # ---- NEW in v14: All-low column guard ----
        # If every standard in this year is low, it's a legitimate low-fee
        # year — skip the entire column, don't flag any cell.
        if j in all_low_cols:
            continue

        col = arr[:, j]
        valid = np.isfinite(col) & (col > 0)
        if valid.sum() < 2:
            continue

        j_prev = j - 1 if j > 0 else -1
        j_next = j + 1 if j < n_y - 1 else -1

        candidate_global_jump = is_global_year_jump(arr, j, j_prev) if j_prev >= 0 else False
        if candidate_global_jump:
            is_typo    = is_global_typo_year(arr, j, j_prev, j_next)
            global_jump = not is_typo
        else:
            global_jump = False

        if not candidate_global_jump and j == 0 and j_next >= 0:
            next_col = arr[:, j_next]
            next_col = next_col[np.isfinite(next_col) & (next_col > 0)]
            if len(next_col) >= 2:
                next_yr_med = float(np.median(next_col))
                if next_yr_med > 0:
                    curr_vals = col[valid]
                    high_cnt  = (curr_vals / next_yr_med >= WITHIN_YEAR_HIGH_RATIO * 0.7).sum()
                    if high_cnt >= len(curr_vals) * 0.5:
                        rev_cnt = sum(1 for v in curr_vals
                                      if abs(v/10 - next_yr_med) / next_yr_med <= ACCEPT_TOLERANCE)
                        if rev_cnt >= len(curr_vals) * 0.5:
                            candidate_global_jump = True
                            global_jump = False

        for i in range(n_s):
            if (i, j) in skip_cells:
                continue

            fee = arr[i, j]
            if not (np.isfinite(fee) and fee > 0):
                continue

            ratio = fee / ym

            # ---- FIX_B4: Skip low-anomaly detection for Std 9 & 10 ----
            if is_std_9_or_10(std_names[i]) and ratio <= WITHIN_YEAR_LOW_RATIO:
                continue

            # ---- LOCALLY-LOW GUARD ----
            if (i, j) in locally_low_cells:
                continue

            # ---- REPEATED-VALUE GUARD ----
            _trusted_override = False
            if fee in trusted_values[i]:
                oh_excl = arr[i].copy(); oh_excl[oh_excl == fee] = np.nan
                oh_excl = oh_excl[np.isfinite(oh_excl) & (oh_excl > 0)]
                if len(oh_excl) >= 2:
                    q1t, q3t = np.percentile(oh_excl, 25), np.percentile(oh_excl, 75)
                    iqrt = q3t - q1t
                    ohct = oh_excl[(oh_excl >= q1t-3*iqrt) & (oh_excl <= q3t+3*iqrt)] \
                           if iqrt > 0 else oh_excl
                    if len(ohct) >= 2:
                        m_clean = float(np.median(ohct))
                        cv_clean = float(np.std(ohct)/m_clean) if m_clean > 0 else 1.0
                        if (m_clean > 0 and cv_clean < 0.5
                                and fee / m_clean >= WITHIN_YEAR_HIGH_RATIO
                                and i not in consistently_high):
                            _trusted_override = True
                if not _trusted_override:
                    continue

            _skip_global_jump = _trusted_override

            # ---- DUPLICATE GUARD ----
            if (i, j) in dup_cells:
                continue

            # ---- CROSS-STANDARD SHARED-VALUE GUARD ----
            if fee in cross_shared[j]:
                _bypass = False
                if candidate_global_jump and not global_jump: _bypass = True
                if not _bypass and _trusted_override:         _bypass = True
                if not _bypass and ratio >= WITHIN_YEAR_LOW_RATIO:
                    oh = arr[i].copy(); oh[j] = np.nan
                    oh = oh[np.isfinite(oh) & (oh > 0)]
                    if len(oh) >= 2:
                        q1o, q3o = np.percentile(oh, 25), np.percentile(oh, 75)
                        iqro = q3o - q1o
                        ohc  = oh[(oh >= q1o-3*iqro) & (oh <= q3o+3*iqro)] if iqro > 0 else oh
                        if len(ohc) >= 2:
                            own_m  = float(np.median(ohc))
                            own_cv = float(np.std(ohc)/own_m) if own_m > 0 else 1.0
                            if (own_m > 0 and own_cv < 0.5
                                    and fee/own_m <= WITHIN_YEAR_LOW_RATIO
                                    and i not in consistently_low):
                                _bypass = True
                if not _bypass:
                    if ratio >= WITHIN_YEAR_LOW_RATIO: continue
                    elif i in consistently_low:        continue

            # ---- SHARED-LOW-YEAR GUARD ----
            if (i, j) in shared_low_cells:
                if i not in consistently_low:
                    pass
                else:
                    continue

            # ---- CONSISTENT-SCALE GUARD (low) ----
            if i in consistently_low:
                continue

            # ---- CONSISTENT-SCALE GUARD (high) ----
            year_median = ym
            if i in consistently_high:
                trusted_set = trusted_values[i]
                own_row = arr[i].copy(); own_row[j] = np.nan
                own_row_valid = own_row[np.isfinite(own_row) & (own_row > 0)]
                trusted_own = own_row_valid[np.isin(own_row_valid,
                                                     list(trusted_set))] \
                              if trusted_set else np.array([])
                own_ref = (float(np.median(trusted_own)) if len(trusted_own) >= 1
                           else (float(np.median(own_row_valid))
                                 if len(own_row_valid) >= 1 else np.nan))
                if np.isfinite(own_ref) and own_ref > 0:
                    own_ratio = fee / own_ref
                    if 1/WITHIN_YEAR_HIGH_RATIO <= own_ratio <= WITHIN_YEAR_HIGH_RATIO:
                        continue
                    ratio       = own_ratio
                    year_median = own_ref
                else:
                    continue

            # ---- PHASE-CHANGE GUARD ----
            if i in phase_changed:
                j_trans = phase_changed[i]
                if j < j_trans:
                    continue
                else:
                    high_fees = [arr[i, jj] for jj in range(j_trans, n_y)
                                 if np.isfinite(arr[i, jj]) and arr[i, jj] > 0]
                    if high_fees:
                        own_ref   = float(np.median(high_fees))
                        own_ratio = fee / own_ref if own_ref > 0 else 1.0
                        if 1/WITHIN_YEAR_HIGH_RATIO <= own_ratio <= WITHIN_YEAR_HIGH_RATIO:
                            continue
                        ratio       = own_ratio
                        year_median = own_ref

            # ---- ANOMALY DETECTION ----
            _eff_global_jump = global_jump and not _skip_global_jump
            anomaly = None
            if ratio >= WITHIN_YEAR_HIGH_RATIO and not _eff_global_jump:
                anomaly = "high"
            elif ratio <= WITHIN_YEAR_LOW_RATIO and not _eff_global_jump:
                anomaly = "low"

            # FIX C: own-history check
            if anomaly is None and not _eff_global_jump:
                oh_excl = arr[i].copy(); oh_excl[j] = np.nan
                oh_excl = oh_excl[np.isfinite(oh_excl) & (oh_excl > 0)]
                if len(oh_excl) >= 2:
                    q1h, q3h = np.percentile(oh_excl, 25), np.percentile(oh_excl, 75)
                    iqrh = q3h - q1h
                    ownc = oh_excl[(oh_excl >= q1h-3*iqrh) & (oh_excl <= q3h+3*iqrh)] \
                           if iqrh > 0 else oh_excl
                    if len(ownc) >= 2:
                        omh = float(np.median(ownc))
                        ocv = float(np.std(ownc)/omh) if omh > 0 else 1.0
                        if omh > 0 and ocv < 0.5:
                            or_ = fee / omh
                            if or_ <= WITHIN_YEAR_LOW_RATIO:
                                if not is_std_9_or_10(std_names[i]):
                                    anomaly = "low"; year_median = omh; ratio = or_
                            elif or_ >= WITHIN_YEAR_HIGH_RATIO and i not in consistently_high:
                                anomaly = "high"; year_median = omh; ratio = or_

            # ---- LOCAL-DIP GUARD ----
            if anomaly == "low" and is_local_dip_np(arr, i, j, n_y, col_medians):
                continue

            # ---- LOCAL-PEAK GUARD ----
            if anomaly == "high" and school_year_medians:
                _extra_excl = set()
                if _skip_global_jump and year_median > 0:
                    hist_vals = [m for y2, m in school_year_medians.items()
                                 if y2 != year and m > 0]
                    if len(hist_vals) >= 2:
                        sq1, sq3 = np.percentile(hist_vals, 25), np.percentile(hist_vals, 75)
                        siqr = sq3 - sq1
                        sc   = [v for v in hist_vals if siqr <= 0 or v <= sq3+3*siqr]
                        if sc:
                            scm = float(np.median(sc))
                            if scm > 0:
                                _extra_excl = {y2 for y2,m in school_year_medians.items()
                                               if m/scm >= WITHIN_YEAR_HIGH_RATIO}
                _clean_meds = {y2: m for y2,m in school_year_medians.items()
                               if not (y2 == year and (
                                   (candidate_global_jump and not global_jump)
                                   or _skip_global_jump))
                               and y2 not in _extra_excl}
                if _clean_meds:
                    max_sm = max(_clean_meds.values())
                    if max_sm > 0 and fee / max_sm <= WITHIN_YEAR_HIGH_RATIO:
                        continue

            if anomaly is None:
                continue

            # ---- EXPECTED VALUE ----
            _skip_peers = (candidate_global_jump and not global_jump) or _skip_global_jump
            if not _skip_peers and np.isfinite(year_median) and year_median > 0:
                if len(school_year_medians) >= 3:
                    hist_meds = [m for y2,m in school_year_medians.items()
                                 if y2 != year and m > 0]
                    if len(hist_meds) >= 2:
                        shm = float(np.median(hist_meds))
                        if shm > 0 and year_median / shm <= WITHIN_YEAR_LOW_RATIO:
                            _skip_peers = True

            exp = expected_fee_np(arr, i, j, n_y, col_medians,
                                  row_clean_med_global,
                                  skip_peer_axis=_skip_peers)

            if anomaly in ("high", "low"):
                peer_mask = np.arange(n_s) != i
                peer_col  = arr[peer_mask, j]
                peer_fees_this_year = peer_col[np.isfinite(peer_col) & (peer_col > 0)].tolist()
            else:
                peer_fees_this_year = []

            corrected = None; condition_label = None

            # Condition 6
            if corrected is None and anomaly == "low" and fee < 1000:
                c6 = try_fix_decimal_misplacement(fee, exp, peer_fees_this_year)
                if c6 is not None and candidate_is_plausible(c6, exp):
                    corrected = c6; condition_label = "Condition 6 - decimal point misplacement"

            # Condition 3
            if corrected is None:
                c3 = try_fix_repeated(fee)
                if c3 is not None and candidate_is_plausible(c3, exp):
                    corrected = c3; condition_label = "Condition 3 - repeated digits"

            peer_rounded_set = {round(float(p)) for p in peer_fees_this_year} \
                               if peer_fees_this_year else set()
            c1_has_peer       = (corrected is None and anomaly == "high"
                                 and fee % 10 == 0
                                 and round(fee/10) in peer_rounded_set)
            _global_typo_year = (candidate_global_jump and not global_jump) or _skip_global_jump
            _run_c1_first     = c1_has_peer or (_global_typo_year and fee % 10 == 0)

            if _run_c1_first:
                c1 = try_fix_extra_zero(fee)
                if c1 is not None and candidate_is_plausible(c1, exp):
                    corrected = c1; condition_label = "Condition 1 - extra zero"

            # Condition 5
            if corrected is None and anomaly == "high":
                c5 = try_fix_extra_inserted_digit(fee, exp, peer_fees_this_year)
                if c5 is not None and candidate_is_plausible(c5, exp):
                    if fee % 10 != 0 or abs(c5 - fee/10) > 1:
                        corrected = c5; condition_label = "Condition 5 - extra inserted digit"

            # Condition 8
            if corrected is None and anomaly == "high":
                c8 = try_fix_power_of_ten(fee, exp, peer_fees_this_year)
                if c8 is not None and candidate_is_plausible(c8, exp):
                    corrected = c8; condition_label = "Condition 8 - multiple extra zeros"

            # Condition 1 fallback
            if corrected is None and anomaly == "high":
                c1 = try_fix_extra_zero(fee)
                if c1 is not None and candidate_is_plausible(c1, exp):
                    corrected = c1; condition_label = "Condition 1 - extra zero"

            # Condition 4
            if corrected is None and anomaly == "low":
                oh = arr[i].copy(); oh[j] = np.nan
                oh = oh[np.isfinite(oh) & (oh > 0)]
                if len(oh) >= 2:
                    q1, q3 = np.percentile(oh, 25), np.percentile(oh, 75)
                    iqr    = q3 - q1
                    oc     = oh[(oh >= q1-3*iqr) & (oh <= q3+3*iqr)] if iqr > 0 else oh
                    om     = float(np.median(oc)) if len(oc) >= 2 else float(np.median(oh))
                else:
                    om = None
                c4 = try_fix_missing_digit(fee, peer_fees_this_year, exp, own_median=om)
                if c4 is not None and candidate_is_plausible(c4, exp):
                    corrected = c4; condition_label = "Condition 4 - missing digit (peer match)"

            # Condition 2
            if corrected is None and anomaly == "low":
                c2 = try_fix_missing_zero(fee)
                if candidate_is_plausible(c2, exp):
                    corrected = c2; condition_label = "Condition 2 - missing zero"

            # Condition 7
            if corrected is None and anomaly == "low":
                c7 = try_fix_digit_substitution(fee, exp, peer_fees_this_year)
                if c7 is not None and candidate_is_plausible(c7, exp):
                    corrected = c7; condition_label = "Condition 7 - digit substitution"

            if corrected is not None:
                corrections.append({
                    "school_name":         school_name,
                    "standard_name":       std_names[i],
                    "standard_id":         std_ids[i],
                    "Academic_year":       year,
                    "previous_fee":        fee,
                    "corrected_fee":       corrected,
                    "condition":           condition_label,
                    "year_median":         round(float(year_median), 2),
                    "expected_fee":        round(exp, 2) if np.isfinite(exp) else "",
                    "global_jump_skipped": global_jump,
                    "pass":                "second" if skip_cells else "first",
                })

    return corrections


# ---------------------------------------------------------------
# MAIN ANOMALY DETECTOR (per school) — pre-passes + two-pass
# ---------------------------------------------------------------
def detect_school(school_df: pd.DataFrame, school_name: str):
    arr, std_meta, years, dup_keys = build_matrix(school_df)
    n_s, n_y = arr.shape

    std_ids    = [m[0] for m in std_meta]
    sid_to_row = {sid: i for i, sid in enumerate(std_ids)}
    yr_to_col  = {y: j   for j, y   in enumerate(years)}
    dup_cells  = {(sid_to_row[sid], yr_to_col[yr])
                  for sid, yr in dup_keys
                  if sid in sid_to_row and yr in yr_to_col}

    # ---- PRE-PASS 1 (FIX_B4): fix lakh-range fees for Std 9 & 10 ----
    pre_pass_b4, pre_corrections_map_b4 = apply_std9_10_lakh_fix(
        arr, std_meta, years, school_name
    )

    # ---- PRE-PASS 2 (FIX_B5): school-wide uniform lakh tail correction ----
    pre_pass_b5, pre_corrections_map_b5 = apply_school_wide_uniform_lakh_fix(
        arr, std_meta, years, school_name,
        existing_corrections_map=pre_corrections_map_b4,
    )

    # Merge both pre-pass correction maps
    all_pre_corrections_map = {**pre_corrections_map_b4, **pre_corrections_map_b5}

    # Apply all pre-pass corrections into array so medians are clean from the start
    arr_clean = arr.copy()
    for (i, j), val in all_pre_corrections_map.items():
        arr_clean[i, j] = val

    # ---- pre-compute statistics on cleaned array ----
    col_medians         = compute_col_medians(arr_clean)
    school_year_medians = {years[j]: float(col_medians[j])
                           for j in range(n_y) if np.isfinite(col_medians[j])}
    row_clean_med_global, _ = compute_row_stats(arr_clean)

    trusted_values    = get_trusted_values(arr_clean)
    consistently_low  = get_consistently_low_standards(arr_clean, col_medians)
    consistently_high = get_consistently_high_standards(arr_clean, col_medians)
    phase_changed     = get_phase_changed_standards(arr_clean, col_medians, years)
    cross_shared      = get_cross_standard_shared_values(arr_clean, col_medians)
    shared_low_cells  = get_shared_low_cells(arr_clean, col_medians, n_s, n_y)
    locally_low_cells = get_locally_low_cells(arr_clean, row_clean_med_global, col_medians)

    # ---- NEW in v14, revised in v15: all-low column guard ----
    all_low_cols = get_all_low_columns(arr_clean, col_medians, row_clean_med_global)

    # Pre-pass cells must not be re-evaluated in subsequent passes
    already_corrected = set(all_pre_corrections_map.keys())

    # ---- FIRST PASS ----
    first_pass = _run_detection_loop(
        arr_clean, std_meta, years, dup_cells,
        col_medians, row_clean_med_global,
        trusted_values, consistently_low, consistently_high,
        phase_changed, cross_shared, shared_low_cells,
        locally_low_cells,
        school_name, school_year_medians,
        all_low_cols=all_low_cols,
        skip_cells=already_corrected,
    )

    # ---- FIX_B1: rebuild medians using first-pass corrections ----
    if first_pass:
        fp_corrections_map = {}
        for c in first_pass:
            i = sid_to_row.get(c["standard_id"])
            j = yr_to_col.get(c["Academic_year"])
            if i is not None and j is not None:
                fp_corrections_map[(i, j)] = c["corrected_fee"]

        all_corrections_map = {**all_pre_corrections_map, **fp_corrections_map}
        col_medians2 = build_corrected_col_medians(arr, all_corrections_map)

        changed_years = set()
        for jj in range(n_y):
            m1 = col_medians[jj]
            m2 = col_medians2[jj]
            if np.isfinite(m1) and np.isfinite(m2) and m1 > 0:
                if abs(m2 - m1) / m1 > 0.05:
                    changed_years.add(jj)

        second_pass = []
        if changed_years:
            school_year_medians2 = {years[j]: float(col_medians2[j])
                                    for j in range(n_y) if np.isfinite(col_medians2[j])}
            consistently_low2  = get_consistently_low_standards(arr_clean, col_medians2)
            consistently_high2 = get_consistently_high_standards(arr_clean, col_medians2)
            phase_changed2     = get_phase_changed_standards(arr_clean, col_medians2, years)
            cross_shared2      = get_cross_standard_shared_values(arr_clean, col_medians2)
            shared_low_cells2  = get_shared_low_cells(arr_clean, col_medians2, n_s, n_y)
            locally_low_cells2 = get_locally_low_cells(arr_clean, row_clean_med_global,
                                                        col_medians2)
            row_clean_med2, _  = compute_row_stats(arr_clean)
            # NEW in v14, revised in v15: recompute all_low_cols with updated medians
            all_low_cols2      = get_all_low_columns(arr_clean, col_medians2, row_clean_med2)

            skip_second = set(all_corrections_map.keys())

            second_pass = _run_detection_loop(
                arr_clean, std_meta, years, dup_cells,
                col_medians2, row_clean_med2,
                trusted_values, consistently_low2, consistently_high2,
                phase_changed2, cross_shared2, shared_low_cells2,
                locally_low_cells2,
                school_name, school_year_medians2,
                all_low_cols=all_low_cols2,
                skip_cells=skip_second,
            )
            second_pass = [c for c in second_pass
                           if yr_to_col.get(c["Academic_year"]) in changed_years]

        return pre_pass_b4 + pre_pass_b5 + first_pass + second_pass

    return pre_pass_b4 + pre_pass_b5 + first_pass


# ---------------------------------------------------------------
# ENTRY POINT
# ---------------------------------------------------------------
def main():
    print("Loading data -")
    df, fees_orig = load_and_enrich()
    print(f"  Rows: {len(df):,}  |  Schools: {df['school_key'].nunique():,}"
          f"  |  Standards: {df['standard_id'].nunique()}"
          f"  |  Years: {df['academic_year'].nunique()}")

    all_corrections = []
    school_groups   = df.groupby("school_key")
    total_schools   = len(school_groups)

    for i, (sk, sdf) in enumerate(school_groups, 1):
        school_name = sdf["school_name"].iloc[0] if "school_name" in sdf.columns else str(sk)
        if i % 500 == 0 or i == total_schools:
            print(f"  Processing school {i}/{total_schools} -")
        all_corrections.extend(detect_school(sdf, school_name))

    print(f"\nTotal anomalies found: {len(all_corrections)}")

    corr_lookup = {}
    for c in all_corrections:
        mask = ((df["standard_id"]   == c["standard_id"]) &
                (df["academic_year"] == c["Academic_year"]) &
                (df["school_name"]   == c["school_name"]))
        for idx in df[mask].index:
            corr_lookup[idx] = c["corrected_fee"]

    fees_out = fees_orig.copy()
    fees_out["approved_fee"] = fees_out["approved_fee"].astype(object)
    for idx, new_val in corr_lookup.items():
        fees_out.at[idx, "approved_fee"] = new_val

    fees_out.to_csv(OUT_FEES, index=False)
    print(f"OK  Updated fees saved    -> {OUT_FEES}")

    log_cols = ["school_name","standard_name","Academic_year",
                "previous_fee","corrected_fee","condition",
                "year_median","expected_fee","global_jump_skipped","pass"]
    changes_df = pd.DataFrame(all_corrections, columns=log_cols)
    changes_df.to_csv(OUT_CHANGES, index=False)
    print(f"OK  Corrections log saved -> {OUT_CHANGES}")

    if all_corrections:
        print("\n-- Condition breakdown --")
        print(changes_df["condition"].value_counts().to_string())
        print("\n-- Sample corrections (first 15) --")
        print(changes_df[["school_name","standard_name","Academic_year",
                           "previous_fee","corrected_fee","condition","pass"]]
              .head(15).to_string(index=False))


if __name__ == "__main__":
    main()