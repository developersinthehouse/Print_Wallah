import logging
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

import requests


POLL_INTERVAL_SECONDS = 5
SUBSCRIPTION_RECHECK_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 20
INITIAL_BACKOFF_SECONDS = 2
MAX_BACKOFF_SECONDS = 300
API_BASE_URL = os.getenv("PRINT_WALLAH_API_URL", "").rstrip("/")
SHOP_ID = os.getenv("PRINT_WALLAH_SHOP_ID", "")
AGENT_TOKEN = os.getenv("PRINT_WALLAH_AGENT_TOKEN", "")


class SubscriptionExpired(Exception):
    pass


def get_data_directory():
    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "PrintWallah"
    return Path.home() / ".printwallah"


def configure_logging():
    log_directory = get_data_directory()
    try:
        log_directory.mkdir(parents=True, exist_ok=True)
        log_path = log_directory / "agent.log"
    except OSError:
        log_path = Path(__file__).with_name("agent.log")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(log_path, encoding="utf-8"), logging.StreamHandler()],
    )


class PrintAgent:
    def __init__(self, api_base_url, shop_id, agent_token):
        self.api_base_url = api_base_url
        self.shop_id = shop_id
        self.headers = {"Authorization": f"Bearer {agent_token}"}
        self.session = requests.Session()
        self.spool_directory = get_data_directory() / "spool"
        self.spool_directory.mkdir(parents=True, exist_ok=True)
        self.handled_job_ids = set()

    def _shop_jobs_url(self):
        return f"{self.api_base_url}/api/shops/{quote(self.shop_id, safe='')}/print-jobs"

    def poll_jobs(self):
        response = self.session.get(
            self._shop_jobs_url(),
            params={"status": "READY_TO_PRINT"},
            headers=self.headers,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if response.status_code == 403:
            raise SubscriptionExpired("Backend denied polling (403); shop may be expired or locked")
        response.raise_for_status()

        payload = response.json()
        jobs = payload.get("jobs") if isinstance(payload, dict) else payload
        if not isinstance(jobs, list):
            raise ValueError("Ready-jobs response must be a list or an object containing a 'jobs' list")
        return jobs

    def download_job_file(self, job):
        file_url = job.get("fileUrl")
        if not isinstance(file_url, str) or not file_url:
            raise ValueError("Job is missing a valid HTTP(S) fileUrl")
        resolved_url = urljoin(f"{self.api_base_url.rstrip('/')}/", file_url)
        parsed_url = urlparse(resolved_url)
        base_url = urlparse(self.api_base_url)
        if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
            raise ValueError("Job is missing a valid HTTP(S) fileUrl")

        job_id = str(job["id"])
        safe_job_id = re.sub(r"[^A-Za-z0-9_-]", "_", job_id)
        file_name = job.get("fileName")
        suffix = Path(file_name).suffix[:16] if isinstance(file_name, str) else ""
        if not suffix:
            suffix = Path(parsed_url.path).suffix[:16]
        file_path = self.spool_directory / f"job_{safe_job_id}{suffix}"

        headers = self.headers if parsed_url.netloc == base_url.netloc else None
        response = self.session.get(
            resolved_url,
            stream=True,
            headers=headers,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        with file_path.open("wb") as output_file:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if chunk:
                    output_file.write(chunk)
        return file_path

    @staticmethod
    def send_to_printer(file_path):
        if sys.platform != "win32" or not hasattr(os, "startfile"):
            raise OSError("Automatic printing is supported only on Windows")
        os.startfile(str(file_path), "print")

    def report_result(self, job_id, status, error=None):
        url = f"{self._shop_jobs_url()}/{quote(str(job_id), safe='')}/status"
        payload = {"status": status}
        if error:
            payload["error"] = str(error)[:1000]

        response = self.session.post(
            url,
            json=payload,
            headers=self.headers,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()

    def process_job(self, job):
        job_id = job.get("id")
        if job_id is None:
            logging.error("Ignoring ready job with no id")
            return

        job_id = str(job_id)
        if job_id in self.handled_job_ids:
            return

        try:
            file_path = self.download_job_file(job)
            copies = job.get("copies", 1)
            if isinstance(copies, bool) or not isinstance(copies, int) or not 1 <= copies <= 100:
                raise ValueError("Job has an invalid copy count")
            for _ in range(copies):
                self.send_to_printer(file_path)
            result_status = "PRINTED"
            result_error = None
            logging.info("Job %s sent to the default Windows printer", job_id)
        except (KeyError, OSError, requests.RequestException, ValueError) as error:
            result_status = "PRINT_FAILED"
            result_error = error
            logging.exception("Could not print job %s", job_id)

        self.handled_job_ids.add(job_id)
        try:
            self.report_result(job_id, result_status, result_error)
        except requests.RequestException:
            logging.exception("Could not report result for job %s; it will not be reprinted during this run", job_id)

    def run_forever(self):
        backoff_seconds = INITIAL_BACKOFF_SECONDS
        logging.info("Print agent started for shop %s", self.shop_id)

        while True:
            try:
                jobs = self.poll_jobs()
                for job in jobs:
                    if isinstance(job, dict):
                        self.process_job(job)
                    else:
                        logging.error("Ignoring invalid job entry: expected an object")
                backoff_seconds = INITIAL_BACKOFF_SECONDS
                time.sleep(POLL_INTERVAL_SECONDS)
            except SubscriptionExpired as error:
                logging.warning(
                    "Print polling paused: %s; checking subscription again in %s seconds",
                    error,
                    SUBSCRIPTION_RECHECK_SECONDS,
                )
                time.sleep(SUBSCRIPTION_RECHECK_SECONDS)
            except (requests.RequestException, ValueError) as error:
                logging.exception("Polling failed: %s; retrying in %s seconds", error, backoff_seconds)
                time.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, MAX_BACKOFF_SECONDS)


def main():
    configure_logging()
    missing_settings = [
        name
        for name, value in (
            ("PRINT_WALLAH_API_URL", API_BASE_URL),
            ("PRINT_WALLAH_SHOP_ID", SHOP_ID),
            ("PRINT_WALLAH_AGENT_TOKEN", AGENT_TOKEN),
        )
        if not value
    ]
    if missing_settings:
        logging.error("Missing required environment variables: %s", ", ".join(missing_settings))
        return 1

    try:
        PrintAgent(API_BASE_URL, SHOP_ID, AGENT_TOKEN).run_forever()
    except OSError:
        logging.exception("Could not initialize the local print spool directory")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
