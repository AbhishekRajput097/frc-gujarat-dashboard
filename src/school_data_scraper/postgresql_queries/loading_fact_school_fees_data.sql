INSERT INTO fact_school_fees (
    fee_key,
    school_key,
    standard_id,
    academic_year,
    approved_fee
)
SELECT
    gen_random_uuid(),
    ds.school_key,
    sm.standard_id,
    regexp_replace(fr.academic_year,'.*(\d{4})\).*','\1')::INT,
    NULLIF(fr.approved_fee,0)
FROM fees_raw fr
JOIN dim_school ds
    ON fr.school_id = ds.school_id
JOIN standard_mapping sm
    ON fr.standard_name = sm.raw_standard_name;

/* --------- Index Creation -------------
CREATE INDEX idx_fact_school
ON fact_school_fees(school_key);

CREATE INDEX idx_fact_year
ON fact_school_fees(academic_year);

CREATE INDEX idx_fact_standard
ON fact_school_fees(standard_id); */