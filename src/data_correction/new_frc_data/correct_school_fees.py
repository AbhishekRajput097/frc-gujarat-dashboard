"""
fee_data_quality.py
===================
Production-grade, fully vectorized data quality script for detecting and
correcting human data entry errors in school fee data (FRC Gujarat).

Designed for large datasets (1M+ rows).  No Python-level loops over rows.

Author  : Senior Data Engineer
Version : 2.0.0

Usage:
    python fee_data_quality.py

Input files  (working directory):
    fact_school_fees.csv
    dim_school.csv
    dim_standard.csv

Output files (working directory):
    fact_school_fees_corrected.csv
    fee_corrections_audit.csv
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration  — all thresholds in one place
# ---------------------------------------------------------------------------
class Config:
    input_fact       = Path("fact_school_fees.csv")
    input_school     = Path("../../../data/data_correction/dim_school.csv")
    input_standard   = Path("../../../data/dashboard_local/data/dim_standard.csv")
    output_corrected = Path("fact_school_fees_corrected.csv")
    output_audit     = Path("fee_corrections_audit.csv")

    # Outlier multipliers
    high_factor: float = 5.0    # fee > high_factor  x median  =>  high outlier
    low_factor:  float = 0.20   # fee < low_factor   x median  =>  low outlier

    # Digit-repetition: only attempt for numbers with this many digits
    min_digits_for_repeat: int = 6

    # Stable-data guard: same value repeated >= N times across years -> do not touch
    stable_count_threshold: int = 2

    # Regime-change guard
    regime_jump_factor: float = 3.0
    regime_min_years:   int   = 2

    # Minimum peers / history records needed before attempting correction
    min_peer_records: int = 2
    min_hist_records: int = 2

    # Power-of-10 correction: ratio must be within this tolerance of an exact power
    power_of_10_tolerance: float = 0.05

    # After power-of-10 correction, candidate must be within this band of reference
    correction_band_low:  float = 0.5
    correction_band_high: float = 2.0


CFG = Config()


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------
def load_inputs(cfg: Config) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    for p in (cfg.input_fact, cfg.input_school, cfg.input_standard):
        if not p.exists():
            raise FileNotFoundError(f"Required input file not found: {p}")

    log.info("Reading input files ...")
    fact     = pd.read_csv(cfg.input_fact,  low_memory=False)
    school   = pd.read_csv(cfg.input_school)
    standard = pd.read_csv(cfg.input_standard)

    fact["approved_fee"] = pd.to_numeric(fact["approved_fee"], errors="coerce")
    log.info("fact=%d rows  school=%d  standard=%d", len(fact), len(school), len(standard))
    return fact, school, standard


def save_outputs(fact_corrected: pd.DataFrame,
                 audit_df: pd.DataFrame,
                 cfg: Config) -> None:
    out_cols = ["fee_key", "school_key", "standard_id",
                "academic_year", "approved_fee", "inserted_at"]
    fact_corrected[out_cols].to_csv(cfg.output_corrected, index=False)
    log.info("Written -> %s", cfg.output_corrected)

    audit_df.to_csv(cfg.output_audit, index=False)
    log.info("Written -> %s  (%d corrections)", cfg.output_audit, len(audit_df))


# ---------------------------------------------------------------------------
# Step 2: context medians via groupby transform  (O(N log N), no loops)
# ---------------------------------------------------------------------------
def add_peer_median(df: pd.DataFrame) -> pd.DataFrame:
    """
    Peer median = median fee of all standards in the same school+year.
    Using full-group median as the leave-one-out proxy (median is robust to
    a single outlier, which is the very value we are trying to detect).
    """
    grp = df.groupby(["school_key", "academic_year"])["approved_fee"]
    df["peer_median"] = grp.transform("median")
    df["peer_count"]  = grp.transform("count")
    return df


def add_hist_median(df: pd.DataFrame) -> pd.DataFrame:
    """
    Historical median = median fee across all years for the same school+standard.
    Same LOO-proxy reasoning as above.
    """
    grp = df.groupby(["school_key", "standard_id"])["approved_fee"]
    df["hist_median"] = grp.transform("median")
    df["hist_count"]  = grp.transform("count")
    return df


# ---------------------------------------------------------------------------
# Step 3a: stable-data guard  (Case D)  — pure groupby
# ---------------------------------------------------------------------------
def add_stable_flag(df: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    df["_val_count"] = df.groupby(
        ["school_key", "standard_id", "approved_fee"]
    )["approved_fee"].transform("count")
    df["is_stable"]  = df["_val_count"] >= cfg.stable_count_threshold
    df.drop(columns=["_val_count"], inplace=True)
    return df


# ---------------------------------------------------------------------------
# Step 3b: regime-change guard  (Case A)
# Unavoidably has a small group-level loop (one iteration per school+standard
# combo, NOT per row) — typically a few thousand iterations for 1M+ rows.
# ---------------------------------------------------------------------------
def build_regime_flags(df: pd.DataFrame, cfg: Config) -> pd.Series:
    """
    True  =>  this row belongs to a regime change  =>  do NOT correct.

    Per school+standard, sort by year, then walk forward:
    if fees[i:] are consistently >= regime_jump_factor * median(fees[:i])
    for at least regime_min_years positions, mark them as a new regime.
    """
    regime_flag = pd.Series(False, index=df.index, dtype=bool)

    # Only keep columns we need
    cols = ["school_key", "standard_id", "academic_year", "approved_fee"]
    work = df[cols].copy()
    work["_idx"] = df.index

    for (sk, sid), grp in work.groupby(["school_key", "standard_id"], sort=False):
        if len(grp) < cfg.regime_min_years + 1:
            continue
        grp_s  = grp.sort_values("academic_year")
        fees   = grp_s["approved_fee"].to_numpy(dtype=float)
        idxs   = grp_s["_idx"].to_numpy()
        n      = len(fees)

        for i in range(1, n):
            old_med = float(np.median(fees[:i]))
            if old_med <= 0:
                continue
            if fees[i] < cfg.regime_jump_factor * old_med:
                continue
            # Count how many values from position i onward are in the new regime
            new_regime_count = int(np.sum(fees[i:] >= cfg.regime_jump_factor * old_med))
            if new_regime_count >= cfg.regime_min_years:
                regime_flag.loc[idxs[i:]] = True
                break

    return regime_flag


# ---------------------------------------------------------------------------
# Step 3c: consistent upward-trend guard
# Same structure: group-level loop, not row-level.
# ---------------------------------------------------------------------------
def build_trend_flags(df: pd.DataFrame) -> pd.Series:
    trend_flag = pd.Series(False, index=df.index, dtype=bool)

    cols = ["school_key", "standard_id", "academic_year", "approved_fee"]
    work = df[cols].copy()
    work["_idx"] = df.index

    for (sk, sid), grp in work.groupby(["school_key", "standard_id"], sort=False):
        if len(grp) < 3:
            continue
        fees = grp.sort_values("academic_year")["approved_fee"].to_numpy(dtype=float)
        diffs = np.diff(fees)
        if np.all(diffs >= 0) and np.sum(diffs > 0) >= 2:
            trend_flag.loc[grp["_idx"].to_numpy()] = True

    return trend_flag


# ---------------------------------------------------------------------------
# Step 5a: digit-repetition detection  (vectorized string ops)
# ---------------------------------------------------------------------------
def vectorized_digit_repeat(fees: pd.Series, cfg: Config) -> pd.Series:
    """
    Returns a Series of candidate corrected values (NaN where not applicable).
    Pure pandas string operations — no Python loop over individual rows.
    """
    int_str = fees.dropna().round().astype("int64").astype(str)
    lengths  = int_str.str.len()

    # Pre-filter: even digit count and long enough
    mask = (lengths >= cfg.min_digits_for_repeat) & (lengths % 2 == 0)
    filtered = int_str[mask]

    half  = lengths[mask] // 2
    left  = filtered.str[:half]          # vectorized slice
    right = filtered.str[half:]          # vectorized slice
    is_repeat = left == right

    candidates = pd.Series(np.nan, index=fees.index, dtype=float)
    valid_idx  = filtered.index[is_repeat]
    if len(valid_idx):
        corrected_vals = left[is_repeat].astype("int64").astype(float)
        candidates.loc[valid_idx] = corrected_vals.values

    return candidates


# ---------------------------------------------------------------------------
# Step 5b: power-of-10 correction  (fully vectorized, no loops)
# ---------------------------------------------------------------------------
def vectorized_power_of_10(fees: pd.Series,
                            reference: pd.Series,
                            cfg: Config) -> pd.Series:
    """
    For each (fee, reference) pair attempt power-of-10 correction.
    Returns a Series of candidate corrected values (NaN where not applicable).
    """
    candidates = pd.Series(np.nan, index=fees.index, dtype=float)

    valid = fees.notna() & reference.notna() & (fees > 0) & (reference > 0)
    if not valid.any():
        return candidates

    ratio      = fees[valid] / reference[valid]
    log_ratio  = np.log10(ratio.astype(float))
    rounded    = np.round(log_ratio)

    # Conditions: non-zero integer exponent and close to exact power
    nonzero    = rounded != 0
    close      = np.abs(log_ratio - rounded) <= cfg.power_of_10_tolerance
    apply_mask_local = nonzero & close

    if not apply_mask_local.any():
        return candidates

    apply_idx  = fees[valid].index[apply_mask_local]
    corrected  = fees[apply_idx] / (10 ** rounded[apply_mask_local])

    # Band check vs reference
    ref_sub    = reference[apply_idx]
    in_band    = (
        (corrected >= cfg.correction_band_low  * ref_sub) &
        (corrected <= cfg.correction_band_high * ref_sub)
    )
    candidates.loc[apply_idx[in_band]] = corrected[in_band].values
    return candidates


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def run(cfg: Config = CFG) -> None:

    # ------------------------------------------------------------------
    # 1. Load & join dimension names
    # ------------------------------------------------------------------
    fact, dim_school, dim_standard = load_inputs(cfg)

    fact = fact.merge(dim_school[["school_key", "school_name"]],
                      on="school_key", how="left")
    fact = fact.merge(dim_standard[["standard_id", "standard_name"]],
                      on="standard_id", how="left")

    # ------------------------------------------------------------------
    # 2. Compute context medians
    # ------------------------------------------------------------------
    log.info("Computing peer medians (school x year) ...")
    fact = add_peer_median(fact)

    log.info("Computing historical medians (school x standard) ...")
    fact = add_hist_median(fact)

    # ------------------------------------------------------------------
    # 3. Compute guard flags
    # ------------------------------------------------------------------
    log.info("Computing stable-data flags ...")
    fact = add_stable_flag(fact, cfg)

    log.info("Computing regime-change flags ...")
    fact["is_regime"] = build_regime_flags(fact, cfg)

    log.info("Computing trend flags ...")
    fact["is_trend"] = build_trend_flags(fact)

    fact["do_not_touch"] = fact["is_stable"] | fact["is_regime"] | fact["is_trend"]

    # ------------------------------------------------------------------
    # 4. Identify outlier candidates  (vectorized boolean masks)
    # ------------------------------------------------------------------
    log.info("Identifying outlier candidates ...")

    valid_fee       = fact["approved_fee"].notna() & (fact["approved_fee"] > 0)
    sufficient_peer = fact["peer_count"] >= cfg.min_peer_records
    sufficient_hist = fact["hist_count"] >= cfg.min_hist_records

    peer_high = fact["approved_fee"] > cfg.high_factor * fact["peer_median"]
    peer_low  = fact["approved_fee"] < cfg.low_factor  * fact["peer_median"]
    hist_high = fact["approved_fee"] > cfg.high_factor * fact["hist_median"]
    hist_low  = fact["approved_fee"] < cfg.low_factor  * fact["hist_median"]

    # Both peer AND historical context must agree
    outlier_mask = (
        valid_fee
        & sufficient_peer
        & sufficient_hist
        & ~fact["do_not_touch"]
        & ((peer_high & hist_high) | (peer_low & hist_low))
    )

    log.info("Outlier candidates: %d", outlier_mask.sum())
    candidates = fact[outlier_mask].copy()

    if candidates.empty:
        log.info("No corrections needed.")
        candidates["corrected_fee"]   = pd.Series(dtype=float)
        candidates["correction_type"] = pd.Series(dtype=str)
    else:
        # --------------------------------------------------------------
        # 5a. Digit-repetition correction
        # --------------------------------------------------------------
        log.info("Applying digit-repetition detection ...")
        dr = vectorized_digit_repeat(candidates["approved_fee"], cfg)

        ref_for_dr = candidates[["peer_median", "hist_median"]].min(axis=1)
        dr_in_band = (
            (dr >= cfg.correction_band_low  * ref_for_dr) &
            (dr <= cfg.correction_band_high * ref_for_dr)
        )
        dr_valid = dr.notna() & dr_in_band

        candidates["corrected_fee"]   = np.nan
        candidates["correction_type"] = ""
        candidates.loc[dr_valid, "corrected_fee"]   = dr[dr_valid]
        candidates.loc[dr_valid, "correction_type"] = "digit_repetition"

        # --------------------------------------------------------------
        # 5b. Power-of-10 correction for remaining outliers
        # --------------------------------------------------------------
        log.info("Applying power-of-10 correction ...")
        remaining = candidates["corrected_fee"].isna()

        is_high = (peer_high & hist_high)[outlier_mask]
        reference = np.where(
            is_high,
            candidates[["peer_median", "hist_median"]].min(axis=1),
            candidates[["peer_median", "hist_median"]].max(axis=1),
        )
        reference_s = pd.Series(reference, index=candidates.index)

        p10 = vectorized_power_of_10(
            candidates.loc[remaining, "approved_fee"],
            reference_s[remaining],
            cfg,
        )

        p10_valid_idx = p10[p10.notna()].index
        if len(p10_valid_idx):
            # Final dual-context band check
            peer_ok = (
                (p10[p10_valid_idx] >= cfg.correction_band_low  * candidates.loc[p10_valid_idx, "peer_median"]) &
                (p10[p10_valid_idx] <= cfg.correction_band_high * candidates.loc[p10_valid_idx, "peer_median"])
            )
            hist_ok = (
                (p10[p10_valid_idx] >= cfg.correction_band_low  * candidates.loc[p10_valid_idx, "hist_median"]) &
                (p10[p10_valid_idx] <= cfg.correction_band_high * candidates.loc[p10_valid_idx, "hist_median"])
            )
            final_idx = p10_valid_idx[peer_ok & hist_ok]

            is_extra_zero = (
                candidates.loc[final_idx, "approved_fee"] >
                candidates.loc[final_idx, "peer_median"]
            )
            candidates.loc[final_idx, "corrected_fee"]   = p10[final_idx].values
            candidates.loc[final_idx, "correction_type"] = np.where(
                is_extra_zero, "extra_zero", "missing_zero"
            )

    # ------------------------------------------------------------------
    # 6. Apply corrections back to the fact table
    # ------------------------------------------------------------------
    actually_corrected = candidates[candidates["corrected_fee"].notna()].copy()
    log.info("Total corrections to apply: %d", len(actually_corrected))

    fact_out = fact.copy()
    fact_out.loc[actually_corrected.index, "approved_fee"] = \
        actually_corrected["corrected_fee"].values

    # ------------------------------------------------------------------
    # 7. Build audit table
    # ------------------------------------------------------------------
    audit_out = actually_corrected[[
        "school_name", "standard_name", "academic_year",
        "approved_fee", "corrected_fee", "correction_type",
        "peer_median", "hist_median",
    ]].rename(columns={
        "approved_fee": "previous_fee",
        "peer_median":  "peer_context_median",
        "hist_median":  "historical_context_median",
    }).copy()

    audit_out["reason"] = (
        "Type: "       + audit_out["correction_type"]
        + "  | peer_median="  + audit_out["peer_context_median"].round(0).astype(str)
        + "  | hist_median="  + audit_out["historical_context_median"].round(0).astype(str)
    )

    audit_final = audit_out[[
        "school_name", "standard_name", "academic_year",
        "previous_fee", "corrected_fee", "correction_type", "reason",
    ]]

    # ------------------------------------------------------------------
    # 8. Drop helper columns and save
    # ------------------------------------------------------------------
    drop_cols = [
        "school_name", "standard_name",
        "peer_median", "peer_count",
        "hist_median", "hist_count",
        "is_stable", "is_regime", "is_trend", "do_not_touch",
    ]
    fact_out.drop(columns=[c for c in drop_cols if c in fact_out.columns],
                  inplace=True)

    save_outputs(fact_out, audit_final, cfg)

    log.info(
        "Done. %d correction(s) applied out of %d rows (%.4f%%).",
        len(actually_corrected), len(fact),
        100.0 * len(actually_corrected) / max(len(fact), 1),
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    run()