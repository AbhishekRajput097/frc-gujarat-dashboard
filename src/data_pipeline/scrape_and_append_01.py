"""
FRC Gujarat — Incremental Parallel Scraper
==========================================
• Scrapes https://frcgujarat.org/Home/SearchSchool for NEW schools only
• Compares against existing data/schools_raw.csv using (index_number, medium, board)
• Appends new rows to data/schools_raw.csv and data/fees_raw.csv
• Adds `scraped_at` column to both files for tracking
• Parallel page scraping via ThreadPoolExecutor
• File-safe writes via threading.Lock
• Auto-restart on crash with checkpoint (last processed page saved to data/checkpoint.txt)
• Exponential-backoff retries per page / per school

Usage:
    python scrape_frc_incremental.py

Environment variables (.env):
    HEADLESS=true
    MAX_RETRIES=5
    BASE_DELAY_SECONDS=2
    WORKERS=4          # Number of parallel browser workers
    START_PAGE=1       # Override start page (default: reads checkpoint)
"""

import os
import csv
import time
import uuid
import re
import sys
import logging
import threading
import traceback
from decimal import Decimal
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

# ============================================================
# ENV + CONFIG
# ============================================================
load_dotenv()

HEADLESS          = os.getenv("HEADLESS", "true").lower() == "true"
MAX_RETRIES       = int(os.getenv("MAX_RETRIES", "5"))
BASE_DELAY        = int(os.getenv("BASE_DELAY_SECONDS", "2"))
WORKERS           = int(os.getenv("WORKERS", "8"))
START_PAGE_ENV    = os.getenv("START_PAGE", None)

BASE_URL          = "https://frcgujarat.org/Home/SearchSchool"
DATA_DIR          = Path(__file__).parent / "data" / "raw_data"
SCHOOLS_CSV       = DATA_DIR / "../../data/data_pipeline/data/raw_data/schools_raw.csv"
FEES_CSV          = DATA_DIR / "fees_raw.csv"
CHECKPOINT_FILE   = DATA_DIR / "checkpoint.txt"

DATA_DIR.mkdir(parents=True, exist_ok=True)

# ============================================================
# LOGGING
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(DATA_DIR / "scraper.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ============================================================
# THREAD-SAFE CSV WRITER
# ============================================================
_csv_lock = threading.Lock()

SCHOOLS_COLUMNS = [
    "school_id", "school_name", "index_number", "district",
    "medium", "board", "zone", "fee_status", "source_url",
    "created_at", "scraped_at",
]
FEES_COLUMNS = [
    "fee_id", "school_id", "standard_name",
    "academic_year", "approved_fee", "scraped_at",
]

def _ensure_csv_headers():
    """Create CSV files with headers if they don't exist yet."""
    if not SCHOOLS_CSV.exists():
        with open(SCHOOLS_CSV, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=SCHOOLS_COLUMNS).writeheader()
        log.info("Created schools_raw.csv with headers")

    if not FEES_CSV.exists():
        with open(FEES_CSV, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=FEES_COLUMNS).writeheader()
        log.info("Created fees_raw.csv with headers")

    # If files exist but are missing scraped_at column, add it
    for path, cols in [(SCHOOLS_CSV, SCHOOLS_COLUMNS), (FEES_CSV, FEES_COLUMNS)]:
        if path.exists() and path.stat().st_size > 0:
            with open(path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                existing_cols = reader.fieldnames or []
            if "scraped_at" not in existing_cols:
                log.info(f"Adding 'scraped_at' column to {path.name} ...")
                _add_scraped_at_column(path, cols)

def _add_scraped_at_column(path: Path, new_cols: list):
    """Rewrite a CSV to add the scraped_at column (migration)."""
    tmp = path.with_suffix(".tmp")
    now = datetime.now(timezone.utc).isoformat()
    with open(path, "r", encoding="utf-8") as fin, \
         open(tmp, "w", newline="", encoding="utf-8") as fout:
        reader = csv.DictReader(fin)
        writer = csv.DictWriter(fout, fieldnames=new_cols)
        writer.writeheader()
        for row in reader:
            row.setdefault("scraped_at", now)
            writer.writerow({c: row.get(c, "") for c in new_cols})
    tmp.replace(path)
    log.info(f"Migration done: scraped_at added to {path.name}")

def append_school_row(row: dict):
    with _csv_lock:
        with open(SCHOOLS_CSV, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=SCHOOLS_COLUMNS)
            writer.writerow(row)

def append_fee_rows(rows: list):
    if not rows:
        return
    with _csv_lock:
        with open(FEES_CSV, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FEES_COLUMNS)
            writer.writerows(rows)

# ============================================================
# CHECKPOINT
# ============================================================
def read_checkpoint() -> int:
    if CHECKPOINT_FILE.exists():
        try:
            val = CHECKPOINT_FILE.read_text().strip()
            return int(val)
        except Exception:
            pass
    return 1

def write_checkpoint(page_num: int):
    CHECKPOINT_FILE.write_text(str(page_num))

# ============================================================
# EXISTING DATA — deduplication set
# ============================================================
def load_existing_keys() -> set:
    """
    Returns a set of (index_number, medium, board) tuples already in schools_raw.csv.
    This is used to skip schools we already have.
    """
    keys = set()
    if not SCHOOLS_CSV.exists():
        return keys
    try:
        with open(SCHOOLS_CSV, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                idx  = (row.get("index_number") or "").strip()
                med  = (row.get("medium") or "").strip()
                brd  = (row.get("board") or "").strip()
                if idx:
                    keys.add((idx, med, brd))
    except Exception as e:
        log.warning(f"Could not read existing schools: {e}")
    log.info(f"Loaded {len(keys)} existing school keys for deduplication")
    return keys

# ============================================================
# HELPERS
# ============================================================
def parse_fee(raw: str):
    if not raw:
        return None
    cleaned = raw.replace(",", "").strip()
    if cleaned in {"-", "—", "NA", "N/A", ""}:
        return None
    try:
        return str(Decimal(cleaned))
    except Exception:
        return None

def extract_name_and_index(text: str):
    match = re.search(r"\((\d{6,})\)", text)
    index = match.group(1) if match else None
    name  = re.sub(r"\(\d{6,}\)", "", text).strip()
    return name, index

def with_retries(fn, label=""):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fn()
        except Exception as e:
            log.warning(f"[{label}] Attempt {attempt}/{MAX_RETRIES} failed: {e}")
            if attempt == MAX_RETRIES:
                raise
            time.sleep(BASE_DELAY * (2 ** (attempt - 1)))

def safe_goto(pw_page, url, label=""):
    def _go():
        pw_page.goto(url, timeout=90_000, wait_until="domcontentloaded")
    with_retries(_go, label=label)

# ============================================================
# SCRAPE ONE PAGE
# ============================================================
def scrape_page(page_number: int, existing_keys: set) -> tuple[int, int]:
    """
    Scrapes one paginated page. Returns (new_schools_found, schools_skipped).
    Runs in its own thread with its own Playwright browser instance.
    """
    new_count = 0
    skipped   = 0
    page_url  = f"{BASE_URL}?page={page_number}"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        )
        pw_page = context.new_page()

        try:
            safe_goto(pw_page, page_url, label=f"page={page_number}")
            pw_page.wait_for_selector("table", timeout=20_000)
            rows = pw_page.query_selector_all("table tbody tr")

            if not rows:
                log.info(f"Page {page_number}: no rows — end of data")
                browser.close()
                return 0, 0

            for row in rows:
                cols = row.query_selector_all("td")
                if len(cols) < 6:
                    continue

                raw_name     = cols[1].inner_text().strip()
                school_name, index_number = extract_name_and_index(raw_name)
                medium   = cols[2].inner_text().strip()
                board    = cols[3].inner_text().strip()
                district = cols[4].inner_text().strip()

                key = (index_number or "", medium, board)

                # ---- DEDUPLICATION CHECK ----
                with _csv_lock:
                    already_exists = key in existing_keys

                if already_exists:
                    skipped += 1
                    log.debug(f"Page {page_number}: SKIP existing — {school_name} ({index_number}) [{medium}/{board}]")
                    continue

                # ---- SCRAPE THIS SCHOOL ----
                scraped_at = datetime.now(timezone.utc).isoformat()
                school_id  = str(uuid.uuid4())

                def scrape_this_school(
                    _cols=cols, _school_name=school_name,
                    _index=index_number, _medium=medium,
                    _board=board, _district=district,
                    _school_id=school_id, _scraped_at=scraped_at
                ):
                    time.sleep(0.3)
                    view_btn = _cols[5].query_selector("button")
                    view_btn.scroll_into_view_if_needed()
                    view_btn.click(force=True)

                    modal = pw_page.wait_for_selector(
                        "#schoolFeeModal", timeout=20_000
                    )

                    # Fee status
                    fee_status = ""
                    for block in modal.query_selector_all(".row .col-md-6"):
                        txt = block.inner_text()
                        if "Fee Status" in txt:
                            fee_status = txt.split(":", 1)[-1].strip()

                    # Fee table
                    headers  = modal.query_selector_all("table thead th")
                    fee_rows = modal.query_selector_all("table tbody tr")
                    fee_inserts = []

                    for fr in fee_rows:
                        tds = fr.query_selector_all("td")
                        if len(tds) < 2:
                            continue
                        standard = tds[0].inner_text().strip()
                        for i in range(1, len(tds)):
                            if i >= len(headers):
                                break
                            year = headers[i].inner_text().strip()
                            raw  = tds[i].inner_text().strip()
                            fee  = parse_fee(raw)
                            fee_inserts.append({
                                "fee_id":        str(uuid.uuid4()),
                                "school_id":     _school_id,
                                "standard_name": standard,
                                "academic_year": year,
                                "approved_fee":  fee if fee is not None else "",
                                "scraped_at":    _scraped_at,
                            })

                    # Write school row
                    school_row = {
                        "school_id":     _school_id,
                        "school_name":   _school_name,
                        "index_number":  _index or "",
                        "district":      _district,
                        "medium":        _medium,
                        "board":         _board,
                        "zone":          "",
                        "fee_status":    fee_status,
                        "source_url":    page_url,
                        "created_at":    _scraped_at,
                        "scraped_at":    _scraped_at,
                    }
                    append_school_row(school_row)
                    append_fee_rows(fee_inserts)

                    # Add to in-memory dedup set immediately
                    with _csv_lock:
                        existing_keys.add((_index or "", _medium, _board))

                    # Close modal
                    try:
                        modal.query_selector("button.close").click()
                        pw_page.wait_for_selector(
                            "#schoolFeeModal", state="hidden", timeout=5_000
                        )
                    except Exception:
                        pw_page.keyboard.press("Escape")
                        pw_page.wait_for_timeout(500)

                try:
                    with_retries(
                        scrape_this_school,
                        label=f"page={page_number} school={school_name}"
                    )
                    new_count += 1
                    log.info(
                        f"Page {page_number}: NEW — {school_name} "
                        f"({index_number}) [{medium}/{board}]"
                    )
                except Exception as e:
                    log.error(
                        f"Page {page_number}: FAILED after retries — "
                        f"{school_name}: {e}"
                    )

        except Exception as e:
            log.error(f"Page {page_number}: page-level error — {e}")
            log.debug(traceback.format_exc())
        finally:
            try:
                browser.close()
            except Exception:
                pass

    return new_count, skipped

# ============================================================
# GET TOTAL PAGES
# ============================================================
def get_total_pages() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        pw_page = browser.new_page()
        try:
            safe_goto(pw_page, BASE_URL, label="total_pages")
            pw_page.wait_for_selector("table", timeout=20_000)

            # Try to find the "Last" pagination link
            last_link = pw_page.query_selector("ul.pagination li:last-child a")
            if last_link:
                href = last_link.get_attribute("href") or ""
                match = re.search(r"page=(\d+)", href)
                if match:
                    return int(match.group(1))

            # Fallback: look for all page number links
            links = pw_page.query_selector_all("ul.pagination li a")
            max_page = 1
            for link in links:
                href = link.get_attribute("href") or ""
                m = re.search(r"page=(\d+)", href)
                if m:
                    max_page = max(max_page, int(m.group(1)))
            return max_page
        except Exception as e:
            log.warning(f"Could not determine total pages: {e}. Defaulting to 1700.")
            return 1700
        finally:
            browser.close()

# ============================================================
# MAIN SCRAPE ORCHESTRATOR
# ============================================================
def run_scrape():
    _ensure_csv_headers()
    existing_keys = load_existing_keys()

    # Determine start page
    if START_PAGE_ENV:
        start_page = int(START_PAGE_ENV)
        log.info(f"START_PAGE env override: starting from page {start_page}")
    else:
        start_page = read_checkpoint()
        log.info(f"Resuming from checkpoint: page {start_page}")

    total_pages = get_total_pages()
    log.info(f"Total pages on site: {total_pages}")
    log.info(f"Workers: {WORKERS}")

    total_new     = 0
    total_skipped = 0
    completed_pages = set()

    # Build list of pages to process
    pages_to_do = list(range(start_page, total_pages + 1))
    log.info(f"Pages to process: {len(pages_to_do)}")

    # Track the lowest incomplete page for checkpoint
    _checkpoint_lock = threading.Lock()
    _min_pending = [start_page]  # mutable reference

    def update_checkpoint(done_page: int):
        with _checkpoint_lock:
            completed_pages.add(done_page)
            # Advance checkpoint to the highest consecutive completed page
            cp = read_checkpoint()
            while cp in completed_pages:
                cp += 1
            write_checkpoint(cp)

    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        future_to_page = {
            executor.submit(scrape_page, pg, existing_keys): pg
            for pg in pages_to_do
        }

        for future in as_completed(future_to_page):
            pg = future_to_page[future]
            try:
                new_c, skip_c = future.result()
                total_new     += new_c
                total_skipped += skip_c
                update_checkpoint(pg)
                log.info(
                    f"✓ Page {pg} done | new={new_c} skipped={skip_c} | "
                    f"total_new={total_new} total_skipped={total_skipped}"
                )
            except Exception as e:
                log.error(f"Page {pg} raised an unhandled exception: {e}")
                log.debug(traceback.format_exc())

    log.info(
        f"Scrape complete. Total new schools: {total_new}, "
        f"Total skipped (already existed): {total_skipped}"
    )
    # Clear checkpoint on full success
    if CHECKPOINT_FILE.exists():
        CHECKPOINT_FILE.unlink()
        log.info("Checkpoint cleared — full run completed successfully.")

# ============================================================
# AUTO-RESTART WRAPPER
# ============================================================
def main():
    attempt = 0
    max_auto_restarts = 10

    while attempt <= max_auto_restarts:
        try:
            run_scrape()
            log.info("All done!")
            return
        except KeyboardInterrupt:
            log.info("Interrupted by user. Checkpoint saved. Re-run to resume.")
            return
        except Exception as e:
            attempt += 1
            delay = BASE_DELAY * (2 ** min(attempt, 6))  # cap at ~128s
            log.error(
                f"Top-level crash (attempt {attempt}/{max_auto_restarts}): {e}\n"
                f"Restarting in {delay}s ..."
            )
            log.debug(traceback.format_exc())
            if attempt > max_auto_restarts:
                log.error("Max auto-restarts reached. Exiting.")
                sys.exit(1)
            time.sleep(delay)

if __name__ == "__main__":
    main()