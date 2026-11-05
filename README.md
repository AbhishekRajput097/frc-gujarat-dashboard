# FRC Gujarat Dashboard

FRC fee data pipeline, school data scraper, data corrections and the dashboard (frontend + local versions).

## Structure

- `dashboard_frontend/`
- `dashboard_local/`
- `data/`
- `notebooks/`
- `src/`

## Setup

Copy `.env.example` to `.env` and fill in the values.

## Large files not included

These are larger than 50 MB (GitHub's warning size) and are not in this repo:

- `dashboard_local/data/fact_school_fees.csv` (135 MB)
- `data_pipeline/data/raw_data/fees_raw.csv` (179 MB)
- `data_pipeline/data/structured_data/fact_school_fees.csv` (136 MB)
- `data_pipeline/data/structured_data/fact_school_fees_valid.csv` (104 MB)
- `data_correction/fact_school_fees.csv` (142 MB)
- `data_correction/fact_school_fees_corrected_final.csv` (143 MB)
- `data_correction/FRC Latest Data 18th March/fact_school_fees.csv` (135 MB)
- `data_correction/NEW FRC DATA SECOND/fact_school_fees.csv` (135 MB)
- `data_correction/NEW FRC DATA SECOND/updated_fact_school_fees.csv` (135 MB)
- `data_correction/New FRC Data/fact_school_fees.csv` (142 MB)
- `data_correction/New FRC Data/fact_school_fees_clean.csv` (135 MB)
- `data_21_march/fact_school_fees.csv` (104 MB)
