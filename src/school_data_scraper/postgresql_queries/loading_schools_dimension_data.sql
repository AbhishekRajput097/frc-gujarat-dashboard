INSERT INTO dim_school (
    school_key,
    school_id,
    school_name,
    index_number,
    district,
    medium,
    board,
    zone,
    fee_status,
    source_url,
    created_at
)
SELECT
    gen_random_uuid(),
    school_id,
    school_name,
    index_number,
    district,
    medium,
    board,
    zone,
    fee_status,
    source_url,
    created_at
FROM schools_raw;