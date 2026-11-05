import os
import time
import uuid
import re
import logging
from decimal import Decimal

from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import execute_batch
from playwright.sync_api import sync_playwright

# ============================================================
# ENV + CONFIG
# ============================================================

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
HEADLESS = os.getenv("HEADLESS", "true").lower() == "true"
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "5"))
BASE_DELAY_SECONDS = int(os.getenv("BASE_DELAY_SECONDS", "2"))

BASE_URL = "https://frcgujarat.org/Home/SearchSchool"

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL not set")

# ============================================================
# LOGGING
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | page=%(page)s | school=%(school)s | %(message)s"
)

def log_info(msg, page=None, school=None):
    logging.info(msg, extra={"page": page, "school": school})

def log_error(msg, page=None, school=None):
    logging.error(msg, extra={"page": page, "school": school})

# ============================================================
# DATABASE
# ============================================================

def get_db():
    return psycopg2.connect(DATABASE_URL)

def create_tables(conn):
    with conn.cursor() as cur:
        cur.execute("""
        CREATE TABLE IF NOT EXISTS schools_raw (
            school_id UUID PRIMARY KEY,
            school_name TEXT,
            index_number TEXT,
            district TEXT,
            medium TEXT,
            board TEXT,
            zone TEXT,
            fee_status TEXT,
            source_url TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );
        """)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS fees_raw (
            fee_id UUID PRIMARY KEY,
            school_id UUID REFERENCES schools_raw(school_id),
            standard_name TEXT,
            academic_year TEXT,
            approved_fee NUMERIC
        );
        """)
    conn.commit()

# ============================================================
# HELPERS
# ============================================================

def parse_fee(raw: str):
    if not raw:
        return None
    cleaned = raw.replace(",", "").strip()
    if cleaned in {"-", "—", "NA", "N/A"}:
        return None
    try:
        return Decimal(cleaned)
    except Exception:
        return None

def extract_name_and_index(text: str):
    match = re.search(r"\((\d{6,})\)", text)
    index = match.group(1) if match else None
    name = re.sub(r"\(\d{6,}\)", "", text).strip()
    return name, index

def with_retries(fn, page=None, school=None):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fn()
        except Exception as e:
            log_error(f"Attempt {attempt} failed: {e}", page, school)
            if attempt == MAX_RETRIES:
                raise
            time.sleep(BASE_DELAY_SECONDS * (2 ** (attempt - 1)))

def safe_goto(page, url, page_number):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            page.goto(
                url,
                timeout=90000,
                wait_until="domcontentloaded"
            )
            return
        except Exception as e:
            log_error(
                f"Page navigation failed (attempt {attempt}): {e}",
                page=page_number
            )
            if attempt == MAX_RETRIES:
                raise
            time.sleep(BASE_DELAY_SECONDS * (2 ** (attempt - 1)))

# ============================================================
# SCRAPER
# ============================================================

def scrape():
    conn = get_db()
    create_tables(conn)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        context = browser.new_context()
        page = context.new_page()

        page_number = int(os.getenv("START_PAGE", "1"))

        while True:
            page_url = f"{BASE_URL}?page={page_number}"
            log_info("Processing page", page=page_number)

            safe_goto(page, page_url, page_number)
            page.wait_for_selector("table", timeout=15000)

            rows = page.query_selector_all("table tbody tr")
            if not rows:
                log_info("No rows found, stopping pagination", page=page_number)
                break

            for row in rows:
                cols = row.query_selector_all("td")
                if len(cols) < 6:
                    continue

                raw_name = cols[1].inner_text().strip()
                school_name, index_number = extract_name_and_index(raw_name)

                medium = cols[2].inner_text().strip()
                board = cols[3].inner_text().strip()
                district = cols[4].inner_text().strip()

                def scrape_school():
                    time.sleep(0.3)

                    view_btn = cols[5].query_selector("button")
                    view_btn.scroll_into_view_if_needed()
                    view_btn.click(force=True)

                    modal = page.wait_for_selector("#schoolFeeModal", timeout=15000)
                    school_id = str(uuid.uuid4())

                    try:
                        fee_status = ""
                        for block in modal.query_selector_all(".row .col-md-6"):
                            txt = block.inner_text()
                            if "Fee Status" in txt:
                                fee_status = txt.split(":", 1)[-1].strip()

                        with conn.cursor() as cur:
                            cur.execute("""
                                INSERT INTO schools_raw (
                                    school_id, school_name, index_number,
                                    district, medium, board,
                                    zone, fee_status, source_url
                                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                            """, (
                                school_id, school_name, index_number,
                                district, medium, board,
                                None, fee_status, page_url
                            ))

                        fee_rows = modal.query_selector_all("table tbody tr")
                        headers = modal.query_selector_all("table thead th")

                        fee_inserts = []

                        for fr in fee_rows:
                            tds = fr.query_selector_all("td")
                            if len(tds) < 2:
                                continue

                            standard = tds[0].inner_text().strip()

                            for i in range(1, len(tds)):
                                year = headers[i].inner_text().strip()
                                raw = tds[i].inner_text().strip()
                                fee = parse_fee(raw)

                                fee_inserts.append((
                                    str(uuid.uuid4()),
                                    school_id,
                                    standard,
                                    year,
                                    fee
                                ))

                        if fee_inserts:
                            with conn.cursor() as cur:
                                execute_batch(
                                    cur,
                                    """
                                    INSERT INTO fees_raw (
                                        fee_id, school_id,
                                        standard_name, academic_year, approved_fee
                                    ) VALUES (%s,%s,%s,%s,%s)
                                    """,
                                    fee_inserts
                                )

                        conn.commit()

                    finally:
                        try:
                            modal.query_selector("button.close").click()
                            page.wait_for_selector("#schoolFeeModal", state="hidden", timeout=5000)
                        except Exception:
                            page.keyboard.press("Escape")
                            page.wait_for_timeout(500)

                with_retries(scrape_school, page=page_number, school=school_name)

            page_number += 1
            page.wait_for_timeout(1200)

        browser.close()
        conn.close()

# ============================================================
# ENTRY
# ============================================================

if __name__ == "__main__":
    scrape()
