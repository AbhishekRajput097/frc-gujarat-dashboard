import pandas as pd

df = pd.read_csv("../../../../data/data_pipeline/data/structured_data/dim_school.csv", dtype=str)

# Remove line breaks from all string columns
df = df.replace({r'[\r\n]+': ' '}, regex=True)

# Save clean CSV
df.to_csv("../../../../data/data_pipeline/data/structured_data/dim_school_clean.csv", index=False, quoting=1)  # quoting=1 = QUOTE_ALL