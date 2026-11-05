/* 1. Create dim_school 
CREATE TABLE dim_school (
    school_key UUID PRIMARY KEY,
    school_id UUID UNIQUE NOT NULL,
    school_name TEXT NOT NULL,
    index_number TEXT NOT NULL,
    district TEXT,
    medium TEXT,
    board TEXT,
    zone TEXT,
    fee_status TEXT,
    source_url TEXT,
    created_at TIMESTAMP,
    inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
); */


/* 2. Create dim_standard
CREATE TABLE dim_standard (
    standard_id SERIAL PRIMARY KEY,
    standard_name TEXT UNIQUE NOT NULL,
    standard_group TEXT,
    standard_order INTEGER NOT NULL,
    inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
); */


/* 3. Create standard_mapping
CREATE TABLE standard_mapping (
    mapping_id SERIAL PRIMARY KEY,
    raw_standard_name TEXT UNIQUE NOT NULL,
    standard_id INTEGER NOT NULL
        REFERENCES dim_standard(standard_id)
); */


/* 4. Create fact_school_fees
CREATE TABLE fact_school_fees (
    fee_key UUID PRIMARY KEY,
    school_key UUID NOT NULL
        REFERENCES dim_school(school_key),

    standard_id INTEGER NOT NULL
        REFERENCES dim_standard(standard_id),

    academic_year INTEGER NOT NULL,
    approved_fee NUMERIC(12,2),

    inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
); */