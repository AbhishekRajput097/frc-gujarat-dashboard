"""
FRC Gujarat — Filter Valid Fee Records
=======================================
Reads:
    data/structured_data/fact_school_fees.csv

Creates (never overwrites source):
    data/structured_data/fact_school_fees_valid.csv

Keeps only rows where approved_fee:
    - is not null / empty
    - is not zero (0 or 0.0)

Source file is never modified.

Usage:
    python filter_valid_fees.py
"""

import sys
import logging
import pandas as pd
from pathlib import Path

# ============================================================
# PATHS
# ============================================================
BASE_DIR   = Path(__file__).parent
STRUCT_DIR = BASE_DIR / "data" / "structured_data"

SOURCE_CSV = STRUCT_DIR / "fact_school_fees.csv"
OUTPUT_CSV = STRUCT_DIR / "fact_school_fees_valid.csv"

# ============================================================
# LOGGING
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

# ============================================================
# MAIN
# ============================================================
def main():
    log.info("=" * 55)
    log.info("FRC Gujarat — Filter Valid Fee Records")
    log.info("=" * 55)

    if not SOURCE_CSV.exists():
        log.error(f"Source file not found: {SOURCE_CSV}")
        sys.exit(1)

    log.info(f"Reading {SOURCE_CSV.name} ...")
    df = pd.read_csv(SOURCE_CSV, dtype=str, low_memory=False)
    total_rows = len(df)
    log.info(f"  Total rows loaded : {total_rows:,}")

    # Convert approved_fee to numeric — invalid/empty become NaN
    df["approved_fee_num"] = pd.to_numeric(df["approved_fee"], errors="coerce")

    # Keep rows where approved_fee is a real non-zero number
    mask_valid = (
        df["approved_fee_num"].notna() &   # not null / empty
        (df["approved_fee_num"] != 0)       # not zero
    )

    df_valid   = df[mask_valid].drop(columns=["approved_fee_num"])
    df_removed = df[~mask_valid]

    kept    = len(df_valid)
    removed = len(df_removed)

    log.info(f"  Rows kept    (valid fees) : {kept:,}")
    log.info(f"  Rows removed (null / zero): {removed:,}")

    # Breakdown of what was removed
    null_count = df[~mask_valid]["approved_fee_num"].isna().sum()
    zero_count = removed - null_count
    log.info(f"    ↳ null / empty : {null_count:,}")
    log.info(f"    ↳ zero values  : {zero_count:,}")

    # Write output
    df_valid.to_csv(OUTPUT_CSV, index=False)
    log.info(f"Saved → {OUTPUT_CSV.name}  ({kept:,} rows)")
    log.info("=" * 55)
    log.info("Source file unchanged.")
    log.info("=" * 55)

if __name__ == "__main__":
    main()